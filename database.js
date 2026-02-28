const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

async function setupDatabase() {
    const db = await open({
        filename: path.join(__dirname, 'website.db'),
        driver: sqlite3.Database
    });

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
            upi_transaction_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS user_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);

    // Check if phone column exists
    const tableInfo = await db.all("PRAGMA table_info(orders)");
    const hasPhone = tableInfo.some(col => col.name === 'phone');
    if (!hasPhone) {
        await db.exec("ALTER TABLE orders ADD COLUMN phone TEXT;");
    }

    // Insert sample products if none exist
    const productCount = await db.get('SELECT COUNT(*) as count FROM products');
    if (productCount.count === 0) {
        const sampleProducts = [
            ['Adidas Essential T-Shirt', 'Classic adidas t-shirt', 29.99, 'T-Shirts', 'Adidas', '/images/default-product.jpg', 50],
            ['Adidas Response T-Shirt', 'Performance fit', 34.99, 'T-Shirts', 'Adidas', '/images/default-product.jpg', 45],
            ['Adidas Sport Hoodie', 'Comfortable hoodie', 59.99, 'Hoodies', 'Adidas', '/images/default-product.jpg', 30],
            ['Adidas Running Shorts', 'Lightweight shorts', 24.99, 'Sports Wear', 'Adidas', '/images/default-product.jpg', 40],
            ['Puma Essential Tee', 'Soft cotton', 24.99, 'T-Shirts', 'Puma', '/images/default-product.jpg', 60],
            ['Puma Training Tee', 'DryCELL tech', 32.99, 'T-Shirts', 'Puma', '/images/default-product.jpg', 55],
            ['Puma Hoodie', 'Classic hoodie', 54.99, 'Hoodies', 'Puma', '/images/default-product.jpg', 35],
            ['Puma Running Shoes', 'Lightweight shoes', 79.99, 'Sports Wear', 'Puma', '/images/default-product.jpg', 25],
            ['UA Tech T-Shirt', 'Anti-pill fabric', 27.99, 'T-Shirts', 'Under Armour', '/images/default-product.jpg', 70],
            ['UA HeatGear Tee', 'Compression fit', 34.99, 'T-Shirts', 'Under Armour', '/images/default-product.jpg', 48],
            ['UA Storm Hoodie', 'Water-resistant', 64.99, 'Hoodies', 'Under Armour', '/images/default-product.jpg', 32],
            ['UA Running Leggings', 'High-rise', 44.99, 'Sports Wear', 'Under Armour', '/images/default-product.jpg', 28],
            ['NB Classics Tee', 'Retro style', 26.99, 'T-Shirts', 'New Balance', '/images/default-product.jpg', 62],
            ['NB Impact Tee', 'NB DRY tech', 32.99, 'T-Shirts', 'New Balance', '/images/default-product.jpg', 53],
            ['NB Hoodie', 'French terry', 57.99, 'Hoodies', 'New Balance', '/images/default-product.jpg', 38],
            ['NB Running Shorts', 'NB ICE quick-dry', 29.99, 'Sports Wear', 'New Balance', '/images/default-product.jpg', 42],
            ['Hammper Style Hoodie', 'Oversized hoodie', 49.99, 'Hoodies', 'Custom', '/images/default-product.jpg', 25],
            ['Esports Jersey Pro', 'Pro esports jersey', 44.99, 'Esports', 'Custom', '/images/default-product.jpg', 30],
            ['Sticker Print Tee', 'Sticker printed', 34.99, 'Sticker Printed', 'Custom', '/images/default-product.jpg', 40],
            ['Gaming Team Hoodie', 'Team edition', 59.99, 'Esports', 'Custom', '/images/default-product.jpg', 20],
            ['Hammper Style Tee', 'Oversized tee', 39.99, 'T-Shirts', 'Custom', '/images/default-product.jpg', 35],
            ['Sticker Bomb Tee', 'Full print', 44.99, 'Sticker Printed', 'Custom', '/images/default-product.jpg', 28],
            ['Pro Gaming Tee', 'Breathable', 37.99, 'Esports', 'Custom', '/images/default-product.jpg', 45],
            ['Custom Print Hoodie', 'Your design', 54.99, 'Hoodies', 'Custom', '/images/default-product.jpg', 22]
        ];

        for (const product of sampleProducts) {
            await db.run(
                'INSERT INTO products (name, description, price, category, brand, image_url, stock) VALUES (?, ?, ?, ?, ?, ?, ?)',
                product
            );
        }
        console.log('✅ Sample products added');
    }

    return db;
}

module.exports = { setupDatabase };
