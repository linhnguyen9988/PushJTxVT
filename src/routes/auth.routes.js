const bcrypt = require('bcrypt');
const express = require('express');
const jwt = require('jsonwebtoken');
const { isAuth, redirectIfLoggedIn } = require('../middleware/auth');
const { getRegistrationLocked } = require('../services/settings');
const { db } = require('../lib/db');
const { JWT_SECRET } = require('../config/env');
const { issueToken } = require('../services/session');
const { createLog } = require('../services/auditLog');
const { verify2FACode } = require('../services/twofa');

const router = express.Router();

router.get('/', (req, res) => res.redirect('/login'));

router.get('/register', redirectIfLoggedIn, (req, res) => {
    getRegistrationLocked((locked) => {
        res.render('register', { registrationLocked: locked });
    });
});

router.post('/register', async (req, res) => {
    getRegistrationLocked(async (locked) => {
        if (locked) {
            req.flash('error_msg', 'Đăng ký tài khoản mới hiện đang tạm khóa. Vui lòng liên hệ quản trị viên.');
            return res.redirect('/register');
        }

        const { username, shopname, password } = req.body;
        try {
            const hashed = await bcrypt.hash(password, 10);
            db.query('INSERT INTO users (username, shopname, password, role) VALUES (?, ?, ?, "user")', [username, shopname, hashed], (err) => {
                if (err) {
                    req.flash('error_msg', 'Tên đăng nhập đã tồn tại.');
                    return res.redirect('/register');
                }
                res.redirect('/login');
            });
        } catch (e) { res.redirect('/register'); }
    });
});

router.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Chưa nhập tên tài khoản hoặc mật khẩu!' });
    }

    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Lỗi cơ sở dữ liệu' });

        if (results && results.length > 0) {
            const userRecord = results[0];

            if (userRecord.is_locked) {
                return res.status(403).json({ success: false, message: 'Tài khoản này đã bị khóa!' });
            }

            const match = await bcrypt.compare(password, userRecord.password);
            if (match) {
                if (userRecord.totp_enabled && userRecord.totp_secret) {
                    const preToken = jwt.sign(
                        { userId: userRecord.id, purpose: '2fa-pending' },
                        JWT_SECRET,
                        { expiresIn: '5m' }
                    );
                    return res.json({
                        success: false,
                        requires2FA: true,
                        tempToken: preToken,
                        message: 'Vui lòng nhập mã 2FA từ app Authenticator để hoàn tất đăng nhập.'
                    });
                }

                const payload = {
                    username: userRecord.username,
                    role: userRecord.role,
                    userId: userRecord.id
                };
                const token = await issueToken(req, payload, 'app');

                createLog('Đã đăng nhập qua App Mobile', userRecord.username);
                return res.json({
                    success: true,
                    message: 'Đăng nhập thành công',
                    token: token,
                    expires_in: '30d',
                    user: {
                        username: userRecord.username,
                        role: userRecord.role
                    }
                });
            }
        }

        return res.status(401).json({ success: false, message: 'Sai tài khoản hoặc mật khẩu!' });
    });
});

