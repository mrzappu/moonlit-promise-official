const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const { setupDatabase } = require('./database');
const discordLogger = require('./discordLogger');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    createParentPath: true
}));

// Session setup
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
}));

// Passport setup
app.use(passport.initialize());
app.use(passport.session());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Database connection
let db;
setupDatabase().then(database => {
    db = database;
    console.log('Database connected');
}).catch(err => {
    console.error('Database connection error:', err);
});

// Passport Discord Strategy
passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify', 'email']
}, async (accessToken, refreshToken, profile, done) => {
    try {
        // Check if user exists
        let user = await db.get('SELECT * FROM users WHERE discord_id = ?', [profile.id]);
        
        if (user && user.is_banned) {
            return done(null, false, { message: 'You are banned from this site' });
        }

        const adminIds = process.env.ADMIN_DISCORD_IDS ? process.env.ADMIN_DISCORD_IDS.split(',') : [];
        const isAdmin = adminIds.includes(profile.id);

        if (!user) {
            // Create new user
            const result = await db.run(
                'INSERT INTO users (discord_id, username, email, avatar, is_admin) VALUES (?, ?, ?, ?, ?)',
                [profile.id, profile.username, profile.email, profile.avatar, isAdmin]
            );
            
            user = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
            
            // Log registration
            await discordLogger.logRegister(user);
        } else {
            // Update last login
            await db.run(
                'UPDATE users SET last_login = CURRENT_TIMESTAMP, username = ?, email = ?, avatar = ?, is_admin = ? WHERE discord_id = ?',
                [profile.username, profile.email, profile.avatar, isAdmin, profile.id]
            );
            
            user = await db.get('SELECT * FROM users WHERE discord_id = ?', [profile.id]);
        }

        // Log activity
        await db.run(
            'INSERT INTO user_activity (user_id, action, ip_address) VALUES (?, ?, ?)',
            [user.id, 'login', null]
        );

        return done(null, user);
    } catch (error) {
        console.error('Discord strategy error:', error);
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

// Authentication middleware
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/');
}

function ensureAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.is_admin) {
        return next();
    }
    res.status(403).render('error', { 
        message: 'Access denied. Admin only.',
        user: req.user || null 
    });
}

// ==================== PUBLIC ROUTES ====================

