const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

async function setupDatabase() {
    const db = await open({
        filename: path.join(__dirname, 'website.db'),
        driver: sqlite3.Database
    });

    // Create tables
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_id TEXT UNIQUE,
            username TEXT,
            email TEXT,
            avatar TEXT,
            is_admin BOOLEAN DEFAULT 0,
            is_banned BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME
        );

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

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            brand TEXT
        );

        CREATE TABLE IF NOT EXISTS cart (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            product_id INTEGER,
            quantity INTEGER DEFAULT 1,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_id INTEGER,
            quantity INTEGER,
            price DECIMAL(10,2),
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            user_id INTEGER,
            amount DECIMAL(10,2),
            payment_method TEXT,
            payment_proof TEXT,
            status TEXT,
            transaction_id TEXT,
            upi_transaction_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS user_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            details TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- Insert sample categories and brands
        INSERT OR IGNORE INTO categories (name, brand) VALUES 
            ('T-Shirts', 'Adidas'),
            ('T-Shirts', 'Puma'),
            ('T-Shirts', 'Under Armour'),
            ('T-Shirts', 'New Balance'),
            ('Hoodies', 'Adidas'),
            ('Hoodies', 'Puma'),
            ('Hoodies', 'Under Armour'),
            ('Hoodies', 'New Balance'),
            ('Sports Wear', 'Adidas'),
            ('Sports Wear', 'Puma'),
            ('Sports Wear', 'Under Armour'),
            ('Sports Wear', 'New Balance'),
            ('Esports', 'Custom'),
            ('Sticker Printed', 'Custom');
    `);

    // Check if phone column exists in orders table, if not add it
    const tableInfo = await db.all("PRAGMA table_info(orders)");
    const hasPhone = tableInfo.some(col => col.name === 'phone');
    
    if (!hasPhone) {
        await db.exec("ALTER TABLE orders ADD COLUMN phone TEXT;");
        console.log('Added phone column to orders table');
    }

    // Check if upi_transaction_id column exists in payments table
    const paymentsInfo = await db.all("PRAGMA table_info(payments)");
    const hasUpiTxnId = paymentsInfo.some(col => col.name === 'upi_transaction_id');
    
    if (!hasUpiTxnId) {
        await db.exec("ALTER TABLE payments ADD COLUMN upi_transaction_id TEXT;");
        console.log('Added upi_transaction_id column to payments table');
    }

    // Insert sample products
    const sampleProducts = [
        // Adidas Products
        ['Adidas Essential T-Shirt', 'Classic adidas t-shirt for everyday wear', 29.99, 'T-Shirts', 'Adidas', '/images/adidas-tshirt.jpg', 50],
        ['Adidas Response T-Shirt', 'Performance fit training t-shirt', 34.99, 'T-Shirts', 'Adidas', '/images/adidas-response.jpg', 45],
        ['Adidas Sport Hoodie', 'Comfortable hoodie for training', 59.99, 'Hoodies', 'Adidas', '/images/adidas-hoodie.jpg', 30],
        ['Adidas Running Shorts', 'Lightweight running shorts', 24.99, 'Sports Wear', 'Adidas', '/images/adidas-shorts.jpg', 40],
        
        // Puma Products
        ['Puma Essential Tee', 'Soft cotton t-shirt', 24.99, 'T-Shirts', 'Puma', '/images/puma-tee.jpg', 60],
        ['Puma Training Tee', 'DryCELL moisture-wicking technology', 32.99, 'T-Shirts', 'Puma', '/images/puma-training.jpg', 55],
        ['Puma Hoodie', 'Classic puma hoodie', 54.99, 'Hoodies', 'Puma', '/images/puma-hoodie.jpg', 35],
        ['Puma Running Shoes', 'Lightweight running shoes', 79.99, 'Sports Wear', 'Puma', '/images/puma-shoes.jpg', 25],
        
        // Under Armour Products
        ['UA Tech T-Shirt', 'Soft, anti-pill technology', 27.99, 'T-Shirts', 'Under Armour', '/images/ua-tech.jpg', 70],
        ['UA HeatGear Tee', 'Compression fit training shirt', 34.99, 'T-Shirts', 'Under Armour', '/images/ua-heatgear.jpg', 48],
        ['UA Storm Hoodie', 'Water-resistant hoodie', 64.99, 'Hoodies', 'Under Armour', '/images/ua-hoodie.jpg', 32],
        ['UA Running Leggings', 'High-rise training leggings', 44.99, 'Sports Wear', 'Under Armour', '/images/ua-leggings.jpg', 28],
        
        // New Balance Products
        ['NB Classics Tee', 'Retro style t-shirt', 26.99, 'T-Shirts', 'New Balance', '/images/nb-classic.jpg', 62],
        ['NB Impact Tee', 'NB DRY moisture-wicking', 32.99, 'T-Shirts', 'New Balance', '/images/nb-impact.jpg', 53],
        ['NB Hoodie', 'French terry hoodie', 57.99, 'Hoodies', 'New Balance', '/images/nb-hoodie.jpg', 38],
        ['NB Running Shorts', 'NB ICE quick-dry', 29.99, 'Sports Wear', 'New Balance', '/images/nb-shorts.jpg', 42],
        
        // Custom/Esports Products
        ['Hammper Style Hoodie', 'Premium oversized hoodie like Hammper', 49.99, 'Hoodies', 'Custom', '/images/hammper-hoodie.jpg', 25],
        ['Esports Jersey Pro', 'Professional esports jersey with custom printing', 44.99, 'Esports', 'Custom', '/images/esports-jersey.jpg', 30],
        ['Sticker Print Tee', 'Custom sticker printed t-shirt', 34.99, 'Sticker Printed', 'Custom', '/images/sticker-tee.jpg', 40],
        ['Gaming Team Hoodie', 'Esports team edition hoodie', 59.99, 'Esports', 'Custom', '/images/gaming-hoodie.jpg', 20],
        ['Hammper Style Tee', 'Oversized t-shirt like Hammper', 39.99, 'T-Shirts', 'Custom', '/images/hammper-tee.jpg', 35],
        ['Sticker Bomb Tee', 'Full print sticker style t-shirt', 44.99, 'Sticker Printed', 'Custom', '/images/sticker-bomb.jpg', 28],
        ['Pro Gaming Tee', 'Breathable esports t-shirt', 37.99, 'Esports', 'Custom', '/images/pro-gaming.jpg', 45],
        ['Custom Print Hoodie', 'Your design printed on hoodie', 54.99, 'Hoodies', 'Custom', '/images/custom-hoodie.jpg', 22]
    ];

    for (const product of sampleProducts) {
        await db.run(
            'INSERT OR IGNORE INTO products (name, description, price, category, brand, image_url, stock) VALUES (?, ?, ?, ?, ?, ?, ?)',
            product
        );
    }

    return db;
}

module.exports = { setupDatabase };