router.post('/api/login/2fa-verify', async (req, res) => {
    const { tempToken, code } = req.body;
    if (!tempToken || !code) {
        return res.status(400).json({ success: false, message: 'Thiếu tempToken hoặc mã 2FA.' });
    }

    let decoded;
    try {
        decoded = jwt.verify(tempToken, JWT_SECRET);
    } catch (e) {
        return res.status(401).json({ success: false, message: 'Phiên xác thực đã hết hạn, vui lòng đăng nhập lại.' });
    }
    if (!decoded || decoded.purpose !== '2fa-pending') {
        return res.status(401).json({ success: false, message: 'Token không hợp lệ.' });
    }

    try {
        const [rows] = await db.promise().query('SELECT * FROM users WHERE id = ?', [decoded.userId]);
        if (!rows.length) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản.' });
        const userRecord = rows[0];

        if (userRecord.is_locked) {
            return res.status(403).json({ success: false, message: 'Tài khoản này đã bị khóa!' });
        }

        const ok = await verify2FACode(userRecord.username, userRecord.totp_secret, code);
        if (!ok) return res.status(400).json({ success: false, message: 'Mã 2FA không đúng.' });

        const payload = { username: userRecord.username, role: userRecord.role, userId: userRecord.id };
        const token = await issueToken(req, payload, 'app');

        createLog('Đã đăng nhập qua App Mobile (2FA)', userRecord.username);
        return res.json({
            success: true,
            message: 'Đăng nhập thành công',
            token: token,
            expires_in: '30d',
            user: { username: userRecord.username, role: userRecord.role }
        });
    } catch (e) {
        console.error('Lỗi xác thực 2FA mobile:', e);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

router.get('/api/profile', isAuth, (req, res) => {
    const username = req.app_user;

    const sql = `SELECT * FROM users WHERE username = ?`;

    db.query(sql, [username], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Lỗi DB" });
        if (results.length === 0) return res.status(404).json({ success: false, message: "Không tìm thấy user" });

        res.json({ success: true, data: results[0] });
    });
});

router.get('/login', redirectIfLoggedIn, (req, res) => res.render('login'));

router.post('/login', (req, res) => {
    const { username, password, rememberMe } = req.body;
    if (!username || !password) {
        req.flash('error_msg', 'Chưa nhập tên tài khoản hoặc mật khẩu!');
        return res.redirect('/login');
    }
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.redirect('/login');
        if (results && results.length > 0) {
            const userRecord = results[0];
            if (userRecord.is_locked) {
                req.flash('error_msg', 'Tài khoản này đã bị khóa!');
                return res.redirect('/login');
            }
            const match = await bcrypt.compare(password, userRecord.password);
            if (match) {
                if (userRecord.totp_enabled && userRecord.totp_secret) {
                    req.session.pending2FA = {
                        userId: userRecord.id,
                        username: userRecord.username,
                        role: userRecord.role
                    };
                    return res.redirect('/login/2fa');
                }

                const payload = {
                    username: userRecord.username,
                    role: userRecord.role,
                    userId: userRecord.id
                };
                const token = await issueToken(req, payload, 'web');

                res.cookie('jwt_token', token, {
                    httpOnly: true,
                    secure: true,
                    sameSite: 'lax',
                    maxAge: 30 * 24 * 60 * 60 * 1000
                });

                createLog('Đã đăng nhập vào hệ thống', userRecord.username);
                return res.redirect(userRecord.role === 'admin' ? '/admin/dashboard' : '/orders');
            }
        }
        req.flash('error_msg', 'Sai tài khoản hoặc mật khẩu!');
        res.redirect('/login');
    });
});

router.get('/login/2fa', (req, res) => {
    if (!req.session.pending2FA) return res.redirect('/login');
    res.render('login_2fa', { username: req.session.pending2FA.username });
});

router.post('/login/2fa', async (req, res) => {
    const pending = req.session.pending2FA;
    if (!pending) return res.redirect('/login');

    const { code } = req.body;
    try {
        const [rows] = await db.promise().query('SELECT totp_secret, is_locked FROM users WHERE id = ?', [pending.userId]);
        if (!rows.length) {
            delete req.session.pending2FA;
            req.flash('error_msg', 'Không tìm thấy tài khoản.');
            return res.redirect('/login');
        }
        if (rows[0].is_locked) {
            delete req.session.pending2FA;
            req.flash('error_msg', 'Tài khoản này đã bị khóa!');
            return res.redirect('/login');
        }

        const ok = await verify2FACode(pending.username, rows[0].totp_secret, code);
        if (!ok) {
            req.flash('error_msg', 'Mã xác thực 2FA không đúng. Vui lòng thử lại.');
            return res.redirect('/login/2fa');
        }

        const payload = { username: pending.username, role: pending.role, userId: pending.userId };
        const token = await issueToken(req, payload, 'web');
        res.cookie('jwt_token', token, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000
        });

        createLog('Đã đăng nhập vào hệ thống (2FA)', pending.username);
        delete req.session.pending2FA;
        res.redirect(pending.role === 'admin' ? '/admin/dashboard' : '/orders');
    } catch (e) {
        console.error('Lỗi xác thực 2FA login:', e);
        req.flash('error_msg', 'Lỗi hệ thống, vui lòng thử lại.');
        res.redirect('/login/2fa');
    }
});

router.get('/login/2fa/cancel', (req, res) => {
    delete req.session.pending2FA;
    res.redirect('/login');
});

module.exports = router;
