const QRCode = require('qrcode');
const bcrypt = require('bcrypt');
const express = require('express');
const otplib = require('otplib');
const { db } = require('../lib/db');
const { isAuth, verifyJWT } = require('../middleware/auth');
const { createLog } = require('../services/auditLog');
const { upload } = require('../middleware/upload');
const { generateRecoveryCodes, hashRecoveryCodes, verify2FACode, verifyTotpToken } = require('../services/twofa');
const { APP_2FA_ISSUER } = require('../config/constants');

const router = express.Router();

router.get('/profile', async (req, res) => {
    if (!req.app_user) return res.redirect('/login');

    const username = req.app_user;

    try {
        const sqlUser = `
            SELECT 
                u.*,
                (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as total_orders,
                (SELECT COUNT(*) FROM orders WHERE user_id = u.id AND status IN ('picked_up', 'delivering')) as shipping_orders,
                (SELECT SUM(price) FROM orders WHERE user_id = u.id AND status = 'completed') as total_revenue,
                (SELECT SUM(weight) FROM orders WHERE user_id = u.id AND status = 'completed') as total_weight
            FROM users u 
            WHERE u.username = ?`;

        const [userResults] = await db.promise().query(sqlUser, [username]);

        if (!userResults || userResults.length === 0) {
            return res.redirect('/login');
        }

        const userData = userResults[0];

        const sqlNotes = `SELECT * FROM order_notes WHERE user_id = ? ORDER BY created_at DESC`;
        const sqlProducts = `SELECT product_name FROM order_products WHERE user_id = ? ORDER BY created_at DESC`;

        const [[notes], [products]] = await Promise.all([
            db.promise().query(sqlNotes, [userData.id]),
            db.promise().query(sqlProducts, [userData.id])
        ]);

        let todayStats = [];
        if (userData.role === 'manager' || userData.role === 'admin') {
            const [todayStatsRows] = await db.promise().query(`
                SELECT 
                    u.shopname, 
                    u.username, 
                    COUNT(o.id) as total_orders,
                    SUM(o.price) as total_cod
                FROM orders o
                JOIN users u ON o.user_id = u.id
                WHERE o.created_at >= NOW() - INTERVAL 72 HOUR AND o.status='pending'
                GROUP BY u.id
                ORDER BY total_orders DESC
            `);
            todayStats = todayStatsRows;
        }

        res.render('profile', {
            user: userData.username,
            role: userData.role,
            avatar: userData.avatar,
            stats: userData,
            vtp_inventory_id: userData.vtp_inventory_id,
            vtp_shop_name: userData.vtp_shop_name,
            vtp_shop_phone: userData.vtp_shop_phone,
            vtp_shop_address: userData.vtp_shop_address,
            jt_sdt: userData.jt_sdt,
            jt_shopname: userData.jt_shopname,
            jt_shopaddress: userData.jt_shopaddress,
            jt_shop_ward: userData.jt_shop_ward,
            jt_shop_district: userData.jt_shop_district,
            jt_shop_prov: userData.jt_shop_prov,
            notes: notes || [],
            products: products || [],
            show_cod: userData.show_cod !== undefined ? userData.show_cod : 1,
            use_socket_print: userData.use_socket_print !== undefined ? userData.use_socket_print : 0,
            todayStats: todayStats,
            totp_enabled: !!userData.totp_enabled,
            active: 'profile'
        });

    } catch (error) {
        console.error("Lỗi hệ thống tại route /profile:", error);
        res.status(500).send("Đã có lỗi xảy ra.");
    }
});

