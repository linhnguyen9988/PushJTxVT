const mysql = require('mysql2');
const { requireEnv } = require('../config/env');

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: process.env.DB_NAME || 'pushorder',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

db.getConnection((err, connection) => {
    if (err) console.error('Lỗi kết nối MySQL Pool:', err);
    else {
        connection.release();
    }
});

module.exports = { db };
