require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'clean_service_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function updateSchema() {
    try {
        console.log('Connecting to database...');
        const connection = await pool.getConnection();
        console.log('Connected.');

        const columnsToAdd = [
            "ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'سنوية'",
            "ADD COLUMN IF NOT EXISTS duration VARCHAR(50) DEFAULT 'سنوي'",
            "ADD COLUMN IF NOT EXISTS first_party VARCHAR(255) DEFAULT 'شركة بفت للمقاولات'",
            "ADD COLUMN IF NOT EXISTS second_party VARCHAR(255)",
            "ADD COLUMN IF NOT EXISTS client_phone VARCHAR(50)"
        ];

        for (const col of columnsToAdd) {
            try {
                console.log(`Executing: ALTER TABLE contracts ${col}`);
                await connection.query(`ALTER TABLE contracts ${col}`);
                console.log('Success.');
            } catch (err) {
                console.error(`Error adding column: ${err.message}`);
            }
        }

        console.log('Schema update complete.');
        connection.release();
        process.exit(0);
    } catch (err) {
        console.error('Fatal error:', err);
        process.exit(1);
    }
}

updateSchema();