router.get('/api/sessions', isAuth, async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT id, sid, ip, device, device_type, login_via, created_at, last_active
             FROM user_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_active DESC`,
            [req.app_uid, new Date()]
        );
        res.json({
            success: true,
            sessions: rows.map(r => ({
                id: r.id,
                ip: r.ip,
                device: r.device,
                device_type: r.device_type,
                login_via: r.login_via,
                created_at: r.created_at,
                last_active: r.last_active,
                current: !!req.app_sid && r.sid === req.app_sid
            })),
            legacy: !req.app_sid
        });
    } catch (e) {
        console.error('Lỗi lấy danh sách phiên:', e.message);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

router.post('/api/sessions/logout-all', isAuth, async (req, res) => {
    try {
        await db.promise().query('DELETE FROM user_sessions WHERE user_id = ?', [req.app_uid]);
        await db.promise().query(
            'INSERT INTO user_token_state (user_id, valid_after) VALUES (?, ?) ON DUPLICATE KEY UPDATE valid_after = VALUES(valid_after)',
            [req.app_uid, Math.floor(Date.now() / 1000)]
        );
        createLog('Đã đăng xuất tất cả thiết bị', req.app_user);
        res.clearCookie('jwt_token');
        res.clearCookie('rememberUser');
        res.json({ success: true, current: true, message: 'Đã đăng xuất tất cả thiết bị.' });
    } catch (e) {
        console.error('Lỗi đăng xuất tất cả phiên:', e.message);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

router.post('/api/sessions/:id/logout', isAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'ID không hợp lệ.' });
    try {
        const [rows] = await db.promise().query('SELECT sid, device, ip FROM user_sessions WHERE id = ? AND user_id = ?', [id, req.app_uid]);
        if (!rows.length) return res.status(404).json({ success: false, message: 'Không tìm thấy phiên đăng nhập.' });
        await db.promise().query('DELETE FROM user_sessions WHERE id = ? AND user_id = ?', [id, req.app_uid]);
        const isCurrent = !!req.app_sid && rows[0].sid === req.app_sid;
        createLog(`Đã đăng xuất thiết bị: ${rows[0].device || 'Không rõ'} (${rows[0].ip || '?'})`, req.app_user);
        if (isCurrent) {
            res.clearCookie('jwt_token');
            res.clearCookie('rememberUser');
        }
        res.json({ success: true, current: isCurrent });
    } catch (e) {
        console.error('Lỗi đăng xuất phiên:', e.message);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

router.post('/profile/upload-avatar', isAuth, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.redirect('/profile');
    const path = '/uploads/' + req.file.filename;
    db.query('UPDATE users SET avatar = ? WHERE username = ?', [path, req.app_user], (err) => {
        res.redirect('/profile');
    });
});

router.post('/profile/change-password', isAuth, async (req, res) => {
    const { oldPassword, newPassword, confirmPassword, totpCode } = req.body;
    if (newPassword !== confirmPassword) {
        req.flash('error_msg', 'Mật khẩu mới không khớp.');
        return res.redirect('/profile');
    }
    db.query('SELECT password, totp_secret, totp_enabled FROM users WHERE username = ?', [req.app_user], async (err, results) => {
        if (err || !results || !results.length) {
            req.flash('error_msg', 'Lỗi hệ thống.');
            return res.redirect('/profile');
        }
        const match = await bcrypt.compare(oldPassword, results[0].password);
        if (!match) {
            req.flash('error_msg', 'Mật khẩu cũ không đúng.');
            return res.redirect('/profile');
        }

        if (results[0].totp_enabled) {
            const ok = await verify2FACode(req.app_user, results[0].totp_secret, totpCode);
            if (!ok) {
                req.flash('error_msg', 'Mã 2FA không đúng. Vui lòng thử lại.');
                return res.redirect('/profile');
            }
        }

        const hashed = await bcrypt.hash(newPassword, 10);
        db.query('UPDATE users SET password = ? WHERE username = ?', [hashed, req.app_user], (err) => {
            req.flash('success_msg', 'Đổi mật khẩu thành công.');
            res.redirect('/profile');
        });
    });
});

router.post('/api/change-password', isAuth, async (req, res) => {
    const { oldPassword, newPassword, confirmPassword, totpCode } = req.body;
    const username = req.app_user;

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'Mật khẩu mới không khớp.' });
    }

    try {
        const [rows] = await db.promise().query('SELECT password, totp_secret, totp_enabled FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'User không tồn tại.' });

        const match = await bcrypt.compare(oldPassword, rows[0].password);
        if (!match) {
            return res.status(400).json({ success: false, message: 'Mật khẩu cũ không đúng.' });
        }

        if (rows[0].totp_enabled) {
            const ok = await verify2FACode(username, rows[0].totp_secret, totpCode);
            if (!ok) {
                return res.status(400).json({ success: false, message: 'Mã 2FA không đúng.', require2FACode: true });
            }
        }

        const hashed = await bcrypt.hash(newPassword, 10);
        await db.promise().query('UPDATE users SET password = ? WHERE username = ?', [hashed, username]);

        res.json({ success: true, message: 'Đổi mật khẩu thành công.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

router.post('/api/2fa/setup', isAuth, async (req, res) => {
    try {
        const secret = await otplib.generateSecret();
        req.session.totp_setup_secret = secret;
        req.session.totp_setup_user = req.app_user;

        const otpauthUrl = otplib.generateURI({ issuer: APP_2FA_ISSUER, label: req.app_user, secret });
        const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

        res.json({ success: true, secret, qrDataUrl });
    } catch (e) {
        console.error('Lỗi tạo 2FA:', e);
        res.status(500).json({ success: false, message: 'Không thể tạo mã 2FA lúc này.' });
    }
});

router.post('/api/2fa/enable', isAuth, async (req, res) => {
    const { code } = req.body;
    const secret = req.session.totp_setup_secret;

    if (!secret || req.session.totp_setup_user !== req.app_user) {
        return res.status(400).json({ success: false, message: 'Phiên thiết lập 2FA đã hết hạn, vui lòng bấm Bật 2FA lại.' });
    }

    const ok = await verifyTotpToken(secret, code);
    if (!ok) {
        return res.status(400).json({ success: false, message: 'Mã xác thực không đúng. Vui lòng kiểm tra lại app Authenticator.' });
    }

    try {
        const recoveryCodes = generateRecoveryCodes(8);
        const hashedRecoveryCodes = await hashRecoveryCodes(recoveryCodes);

        await db.promise().query(
            'UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_recovery_codes = ? WHERE username = ?',
            [secret, JSON.stringify(hashedRecoveryCodes), req.app_user]
        );
        delete req.session.totp_setup_secret;
        delete req.session.totp_setup_user;
        createLog('Đã bật Xác thực 2 lớp (2FA)', req.app_user);
        res.json({ success: true, message: 'Đã bật Xác thực 2 lớp thành công!', recoveryCodes });
    } catch (e) {
        console.error('Lỗi bật 2FA:', e);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

router.post('/api/2fa/disable', isAuth, async (req, res) => {
    const { code } = req.body;
    try {
        const [rows] = await db.promise().query('SELECT totp_secret, totp_enabled FROM users WHERE username = ?', [req.app_user]);
        if (!rows.length) return res.status(404).json({ success: false, message: 'Không tìm thấy user.' });
        const u = rows[0];

        if (!u.totp_enabled) {
            return res.json({ success: true, message: '2FA đã tắt sẵn.' });
        }

        const ok = await verify2FACode(req.app_user, u.totp_secret, code);
        if (!ok) {
            return res.status(400).json({ success: false, message: 'Mã không đúng. Nhập mã 6 số từ app Authenticator hoặc 1 mã khôi phục còn hiệu lực.' });
        }

        await db.promise().query('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_recovery_codes = NULL WHERE username = ?', [req.app_user]);
        createLog('Đã tắt Xác thực 2 lớp (2FA)', req.app_user);
        res.json({ success: true, message: 'Đã tắt Xác thực 2 lớp.' });
    } catch (e) {
        console.error('Lỗi tắt 2FA:', e);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

router.post('/api/2fa/recovery-codes/regenerate', isAuth, async (req, res) => {
    const { code } = req.body;
    try {
        const [rows] = await db.promise().query('SELECT totp_secret, totp_enabled FROM users WHERE username = ?', [req.app_user]);
        if (!rows.length || !rows[0].totp_enabled) {
            return res.status(400).json({ success: false, message: 'Tài khoản chưa bật 2FA.' });
        }

        const ok = await verify2FACode(req.app_user, rows[0].totp_secret, code);
        if (!ok) {
            return res.status(400).json({ success: false, message: 'Mã không đúng.' });
        }

        const recoveryCodes = generateRecoveryCodes(8);
        const hashedRecoveryCodes = await hashRecoveryCodes(recoveryCodes);
        await db.promise().query('UPDATE users SET totp_recovery_codes = ? WHERE username = ?', [JSON.stringify(hashedRecoveryCodes), req.app_user]);

        createLog('Đã tạo lại mã khôi phục 2FA', req.app_user);
        res.json({ success: true, message: 'Đã tạo bộ mã khôi phục mới. Các mã cũ không còn hiệu lực.', recoveryCodes });
    } catch (e) {
        console.error('Lỗi tạo lại mã khôi phục:', e);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

router.post('/api/profile/notes/add', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false, message: "Hết phiên làm việc" });

    const { content } = req.body;
    const username = req.app_user;

    try {
        const [users] = await db.promise().query("SELECT id FROM users WHERE username = ?", [username]);
        if (users.length === 0) return res.json({ success: false, message: "User không tồn tại" });

        const userId = users[0].id;
        await db.promise().query("INSERT INTO order_notes (user_id, content) VALUES (?, ?)", [userId, content]);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: "Lỗi hệ thống" });
    }
});

router.post('/api/profile/products/add', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false, message: "Hết phiên làm việc" });

    const { content } = req.body;
    const username = req.app_user;

    try {
        const [users] = await db.promise().query("SELECT id FROM users WHERE username = ?", [username]);
        if (users.length === 0) return res.json({ success: false, message: "User không tồn tại" });

        const userId = users[0].id;
        await db.promise().query("INSERT INTO order_products (user_id, product_name) VALUES (?, ?)", [userId, content]);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: "Lỗi hệ thống" });
    }
});

router.post('/api/profile/notes/delete/:id', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false });

    const noteId = req.params.id;
    const username = req.app_user;

    try {
        const [users] = await db.promise().query("SELECT id FROM users WHERE username = ?", [username]);
        if (users.length === 0) return res.json({ success: false });
        const userId = users[0].id;

        const [result] = await db.promise().query(
            "DELETE FROM order_notes WHERE id = ? AND user_id = ?",
            [noteId, userId]
        );

        if (result.affectedRows === 0) {
            return res.json({ success: false, message: "Bạn không có quyền xóa ghi chú này hoặc ghi chú không tồn tại" });
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false });
    }
});

router.post('/api/profile/products/delete/:id', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false });

    const noteId = req.params.id;
    const username = req.app_user;

    try {
        const [users] = await db.promise().query("SELECT id FROM users WHERE username = ?", [username]);
        if (users.length === 0) return res.json({ success: false });
        const userId = users[0].id;

        const [result] = await db.promise().query(
            "DELETE FROM order_products WHERE id = ? AND user_id = ?",
            [noteId, userId]
        );

        if (result.affectedRows === 0) {
            return res.json({ success: false, message: "Bạn không có quyền xóa sản phẩm này" });
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false });
    }
});

router.post('/api/profile/update-jt', async (req, res) => {
    if (!req.app_user) {
        return res.status(401).json({ success: false });
    }

    const { jt_sdt, jt_shopname, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov } = req.body;
    const username = req.app_user;

    if (!jt_sdt || !jt_shopname || !jt_shopaddress || !jt_shop_ward || !jt_shop_district || !jt_shop_prov) {
        return res.json({ success: false, message: "Thiếu thông tin. Kiểm tra lại!" });
    }

    try {
        await db.promise().query(
            `UPDATE users SET 
                jt_sdt = ?, jt_shopname = ?, jt_shopaddress = ?, 
                jt_shop_ward = ?, jt_shop_district = ?, jt_shop_prov = ? 
            WHERE username = ?`,
            [jt_sdt, jt_shopname, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov, username]
        );
        return res.json({ success: true });

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Lỗi Database" });
    }
});

router.get('/api/profile/stats', isAuth, async (req, res) => {
    const username = req.app_user;
    const days = parseInt(req.query.days) || 1;
    const allowed = [1, 3, 7, 15, 30];
    if (!allowed.includes(days)) return res.status(400).json({ success: false, message: 'Khoảng thời gian không hợp lệ' });

    try {
        const [rows] = await db.promise().query(
            `SELECT
                COUNT(*) as total,
                SUM(price) as total_revenue,
                SUM(CASE WHEN o.status = 'pending'   THEN 1 ELSE 0 END) as cnt_pending,
                SUM(CASE WHEN o.status = 'pending'   THEN price ELSE 0 END) as rev_pending,
                SUM(CASE WHEN o.status = 'picked_up' THEN 1 ELSE 0 END) as cnt_picked_up,
                SUM(CASE WHEN o.status = 'picked_up' THEN price ELSE 0 END) as rev_picked_up,
                SUM(CASE WHEN o.status = 'delivering' THEN 1 ELSE 0 END) as cnt_delivering,
                SUM(CASE WHEN o.status = 'delivering' THEN price ELSE 0 END) as rev_delivering,
                SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as cnt_completed,
                SUM(CASE WHEN o.status = 'completed' THEN price ELSE 0 END) as rev_completed,
                SUM(CASE WHEN o.status = 'returned'  THEN 1 ELSE 0 END) as cnt_returned,
                SUM(CASE WHEN o.status = 'returned'  THEN price ELSE 0 END) as rev_returned,
                SUM(CASE WHEN o.status = 'issue'     THEN 1 ELSE 0 END) as cnt_issue,
                SUM(CASE WHEN o.status = 'issue'     THEN price ELSE 0 END) as rev_issue,
                SUM(CASE WHEN o.status = 'cancel'    THEN 1 ELSE 0 END) as cnt_cancel,
                SUM(CASE WHEN o.status = 'cancel'    THEN price ELSE 0 END) as rev_cancel
             FROM orders o
             JOIN users u ON o.user_id = u.id
             WHERE u.username = ?
             AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [username, days]
        );
        return res.json({ success: true, stats: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Lỗi server' });
    }
});

