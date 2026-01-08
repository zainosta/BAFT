require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Real-time Socket logic
const connectedUsers = new Map(); // username -> Set of socketIds

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('register', (username) => {
        if (username) {
            if (!connectedUsers.has(username)) {
                connectedUsers.set(username, new Set());
            }
            connectedUsers.get(username).add(socket.id);

            // Link socket to username for disconnect
            socket.currentUsername = username;

            io.emit('update-users', Array.from(connectedUsers.keys()));
            console.log(`User registered: ${username} (Socket: ${socket.id}, Total Sockets: ${connectedUsers.get(username).size})`);
        }
    });

    socket.on('request-users', () => {
        socket.emit('update-users', Array.from(connectedUsers.keys()));
    });

    socket.on('send-notification', (data) => {
        // data: { targetUser, priority, duration, senderName, message }
        console.log(`Notification from ${data.senderName} to ${data.targetUser}: ${data.message}`);

        const targetSockets = connectedUsers.get(data.targetUser);
        if (targetSockets && targetSockets.size > 0) {
            targetSockets.forEach(socketId => {
                io.to(socketId).emit('receive-notification', data);
            });
        } else {
            console.log(`Target user ${data.targetUser} not found or offline.`);
        }
    });

    socket.on('logout', () => {
        const username = socket.currentUsername;
        if (username && connectedUsers.has(username)) {
            const userSockets = connectedUsers.get(username);
            userSockets.delete(socket.id);
            if (userSockets.size === 0) {
                connectedUsers.delete(username);
                console.log(`User logged out: ${username}`);
            }
            io.emit('update-users', Array.from(connectedUsers.keys()));
        }
    });

    socket.on('disconnect', () => {
        const username = socket.currentUsername;
        if (username && connectedUsers.has(username)) {
            const userSockets = connectedUsers.get(username);
            userSockets.delete(socket.id);

            if (userSockets.size === 0) {
                connectedUsers.delete(username);
                console.log(`User completely offline: ${username}`);
            } else {
                console.log(`User ${username} closed one tab. (${userSockets.size} remaining)`);
            }
            io.emit('update-users', Array.from(connectedUsers.keys()));
        }
    });
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // Increased limit for PDF upload
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'clean_service_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true // Fix for -1 day issue (return dates as strings)
});

// Multer for uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Multer for contract attachments (dynamic directory per contract)
const createAttachmentStorage = (contractId) => {
    return multer.diskStorage({
        destination: function (req, file, cb) {
            const dir = path.join('uploads', 'contracts', contractId);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            cb(null, dir);
        },
        filename: function (req, file, cb) {
            const ext = path.extname(file.originalname);
            const fieldName = req.body.fieldName || file.fieldname || 'attachment';
            cb(null, `${fieldName}_${Date.now()}${ext}`);
        }
    });
};

const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        }
        cb(new Error('Only images (JPEG, PNG, GIF) and PDF files are allowed'));
    }
});

// Auth Middleware
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    // 1. Try JWT
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (!err) {
            req.user = user;
            return next();
        }

        // 2. Try Signing Token (Base64: ContractID:Email/Token)
        try {
            const decoded = Buffer.from(token, 'base64').toString('utf-8');
            // Expected format: ContractID:Something
            if (decoded.includes(':')) {
                const [contractId, email] = decoded.split(':');
                // Basic validation: Must look like a contract ID
                if (contractId && (contractId.startsWith('CN-') || contractId.includes('-'))) {
                    req.user = { role: 'signer', id: contractId };
                    return next();
                }
            }
        } catch (e) {
            // ignore
        }

        return res.status(403).json({ message: 'Forbidden' });
    });
};

// Role Check Middleware
const roleCheck = (roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Access denied' });
        }
        next();
    };
};

// --- Routes ---

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
        const user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Force 'admin' role for the main admin user (Fix for legacy schema or missing role)
        if (user.username === 'admin') {
            user.role = 'admin';
        }

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name } });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Users (List) - Admin Only
app.get('/api/users', authMiddleware, roleCheck(['admin']), async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id, username, role, display_name, created_at FROM users ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Users (Create)
app.post('/api/users', async (req, res) => {
    const { username, password, role, display_name } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.execute('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)', [username, hash, role, display_name]);
        res.json({ message: 'User created' });
    } catch (err) {
        // Self-healing: Catch "Data truncated" (Code 1265) or generic string error
        if (err.message.includes('truncated') || err.message.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') {
            console.log('Detected truncation error. Attempting to fix "role" column schema...');
            try {
                await pool.execute("ALTER TABLE users MODIFY COLUMN role VARCHAR(255) DEFAULT 'staff'");
                console.log('Schema fixed. Retrying insert...');
                const hash = await bcrypt.hash(password, 10);
                await pool.execute('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)', [username, hash, role, display_name]);
                return res.json({ message: 'User created (after schema fix)' });
            } catch (fixErr) {
                console.error('Failed to fix schema or retry:', fixErr);
                return res.status(500).json({ message: 'Failed to fix database schema: ' + fixErr.message });
            }
        }
        console.error('Create user error:', err);
        res.status(500).json({ message: err.message });
    }
});