// Home page
app.get('/', async (req, res) => {
    try {
        if (!db) {
            // If database isn't ready yet, show a loading page or simple template
            return res.render('index', { 
                user: req.user || null, 
                featuredProducts: [],
                brands: ['Adidas', 'Puma', 'Under Armour', 'New Balance']
            });
        }
        
        const featuredProducts = await db.all('SELECT * FROM products ORDER BY RANDOM() LIMIT 8');
        res.render('index', { 
            user: req.user || null, 
            featuredProducts,
            brands: ['Adidas', 'Puma', 'Under Armour', 'New Balance']
        });
    } catch (error) {
        console.error('Home page error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
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
        const totalPages = Math.ceil(totalCount.count / limit);
        
        const categories = await db.all('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""');
        const brands = await db.all('SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != ""');

        res.render('shop', { 
            user: req.user || null, 
            products, 
            categories, 
            brands,
            filters: { category, brand, search },
            currentPage: page,
            totalPages
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

        // Log product view
        if (req.user) {
            await discordLogger.logProductView(req.user, product);
        }

        const relatedProducts = await db.all(
            'SELECT * FROM products WHERE category = ? AND id != ? LIMIT 4',
            [product.category, product.id]
        );

        res.render('product', { user: req.user || null, product, relatedProducts });
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

        const tax = subtotal * 0.18; // 18% GST
        const discount = req.session.discount || 0;
        const total = subtotal + tax - discount;

        // Log cart view
        await discordLogger.logCartView(req.user);

        res.render('cart', { 
            user: req.user, 
            cartItems, 
            subtotal,
            tax,
            discount,
            total
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

        // Check if product exists and has stock
        const product = await db.get('SELECT * FROM products WHERE id = ?', [productId]);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        if (product.stock < quantity) {
            return res.status(400).json({ error: 'Insufficient stock' });
        }

        // Check if item already in cart
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

        // Log cart addition
        await discordLogger.logCartAdd(req.user, product, quantity);

        res.json({ success: true, message: 'Item added to cart' });
    } catch (error) {
        console.error('Add to cart error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update cart item quantity
app.post('/cart/update/:cartId', ensureAuthenticated, async (req, res) => {
    try {
        const { quantity } = req.body;
        
        // Check stock
        const cartItem = await db.get(`
            SELECT c.*, p.stock 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.id = ? AND c.user_id = ?
        `, [req.params.cartId, req.user.id]);

        if (!cartItem) {
            return res.status(404).json({ error: 'Cart item not found' });
        }

        if (quantity > cartItem.stock) {
            return res.status(400).json({ error: 'Insufficient stock' });
        }

        await db.run(
            'UPDATE cart SET quantity = ? WHERE id = ? AND user_id = ?',
            [quantity, req.params.cartId, req.user.id]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update cart error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Remove from cart
app.post('/cart/remove/:cartId', ensureAuthenticated, async (req, res) => {
    try {
        const cartItem = await db.get(
            'SELECT c.*, p.name FROM cart c JOIN products p ON c.product_id = p.id WHERE c.id = ? AND c.user_id = ?',
            [req.params.cartId, req.user.id]
        );

        if (!cartItem) {
            return res.status(404).json({ error: 'Item not found' });
        }

        await db.run('DELETE FROM cart WHERE id = ?', [req.params.cartId]);

        // Log cart removal
        await discordLogger.logCartRemove(req.user, { name: cartItem.name });

        res.json({ success: true, message: 'Item removed from cart' });
    } catch (error) {
        console.error('Remove from cart error:', error);
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

// Cart count API
app.get('/cart/count', ensureAuthenticated, async (req, res) => {
    try {
        const result = await db.get(
            'SELECT SUM(quantity) as count FROM cart WHERE user_id = ?',
            [req.user.id]
        );
        res.json({ count: result.count || 0 });
    } catch (error) {
        console.error('Cart count error:', error);
        res.json({ count: 0 });
    }
});

// Apply coupon
app.post('/cart/apply-coupon', ensureAuthenticated, async (req, res) => {
    try {
        const { code } = req.body;
        
        // Simple coupon logic - you can expand this
        const validCoupons = {
            'WELCOME10': 10,
            'SAVE20': 20,
            'FREESHIP': 0
        };
        
        if (validCoupons[code]) {
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
            
            const discountAmount = (subtotal * validCoupons[code]) / 100;
            
            // Store discount in session
            req.session.discount = discountAmount;
            res.json({ success: true, message: `Coupon applied! You saved ₹${discountAmount}` });
        } else {
            res.json({ success: false, message: 'Invalid coupon code' });
        }
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
        const total = subtotal + tax - discount;

        res.render('checkout', { 
            user: req.user, 
            cartItems, 
            subtotal,
            tax,
            discount,
            total,
            paymentMethods: ['UPI', 'Paytm', 'Google Pay', 'QR Code']
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
        const { paymentMethod, address } = req.body;
        let paymentProof = null;

        // Handle payment proof upload for QR payments
        if (paymentMethod === 'QR Code' && req.files && req.files.paymentProof) {
            const file = req.files.paymentProof;
            const fileName = `proof_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '')}`;
            const uploadPath = path.join(__dirname, 'public/uploads', fileName);
            
            await file.mv(uploadPath);
            paymentProof = `/uploads/${fileName}`;
        }

        // Get cart items
        const cartItems = await db.all(
            'SELECT c.*, p.price, p.id as product_id FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?',
            [req.user.id]
        );

        if (cartItems.length === 0) {
            return res.status(400).json({ error: 'Cart is empty' });
        }

        // Calculate total
        let subtotal = 0;
        cartItems.forEach(item => {
            subtotal += item.price * item.quantity;
        });
        
        const tax = subtotal * 0.18;
        const discount = req.session.discount || 0;
        const total = subtotal + tax - discount;

        // Generate order number
        const orderNumber = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);

        // Start transaction
        await db.run('BEGIN TRANSACTION');

        // Create order
        const orderResult = await db.run(`
            INSERT INTO orders (user_id, order_number, total_amount, payment_method, shipping_address, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [req.user.id, orderNumber, total, paymentMethod, address, 'pending']);

        // Add order items and update stock
        for (const item of cartItems) {
            await db.run(`
                INSERT INTO order_items (order_id, product_id, quantity, price)
                VALUES (?, ?, ?, ?)
            `, [orderResult.lastID, item.product_id, item.quantity, item.price]);

            // Update stock
            await db.run(
                'UPDATE products SET stock = stock - ? WHERE id = ?',
                [item.quantity, item.product_id]
            );
        }

        // Record payment
        const paymentResult = await db.run(`
            INSERT INTO payments (order_id, user_id, amount, payment_method, payment_proof, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [orderResult.lastID, req.user.id, total, paymentMethod, paymentProof, 'pending']);

        // Clear cart
        await db.run('DELETE FROM cart WHERE user_id = ?', [req.user.id]);

        // Clear discount session
        delete req.session.discount;

        // Commit transaction
        await db.run('COMMIT');

        // Get payment details for logging
        const payment = {
            order_id: orderResult.lastID,
            amount: total,
            payment_method: paymentMethod
        };

        // Log payment initiation
        await discordLogger.logPaymentInit(req.user, payment);

        // If payment proof uploaded, log as success with proof
        if (paymentProof) {
            await discordLogger.logPaymentSuccess(req.user, payment, paymentProof);
        }

        // Log order creation
        const order = {
            order_number: orderNumber,
            total_amount: total,
            payment_method: paymentMethod
        };
        await discordLogger.logOrderCreate(req.user, order);

        res.redirect('/order-confirmation/' + orderResult.lastID);
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Checkout process error:', error);
        await discordLogger.logError(error, { location: 'checkout', user: req.user });
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
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

        res.render('order-confirmation', { user: req.user, order, orderItems });
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
        // Get user statistics
        const orderStats = await db.get(`
            SELECT COUNT(*) as total_orders, SUM(total_amount) as total_spent 
            FROM orders 
            WHERE user_id = ?
        `, [req.user.id]);

        const recentOrders = await db.all(`
            SELECT * FROM orders 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 5
        `, [req.user.id]);

        const recentActivity = await db.all(`
            SELECT * FROM user_activity 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 10
        `, [req.user.id]);

        res.render('profile', { 
            user: req.user, 
            stats: orderStats,
            orders: recentOrders,
            recentActivity 
        });
    } catch (error) {
        console.error('Profile page error:', error);
        res.status(500).render('error', { 
            message: 'Server error',
            user: req.user || null 
        });
    }
});

// Delete account
app.post('/profile/delete', ensureAuthenticated, async (req, res) => {
    try {
        // Start transaction
        await db.run('BEGIN TRANSACTION');
        
        // Delete user data
        await db.run('DELETE FROM cart WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM payments WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM user_activity WHERE user_id = ?', [req.user.id]);
        await db.run('DELETE FROM users WHERE id = ?', [req.user.id]);
        
        await db.run('COMMIT');
        
        // Logout user
        req.logout((err) => {
            if (err) {
                console.error('Logout error:', err);
            }
            res.json({ success: true });
        });
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Delete account error:', error);
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

        // Get items for each order
        for (let order of orders) {
            order.items = await db.all(`
                SELECT oi.*, p.name, p.image_url 
                FROM order_items oi 
                JOIN products p ON oi.product_id = p.id 
                WHERE oi.order_id = ?
            `, [order.id]);
        }

        const totalCount = await db.get(
            'SELECT COUNT(*) as count FROM orders WHERE user_id = ?',
            [req.user.id]
        );
        const totalPages = Math.ceil(totalCount.count / limit);

        res.render('history', { 
            user: req.user, 
            orders,
            currentPage: page,
            totalPages
        });
    } catch (error) {
        console.error('History page error:', error);
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
        
        const payment = await db.get(
            'SELECT * FROM payments WHERE order_id = ?',
            [req.params.id]
        );
        
        res.render('order-details', { user: req.user, order, orderItems, payment });
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
        const orderItems = await db.all(
            'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
            [req.params.id]
        );
        
        for (const item of orderItems) {
            // Check if product still exists and has stock
            const product = await db.get(
                'SELECT * FROM products WHERE id = ? AND stock >= ?',
                [item.product_id, item.quantity]
            );
            
            if (product) {
                // Check if already in cart
                const existing = await db.get(
                    'SELECT * FROM cart WHERE user_id = ? AND product_id = ?',
                    [req.user.id, item.product_id]
                );
                
                if (existing) {
                    const newQuantity = existing.quantity + item.quantity;
                    if (newQuantity <= product.stock) {
                        await db.run(
                            'UPDATE cart SET quantity = ? WHERE id = ?',
                            [newQuantity, existing.id]
                        );
                    }
                } else {
                    await db.run(
                        'INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)',
                        [req.user.id, item.product_id, item.quantity]
                    );
                }
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Reorder error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Cancel order
app.post('/order/:id/cancel', ensureAuthenticated, async (req, res) => {
    try {
        const order = await db.get(
            'SELECT * FROM orders WHERE id = ? AND user_id = ? AND status = "pending"',
            [req.params.id, req.user.id]
        );
        
        if (!order) {
            return res.status(400).json({ error: 'Order cannot be cancelled' });
        }
        
        // Start transaction
        await db.run('BEGIN TRANSACTION');
        
        await db.run(
            'UPDATE orders SET status = "cancelled" WHERE id = ?',
            [req.params.id]
        );
        
        // Restore stock
        const orderItems = await db.all(
            'SELECT * FROM order_items WHERE order_id = ?',
            [req.params.id]
        );
        
        for (const item of orderItems) {
            await db.run(
                'UPDATE products SET stock = stock + ? WHERE id = ?',
                [item.quantity, item.product_id]
            );
        }
        
        await db.run('COMMIT');
        
        // Log cancellation
        await discordLogger.logOrderUpdate(req.user, order, 'pending', 'cancelled');
        
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
        
        // Mock tracking data - you can integrate with actual courier API
        const trackingStatus = [
            { status: 'Order Placed', date: order.created_at, completed: true },
            { status: 'Payment Confirmed', date: order.updated_at, completed: order.status !== 'pending' },
            { status: 'Processing', date: null, completed: order.status === 'processing' || order.status === 'shipped' || order.status === 'delivered' || order.status === 'completed' },
            { status: 'Shipped', date: null, completed: order.status === 'shipped' || order.status === 'delivered' || order.status === 'completed' },
            { status: 'Out for Delivery', date: null, completed: order.status === 'delivered' || order.status === 'completed' },
            { status: 'Delivered', date: null, completed: order.status === 'delivered' || order.status === 'completed' }
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

// ==================== ADMIN ROUTES ====================

// Admin dashboard
app.get('/admin', ensureAdmin, async (req, res) => {
    try {
        // Log admin login
        await discordLogger.logAdminLogin(req.user);

        const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
        const totalOrders = await db.get('SELECT COUNT(*) as count FROM orders');
        const totalProducts = await db.get('SELECT COUNT(*) as count FROM products');
        const totalRevenue = await db.get('SELECT SUM(total_amount) as total FROM orders WHERE status = "completed"');
        
        const recentOrders = await db.all(`
            SELECT o.*, u.username 
            FROM orders o 
            JOIN users u ON o.user_id = u.id 
            ORDER BY o.created_at DESC 
            LIMIT 10
        `);
        
        const recentUsers = await db.all(`
            SELECT * FROM users 
            ORDER BY created_at DESC 
            LIMIT 10
        `);

        const stats = {
            totalUsers,
            totalOrders,
            totalProducts,
            totalRevenue,
            recentOrders,
            recentUsers
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
                   (SELECT SUM(total_amount) FROM orders WHERE user_id = u.id AND status = 'completed') as total_spent
            FROM users u
            ORDER BY u.created_at DESC
        `);

        res.render('admin/users', { user: req.user, users });
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
        
        await db.run('UPDATE users SET is_banned = ? WHERE id = ?', [
            req.body.action === 'ban' ? 1 : 0,
            req.params.userId
        ]);

        // Log admin action
        await discordLogger.logAdminAction(
            req.user, 
            `${req.body.action === 'ban' ? 'Banned' : 'Unbanned'} user`,
            `User: ${targetUser.username} (${targetUser.discord_id})`
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Ban user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== FIXED ADMIN PRODUCTS ROUTE ====================
// Admin products page
app.get('/admin/products', ensureAdmin, async (req, res) => {
    try {
        const products = await db.all('SELECT * FROM products ORDER BY created_at DESC');
        
        // Get distinct categories and brands from database
        const categories = await db.all('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""');
        const brands = await db.all('SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != ""');
        
        // Default options if database has no categories/brands
        const defaultCategories = [
            { category: 'T-Shirts' },
            { category: 'Hoodies' },
            { category: 'Sports Wear' },
            { category: 'Esports' },
            { category: 'Sticker Printed' }
        ];
        
        const defaultBrands = [
            { brand: 'Adidas' },
            { brand: 'Puma' },
            { brand: 'Under Armour' },
            { brand: 'New Balance' },
            { brand: 'Custom' }
        ];
        
        res.render('admin/products', { 
            user: req.user, 
            products,
            categories: categories.length > 0 ? categories : defaultCategories,
            brands: brands.length > 0 ? brands : defaultBrands
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

        // Handle image upload
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

        const newProduct = { id: result.lastID, name, price, category };

        // Log product addition
        await discordLogger.logProductAdd(req.user, newProduct);
        await discordLogger.logAdminAction(req.user, 'Added product', `Product: ${name}`);

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

        // Log product edit
        await discordLogger.logProductEdit(req.user, { name, price }, 'Product details updated');
        await discordLogger.logAdminAction(req.user, 'Edited product', `Product: ${name}`);

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

        // Log product deletion
        await discordLogger.logProductDelete(req.user, product);
        await discordLogger.logAdminAction(req.user, 'Deleted product', `Product: ${product.name}`);

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
                   (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
            FROM orders o
            JOIN users u ON o.user_id = u.id
            ORDER BY o.created_at DESC
        `);

        res.render('admin/orders', { user: req.user, orders });
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

        await db.run('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
            [status, req.params.id]);

        // Log order status change
        await discordLogger.logOrderUpdate(req.user, order, oldStatus, status);
        await discordLogger.logAdminAction(req.user, 'Updated order status', 
            `Order ${order.order_number}: ${oldStatus} -> ${status}`);

        res.json({ success: true });
    } catch (error) {
        console.error('Update order status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Backup database
app.get('/admin/backup', ensureAdmin, async (req, res) => {
    try {
        const dbPath = path.join(__dirname, 'website.db');
        const backupPath = path.join(__dirname, `backup_${Date.now()}.db`);
        
        // Copy database file
        fs.copyFileSync(dbPath, backupPath);
        
        const stats = fs.statSync(backupPath);
        
        // Log backup
        await discordLogger.logBackup(req.user, path.basename(backupPath), stats.size);
        await discordLogger.logAdminAction(req.user, 'Created backup', `Backup file: ${path.basename(backupPath)}`);

        res.download(backupPath, 'website_backup.db', (err) => {
            // Delete backup file after download
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
        
        // Close current database connection
        await db.close();
        
        // Replace database file
        await file.mv(dbPath);
        
        // Reopen database
        db = await setupDatabase();

        await discordLogger.logAdminAction(req.user, 'Restored database', 'Database restored from backup');

        res.json({ success: true, message: 'Database restored successfully' });
    } catch (error) {
        console.error('Restore error:', error);
        res.status(500).json({ error: 'Restore failed' });
    }
});

// ==================== API ROUTES ====================

// Search API
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        
        const products = await db.all(`
            SELECT * FROM products 
            WHERE name LIKE ? OR description LIKE ? 
            LIMIT 10
        `, [`%${q}%`, `%${q}%`]);
        
        res.json(products);
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
        
        const products = await db.all(
            'SELECT * FROM products ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [limit, offset]
        );
        
        res.json({ products });
    } catch (error) {
        console.error('Products API error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== AUTH ROUTES ====================

// Discord login
app.get('/auth/discord', passport.authenticate('discord'));

// Discord callback
app.get('/auth/discord/callback', 
    passport.authenticate('discord', { 
        failureRedirect: '/',
        failureMessage: true 
    }),
    async (req, res) => {
        // Log login
        await discordLogger.logLogin(req.user, req.ip);
        res.redirect('/');
    }
);

// Logout
app.get('/logout', (req, res, next) => {
    req.logout(function(err) {
        if (err) { return next(err); }
        res.redirect('/');
    });
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
    res.status(404).render('error', { 
        message: 'Page not found',
        user: req.user || null
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    discordLogger.logError(err, { location: req.path, user: req.user });
    res.status(500).render('error', { 
        message: 'Something went wrong!',
        user: req.user || null
    });
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    discordLogger.logSystem(`Server started on port ${PORT}`, 'info');
});

module.exports = app;
