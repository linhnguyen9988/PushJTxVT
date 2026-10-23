const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getClientIp, parseUserAgent } = require('../utils/request');
const { db } = require('../lib/db');
const { JWT_EXPIRES_IN, JWT_SECRET } = require('../config/env');

async function issueToken(req, payload, via) {
    const sid = crypto.randomBytes(16).toString('hex');
    try {
        const ua = String(req.headers['user-agent'] || '').slice(0, 500);
        const info = parseUserAgent(ua);
        let device = info.label;
        const custom = req.body && typeof req.body.deviceName === 'string' ? req.body.deviceName.trim().slice(0, 100) : '';
        if (via === 'app' && custom) device = custom;
        const now = new Date();
        const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        await db.promise().query('DELETE FROM user_sessions WHERE user_id = ? AND expires_at < ?', [payload.userId, now]);
        await db.promise().query(
            `INSERT INTO user_sessions (sid, user_id, ip, user_agent, device, device_type, login_via, created_at, last_active, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sid, payload.userId, getClientIp(req), ua, device, info.type, via, now, now, expires]
        );
        return jwt.sign({ ...payload, sid }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    } catch (e) {
        console.error('Lỗi lưu phiên đăng nhập:', e.message);
        return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    }
}

function checkTokenSession(req, decoded, cb) {
    if (req._sessChecked !== undefined) return cb(req._sessChecked, req._sessErr);
    const finish = (valid, err) => { req._sessChecked = valid; req._sessErr = err; cb(valid, err); };

    if (decoded.sid) {
        db.query('SELECT id FROM user_sessions WHERE sid = ? AND user_id = ? AND expires_at > ? LIMIT 1',
            [decoded.sid, decoded.userId, new Date()], (err, rows) => {
                if (err) return finish(false, err);
                if (!rows.length) return finish(false);
                db.query('UPDATE user_sessions SET last_active = ? WHERE sid = ? AND last_active < ?',
                    [new Date(), decoded.sid, new Date(Date.now() - 60 * 1000)]);
                finish(true);
            });
    } else {
        db.query('SELECT valid_after FROM user_token_state WHERE user_id = ? LIMIT 1', [decoded.userId], (err, rows) => {
            if (err) {
                console.error('Lỗi kiểm tra token cũ:', err.message);
                return finish(true);
            }
            const v = rows.length ? Number(rows[0].valid_after) : 0;
            finish(!(v && decoded.iat <= v));
        });
    }
}

module.exports = { checkTokenSession, issueToken };