// DEBUG: Reset Users Table (Forcing schema fix via DROP/CREATE)
// Only callable if you are logged in as admin (which we fixed above)
app.post('/api/debug/reset-users', authMiddleware, roleCheck(['admin']), async (req, res) => {
    try {
        console.log('RESETTING USERS TABLE...');
        await pool.execute('DROP TABLE IF EXISTS users');
        await pool.execute(`
            CREATE TABLE users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(255) DEFAULT 'staff',
                display_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Re-create default admin
        const hash = await bcrypt.hash('admin123', 10);
        await pool.execute("INSERT INTO users (username, password_hash, role, display_name) VALUES ('admin', ?, 'admin', 'System Admin')", [hash]);

        res.json({ message: 'Users table reset successfully. Default admin restored.' });
    } catch (err) {
        console.error('Reset table error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Users (Delete) - Admin Only
app.delete('/api/users/:id', authMiddleware, roleCheck(['admin']), async (req, res) => {
    try {
        const [result] = await pool.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Clients (Create/Get)
app.post('/api/clients', authMiddleware, async (req, res) => {
    const { name, type, city, district } = req.body;
    try {
        // Check if exists
        const [existing] = await pool.execute('SELECT id FROM clients WHERE name = ?', [name]);
        if (existing.length > 0) return res.json({ id: existing[0].id });

        const [result] = await pool.execute('INSERT INTO clients (name, type, city, district) VALUES (?, ?, ?, ?)', [name, type, city, district]);
        res.json({ id: result.insertId });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/clients/:id', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM clients WHERE id = ?', [req.params.id]);
        res.json(rows[0] || {});
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Services
app.get('/api/services', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM services');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- CONTRACTS ---

// Helper to get available columns
let availableColumns = [];
async function getColumns() {
    try {
        const [rows] = await pool.execute('SHOW COLUMNS FROM contracts');
        availableColumns = rows.map(r => r.Field);
        console.log('Available columns:', availableColumns);
    } catch (e) {
        console.error('Error fetching columns:', e);
    }
}

// GET Contracts (Search & Filter)
app.get('/api/contracts', authMiddleware, async (req, res) => {
    const { q, status } = req.query;

    // Dynamic selection based on available columns
    const cols = [
        'c.id', 'c.client_id', 'cl.name as client_name', 'c.service_name',
        'c.from_date', 'c.to_date', 'c.total_price', 'c.manager', 'c.status',
        'c.terms', 'c.sign_method', 'c.city', 'c.district', 'c.location',
        'c.monthly_fee', 'c.container_type', 'c.container_location', 'c.pickup_location'
    ];

    // Add optional columns if they exist
    if (availableColumns.includes('duration')) cols.push('c.duration');
    if (availableColumns.includes('payment_type')) cols.push('c.payment_type');
    if (availableColumns.includes('first_party')) cols.push('c.first_party');
    if (availableColumns.includes('second_party')) cols.push('c.second_party');
    if (availableColumns.includes('client_email')) cols.push('c.client_email');
    if (availableColumns.includes('client_phone')) cols.push('c.client_phone');
    if (availableColumns.includes('client_type')) cols.push('c.client_type');
    if (availableColumns.includes('collector')) cols.push('c.collector');
    if (availableColumns.includes('tax')) cols.push('c.tax');
    if (availableColumns.includes('parent_contract_id')) cols.push('c.parent_contract_id');
    let sql = `
    SELECT ${cols.join(', ')}
    FROM contracts c
    LEFT JOIN clients cl ON c.client_id = cl.id
    WHERE 1=1
  `;
    const params = [];

    if (status) {
        sql += ' AND c.status = ?';
        params.push(status);
    }

    if (q) {
        // Enhanced partial match on ID, Client Name, or second_party (for client filtering)
        if (availableColumns.includes('second_party')) {
            sql += ' AND (c.id LIKE ? OR cl.name LIKE ? OR c.second_party LIKE ?)';
            params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        } else {
            sql += ' AND (c.id LIKE ? OR cl.name LIKE ?)';
            params.push(`%${q}%`, `%${q}%`);
        }
    }

    // Smart sorting: If searching by client name, sort alphabetically by client name first
    // Otherwise sort by creation date
    if (q && q.trim().length > 0) {
        // When searching, prioritize alphabetical sorting by client name
        sql += ' ORDER BY c.second_party ASC, c.created_at DESC LIMIT 500';
    } else if (status) {
        // When filtering by status only, sort by date
        sql += ' ORDER BY c.created_at DESC LIMIT 100';
    } else {
        // Default: recent contracts first
        sql += ' ORDER BY c.created_at DESC LIMIT 100';
    }

    try {
        const [rows] = await pool.execute(sql, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// POST Contract
app.post('/api/contracts', authMiddleware, async (req, res) => {
    const data = req.body;

    if (!data.id) {
        const year = new Date().getFullYear();
        try {
            const [r] = await pool.execute(
                'SELECT MAX(CAST(SUBSTRING_INDEX(id, "-", -1) AS UNSIGNED)) as max_num FROM contracts WHERE id LIKE ?',
                [`CN-${year}-%`]
            );
            const nextNum = (r[0].max_num || 0) + 1;
            data.id = `CN-${year}-${nextNum}`;
        } catch (e) {
            data.id = `CN-${year}-${Date.now()}`;
        }
    }

    // Dynamic Insert
    const fields = [
        'id', 'client_id', 'service_name', 'from_date', 'to_date',
        'monthly_fee', 'total_price', 'manager', 'status',
        'terms', 'sign_method', 'city', 'district', 'location',
        'container_type', 'container_location', 'pickup_location'
    ];
    const values = [
        data.id, data.client_id, data.service_name, data.from_date || null, data.to_date || null,
        data.monthly_fee || 0, data.total_price || 0, data.manager, data.status || 'pending',
        data.terms, data.sign_method, data.city, data.district, data.location,
        data.container_type, data.container_location || null, data.pickup_location || null
    ];

    // Add optional fields if they exist in DB
    const optional = ['duration', 'payment_type', 'first_party', 'second_party', 'client_email', 'client_phone', 'client_type', 'collector', 'tax', 'parent_contract_id'];
    optional.forEach(f => {
        if (availableColumns.includes(f)) {
            fields.push(f);
            values.push(data[f] || null);
        }
    });

    const placeholders = fields.map(() => '?').join(', ');
    const sql = `INSERT INTO contracts (${fields.join(', ')}) VALUES (${placeholders})`;

    try {
        await pool.execute(sql, values);
        res.json({ message: 'Contract created', id: data.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// PUT Contract
app.put('/api/contracts/:id', authMiddleware, async (req, res) => {
    const id = req.params.id;
    const data = req.body;

    const fields = [];
    const params = [];

    const allowed = [
        'client_id', 'service_name', 'from_date', 'to_date',
        'monthly_fee', 'total_price', 'manager', 'status',
        'terms', 'sign_method', 'city', 'district', 'location',
        'container_type', 'container_location', 'pickup_location'
    ];

    // Add optional fields to allowed list if they exist
    const optional = ['duration', 'payment_type', 'first_party', 'second_party', 'client_email', 'client_phone', 'client_type', 'collector', 'tax', 'parent_contract_id'];
    optional.forEach(f => {
        if (availableColumns.includes(f)) allowed.push(f);
    });

    allowed.forEach(f => {
        if (data[f] !== undefined) {
            fields.push(`${f} = ?`);
            params.push(data[f] === '' ? null : data[f]);
        }
    });

    if (fields.length === 0) return res.json({ message: 'No changes' });

    const sql = `UPDATE contracts SET ${fields.join(', ')} WHERE id = ?`;
    params.push(id);

    try {
        await pool.execute(sql, params);
        res.json({ message: 'Contract updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// DELETE Contract
app.delete('/api/contracts/:id', authMiddleware, async (req, res) => {
    // Permission Check: Admin only
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Access denied: Admin role required to delete permissions' });
    }
    const id = req.params.id;

    try {
        // First delete related attachments
        await pool.execute('DELETE FROM contract_attachments WHERE contract_id = ?', [id]);

        // Then delete the contract
        const [result] = await pool.execute('DELETE FROM contracts WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Contract not found' });
        }

        // Delete uploaded files if they exist
        const contractDir = path.join(__dirname, 'uploads', 'contracts', id);
        if (fs.existsSync(contractDir)) {
            fs.rmSync(contractDir, { recursive: true, force: true });
            console.log(`Deleted contract directory: ${contractDir}`);
        }

        console.log(`✅ Contract ${id} deleted successfully`);
        res.json({ message: 'Contract deleted successfully', id });
    } catch (err) {
        console.error('Delete contract error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Export CSV
app.get('/api/contracts/export/csv', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM contracts');
        const fields = ['id', 'client_id', 'service_name', 'total_price', 'status', 'created_at'];
        const csv = [
            fields.join(','),
            ...rows.map(r => fields.map(f => JSON.stringify(r[f] || '')).join(','))
        ].join('\n');

        res.header('Content-Type', 'text/csv');
        res.attachment('contracts.csv');
        res.send(csv);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Terms API
app.get('/api/terms', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM terms ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/terms', authMiddleware, async (req, res) => {
    const { name, type, content } = req.body;
    try {
        const [resDb] = await pool.execute('INSERT INTO terms (name, type, content) VALUES (?, ?, ?)', [name, type, content]);
        res.json({ id: resDb.insertId, name, type, content });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.put('/api/terms/:id', authMiddleware, async (req, res) => {
    const { name, type, content } = req.body;
    try {
        await pool.execute('UPDATE terms SET name=?, type=?, content=? WHERE id=?', [name, type, content, req.params.id]);
        res.json({ id: req.params.id, name, type, content });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.delete('/api/terms/:id', authMiddleware, async (req, res) => {
    try {
        await pool.execute('DELETE FROM terms WHERE id=?', [req.params.id]);
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- Reports API ---

// Get list of all collectors with statistics
app.get('/api/reports/collectors', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT 
                collector,
                COUNT(*) as contract_count,
                SUM(total_price) as total_value,
                SUM(monthly_fee) as monthly_revenue,
                AVG(total_price) as avg_contract_value,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count
            FROM contracts
            WHERE collector IS NOT NULL AND collector != ''
            GROUP BY collector
            ORDER BY contract_count DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Collectors report error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Get detailed report for specific collector
app.get('/api/reports/collectors/:name', authMiddleware, async (req, res) => {
    try {
        const collectorName = decodeURIComponent(req.params.name);

        // Get statistics
        const [stats] = await pool.execute(`
            SELECT 
                COUNT(*) as total_contracts,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_contracts,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_contracts,
                SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_contracts,
                SUM(total_price) as total_value,
                SUM(monthly_fee) as monthly_revenue,
                AVG(total_price) as avg_contract_value
            FROM contracts
            WHERE collector = ?
        `, [collectorName]);

        // Get all contracts
        const cols = [
            'c.id', 'c.client_id', 'cl.name as client_name', 'c.second_party',
            'c.service_name', 'c.from_date', 'c.to_date', 'c.total_price',
            'c.monthly_fee', 'c.manager', 'c.collector', 'c.status',
            'c.city', 'c.district', 'c.container_type', 'c.client_phone'
        ];
        if (availableColumns.includes('duration')) cols.push('c.duration');
        if (availableColumns.includes('payment_type')) cols.push('c.payment_type');
        if (availableColumns.includes('tax')) cols.push('c.tax');

        const [contracts] = await pool.execute(`
            SELECT ${cols.join(', ')}
            FROM contracts c
            LEFT JOIN clients cl ON c.client_id = cl.id
            WHERE c.collector = ?
            ORDER BY c.created_at DESC
        `, [collectorName]);

        res.json({
            entityName: collectorName,
            entityType: 'collector',
            statistics: stats[0],
            contracts: contracts
        });
    } catch (err) {
        console.error('Collector detail report error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Get list of all marketers with statistics
app.get('/api/reports/marketers', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT 
                manager,
                COUNT(*) as contract_count,
                SUM(total_price) as total_value,
                SUM(monthly_fee) as monthly_revenue,
                AVG(total_price) as avg_contract_value,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count
            FROM contracts
            WHERE manager IS NOT NULL AND manager != ''
            GROUP BY manager
            ORDER BY contract_count DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Marketers report error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Get detailed report for specific marketer
app.get('/api/reports/marketers/:name', authMiddleware, async (req, res) => {
    try {
        const marketerName = decodeURIComponent(req.params.name);

        // Get statistics
        const [stats] = await pool.execute(`
            SELECT 
                COUNT(*) as total_contracts,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_contracts,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_contracts,
                SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_contracts,
                SUM(total_price) as total_value,
                SUM(monthly_fee) as monthly_revenue,
                AVG(total_price) as avg_contract_value
            FROM contracts
            WHERE manager = ?
        `, [marketerName]);

        // Get all contracts
        const cols = [
            'c.id', 'c.client_id', 'cl.name as client_name', 'c.second_party',
            'c.service_name', 'c.from_date', 'c.to_date', 'c.total_price',
            'c.monthly_fee', 'c.manager', 'c.collector', 'c.status',
            'c.city', 'c.district', 'c.container_type', 'c.client_phone'
        ];
        if (availableColumns.includes('duration')) cols.push('c.duration');
        if (availableColumns.includes('payment_type')) cols.push('c.payment_type');
        if (availableColumns.includes('tax')) cols.push('c.tax');

        const [contracts] = await pool.execute(`
            SELECT ${cols.join(', ')}
            FROM contracts c
            LEFT JOIN clients cl ON c.client_id = cl.id
            WHERE c.manager = ?
            ORDER BY c.created_at DESC
        `, [marketerName]);

        res.json({
            entityName: marketerName,
            entityType: 'marketer',
            statistics: stats[0],
            contracts: contracts
        });
    } catch (err) {
        console.error('Marketer detail report error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Get list of all clients/second parties with statistics
app.get('/api/reports/clients', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT 
                second_party,
                COUNT(*) as contract_count,
                SUM(total_price) as total_value,
                SUM(monthly_fee) as monthly_revenue,
                AVG(total_price) as avg_contract_value,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count
            FROM contracts
            WHERE second_party IS NOT NULL AND second_party != ''
            GROUP BY second_party
            ORDER BY contract_count DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Clients report error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Get detailed report for specific client/second party
app.get('/api/reports/clients/:name', authMiddleware, async (req, res) => {
    try {
        const clientName = decodeURIComponent(req.params.name);

        // Get statistics
        const [stats] = await pool.execute(`
            SELECT 
                COUNT(*) as total_contracts,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_contracts,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_contracts,
                SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_contracts,
                SUM(total_price) as total_value,
                SUM(monthly_fee) as monthly_revenue,
                AVG(total_price) as avg_contract_value
            FROM contracts
            WHERE second_party = ?
        `, [clientName]);

        // Get all contracts
        const cols = [
            'c.id', 'c.client_id', 'cl.name as client_name', 'c.second_party',
            'c.service_name', 'c.from_date', 'c.to_date', 'c.total_price',
            'c.monthly_fee', 'c.manager', 'c.collector', 'c.status',
            'c.city', 'c.district', 'c.container_type', 'c.client_phone'
        ];
        if (availableColumns.includes('duration')) cols.push('c.duration');
        if (availableColumns.includes('payment_type')) cols.push('c.payment_type');
        if (availableColumns.includes('tax')) cols.push('c.tax');

        const [contracts] = await pool.execute(`
            SELECT ${cols.join(', ')}
            FROM contracts c
            LEFT JOIN clients cl ON c.client_id = cl.id
            WHERE c.second_party = ?
            ORDER BY c.created_at DESC
        `, [clientName]);

        res.json({
            entityName: clientName,
            entityType: 'client',
            statistics: stats[0],
            contracts: contracts
        });
    } catch (err) {
        console.error('Client detail report error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Clients API
app.get('/api/clients', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM clients ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/clients', authMiddleware, async (req, res) => {
    const { id, name, type, city, district } = req.body;
    try {
        if (id) {
            // If ID is provided, insert with custom ID
            await pool.execute(
                'INSERT INTO clients (id, name, type, city, district) VALUES (?, ?, ?, ?, ?)',
                [id, name, type || 'فرد', city || null, district || null]
            );
            res.json({ id, name, type, city, district });
        } else {
            // Generate a unique string ID if not provided
            const generatedId = 'client-' + Date.now();
            await pool.execute(
                'INSERT INTO clients (id, name, type, city, district) VALUES (?, ?, ?, ?, ?)',
                [generatedId, name, type || 'فرد', city || null, district || null]
            );
            res.json({ id: generatedId, name, type, city, district });
        }
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.put('/api/clients/:id', authMiddleware, async (req, res) => {
    const { name, type, city, district } = req.body;
    try {
        await pool.execute(
            'UPDATE clients SET name=?, type=?, city=?, district=? WHERE id=?',
            [name, type || 'فرد', city || null, district || null, req.params.id]
        );
        res.json({ id: req.params.id, name, type, city, district });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.delete('/api/clients/:id', authMiddleware, async (req, res) => {
    try {
        await pool.execute('DELETE FROM clients WHERE id=?', [req.params.id]);
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- PDF Signing Features ---

// 1. Generate/Serve PDF Preview (Deprecated: Client-side generation used)
app.get('/api/contracts/:id/pdf-preview', (req, res) => {
    res.status(400).send('Please use client-side generation');
});

// 2. Process Signature (Upload Signed PDF)
const uploadMiddleware = (req, res, next) => {
    if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
        upload.single('signedPdf')(req, res, next);
    } else {
        next();
    }
};

app.post('/api/contracts/:id/sign', uploadMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        // Check if file was uploaded (multipart) or sent as base64 json
        let pdfBuffer;

        if (req.file) {
            pdfBuffer = fs.readFileSync(req.file.path);
            // Clean up temp file
            fs.unlinkSync(req.file.path);
        } else if (req.body.pdfBase64) {
            // Handle Base64 upload - Robust parsing
            try {
                const parts = req.body.pdfBase64.split(',');
                const base64Data = parts.length > 1 ? parts[1] : parts[0];
                pdfBuffer = Buffer.from(base64Data, 'base64');
                console.log(`PDF Buffer created, size: ${pdfBuffer.length} bytes`);
            } catch (e) {
                console.error('Base64 parsing error:', e);
                return res.status(400).json({ message: 'Invalid Base64 data' });
            }
        } else {
            return res.status(400).json({ message: 'No PDF provided' });
        }

        // Create contract directory if it doesn't exist
        const contractDir = path.join(__dirname, 'uploads', 'contracts', id);
        if (!fs.existsSync(contractDir)) {
            fs.mkdirSync(contractDir, { recursive: true });
            console.log(`Created contract directory: ${contractDir}`);
        }

        // Save the signed PDF to contract folder
        const signedFileName = `signed_${id}.pdf`;
        const contractPdfPath = path.join(contractDir, signedFileName);
        fs.writeFileSync(contractPdfPath, pdfBuffer);
        console.log(`✅ Signed PDF saved to contract folder: ${contractPdfPath}`);

        // Also save to uploads root for backward compatibility
        const rootPdfPath = path.join(__dirname, 'uploads', signedFileName);
        fs.writeFileSync(rootPdfPath, pdfBuffer);
        console.log(`✅ Signed PDF saved to uploads root: ${rootPdfPath}`);

        // Update Status
        // Use 'إلكتروني' to match the existing ENUM('إلكتروني','يدوي') in the database
        await pool.execute('UPDATE contracts SET status = "active", sign_method = "إلكتروني" WHERE id = ?', [id]);

        // Fetch contract for email
        const [rows] = await pool.execute('SELECT * FROM contracts WHERE id = ?', [id]);
        const contract = rows[0];

        // Send Email (Simulation)
        console.log(`📧 Email simulation: Sending to ${contract?.client_email || 'N/A'}`);
        // In production: transporter.sendMail(...)

        res.json({ message: 'Signed successfully', file: signedFileName, path: contractPdfPath });

    } catch (err) {
        console.error('❌ Sign Endpoint Error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Download Signed PDF
app.get('/api/contracts/:id/download', async (req, res) => {
    const { id } = req.params;
    const signedFileName = `signed_${id}.pdf`;
    const signedPath = path.join(__dirname, 'uploads', signedFileName);

    try {
        if (!fs.existsSync(signedPath)) {
            return res.status(404).json({ message: 'Signed PDF not found' });
        }

        res.download(signedPath, signedFileName);
    } catch (err) {
        console.error('Download Error:', err);
        res.status(500).json({ message: err.message });
    }
});

// 3. Signing Link Redirect
app.get('/sign/:id/:token', (req, res) => {
    const { id, token } = req.params;
    res.redirect(`/pdf-sign.html?id=${id}&token=${token}`);
});

// --- Contract Attachments Endpoints ---

// Upload contract attachments
app.post('/api/contracts/:id/attachments', attachmentUpload.array('files', 10), async (req, res) => {
    const { id } = req.params;
    const { attachmentsData } = req.body;

    try {
        let attachments = [];

        // Parse attachments data if it's a string
        if (typeof attachmentsData === 'string') {
            attachments = JSON.parse(attachmentsData);
        } else {
            attachments = attachmentsData || [];
        }

        console.log(`📎 Processing ${attachments.length} attachments for contract ${id}`);

        // Create contract directory
        const contractDir = path.join('uploads', 'contracts', id);
        if (!fs.existsSync(contractDir)) {
            fs.mkdirSync(contractDir, { recursive: true });
        }

        const files = req.files || [];
        let fileIndex = 0;
        const savedAttachments = [];

        for (let i = 0; i < attachments.length; i++) {
            const attachment = attachments[i];

            // Handle both snake_case (from new index.html) and camelCase (for legacy)
            const fieldName = attachment.field_name || attachment.fieldName;
            const fieldType = attachment.field_type || attachment.fieldType;
            const textValue = attachment.text_value || attachment.textValue;
            let fileData = attachment.fileData || attachment.file_data;

            console.log(`Processing attachment ${i + 1}/${attachments.length}: name=${fieldName}, type=${fieldType}`);

            let imageFilename = null;

            if (fieldType === 'image' || fieldType === 'file') {
                // Priority 1: File from Multer (FormData upload)
                if (files[fileIndex]) {
                    const file = files[fileIndex];
                    const ext = path.extname(file.originalname) || '.jpg';
                    imageFilename = `${fieldName}_${Date.now()}${ext}`;
                    const filePath = path.join(contractDir, imageFilename);

                    fs.writeFileSync(filePath, file.buffer);
                    console.log(`✅ File saved from buffer: ${filePath}`);
                    fileIndex++;
                }
                // Priority 2: Base64 data (JSON upload)
                else if (fileData) {
                    try {
                        const matches = fileData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                        const base64Content = matches ? matches[2] : fileData;
                        const mimeType = matches ? matches[1] : 'image/jpeg';

                        let ext = '.jpg';
                        if (mimeType.includes('png')) ext = '.png';
                        else if (mimeType.includes('gif')) ext = '.gif';
                        else if (mimeType.includes('pdf')) ext = '.pdf';

                        imageFilename = `${fieldName}_${Date.now()}${ext}`;
                        const filePath = path.join(contractDir, imageFilename);

                        fs.writeFileSync(filePath, Buffer.from(base64Content, 'base64'));
                        console.log(`✅ File saved from base64: ${filePath}`);
                    } catch (err) {
                        console.error(`❌ Error saving base64 for ${fieldName}:`, err);
                    }
                }
            }

            // Save to database
            await pool.execute(
                'INSERT INTO contract_attachments (contract_id, field_name, field_type, text_value, image_filename) VALUES (?, ?, ?, ?, ?)',
                [id, fieldName, fieldType, fieldType === 'text' ? textValue : null, imageFilename]
            );

            savedAttachments.push({ fieldName, fieldType, imageFilename });
        }

        res.json({ message: 'Attachments saved successfully', attachments: savedAttachments });
    } catch (err) {
        console.error('❌ Attachment error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Get contract attachments
app.get('/api/contracts/:id/attachments', async (req, res) => {
    const { id } = req.params;

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM contract_attachments WHERE contract_id = ? ORDER BY created_at ASC',
            [id]
        );
        res.json(rows);
    } catch (err) {
        console.error('Get attachments error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Serve attachment file
app.get('/api/contracts/:id/attachments/file/:filename', (req, res) => {
    const { id, filename } = req.params;
    const filePath = path.join(__dirname, 'uploads', 'contracts', id, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: 'File not found' });
    }

    res.sendFile(filePath);
});

// Auto-migration function (Try to fix, but don't crash)
async function checkSchema() {
    console.log('Checking database schema...');
    const connection = await pool.getConnection();
    try {
        const columns = [
            { name: 'payment_type', def: "VARCHAR(50) DEFAULT 'سنوية'" },
            { name: 'duration', def: "VARCHAR(50) DEFAULT 'سنوي'" },
            { name: 'first_party', def: "VARCHAR(255) DEFAULT 'شركة بفت للمقاولات'" },
            { name: 'second_party', def: "VARCHAR(255)" },
            { name: 'client_phone', def: "VARCHAR(50)" },
            { name: 'collector', def: "VARCHAR(255)" },
            { name: 'container_location', def: "VARCHAR(255)" },
            { name: 'pickup_location', def: "VARCHAR(255)" },
            { name: 'sign_method', def: "VARCHAR(50) DEFAULT 'manual'" },
            { name: 'tax', def: "VARCHAR(50) DEFAULT '15%'" },
            { name: 'parent_contract_id', def: "VARCHAR(50) DEFAULT NULL" }
        ];

        // Force update sign_method to ensure it's long enough
        try {
            console.log('Attempting to fix sign_method column...');
            await connection.query("ALTER TABLE contracts MODIFY COLUMN sign_method VARCHAR(50) DEFAULT 'manual'");
            console.log('sign_method column fixed successfully.');
        } catch (e) {
            console.error('Failed to fix sign_method column:', e.message);
        }

        // Debug: Show actual columns
        try {
            const [desc] = await connection.query("DESCRIBE contracts");
            console.log('Current Schema:', desc.map(c => `${c.Field} (${c.Type})`).join(', '));
        } catch (e) {
            console.error('Failed to describe table:', e);
        }

        for (const col of columns) {
            try {
                await connection.query(`SELECT ${col.name} FROM contracts LIMIT 1`);
            } catch (err) {
                if (err.code === 'ER_BAD_FIELD_ERROR') {
                    console.log(`Attempting to add missing column: ${col.name}`);
                    try {
                        await connection.query(`ALTER TABLE contracts ADD COLUMN ${col.name} ${col.def}`);
                        console.log('Success.');
                    } catch (alterErr) {
                        console.error(`FAILED to add column ${col.name}: ${alterErr.message}`);
                        console.error('You may need to run the fix_schema.js script or add columns manually.');
                    }
                }
            }
        }

        // Fix users table "role" column truncation (Expand to 255 chars)
        try {
            await connection.query("ALTER TABLE users MODIFY COLUMN role VARCHAR(255) DEFAULT 'staff'");
            console.log('Users role column length fixed (255 chars).');
        } catch (roleErr) {
            // Ignore error if it's just about no changes, but log others
            console.log('Role column check:', roleErr.message);
        }

        // Create users table if not exists (Fix for login/hash issues)
        try {
            await connection.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(50) NOT NULL UNIQUE,
                    password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(50) DEFAULT 'staff',
                    display_name VARCHAR(100),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('Users table checked/created successfully.');
        } catch (usersErr) {
            console.error('Failed to create users table:', usersErr.message);
        }

        // Create terms table if it doesn't exist
        try {
            await connection.query(`
                CREATE TABLE IF NOT EXISTS terms (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    type VARCHAR(50) DEFAULT 'text',
                    content TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);
            console.log('Terms table checked/created successfully.');
        } catch (termsErr) {
            console.error('Failed to create terms table:', termsErr.message);
        }

        // Create contract_attachments table if it doesn't exist
        try {
            await connection.query(`
                CREATE TABLE IF NOT EXISTS contract_attachments (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    contract_id VARCHAR(50) NOT NULL,
                    field_name VARCHAR(100) NOT NULL,
                    field_type ENUM('text', 'image') NOT NULL,
                    text_value TEXT,
                    image_filename VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_contract_id (contract_id)
                )
            `);
            console.log('Contract attachments table checked/created successfully.');

            // Add is_from_parent column if it doesn't exist
            try {
                await connection.query(`ALTER TABLE contract_attachments ADD COLUMN is_from_parent BOOLEAN DEFAULT FALSE`);
                console.log('Added is_from_parent column to contract_attachments');
            } catch (colErr) {
                if (colErr.code !== 'ER_DUP_FIELDNAME') {
                    console.error('Failed to add is_from_parent column:', colErr.message);
                }
            }
        } catch (attachErr) {
            console.error('Failed to create contract_attachments table:', attachErr.message);
        }

    } catch (err) {
        console.error('Schema check error:', err);
    } finally {
        connection.release();
        // Always fetch columns after check
        await getColumns();
    }
}

// Start server after checking schema
checkSchema().then(() => {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    let localIP = 'localhost';

    // Find the local IP address
    Object.keys(networkInterfaces).forEach((ifName) => {
        networkInterfaces[ifName].forEach((iface) => {
            // Skip internal/loopback and non-IPv4
            if (!iface.internal && iface.family === 'IPv4') {
                localIP = iface.address;
            }
        });
    });

    http.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`\n📱 **Access from your phone:**`);
        console.log(`   http://${localIP}:${PORT}`);
        console.log(`\n💻 **Access from this PC:**`);
        console.log(`   http://localhost:${PORT}`);
        console.log(`\n⚠️  Make sure your phone is on the same WiFi network!\n`);
    });
});



