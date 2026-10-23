const crypto = require('crypto');
const bcrypt = require('bcrypt');
const otplib = require('otplib');
const { db } = require('../lib/db');

function generateRecoveryCodes(count = 8) {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codes = [];
    for (let i = 0; i < count; i++) {
        let raw = '';
        for (let j = 0; j < 8; j++) raw += charset[crypto.randomInt(0, charset.length)];
        codes.push(raw.slice(0, 4) + '-' + raw.slice(4));
    }
    return codes;
}

async function hashRecoveryCodes(plainCodes) {
    const hashed = [];
    for (const c of plainCodes) hashed.push(await bcrypt.hash(c, 10));
    return hashed;
}

function normalizeRecoveryInput(code) {
    return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

async function verifyAndConsumeRecoveryCode(username, inputCode) {
    if (!inputCode) return false;
    const normalized = normalizeRecoveryInput(inputCode);
    if (!normalized) return false;

    const [rows] = await db.promise().query('SELECT totp_recovery_codes FROM users WHERE username = ?', [username]);
    if (!rows.length || !rows[0].totp_recovery_codes) return false;

    let hashedCodes;
    try { hashedCodes = JSON.parse(rows[0].totp_recovery_codes); } catch (e) { return false; }
    if (!Array.isArray(hashedCodes) || hashedCodes.length === 0) return false;

    for (let i = 0; i < hashedCodes.length; i++) {
        const match = await bcrypt.compare(normalized, hashedCodes[i]);
        if (match) {
            hashedCodes.splice(i, 1);
            await db.promise().query('UPDATE users SET totp_recovery_codes = ? WHERE username = ?', [JSON.stringify(hashedCodes), username]);
            return true;
        }
    }
    return false;
}

async function verify2FACode(username, secret, inputCode) {
    if (!inputCode) return false;
    const totpOk = await verifyTotpToken(secret, inputCode);
    if (totpOk) return true;
    return await verifyAndConsumeRecoveryCode(username, inputCode);
}

async function verifyTotpToken(secret, token) {
    if (!secret || !token) return false;
    try {
        const result = await otplib.verify({ token: String(token).trim(), secret, window: 1 });
        return !!(result && result.valid);
    } catch (e) {
        return false;
    }
}

module.exports = { generateRecoveryCodes, hashRecoveryCodes, verify2FACode, verifyTotpToken };
