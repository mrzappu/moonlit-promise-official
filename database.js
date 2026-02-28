const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const bcrypt = require('bcrypt');

async function setupDatabase() {
    const db = await open({
        filename: path.join(__dirname, 'website.db'),
        driver: sqlite3.Database
    });

    // Enable foreign keys
    await db.exec('PRAGMA foreign_keys = ON;');

    // Create tables
    await db.exec(`
        -- Users table with local auth support
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_id TEXT UNIQUE,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            phone TEXT,
            avatar TEXT,
            is_admin BOOLEAN DEFAULT 0,
            is_banned BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME,
            login_attempts INTEGER DEFAULT 0,
            locked_until DATETIME
        );

        -- Products table
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            price DECIMAL(10,2) NOT NULL,
            category TEXT,
            brand TEXT,
            image_url TEXT,
            stock INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Categories table
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            brand TEXT
        );

        -- Cart table
        CREATE TABLE IF NOT EXISTS cart (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            product_id INTEGER,
            quantity INTEGER DEFAULT 1,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        -- Orders table with full details
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            order_number TEXT UNIQUE,
            total_amount DECIMAL(10,2),
            status TEXT DEFAULT 'pending',
            payment_method TEXT,
            payment_proof TEXT,
            shipping_address TEXT,
            phone TEXT,
            city TEXT,
            pincode TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Order items table
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_id INTEGER,
            quantity INTEGER,
            price DECIMAL(10,2),
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        -- Payments table
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            user_id INTEGER,
            amount DECIMAL(10,2),
            payment_method TEXT,
            payment_proof TEXT,
            status TEXT DEFAULT 'pending',
            upi_transaction_id TEXT,
            transaction_reference TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- User activity logging
        CREATE TABLE IF NOT EXISTS user_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            ip_address TEXT,
            user_agent TEXT,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Password reset tokens
        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            token TEXT UNIQUE,
            expires_at DATETIME,
            used BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Wishlist table
        CREATE TABLE IF NOT EXISTS wishlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            product_id INTEGER,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            UNIQUE(user_id, product_id)
        );

        -- Reviews table
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            product_id INTEGER,
            rating INTEGER CHECK (rating >= 1 AND rating <= 5),
            comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        -- Coupons table
        CREATE TABLE IF NOT EXISTS coupons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE,
            discount_type TEXT CHECK (discount_type IN ('percentage', 'fixed')),
            discount_value DECIMAL(10,2),
            min_order_amount DECIMAL(10,2),
            max_discount DECIMAL(10,2),
            valid_from DATETIME,
            valid_until DATETIME,
            usage_limit INTEGER,
            used_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Check and add missing columns to users table
    const userTableInfo = await db.all("PRAGMA table_info(users)");
    const userColumns = userTableInfo.map(col => col.name);
    
    if (!userColumns.includes('login_attempts')) {
        await db.exec("ALTER TABLE users ADD COLUMN login_attempts INTEGER DEFAULT 0;");
    }
    if (!userColumns.includes('locked_until')) {
        await db.exec("ALTER TABLE users ADD COLUMN locked_until DATETIME;");
    }
    if (!userColumns.includes('phone')) {
        await db.exec("ALTER TABLE users ADD COLUMN phone TEXT;");
    }

    // Check and add missing columns to orders table
    const orderTableInfo = await db.all("PRAGMA table_info(orders)");
    const orderColumns = orderTableInfo.map(col => col.name);
    
    if (!orderColumns.includes('city')) {
        await db.exec("ALTER TABLE orders ADD COLUMN city TEXT;");
    }
    if (!orderColumns.includes('pincode')) {
        await db.exec("ALTER TABLE orders ADD COLUMN pincode TEXT;");
    }
    if (!orderColumns.includes('notes')) {
        await db.exec("ALTER TABLE orders ADD COLUMN notes TEXT;");
    }

    // Check and add missing columns to user_activity table
    const activityTableInfo = await db.all("PRAGMA table_info(user_activity)");
    const activityColumns = activityTableInfo.map(col => col.name);
    
    if (!activityColumns.includes('user_agent')) {
        await db.exec("ALTER TABLE user_activity ADD COLUMN user_agent TEXT;");
    }
    if (!activityColumns.includes('details')) {
        await db.exec("ALTER TABLE user_activity ADD COLUMN details TEXT;");
    }

    // Insert default categories if none exist
    const categoryCount = await db.get('SELECT COUNT(*) as count FROM categories');
    if (categoryCount.count === 0) {
        const defaultCategories = [
            ['T-Shirts', 'Adidas'],
            ['T-Shirts', 'Puma'],
            ['T-Shirts', 'Under Armour'],
            ['T-Shirts', 'New Balance'],
            ['Hoodies', 'Adidas'],
            ['Hoodies', 'Puma'],
            ['Hoodies', 'Under Armour'],
            ['Hoodies', 'New Balance'],
            ['Sports Wear', 'Adidas'],
            ['Sports Wear', 'Puma'],
            ['Sports Wear', 'Under Armour'],
            ['Sports Wear', 'New Balance'],
            ['Esports', 'Custom'],
            ['Sticker Printed', 'Custom']
        ];

        for (const cat of defaultCategories) {
            await db.run(
                'INSERT INTO categories (name, brand) VALUES (?, ?)',
                cat
            );
        }
        console.log('✅ Default categories added');
    }

    // Insert sample products if none exist
    const productCount = await db.get('SELECT COUNT(*) as count FROM products');
    if (productCount.count === 0) {
        const sampleProducts = [
            // Adidas Products
            ['Adidas Essential T-Shirt', 'Classic adidas t-shirt for everyday wear. Made with soft cotton fabric for maximum comfort.', 29.99, 'T-Shirts', 'Adidas', '/images/adidas-tshirt.jpg', 50],
            ['Adidas Response T-Shirt', 'Performance fit training t-shirt with moisture-wicking technology.', 34.99, 'T-Shirts', 'Adidas', '/images/adidas-response.jpg', 45],
            ['Adidas Sport Hoodie', 'Comfortable hoodie for training and casual wear. Features kangaroo pocket.', 59.99, 'Hoodies', 'Adidas', '/images/adidas-hoodie.jpg', 30],
            ['Adidas Running Shorts', 'Lightweight running shorts with built-in briefs.', 24.99, 'Sports Wear', 'Adidas', '/images/adidas-shorts.jpg', 40],
            
            // Puma Products
            ['Puma Essential Tee', 'Soft cotton t-shirt with classic Puma logo.', 24.99, 'T-Shirts', 'Puma', '/images/puma-tee.jpg', 60],
            ['Puma Training Tee', 'DryCELL moisture-wicking technology keeps you dry.', 32.99, 'T-Shirts', 'Puma', '/images/puma-training.jpg', 55],
            ['Puma Hoodie', 'Classic puma hoodie with drawstring hood.', 54.99, 'Hoodies', 'Puma', '/images/puma-hoodie.jpg', 35],
            ['Puma Running Shoes', 'Lightweight running shoes with cushioned sole.', 79.99, 'Sports Wear', 'Puma', '/images/puma-shoes.jpg', 25],
            
            // Under Armour Products
            ['UA Tech T-Shirt', 'Soft, anti-pill technology with UA Tech fabric.', 27.99, 'T-Shirts', 'Under Armour', '/images/ua-tech.jpg', 70],
            ['UA HeatGear Tee', 'Compression fit training shirt with HeatGear fabric.', 34.99, 'T-Shirts', 'Under Armour', '/images/ua-heatgear.jpg', 48],
            ['UA Storm Hoodie', 'Water-resistant hoodie with UA Storm technology.', 64.99, 'Hoodies', 'Under Armour', '/images/ua-hoodie.jpg', 32],
            ['UA Running Leggings', 'High-rise training leggings with anti-odor technology.', 44.99, 'Sports Wear', 'Under Armour', '/images/ua-leggings.jpg', 28],
            
            // New Balance Products
            ['NB Classics Tee', 'Retro style t-shirt with New Balance heritage logo.', 26.99, 'T-Shirts', 'New Balance', '/images/nb-classic.jpg', 62],
            ['NB Impact Tee', 'NB DRY moisture-wicking technology for training.', 32.99, 'T-Shirts', 'New Balance', '/images/nb-impact.jpg', 53],
            ['NB Hoodie', 'French terry hoodie with cozy fleece lining.', 57.99, 'Hoodies', 'New Balance', '/images/nb-hoodie.jpg', 38],
            ['NB Running Shorts', 'NB ICE quick-dry shorts for running.', 29.99, 'Sports Wear', 'New Balance', '/images/nb-shorts.jpg', 42],
            
            // Custom/Esports Products
            ['Hammper Style Hoodie', 'Premium oversized hoodie like Hammper. Ultra-soft fabric with oversized fit.', 49.99, 'Hoodies', 'Custom', '/images/hammper-hoodie.jpg', 25],
            ['Esports Jersey Pro', 'Professional esports jersey with custom printing. Breathable mesh fabric.', 44.99, 'Esports', 'Custom', '/images/esports-jersey.jpg', 30],
            ['Sticker Print Tee', 'Custom sticker printed t-shirt. Choose your favorite stickers.', 34.99, 'Sticker Printed', 'Custom', '/images/sticker-tee.jpg', 40],
            ['Gaming Team Hoodie', 'Esports team edition hoodie with custom team logo.', 59.99, 'Esports', 'Custom', '/images/gaming-hoodie.jpg', 20],
            ['Hammper Style Tee', 'Oversized t-shirt like Hammper with dropped shoulders.', 39.99, 'T-Shirts', 'Custom', '/images/hammper-tee.jpg', 35],
            ['Sticker Bomb Tee', 'Full print sticker style t-shirt with random sticker design.', 44.99, 'Sticker Printed', 'Custom', '/images/sticker-bomb.jpg', 28],
            ['Pro Gaming Tee', 'Breathable esports t-shirt with moisture-wicking fabric.', 37.99, 'Esports', 'Custom', '/images/pro-gaming.jpg', 45],
            ['Custom Print Hoodie', 'Your design printed on premium hoodie.', 54.99, 'Hoodies', 'Custom', '/images/custom-hoodie.jpg', 22]
        ];

        for (const product of sampleProducts) {
            await db.run(
                'INSERT INTO products (name, description, price, category, brand, image_url, stock) VALUES (?, ?, ?, ?, ?, ?, ?)',
                product
            );
        }
        console.log('✅ Sample products added');
    }

    // Insert sample coupons
    const couponCount = await db.get('SELECT COUNT(*) as count FROM coupons');
    if (couponCount.count === 0) {
        const sampleCoupons = [
            ['WELCOME10', 'percentage', 10, 0, 100, date('now'), date('now', '+30 days'), 100],
            ['SAVE20', 'percentage', 20, 500, 200, date('now'), date('now', '+30 days'), 50],
            ['FREESHIP', 'fixed', 50, 0, 50, date('now'), date('now', '+30 days'), 200],
            ['SUMMER25', 'percentage', 25, 1000, 300, date('now'), date('now', '+60 days'), 100],
            ['FLASH50', 'percentage', 50, 2000, 500, date('now'), date('now', '+7 days'), 20]
        ];

        for (const coupon of sampleCoupons) {
            await db.run(
                'INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_discount, valid_from, valid_until, usage_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                coupon
            );
        }
        console.log('✅ Sample coupons added');
    }

    // Create default admin user if none exists
    const adminCount = await db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1');
    if (adminCount.count === 0) {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        
        await db.run(
            'INSERT INTO users (username, email, password, is_admin) VALUES (?, ?, ?, ?)',
            ['admin', 'admin@sportswear.com', hashedPassword, 1]
        );
        console.log('✅ Default admin user created (username: admin, password: admin123)');
    }

    // Create indexes for better performance
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
        CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
        CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
        CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
        CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_user_activity_user_id ON user_activity(user_id);
        CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
        CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
    `);

    console.log('✅ Database setup complete');
    return db;
}

module.exports = { setupDatabase };
