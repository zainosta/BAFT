// create_admin.js
// Usage: copy .env.example -> .env and fill DB credentials then run: npm run create-admin
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
  const adminUser = {
    username: 'admin',
    password: 'admin123', // change after first login
    display_name: 'المدير العام'
  };

  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    const hash = await bcrypt.hash(adminUser.password, 10);

    const [exists] = await conn.execute('SELECT id FROM users WHERE username = ?', [adminUser.username]);
    if (exists.length) {
      console.log('Admin user already exists. Skipping creation.');
      await conn.end();
      process.exit(0);
    }

    const [result] = await conn.execute(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)',
      [adminUser.username, hash, 'admin', adminUser.display_name]
    );
    console.log('Admin user created with id:', result.insertId);
    console.log('Username: admin');
    console.log('Password:', adminUser.password);
    await conn.end();
  } catch (err) {
    console.error('Error creating admin user:', err.message);
    process.exit(1);
  }
})();