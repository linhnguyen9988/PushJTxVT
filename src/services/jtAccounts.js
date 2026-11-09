const { createHash } = require('node:crypto');
const { JT_CONFIG } = require('../config/env');
const { db } = require('../lib/db');

function deriveJtPassword(key) {
    return createHash('md5').update(`${key}jadada369t3`, 'utf8').digest('hex').toUpperCase();
}

function credentialsFor(account) {
    if (!account) return { ...JT_CONFIG, id: null };
    const key = process.env.JT_KEY;
    if (!key) throw new Error('Chưa cấu hình JT_KEY cho tài khoản J&T.');
    return { ...JT_CONFIG, id: account.id, customerCode: account.customer_code, password: deriveJtPassword(key) };
}

async function listJtAccounts() {
    const [rows] = await db.promise().query(`
        SELECT a.id, a.customer_code, a.id <=> s.default_account_id AS is_default
        FROM jt_accounts a CROSS JOIN jt_account_settings s
        WHERE s.id = 1 ORDER BY is_default DESC, a.id`);
    return rows;
}

async function addJtAccount(customerCode) {
    const connection = await db.promise().getConnection();
    try {
        await connection.beginTransaction();
        const [settings] = await connection.query('SELECT default_account_id FROM jt_account_settings WHERE id = 1 FOR UPDATE');
        if (!settings.length) throw new Error('Thiếu cấu hình tài khoản J&T.');
        const [insert] = await connection.query('INSERT INTO jt_accounts (customer_code) VALUES (?)', [customerCode]);
        if (settings[0].default_account_id === null) {
            await connection.query('UPDATE jt_account_settings SET default_account_id = ? WHERE id = 1', [insert.insertId]);
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function setDefaultJtAccount(id) {
    const [result] = await db.promise().query(`
        UPDATE jt_account_settings s JOIN jt_accounts a ON a.id = ?
        SET s.default_account_id = a.id WHERE s.id = 1`, [id]);
    return result.affectedRows > 0;
}

async function getDefaultJtCredentials() {
    const [rows] = await db.promise().query(`
        SELECT a.id, a.customer_code FROM jt_account_settings s
        JOIN jt_accounts a ON a.id = s.default_account_id WHERE s.id = 1`);
    return credentialsFor(rows[0]);
}

async function getJtCredentialsForOrder(code, { byBillCode = false } = {}) {
    const column = byBillCode ? 'realjtbillcode' : 'order_code';
    const [rows] = await db.promise().query(`
        SELECT o.jt_account_id, a.id, a.customer_code FROM orders o
        LEFT JOIN jt_accounts a ON a.id = o.jt_account_id
        WHERE o.${column} = ? AND o.provider = 'J&T' LIMIT 1`, [code]);
    const order = rows[0];
    if (order?.jt_account_id != null && order.id == null) throw new Error('Không tìm thấy tài khoản J&T của vận đơn.');
    return credentialsFor(order?.id == null ? null : order);
}

module.exports = { addJtAccount, deriveJtPassword, getDefaultJtCredentials, getJtCredentialsForOrder, listJtAccounts, setDefaultJtAccount };
