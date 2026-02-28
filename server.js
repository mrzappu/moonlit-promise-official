const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { setupDatabase } = require('./database');
const discordLogger = require('./discordLogger');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Debug environment variables
console.log('=== ENVIRONMENT CHECK ===');
console.log('DISCORD_BOT_TOKEN exists:', !!process.env.DISCORD_BOT_TOKEN);
console.log('DISCORD_BOT_TOKEN length:', process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.length : 0);
console.log('DISCORD_CLIENT_ID:', process.env.DISCORD_CLIENT_ID);
console.log('DISCORD_CLIENT_SECRET exists:', !!process.env.DISCORD_CLIENT_SECRET);
console.log('DISCORD_CALLBACK_URL:', process.env.DISCORD_CALLBACK_URL);
console.log('SESSION_SECRET exists:', !!process.env.SESSION_SECRET);
console.log('========================');

// Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.charset = 'utf-8'; // FIXED: Removed extra parenthesis
    next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 },
    createParentPath: true,
    abortOnLimit: true
}));

// Session setup
app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    },
    proxy: true
}));

app.use(passport.initialize());
app.use(passport.session());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Database connection
let db;
setupDatabase().then(database => {
    db = database;
    console.log('✅ Database connected');
}).catch(err => {
    console.error('❌ Database connection error:', err);
});

// ==================== PASSPORT STRATEGIES ====================

// Local Strategy for username/password
passport.use('local', new LocalStrategy(
    async (username, password, done) => {
        try {
            console.log('📝 Local login attempt for:', username);
            
            if (!db) {
                return done(null, false, { message: 'Database not ready' });
            }

            // Find user by username or email
            const user = await db.get(
                'SELECT * FROM users WHERE username = ? OR email = ?', 
                [username, username]
            );
            
            if (!user) {
                await discordLogger.logFailedLogin(username, null, 'User not found', 'Username/Password');
                return done(null, false, { message: 'Invalid username or password' });
            }
            
            // Check if account is locked
            if (user.locked_until && new Date(user.locked_until) > new Date()) {
                const lockTime = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
                return done(null, false, { message: `Account is locked. Try again in ${lockTime} minutes.` });
            }
            
            if (user.is_banned) {
                return done(null, false, { message: 'Your account has been banned' });
            }
            
            // Check password
            const isValid = await bcrypt.compare(password, user.password);
            if (!isValid) {
                // Increment login attempts
                const attempts = (user.login_attempts || 0) + 1;
                
                if (attempts >= 5) {
                    // Lock account for 15 minutes
                    const lockUntil = new Date(Date.now() + 15 * 60 * 1000);
                    await db.run(
                        'UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?',
                        [attempts, lockUntil.toISOString(), user.id]
                    );
                    await discordLogger.logAccountLockout(user, req?.ip, 'Too many failed attempts');
                } else {
                    await db.run('UPDATE users SET login_attempts = ? WHERE id = ?', [attempts, user.id]);
                }
                
                await discordLogger.logFailedLogin(username, req?.ip, 'Invalid password', 'Username/Password');
                return done(null, false, { message: 'Invalid username or password' });
            }
            
            // Reset login attempts on successful login
            await db.run(
                'UPDATE users SET last_login = CURRENT_TIMESTAMP, login_attempts = 0, locked_until = NULL WHERE id = ?',
                [user.id]
            );
            
            // Log activity
            await db.run(
                'INSERT INTO user_activity (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [user.id, 'login', req?.ip, req?.headers['user-agent']]
            );
            
            await discordLogger.logLocalLogin(user, req?.ip);
            
            return done(null, user);
        } catch (error) {
            console.error('❌ Local strategy error:', error);
            return done(error);
        }
    }
));

// Discord Strategy
passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify', 'email']
}, async (accessToken, refreshToken, profile, done) => {
    try {
        console.log('📝 Discord login attempt for:', profile.username);
        
        if (!db) {
            return done(null, false, { message: 'Database not ready' });
        }

        let user = await db.get('SELECT * FROM users WHERE discord_id = ?', [profile.id]);
        
        if (user && user.is_banned) {
            return done(null, false, { message: 'You are banned from this site' });
        }

        const adminIds = process.env.ADMIN_DISCORD_IDS ? process.env.ADMIN_DISCORD_IDS.split(',') : [];
        const isAdmin = adminIds.includes(profile.id);

        if (!user) {
            // Check if username exists, if so append random numbers
            let username = profile.username;
            const existingUser = await db.get('SELECT * FROM users WHERE username = ?', [username]);
            if (existingUser) {
                username = `${username}${Math.floor(Math.random() * 1000)}`;
            }
            
            const result = await db.run(
                'INSERT INTO users (discord_id, username, email, avatar, is_admin) VALUES (?, ?, ?, ?, ?)',
                [profile.id, username, profile.email, profile.avatar, isAdmin]
            );
            
            user = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
            console.log('✅ New Discord user created:', user.username);
            await discordLogger.logRegister(user);
        } else {
            await db.run(
                'UPDATE users SET last_login = CURRENT_TIMESTAMP, username = ?, email = ?, avatar = ?, is_admin = ? WHERE discord_id = ?',
                [profile.username, profile.email, profile.avatar, isAdmin, profile.id]
            );
            
            user = await db.get('SELECT * FROM users WHERE discord_id = ?', [profile.id]);
            console.log('✅ Existing Discord user logged in:', user.username);
        }

        // Log activity
        await db.run(
            'INSERT INTO user_activity (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
            [user.id, 'discord_login', req?.ip, req?.headers['user-agent']]
        );

        await discordLogger.logLogin(user, req?.ip, 'Discord');

        return done(null, user);
    } catch (error) {
        console.error('❌ Discord strategy error:', error);
        return done(error);
    }
}));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
        done(null, user);
    } catch (error) {
        done(error);
    }
});

// ==================== AUTHENTICATION MIDDLEWARE ====================

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    req.session.returnTo = req.originalUrl;
    res.redirect('/login');
}

function ensureAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user && req.user.is_admin) {
        return next();
    }
    res.status(403).render('error', { 
        message: 'Access denied. Admin only.',
        user: req.user || null 
    });
}

function ensureGuest(req, res, next) {
    if (req.isAuthenticated()) {
        return res.redirect('/');
    }
    next();
}

// ==================== AUTH ROUTES ====================

// Login page
app.get('/login', ensureGuest, (req, res) => {
    res.render('login', { 
        user: null, 
        error: null, 
        success: null 
    });
});

// Register page
app.get('/register', ensureGuest, (req, res) => {
    res.render('register', { 
        user: null, 
        error: null 
    });
});

// Register handler
app.post('/register', ensureGuest, async (req, res) => {
    try {
        const { username, email, phone, password, confirmPassword } = req.body;
        
        // Validation
        if (!username || !email || !password || !confirmPassword) {
            return res.render('register', { 
                user: null, 
                error: 'All fields are required' 
            });
        }
        
        if (password !== confirmPassword) {
            return res.render('register', { 
                user: null, 
                error: 'Passwords do not match' 
            });
        }
        
        if (password.length < 6) {
            return res.render('register', { 
                user: null, 
                error: 'Password must be at least 6 characters' 
            });
        }
        
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
            return res.render('register', { 
                user: null, 
                error: 'Username must be 3-20 characters and can only contain letters, numbers, and underscores' 
            });
        }
        
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.render('register', { 
                user: null, 
                error: 'Invalid email format' 
            });
        }
        
        // Check if user exists
        const existingUser = await db.get(
            'SELECT * FROM users WHERE username = ? OR email = ?', 
            [username, email]
        );
        
        if (existingUser) {
            if (existingUser.username === username) {
                return res.render('register', { 
                    user: null, 
                    error: 'Username already exists' 
                });
            }
            if (existingUser.email === email) {
                return res.render('register', { 
                    user: null, 
                    error: 'Email already registered' 
                });
            }
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user
        const result = await db.run(
            'INSERT INTO users (username, email, phone, password, is_admin) VALUES (?, ?, ?, ?, ?)',
            [username, email, phone || null, hashedPassword, 0]
        );
        
        // Log activity
        const newUser = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
        
        await db.run(
            'INSERT INTO user_activity (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
            [newUser.id, 'register', req.ip, req.headers['user-agent']]
        );
        
        await discordLogger.logLocalRegister(newUser, req);
        
        res.render('login', { 
            user: null, 
            error: null, 
            success: 'Registration successful! Please login.' 
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.render('register', { 
            user: null, 
            error: 'Registration failed. Please try again.' 
        });
    }
});

// Login handler
app.post('/login', ensureGuest, (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) {
            return next(err);
        }
        if (!user) {
            return res.render('login', { 
                user: null, 
                error: info.message || 'Invalid username or password',
                success: null 
            });
        }
        req.logIn(user, (err) => {
            if (err) {
                return next(err);
            }
            
            // Log successful login
            db.run(
                'INSERT INTO user_activity (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [user.id, 'login_success', req.ip, req.headers['user-agent']]
            );
            
            const returnTo = req.session.returnTo || '/';
            delete req.session.returnTo;
            return res.redirect(returnTo);
        });
    })(req, res, next);
});

// Discord login
app.get('/auth/discord', passport.authenticate('discord'));

// Discord callback
app.get('/auth/discord/callback', 
    passport.authenticate('discord', { 
        failureRedirect: '/login',
        failureMessage: true 
    }),
    (req, res) => {
        const returnTo = req.session.returnTo || '/';
        delete req.session.returnTo;
        res.redirect(returnTo);
    }
);

// Logout
app.get('/logout', (req, res, next) => {
    const user = req.user;
    req.logout(async (err) => {
        if (err) { 
            console.error('Logout error:', err);
            return next(err); 
        }
        
        if (user) {
            await db.run(
                'INSERT INTO user_activity (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [user.id, 'logout', req.ip, req.headers['user-agent']]
            );
            await discordLogger.logLogout(user);
        }
        
        res.redirect('/');
    });
});

// Forgot password page
app.get('/forgot-password', ensureGuest, (req, res) => {
    res.render('forgot-password', { 
        user: null, 
        error: null, 
        success: null 
    });
});

// Forgot password handler
app.post('/forgot-password', ensureGuest, async (req, res) => {
    try {
        const { email } = req.body;
        
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        
        if (user) {
            // Generate reset token
            const token = crypto.randomBytes(32).toString('hex');
            const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
            
            await db.run(
                'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)',
                [user.id, token, expires.toISOString()]
            );
            
            await discordLogger.logAccountRecovery(email, req.ip);
            
            // In production, send email here
            console.log(`Password reset link: /reset-password/${token}`);
        }
        
        // Always show success to prevent email enumeration
        res.render('forgot-password', { 
            user: null, 
            error: null, 
            success: 'If your email is registered, you will receive a password reset link.' 
        });
        
    } catch (error) {
        console.error('Forgot password error:', error);
        res.render('forgot-password', { 
            user: null, 
            error: 'An error occurred. Please try again.',
            success: null 
        });
    }
});

// Reset password page
app.get('/reset-password/:token', ensureGuest, async (req, res) => {
    try {
        const { token } = req.params;
        
        const reset = await db.get(
            'SELECT * FROM password_resets WHERE token = ? AND expires_at > CURRENT_TIMESTAMP AND used = 0',
            [token]
        );
        
        if (!reset) {
            return res.render('error', { 
                message: 'Invalid or expired reset link',
                user: null 
            });
        }
        
        res.render('reset-password', { 
            user: null, 
            token, 
            error: null 
        });
        
    } catch (error) {
        console.error('Reset password page error:', error);
        res.render('error', { 
            message: 'An error occurred',
            user: null 
        });
    }
});