router.post('/api/profile/toggle-cod', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false });
    const { show_cod } = req.body;
    try {
        await db.promise().query(
            `UPDATE users SET show_cod = ? WHERE username = ?`,
            [show_cod ? 1 : 0, req.app_user]
        );
        return res.json({ success: true, show_cod: show_cod ? 1 : 0 });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Lỗi Database' });
    }
});

router.post('/api/profile/toggle-socket-print', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false });
    const { use_socket_print } = req.body;
    try {
        await db.promise().query(
            `UPDATE users SET use_socket_print = ? WHERE username = ?`,
            [use_socket_print ? 1 : 0, req.app_user]
        );
        return res.json({ success: true, use_socket_print: use_socket_print ? 1 : 0 });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Lỗi Database' });
    }
});

router.get('/logout', (req, res) => {
    const token = req.cookies && req.cookies.jwt_token;
    const decoded = token ? verifyJWT(token) : null;
    const done = () => {
        res.clearCookie('jwt_token');
        res.clearCookie('rememberUser');
        res.redirect('/login');
    };
    if (decoded && decoded.sid) {
        db.query('DELETE FROM user_sessions WHERE sid = ?', [decoded.sid], (err) => {
            if (err) console.error('Lỗi xóa phiên khi đăng xuất:', err.message);
            done();
        });
    } else {
        done();
    }
});

module.exports = router;