// Reset password handler
app.post('/reset-password/:token', ensureGuest, async (req, res) => {
    try {
        const { token } = req.params;
        const { password, confirmPassword } = req.body;
        
        if (password !== confirmPassword) {
            return res.render('reset-password', { 
                user: null, 
                token, 
                error: 'Passwords do not match' 
            });
        }
        
        if (password.length < 6) {
            return res.render('reset-password', { 
                user: null, 
                token, 
                error: 'Password must be at least 6 characters' 
            });
        }
        
        const reset = await db.get(
            'SELECT * FROM password_resets WHERE token = ? AND expires_at > CURRENT_TIMESTAMP AND used = 0',
            [token]
        );
        
        if (!reset) {
            return res.render('error', { 
                message: 'Invalid or expired reset link',
                user: null 
            });
        }
        
        // Hash new password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Update user password
        await db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, reset.user_id]);
        
        // Mark token as used
        await db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [reset.id]);
        
        // Log password change
        const user = await db.get('SELECT * FROM users WHERE id = ?', [reset.user_id]);
        await discordLogger.logPasswordChange(user, req.ip, 'user');
        
        res.render('login', { 
            user: null, 
            error: null, 
            success: 'Password reset successful! Please login.' 
        });
        
    } catch (error) {
        console.error('Reset password error:', error);
        res.render('error', { 
            message: 'An error occurred',
            user: null 
        });
    }
});

// ==================== PUBLIC ROUTES ====================

// Home page
app.get('/', async (req, res) => {
    try {
        if (!db) {
            return res.render('index', { 
                user: req.user || null, 
                featuredProducts: [],
                brands: ['Adidas', 'Puma', 'Under Armour', 'New Balance']
            });
        }
        
        const featuredProducts = await db.all('SELECT * FROM products ORDER BY RANDOM() LIMIT 8');
        
        const brandRows = await db.all('SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != ""');
        let brands = brandRows.map(row => row.brand);
        
        if (!brands || brands.length === 0) {
            brands = ['Adidas', 'Puma', 'Under Armour', 'New Balance'];
        }
        
        res.render('index', { 
            user: req.user || null, 
            featuredProducts: featuredProducts || [],
            brands: brands
        });
    } catch (error) {
        console.error('Home page error:', error);
        res.render('index', { 
            user: req.user || null, 
            featuredProducts: [],
            brands: ['Adidas', 'Puma', 'Under Armour', 'New Balance']
        });
    }
});

// Shop page
app.get('/shop', async (req, res) => {
    try {
        const { category, brand, search } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = 12;
        const offset = (page - 1) * limit;
        
        let query = 'SELECT * FROM products WHERE 1=1';
        let countQuery = 'SELECT COUNT(*) as count FROM products WHERE 1=1';
        const params = [];
        const countParams = [];

        if (category) {
            query += ' AND category = ?';
            countQuery += ' AND category = ?';
            params.push(category);
            countParams.push(category);
        }
        if (brand) {
            query += ' AND brand = ?';
            countQuery += ' AND brand = ?';
            params.push(brand);
            countParams.push(brand);
        }
        if (search) {
            query += ' AND (name LIKE ? OR description LIKE ?)';
            countQuery += ' AND (name LIKE ? OR description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
            countParams.push(`%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const products = await db.all(query, params);
        const totalCount = await db.get(countQuery, countParams);
        const totalPages = Math.ceil((totalCount?.count || 0) / limit);
        
        const categories = await db.all('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""');
        const brands = await db.all('SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != ""');

        res.render('shop', { 
            user: req.user || null, 
            products: products || [], 
            categories: categories || [], 
            brands: brands || [],
            filters: { category, brand, search },
            currentPage: page,
            totalPages: totalPages || 1
        });
    } catch (error) {
        console.error('Shop page error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Product details
app.get('/product/:id', async (req, res) => {
    try {
        const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
        if (!product) {
            return res.status(404).render('error', { 
                message: 'Product not found',
                user: req.user || null 
            });
        }

        if (req.user) {
            await discordLogger.logProductView(req.user, product);
        }

        const relatedProducts = await db.all(
            'SELECT * FROM products WHERE category = ? AND id != ? LIMIT 4',
            [product.category, product.id]
        );

        res.render('product', { 
            user: req.user || null, 
            product, 
            relatedProducts: relatedProducts || [] 
        });
    } catch (error) {
        console.error('Product page error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Terms page
app.get('/terms', (req, res) => {
    res.render('terms', { user: req.user || null });
});

// ==================== CART ROUTES ====================

// View cart
app.get('/cart', ensureAuthenticated, async (req, res) => {
    try {
        const cartItems = await db.all(`
            SELECT c.*, p.name, p.price, p.image_url, p.stock 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `, [req.user.id]);

        let subtotal = 0;
        cartItems.forEach(item => {
            subtotal += item.price * item.quantity;
        });

        const tax = subtotal * 0.18;
        const discount = req.session.discount || 0;
        const shipping = subtotal >= 999 ? 0 : 50;
        const total = subtotal + tax + shipping - discount;

        await discordLogger.logCartView(req.user);

        res.render('cart', { 
            user: req.user, 
            cartItems: cartItems || [], 
            subtotal: subtotal || 0,
            tax: tax || 0,
            shipping: shipping,
            discount: discount || 0,
            total: total || 0
        });
    } catch (error) {
        console.error('Cart page error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Add to cart
app.post('/cart/add/:productId', ensureAuthenticated, async (req, res) => {
    try {
        const productId = req.params.productId;
        const quantity = parseInt(req.body.quantity) || 1;

        const product = await db.get('SELECT * FROM products WHERE id = ?', [productId]);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        if (product.stock < quantity) {
            return res.status(400).json({ error: 'Insufficient stock' });
        }

        const existingItem = await db.get(
            'SELECT * FROM cart WHERE user_id = ? AND product_id = ?',
            [req.user.id, productId]
        );

        if (existingItem) {
            const newQuantity = existingItem.quantity + quantity;
            if (newQuantity > product.stock) {
                return res.status(400).json({ error: 'Cannot add more than available stock' });
            }
            
            await db.run(
                'UPDATE cart SET quantity = ? WHERE id = ?',
                [newQuantity, existingItem.id]
            );
        } else {
            await db.run(
                'INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)',
                [req.user.id, productId, quantity]
            );
        }

        await discordLogger.logCartAdd(req.user, product, quantity);

        res.json({ success: true, message: 'Item added to cart' });
    } catch (error) {
        console.error('Add to cart error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Cart count API
app.get('/cart/count', ensureAuthenticated, async (req, res) => {
    try {
        const result = await db.get(
            'SELECT SUM(quantity) as count FROM cart WHERE user_id = ?',
            [req.user.id]
        );
        res.json({ count: result?.count || 0 });
    } catch (error) {
        console.error('Cart count error:', error);
        res.json({ count: 0 });
    }
});

// Remove from cart
app.post('/cart/remove/:cartId', ensureAuthenticated, async (req, res) => {
    try {
        await db.run('DELETE FROM cart WHERE id = ? AND user_id = ?', 
            [req.params.cartId, req.user.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Remove from cart error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update cart quantity
app.post('/cart/update/:cartId', ensureAuthenticated, async (req, res) => {
    try {
        const { quantity } = req.body;
        await db.run('UPDATE cart SET quantity = ? WHERE id = ? AND user_id = ?', 
            [quantity, req.params.cartId, req.user.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Update cart error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Clear cart
app.post('/cart/clear', ensureAuthenticated, async (req, res) => {
    try {
        await db.run('DELETE FROM cart WHERE user_id = ?', [req.user.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Clear cart error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Apply coupon
app.post('/cart/apply-coupon', ensureAuthenticated, async (req, res) => {
    try {
        const { code } = req.body;
        
        const coupon = await db.get(
            'SELECT * FROM coupons WHERE code = ? AND valid_from <= CURRENT_TIMESTAMP AND valid_until >= CURRENT_TIMESTAMP AND (usage_limit IS NULL OR used_count < usage_limit)',
            [code]
        );
        
        if (!coupon) {
            return res.json({ success: false, message: 'Invalid or expired coupon' });
        }
        
        // Get cart subtotal
        const cartItems = await db.all(`
            SELECT c.*, p.price 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `, [req.user.id]);
        
        let subtotal = 0;
        cartItems.forEach(item => {
            subtotal += item.price * item.quantity;
        });
        
        if (subtotal < coupon.min_order_amount) {
            return res.json({ 
                success: false, 
                message: `Minimum order amount of ₹${coupon.min_order_amount} required` 
            });
        }
        
        let discountAmount = 0;
        if (coupon.discount_type === 'percentage') {
            discountAmount = (subtotal * coupon.discount_value) / 100;
            if (coupon.max_discount && discountAmount > coupon.max_discount) {
                discountAmount = coupon.max_discount;
            }
        } else {
            discountAmount = coupon.discount_value;
        }
        
        // Increment coupon usage
        await db.run('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [coupon.id]);
        
        req.session.discount = discountAmount;
        req.session.couponCode = code;
        
        res.json({ success: true, message: `Coupon applied! You saved ₹${discountAmount}` });
        
    } catch (error) {
        console.error('Apply coupon error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== CHECKOUT ROUTES ====================

// Checkout page
app.get('/checkout', ensureAuthenticated, async (req, res) => {
    try {
        const cartItems = await db.all(`
            SELECT c.*, p.name, p.price, p.image_url, p.stock 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `, [req.user.id]);

        if (cartItems.length === 0) {
            return res.redirect('/cart');
        }

        let subtotal = 0;
        cartItems.forEach(item => {
            subtotal += item.price * item.quantity;
        });

        const tax = subtotal * 0.18;
        const discount = req.session.discount || 0;
        const shipping = subtotal >= 999 ? 0 : 50;
        const total = subtotal + tax + shipping - discount;

        const tempOrderId = 'TEMP' + Date.now();
        const upiId = process.env.UPI_ID || 'sportswear@okhdfcbank';
        const payeeName = 'SportsWear';
        const amount = total.toFixed(2);
        
        const upiUrl = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${amount}&cu=INR&tn=${encodeURIComponent('Order ' + tempOrderId)}`;
        const qrCodeDataUrl = await QRCode.toDataURL(upiUrl);

        res.render('checkout', { 
            user: req.user, 
            cartItems: cartItems || [], 
            subtotal: subtotal || 0,
            tax: tax || 0,
            shipping: shipping,
            discount: discount || 0,
            total: total || 0,
            qrCodeDataUrl: qrCodeDataUrl || null,
            upiId: upiId,
            tempOrderId: tempOrderId,
            paymentMethods: ['UPI', 'Paytm', 'Google Pay', 'QR Code', 'Credit Card', 'Debit Card', 'Net Banking']
        });
    } catch (error) {
        console.error('Checkout page error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Process checkout
app.post('/checkout/process', ensureAuthenticated, async (req, res) => {
    try {
        const { paymentMethod, address, city, pincode, phone, notes } = req.body;
        const fullAddress = `${address}, ${city} - ${pincode}`;
        let paymentProof = null;

        if (paymentMethod === 'QR Code' && req.files && req.files.paymentProof) {
            const file = req.files.paymentProof;
            const fileName = `proof_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '')}`;
            const uploadPath = path.join(__dirname, 'public/uploads', fileName);
            await file.mv(uploadPath);
            paymentProof = `/uploads/${fileName}`;
        }

        const cartItems = await db.all(
            'SELECT c.*, p.price, p.id as product_id FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?',
            [req.user.id]
        );

        if (cartItems.length === 0) {
            return res.status(400).json({ error: 'Cart is empty' });
        }

        let subtotal = 0;
        cartItems.forEach(item => {
            subtotal += item.price * item.quantity;
        });
        
        const tax = subtotal * 0.18;
        const shipping = subtotal >= 999 ? 0 : 50;
        const discount = req.session.discount || 0;
        const total = subtotal + tax + shipping - discount;
        const orderNumber = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);

        await db.run('BEGIN TRANSACTION');

        // Create order
        const orderResult = await db.run(`
            INSERT INTO orders (user_id, order_number, total_amount, payment_method, shipping_address, city, pincode, phone, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [req.user.id, orderNumber, total, paymentMethod, fullAddress, city, pincode, phone, notes, 'pending']);

        // Add order items and update stock
        for (const item of cartItems) {
            await db.run(`
                INSERT INTO order_items (order_id, product_id, quantity, price)
                VALUES (?, ?, ?, ?)
            `, [orderResult.lastID, item.product_id, item.quantity, item.price]);

            await db.run(
                'UPDATE products SET stock = stock - ? WHERE id = ?',
                [item.quantity, item.product_id]
            );
        }

        // Record payment
        await db.run(`
            INSERT INTO payments (order_id, user_id, amount, payment_method, payment_proof, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [orderResult.lastID, req.user.id, total, paymentMethod, paymentProof, 'pending']);

        // Clear cart
        await db.run('DELETE FROM cart WHERE user_id = ?', [req.user.id]);

        // Clear discount session
        delete req.session.discount;
        delete req.session.couponCode;

        await db.run('COMMIT');

        // Prepare shipping details for logging
        const shippingDetails = {
            fullAddress,
            city,
            pincode,
            phone
        };

        // Log order creation with full details
        const order = {
            order_number: orderNumber,
            total_amount: total,
            payment_method: paymentMethod,
            status: 'pending',
            phone,
            shipping_address: fullAddress,
            created_at: new Date().toISOString()
        };
        
        await discordLogger.logOrderCreate(req.user, order, cartItems, shippingDetails);

        // Log payment initiation
        const payment = {
            order_id: orderResult.lastID,
            amount: total,
            payment_method: paymentMethod
        };
        await discordLogger.logPaymentInit(req.user, payment, shippingDetails);

        res.redirect('/order-confirmation/' + orderResult.lastID);
        
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Checkout error:', error);
        await discordLogger.logError(error, { location: 'checkout', user: req.user });
        res.status(500).json({ error: 'Server error' });
    }
});

// Order confirmation
app.get('/order-confirmation/:id', ensureAuthenticated, async (req, res) => {
    try {
        const order = await db.get(`
            SELECT o.*, u.username 
            FROM orders o 
            JOIN users u ON o.user_id = u.id 
            WHERE o.id = ? AND o.user_id = ?
        `, [req.params.id, req.user.id]);

        if (!order) {
            return res.status(404).render('error', { 
                message: 'Order not found',
                user: req.user || null 
            });
        }

        const orderItems = await db.all(`
            SELECT oi.*, p.name, p.image_url 
            FROM order_items oi 
            JOIN products p ON oi.product_id = p.id 
            WHERE oi.order_id = ?
        `, [req.params.id]);

        res.render('order-confirmation', { 
            user: req.user, 
            order, 
            orderItems: orderItems || [] 
        });
    } catch (error) {
        console.error('Order confirmation error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// ==================== USER PROFILE ROUTES ====================

// Profile page
app.get('/profile', ensureAuthenticated, async (req, res) => {
    try {
        const orderStats = await db.get(`
            SELECT COUNT(*) as total_orders, 
                   SUM(total_amount) as total_spent,
                   SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as completed_spent
            FROM orders 
            WHERE user_id = ?
        `, [req.user.id]);

        const recentOrders = await db.all(`
            SELECT * FROM orders 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 5
        `, [req.user.id]);

        const wishlistItems = await db.all(`
            SELECT w.*, p.name, p.price, p.image_url 
            FROM wishlist w 
            JOIN products p ON w.product_id = p.id 
            WHERE w.user_id = ?
            ORDER BY w.added_at DESC
        `, [req.user.id]);

        const recentActivity = await db.all(`
            SELECT * FROM user_activity 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 10
        `, [req.user.id]);

        res.render('profile', { 
            user: req.user, 
            stats: orderStats || { total_orders: 0, total_spent: 0, completed_spent: 0 },
            orders: recentOrders || [],
            wishlist: wishlistItems || [],
            recentActivity: recentActivity || [] 
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Update profile
app.post('/profile/update', ensureAuthenticated, async (req, res) => {
    try {
        const { phone, email } = req.body;
        
        await db.run(
            'UPDATE users SET phone = ?, email = ? WHERE id = ?',
            [phone, email, req.user.id]
        );
        
        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Change password
app.post('/profile/change-password', ensureAuthenticated, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        if (newPassword !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }
        
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
        
        const isValid = await bcrypt.compare(currentPassword, user.password);
        if (!isValid) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id]);
        
        await discordLogger.logPasswordChange(req.user, req.ip, 'user');
        
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Password change error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete account
app.post('/profile/delete', ensureAuthenticated, async (req, res) => {
    try {
        await db.run('BEGIN TRANSACTION');
        
        // Delete all user data
        await db.run('DELETE FROM cart WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM wishlist WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM payments WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM user_activity WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM password_resets WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM orders WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM users WHERE id = ?', [req.user.id]);
        
        await db.run('COMMIT');
        
        req.logout((err) => {
            if (err) console.error('Logout error:', err);
            res.json({ success: true });
        });
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add to wishlist
app.post('/wishlist/add/:productId', ensureAuthenticated, async (req, res) => {
    try {
        await db.run(
            'INSERT OR IGNORE INTO wishlist (user_id, product_id) VALUES (?, ?)',
            [req.user.id, req.params.productId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Wishlist add error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Remove from wishlist
app.post('/wishlist/remove/:productId', ensureAuthenticated, async (req, res) => {
    try {
        await db.run(
            'DELETE FROM wishlist WHERE user_id = ? AND product_id = ?',
            [req.user.id, req.params.productId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Wishlist remove error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ORDER HISTORY ROUTES ====================

// Order history
app.get('/history', ensureAuthenticated, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const offset = (page - 1) * limit;

        const orders = await db.all(`
            SELECT o.*, COUNT(oi.id) as item_count 
            FROM orders o 
            LEFT JOIN order_items oi ON o.id = oi.order_id 
            WHERE o.user_id = ? 
            GROUP BY o.id 
            ORDER BY o.created_at DESC
            LIMIT ? OFFSET ?
        `, [req.user.id, limit, offset]);

        for (let order of orders) {
            order.items = await db.all(`
                SELECT oi.*, p.name, p.image_url 
                FROM order_items oi 
                JOIN products p ON oi.product_id = p.id 
                WHERE oi.order_id = ?
            `, [order.id]);
        }

        const totalCount = await db.get('SELECT COUNT(*) as count FROM orders WHERE user_id = ?', [req.user.id]);
        const totalPages = Math.ceil((totalCount?.count || 0) / limit);

        res.render('history', { 
            user: req.user, 
            orders: orders || [],
            currentPage: page,
            totalPages: totalPages || 1
        });
    } catch (error) {
        console.error('History error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Order details
app.get('/order/:id', ensureAuthenticated, async (req, res) => {
    try {
        const order = await db.get(`
            SELECT o.*, u.username, u.discord_id 
            FROM orders o 
            JOIN users u ON o.user_id = u.id 
            WHERE o.id = ? AND o.user_id = ?
        `, [req.params.id, req.user.id]);
        
        if (!order) {
            return res.status(404).render('error', { 
                message: 'Order not found',
                user: req.user || null 
            });
        }
        
        const orderItems = await db.all(`
            SELECT oi.*, p.name, p.image_url, p.description 
            FROM order_items oi 
            JOIN products p ON oi.product_id = p.id 
            WHERE oi.order_id = ?
        `, [req.params.id]);
        
        const payment = await db.get('SELECT * FROM payments WHERE order_id = ?', [req.params.id]);
        
        res.render('order-details', { 
            user: req.user, 
            order, 
            orderItems: orderItems || [],
            payment: payment || null 
        });
    } catch (error) {
        console.error('Order details error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Reorder
app.post('/order/:id/reorder', ensureAuthenticated, async (req, res) => {
    try {
        const orderItems = await db.all('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [req.params.id]);
        
        await db.run('BEGIN TRANSACTION');
        
        for (const item of orderItems) {
            const product = await db.get('SELECT * FROM products WHERE id = ? AND stock >= ?', [item.product_id, item.quantity]);
            
            if (product) {
                const existing = await db.get('SELECT * FROM cart WHERE user_id = ? AND product_id = ?', [req.user.id, item.product_id]);
                
                if (existing) {
                    const newQuantity = existing.quantity + item.quantity;
                    if (newQuantity <= product.stock) {
                        await db.run('UPDATE cart SET quantity = ? WHERE id = ?', [newQuantity, existing.id]);
                    }
                } else {
                    await db.run('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)', [req.user.id, item.product_id, item.quantity]);
                }
            }
        }
        
        await db.run('COMMIT');
        res.json({ success: true });
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Reorder error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Cancel order
app.post('/order/:id/cancel', ensureAuthenticated, async (req, res) => {
    try {
        const order = await db.get('SELECT * FROM orders WHERE id = ? AND user_id = ? AND status IN ("pending", "processing")', [req.params.id, req.user.id]);
        
        if (!order) {
            return res.status(400).json({ error: 'Order cannot be cancelled' });
        }
        
        await db.run('BEGIN TRANSACTION');
        
        await db.run('UPDATE orders SET status = "cancelled" WHERE id = ?', [req.params.id]);
        
        const orderItems = await db.all('SELECT * FROM order_items WHERE order_id = ?', [req.params.id]);
        for (const item of orderItems) {
            await db.run('UPDATE products SET stock = stock + ? WHERE id = ?', [item.quantity, item.product_id]);
        }
        
        await db.run('UPDATE payments SET status = "cancelled" WHERE order_id = ?', [req.params.id]);
        
        await db.run('COMMIT');
        
        await discordLogger.logOrderUpdate(req.user, order, order.status, 'cancelled', 'user');
        res.json({ success: true });
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Cancel order error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Track order
app.get('/track-order/:id', ensureAuthenticated, async (req, res) => {
    try {
        const order = await db.get(`
            SELECT o.*, u.username 
            FROM orders o 
            JOIN users u ON o.user_id = u.id 
            WHERE o.id = ? AND o.user_id = ?
        `, [req.params.id, req.user.id]);
        
        if (!order) {
            return res.status(404).render('error', { 
                message: 'Order not found',
                user: req.user || null 
            });
        }
        
        const trackingStatus = [
            { status: 'Order Placed', date: order.created_at, completed: true },
            { status: 'Payment Confirmed', date: order.updated_at, completed: order.status !== 'pending' },
            { status: 'Processing', date: null, completed: ['processing', 'shipped', 'delivered', 'completed'].includes(order.status) },
            { status: 'Shipped', date: null, completed: ['shipped', 'delivered', 'completed'].includes(order.status) },
            { status: 'Out for Delivery', date: null, completed: ['delivered', 'completed'].includes(order.status) },
            { status: 'Delivered', date: null, completed: ['delivered', 'completed'].includes(order.status) }
        ];
        
        res.render('track-order', { user: req.user, order, trackingStatus });
    } catch (error) {
        console.error('Track order error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// ==================== BOT STATUS ROUTES ====================

// Bot status endpoint (JSON)
app.get('/bot-status', (req, res) => {
    try {
        const status = discordLogger.getStatus();
        res.json({
            success: true,
            ...status
        });
    } catch (error) {
        console.error('Error getting bot status:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Could not retrieve bot status' 
        });
    }
});

// Health check endpoint (for uptime monitoring)
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: db ? 'connected' : 'disconnected',
        bot: discordLogger.getStatus().ready ? 'connected' : 'disconnected'
    });
});

// Simple status page (HTML)
app.get('/status', (req, res) => {
    const botStatus = discordLogger.getStatus();
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>SportsWear Status</title>
        <meta http-equiv="refresh" content="10">
        <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: white; }
            .status { padding: 20px; border-radius: 10px; margin: 20px; font-size: 1.2em; }
            .online { background: #27ae60; }
            .offline { background: #e74c3c; }
            .connecting { background: #f39c12; }
            .info { background: #34495e; padding: 20px; border-radius: 10px; margin: 20px; text-align: left; }
            table { width: 100%; border-collapse: collapse; }
            td { padding: 10px; border-bottom: 1px solid #444; }
            td:first-child { font-weight: bold; width: 200px; }
        </style>
    </head>
    <body>
        <h1>🏪 SportsWear Status Page</h1>
        <div class="status ${botStatus.ready ? 'online' : (botStatus.reconnectAttempts > 0 ? 'connecting' : 'offline')}">
            <h2>Bot is ${botStatus.ready ? '🟢 ONLINE' : (botStatus.reconnectAttempts > 0 ? '🟡 CONNECTING' : '🔴 OFFLINE')}</h2>
        </div>
        <div class="info">
            <h3>📊 System Details:</h3>
            <table>
                <tr><td>Bot Name:</td><td>${botStatus.user?.tag || 'N/A'}</td></tr>
                <tr><td>Bot ID:</td><td>${botStatus.user?.id || 'N/A'}</td></tr>
                <tr><td>Servers:</td><td>${botStatus.guilds}</td></tr>
                <tr><td>Reconnect Attempts:</td><td>${botStatus.reconnectAttempts}/${botStatus.maxReconnectAttempts}</td></tr>
                <tr><td>Queued Messages:</td><td>${botStatus.queuedMessages}</td></tr>
                <tr><td>Uptime:</td><td>${Math.floor(process.uptime() / 60)} minutes ${Math.floor(process.uptime() % 60)} seconds</td></tr>
                <tr><td>Database:</td><td>${db ? '✅ Connected' : '❌ Disconnected'}</td></tr>
                <tr><td>Last Updated:</td><td>${new Date().toLocaleString()}</td></tr>
            </table>
        </div>
        <p><small>Page auto-refreshes every 10 seconds</small></p>
    </body>
    </html>
    `;
    res.send(html);
});

// ==================== API ROUTES ====================

// Search API
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        const products = await db.all(`
            SELECT * FROM products 
            WHERE name LIKE ? OR description LIKE ? 
            LIMIT 20
        `, [`%${q}%`, `%${q}%`]);
        res.json(products || []);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Products API for infinite scroll
app.get('/api/products', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 12;
        const offset = (page - 1) * limit;
        const products = await db.all('SELECT * FROM products ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]);
        res.json({ products: products || [] });
    } catch (error) {
        console.error('Products API error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN ROUTES ====================

// Admin dashboard
app.get('/admin', ensureAdmin, async (req, res) => {
    try {
        await discordLogger.logAdminLogin(req.user);

        const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
        const totalOrders = await db.get('SELECT COUNT(*) as count FROM orders');
        const totalProducts = await db.get('SELECT COUNT(*) as count FROM products');
        const totalRevenue = await db.get('SELECT SUM(total_amount) as total FROM orders WHERE status = "completed"');
        const pendingOrders = await db.get('SELECT COUNT(*) as count FROM orders WHERE status = "pending"');
        
        const recentOrders = await db.all(`
            SELECT o.*, u.username 
            FROM orders o 
            JOIN users u ON o.user_id = u.id 
            ORDER BY o.created_at DESC 
            LIMIT 10
        `);
        
        const recentUsers = await db.all(`SELECT * FROM users ORDER BY created_at DESC LIMIT 10`);

        const stats = {
            totalUsers: totalUsers || { count: 0 },
            totalOrders: totalOrders || { count: 0 },
            totalProducts: totalProducts || { count: 0 },
            totalRevenue: totalRevenue || { total: 0 },
            pendingOrders: pendingOrders || { count: 0 },
            recentOrders: recentOrders || [],
            recentUsers: recentUsers || []
        };

        res.render('admin/dashboard', { user: req.user, stats });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Admin users page
app.get('/admin/users', ensureAdmin, async (req, res) => {
    try {
        const users = await db.all(`
            SELECT u.*, 
                   (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as order_count,
                   (SELECT SUM(total_amount) FROM orders WHERE user_id = u.id AND status = 'completed') as total_spent,
                   (SELECT COUNT(*) FROM user_activity WHERE user_id = u.id) as activity_count
            FROM users u
            ORDER BY u.created_at DESC
        `);

        res.render('admin/users', { user: req.user, users: users || [] });
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Ban/unban user
app.post('/admin/users/:userId/ban', ensureAdmin, async (req, res) => {
    try {
        const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [req.params.userId]);
        await db.run('UPDATE users SET is_banned = ? WHERE id = ?', [req.body.action === 'ban' ? 1 : 0, req.params.userId]);

        await discordLogger.logAdminAction(req.user, `${req.body.action === 'ban' ? 'Banned' : 'Unbanned'} user`, `User: ${targetUser.username}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Ban user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin products page
app.get('/admin/products', ensureAdmin, async (req, res) => {
    try {
        const products = await db.all('SELECT * FROM products ORDER BY created_at DESC');
        const categories = await db.all('SELECT DISTINCT category FROM products');
        const brands = await db.all('SELECT DISTINCT brand FROM products');
        
        res.render('admin/products', { 
            user: req.user, 
            products: products || [],
            categories: categories || [],
            brands: brands || []
        });
    } catch (error) {
        console.error('Admin products error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Add product
app.post('/admin/products', ensureAdmin, async (req, res) => {
    try {
        const { name, description, price, category, brand, stock } = req.body;
        let imageUrl = '/images/default-product.jpg';

        if (req.files && req.files.image) {
            const file = req.files.image;
            const fileName = `product_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '')}`;
            const uploadPath = path.join(__dirname, 'public/uploads', fileName);
            await file.mv(uploadPath);
            imageUrl = `/uploads/${fileName}`;
        }

        const result = await db.run(`
            INSERT INTO products (name, description, price, category, brand, image_url, stock)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [name, description, price, category, brand, imageUrl, stock]);

        await discordLogger.logProductAdd(req.user, { id: result.lastID, name, price, category, brand, stock });
        res.redirect('/admin/products');
    } catch (error) {
        console.error('Add product error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Edit product
app.post('/admin/products/:id/edit', ensureAdmin, async (req, res) => {
    try {
        const { name, description, price, category, brand, stock } = req.body;
        const oldProduct = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);

        let imageUrl = oldProduct.image_url;
        if (req.files && req.files.image) {
            const file = req.files.image;
            const fileName = `product_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '')}`;
            const uploadPath = path.join(__dirname, 'public/uploads', fileName);
            await file.mv(uploadPath);
            imageUrl = `/uploads/${fileName}`;
        }

        await db.run(`
            UPDATE products 
            SET name = ?, description = ?, price = ?, category = ?, brand = ?, image_url = ?, stock = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [name, description, price, category, brand, imageUrl, stock, req.params.id]);

        await discordLogger.logProductEdit(req.user, { name, price }, 'Product updated');
        res.redirect('/admin/products');
    } catch (error) {
        console.error('Edit product error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Delete product
app.post('/admin/products/:id/delete', ensureAdmin, async (req, res) => {
    try {
        const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
        await db.run('DELETE FROM products WHERE id = ?', [req.params.id]);
        await discordLogger.logProductDelete(req.user, product);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin orders page
app.get('/admin/orders', ensureAdmin, async (req, res) => {
    try {
        const orders = await db.all(`
            SELECT o.*, u.username, u.discord_id,
                   (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count,
                   p.payment_proof, p.status as payment_status
            FROM orders o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN payments p ON o.id = p.order_id
            ORDER BY o.created_at DESC
        `);

        res.render('admin/orders', { user: req.user, orders: orders || [] });
    } catch (error) {
        console.error('Admin orders error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Update order status
app.post('/admin/orders/:id/status', ensureAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        const oldStatus = order.status;

        await db.run('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, req.params.id]);

        await discordLogger.logOrderUpdate(req.user, order, oldStatus, status);
        res.json({ success: true });
    } catch (error) {
        console.error('Update order status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Verify payment proof
app.post('/admin/orders/:id/verify-payment', ensureAdmin, async (req, res) => {
    try {
        const { status, upiTransactionId } = req.body;
        const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        const payment = await db.get('SELECT * FROM payments WHERE order_id = ?', [req.params.id]);
        const user = await db.get('SELECT * FROM users WHERE id = ?', [order.user_id]);
        
        if (status === 'completed') {
            await db.run('BEGIN TRANSACTION');
            await db.run('UPDATE orders SET status = "completed", updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
            await db.run('UPDATE payments SET status = "completed", upi_transaction_id = ? WHERE order_id = ?', [upiTransactionId || null, req.params.id]);
            await db.run('COMMIT');
            
            const shippingDetails = {
                phone: order.phone,
                city: order.city,
                pincode: order.pincode,
                fullAddress: order.shipping_address
            };
            
            await discordLogger.logPaymentSuccess(user, payment, payment.payment_proof, upiTransactionId, shippingDetails);
            await discordLogger.logOrderComplete(user, order, shippingDetails);
            res.json({ success: true });
            
        } else if (status === 'failed') {
            await db.run('BEGIN TRANSACTION');
            await db.run('UPDATE orders SET status = "cancelled" WHERE id = ?', [req.params.id]);
            await db.run('UPDATE payments SET status = "failed" WHERE order_id = ?', [req.params.id]);
            
            const orderItems = await db.all('SELECT * FROM order_items WHERE order_id = ?', [req.params.id]);
            for (const item of orderItems) {
                await db.run('UPDATE products SET stock = stock + ? WHERE id = ?', [item.quantity, item.product_id]);
            }
            
            await db.run('COMMIT');
            await discordLogger.logPaymentFailed(user, payment, 'Payment rejected by admin');
            res.json({ success: true });
        }
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Payment verification error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// View payment proof
app.get('/admin/payment-proof/:orderId', ensureAdmin, async (req, res) => {
    try {
        const payment = await db.get('SELECT * FROM payments WHERE order_id = ?', [req.params.orderId]);
        const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.orderId]);
        const user = await db.get('SELECT * FROM users WHERE id = ?', [order.user_id]);
        
        if (!payment || !payment.payment_proof) {
            return res.status(404).render('error', { 
                message: 'Payment proof not found',
                user: req.user 
            });
        }
        
        res.render('admin/payment-proof', { 
            user: req.user, 
            payment, 
            order, 
            customer: user 
        });
    } catch (error) {
        console.error('View payment proof error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user 
        });
    }
});

// Backup database
app.get('/admin/backup', ensureAdmin, async (req, res) => {
    try {
        const dbPath = path.join(__dirname, 'website.db');
        const backupPath = path.join(__dirname, `backup_${Date.now()}.db`);
        fs.copyFileSync(dbPath, backupPath);
        const stats = fs.statSync(backupPath);
        
        await discordLogger.logBackup(req.user, path.basename(backupPath), stats.size);
        res.download(backupPath, 'website_backup.db', (err) => {
            fs.unlinkSync(backupPath);
        });
    } catch (error) {
        console.error('Backup error:', error);
        res.status(500).json({ error: 'Backup failed' });
    }
});

// Restore database
app.post('/admin/restore', ensureAdmin, async (req, res) => {
    try {
        if (!req.files || !req.files.database) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const file = req.files.database;
        const dbPath = path.join(__dirname, 'website.db');
        
        await db.close();
        await file.mv(dbPath);
        db = await setupDatabase();

        res.json({ success: true });
    } catch (error) {
        console.error('Restore error:', error);
        res.status(500).json({ error: 'Restore failed' });
    }
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
    res.status(404).render('error', { 
        message: 'Page not found',
        user: req.user || null
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    discordLogger.logError(err, { location: req.path, user: req.user });
    res.status(500).render('error', { 
        message: 'Something went wrong!',
        user: req.user || null
    });
});

// ==================== START SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌍 Website: http://localhost:${PORT}`);
    console.log(`🌍 Public URL: https://moonlit-promise-new.onrender.com`);
    console.log(`📊 Status page: https://moonlit-promise-new.onrender.com/status`);
    discordLogger.logSystem(`Server started on port ${PORT}`, 'info');
});

module.exports = app;
