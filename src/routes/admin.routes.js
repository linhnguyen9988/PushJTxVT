const ExcelJS = require('exceljs');
const axios = require('axios');
const express = require('express');
const { isAdmin, isManager } = require('../middleware/auth');
const { require2FA } = require('../middleware/require2fa');
const { db } = require('../lib/db');
const { createLog } = require('../services/auditLog');
const { getRegistrationLocked } = require('../services/settings');
const { backfillPartReturnJourneys } = require('../services/partReturn');
const { sslRenewer } = require('../core/server');

const router = express.Router();

router.post('/admin/toggle-lock/:id', isAdmin, require2FA, (req, res) => {
    db.query('UPDATE users SET is_locked = NOT is_locked WHERE id = ?', [req.params.id], (err) => {
        createLog(`Thay đổi trạng thái khóa User ID: ${req.params.id}`, req.app_user);
        res.redirect('/admin/dashboard');
    });
});

router.post('/admin/toggle-registration-lock', isAdmin, require2FA, (req, res) => {
    db.query('UPDATE app_settings SET registration_locked = NOT registration_locked WHERE id = 1', (err) => {
        if (err) {
            console.error('Lỗi toggle registration lock:', err.message);
            return res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
        }
        getRegistrationLocked((locked) => {
            createLog(`${locked ? 'Khóa' : 'Mở khóa'} đăng ký tài khoản mới`, req.app_user);
            res.json({ success: true, locked });
        });
    });
});

router.post('/admin/part-return/backfill', isAdmin, require2FA, async (req, res) => {
    try {
        const r = await backfillPartReturnJourneys(!!(req.body && req.body.all));
        return res.json(Object.assign({ success: r.started !== false }, r));
    } catch (err) {
        console.error('Lỗi kéo bù đơn 1 phần:', err.message);
        return res.status(500).json({ success: false, message: 'Lỗi hệ thống khi kéo bù đơn 1 phần!' });
    }
});

router.get('/admin/ssl/status', isAdmin, (req, res) => {
    res.json({ success: true, ...sslRenewer.status() });
});

router.post('/admin/ssl/renew', isAdmin, require2FA, async (req, res) => {
    try {
        const result = await sslRenewer.renewNow({ force: true });
        createLog(result.staging ? 'Chạy thử gia hạn SSL (staging)' : 'Gia hạn SSL thủ công', req.app_user);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Gia hạn SSL thất bại: ' + e.message });
    }
});

router.get('/admin/bienhoa-wards', isAdmin, (req, res) => {
    db.query('SELECT id, name, new_ward, is_open FROM bienhoa_route_wards ORDER BY ward_code', (err, rows) => {
        if (err) {
            console.error('Lỗi lấy danh sách phường Biên Hòa:', err.message);
            return res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
        }
        res.json({ success: true, wards: rows.map(r => ({ id: r.id, name: r.name, new_ward: r.new_ward, is_open: !!r.is_open })) });
    });
});

router.post('/admin/bienhoa-wards/save', isAdmin, require2FA, async (req, res) => {
    const wards = Array.isArray(req.body.wards) ? req.body.wards : null;
    if (!wards) return res.status(400).json({ success: false, message: 'Dữ liệu không hợp lệ.' });

    const conn = await db.promise().getConnection();
    try {
        const [current] = await conn.query('SELECT id, name, is_open FROM bienhoa_route_wards');
        const currentMap = new Map(current.map(r => [Number(r.id), r]));
        const opened = [], closed = [];

        await conn.beginTransaction();
        for (const w of wards) {
            const id = Number(w.id);
            const row = currentMap.get(id);
            if (!row) continue;
            const next = w.is_open ? 1 : 0;
            if (next === (row.is_open ? 1 : 0)) continue;
            await conn.query('UPDATE bienhoa_route_wards SET is_open = ? WHERE id = ?', [next, id]);
            (next ? opened : closed).push(row.name);
        }
        await conn.commit();

        if (opened.length || closed.length) {
            const parts = [];
            if (opened.length) parts.push(`Mở tuyến: ${opened.join(', ')}`);
            if (closed.length) parts.push(`Tắt tuyến: ${closed.join(', ')}`);
            createLog(`Cập nhật tuyến Biên Hòa - ${parts.join(' | ')}`, req.app_user);
        }
        res.json({ success: true, opened: opened.length, closed: closed.length });
    } catch (e) {
        try { await conn.rollback(); } catch (_) { }
        console.error('Lỗi lưu tuyến Biên Hòa:', e.message);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    } finally {
        conn.release();
    }
});

router.get('/admin/dashboard', isAdmin, async (req, res) => {
    const search = req.query.search || '';
    const currentUser = req.app_user;

    try {
        const [usersRows, statsRows, logsRows, vtpRows, settingsRows, todayStatsRows, admin2FARows] = await Promise.all([
            db.promise().query(
                "SELECT * FROM users WHERE username LIKE ? AND username != ?",
                [`%${search}%`, currentUser]
            ),
            db.promise().query("SELECT role, COUNT(*) as count FROM users GROUP BY role"),
            db.promise().query("SELECT * FROM logs ORDER BY created_at DESC LIMIT 10"),
            db.promise().query("SELECT * FROM viettel_connect WHERE id = 1"),
            db.promise().query("SELECT registration_locked FROM app_settings WHERE id = 1"),
            db.promise().query(`
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
            `),
            db.promise().query("SELECT totp_enabled FROM users WHERE username = ?", [currentUser])
        ]);

        res.render('admin_dashboard', {
            users: usersRows[0],
            stats: statsRows[0],
            logs: logsRows[0],
            search: search,
            vtpConfig: vtpRows[0][0] || null,
            registrationLocked: !!(settingsRows[0][0] && settingsRows[0][0].registration_locked),
            todayStats: todayStatsRows[0],
            currentRole: req.app_role,
            admin2FAEnabled: !!(admin2FARows[0][0] && admin2FARows[0][0].totp_enabled),
            active: 'admin_dashboard'
        });

    } catch (err) {
        console.error("Lỗi Dashboard:", err.message);
        res.status(500).send("Lỗi hệ thống khi tải Dashboard");
    }
});

router.post('/admin/delete/:id', isAdmin, require2FA, async (req, res) => {
    const targetId = req.params.id;
    const adminUsername = req.app_user;

    try {
        const [adminRows] = await db.promise().query('SELECT id FROM users WHERE username = ?', [adminUsername]);
        if (adminRows.length > 0 && adminRows[0].id == targetId) {
            return res.status(400).send("Không thể tự xóa chính mình!");
        }

        await db.promise().query('DELETE FROM users WHERE id = ?', [targetId]);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi khi xóa người dùng");
    }
});

router.post('/admin/change-role/:id', isAdmin, require2FA, async (req, res) => {
    const { newRole } = req.body;
    const targetId = req.params.id;

    try {
        await db.promise().query('UPDATE users SET role = ? WHERE id = ?', [newRole, targetId]);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi khi cập nhật quyền");
    }
});

router.get('/admin/export-excel', isAdmin, async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Users');

        worksheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Username', key: 'username', width: 30 },
            { header: 'Role', key: 'role', width: 15 }
        ];

        const [results] = await db.promise().query('SELECT id, username, role FROM users');

        results.forEach(u => worksheet.addRow(u));

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Users.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error("Lỗi xuất Excel:", err);
        res.status(500).send("Không thể xuất file lúc này");
    }
});

router.post('/admin/update-vtp-system', isAdmin, require2FA, async (req, res) => {
    const { vtp_user, vtp_pass } = req.body;

    try {
        const loginRes = await axios.post('https://partner.viettelpost.vn/v2/user/login', {
            USERNAME: vtp_user,
            PASSWORD: vtp_pass
        });

        if (loginRes.data.status !== 200) {
            return res.json({ success: false, message: "Tài khoản/Mật khẩu VTP không đúng" });
        }

        const tempToken = loginRes.data.data.token;

        const connectRes = await axios.post('https://partner.viettelpost.vn/v2/user/ownerconnect', {
            USERNAME: vtp_user,
            PASSWORD: vtp_pass
        }, {
            headers: { 'token': tempToken }
        });

        if (connectRes.data.status === 200) {
            const tk = connectRes.data.data;

            const sql = `
                UPDATE viettel_connect 
                SET vtp_username = ?, 
                    vtp_password = ?, 
                    vtp_token = ?, 
                    vtp_token_exp = ?, 
                    vtp_cusid = ? 
                WHERE id = 1`;

            await db.promise().query(sql, [vtp_user, vtp_pass, tk.token, tk.expired, tk.userId]);

            res.json({ success: true });
        } else {
            res.json({ success: false, message: "Lỗi Connect: " + connectRes.data.message });
        }
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: "Không kết nối được API Viettel" });
    }
});

router.get('/api/viettel/inventories', async (req, res) => {
    try {
        const [config] = await db.promise().query('SELECT vtp_token FROM viettel_connect WHERE id = 1');

        if (!config[0] || !config[0].vtp_token) {
            return res.status(401).json({ error: "Hệ thống chưa kết nối Viettel Post" });
        }

        const response = await axios.get('https://partner.viettelpost.vn/v2/user/list-inventory', {
            headers: { 'Token': config[0].vtp_token }
        });

        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "Lỗi kết nối API Viettel" });
    }
});

router.post('/admin/assign-vtp-shop', isAdmin, async (req, res) => {
    const { userId, shopData } = req.body;

    const inventoryId = parseInt(shopData.inventoryId) || 0;

    try {
        const sql = `UPDATE users SET vtp_inventory_id = ?, vtp_shop_name = ?, vtp_shop_phone = ?, vtp_shop_address = ? WHERE id = ?`;
        await db.promise().query(sql, [inventoryId, shopData.name, shopData.phone, shopData.address, userId]);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

router.post('/admin/update-user-price', isManager, require2FA, async (req, res) => {
    if (req.app_role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Bạn không có quyền thay đổi giá cước!' });
    }

    const { userId, basePrice, stepPrice, baseWeight } = req.body;

    try {
        await db.promise().query(
            'UPDATE users SET base_price = ?, step_price = ?, base_weight = ? WHERE id = ?',
            [basePrice, stepPrice, baseWeight, userId]
        );

        await db.promise().query(
            'INSERT INTO logs (performed_by, action) VALUES (?, ?)',
            [req.app_user, `Cập nhật giá cước cho User ID ${userId}: KG gốc ${baseWeight}, Gốc ${basePrice}, Bước ${stepPrice}`]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: "Lỗi cơ sở dữ liệu" });
    }
});

router.post('/admin/import-customers', isAdmin, async (req, res) => {
    const { customers, targetUserId } = req.body;
    if (!customers || !targetUserId) return res.json({ success: false });

    try {
        const values = customers.map(c => [c.name, c.phone, c.address, targetUserId]);

        const sql = "INSERT IGNORE INTO customers (name, phone, address, user_id) VALUES ?";
        const [result] = await db.promise().query(sql, [values]);

        res.json({
            success: true,
            count: result.affectedRows,
            ignored: customers.length - result.affectedRows
        });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Lỗi Database' });
    }
});

router.post('/api/admin/update-user-jt', isAdmin, require2FA, async (req, res) => {
    const {
        target_user_id, jt_shopname, jt_sdt,
        jt_shopaddress, jt_shop_prov, jt_shop_district, jt_shop_ward
    } = req.body;
    if (!target_user_id || !jt_shopname || !jt_sdt || !jt_shopaddress || !jt_shop_prov || !jt_shop_district || !jt_shop_ward) {
        return res.status(400).json({ success: false, message: "Thiếu thông tin!" });
    }

    try {
        const sql = `UPDATE users SET jt_shopname=?, jt_sdt=?, jt_shopaddress=?, jt_shop_prov=?, jt_shop_district=?, jt_shop_ward=? WHERE id=?`;
        const params = [jt_shopname, jt_sdt, jt_shopaddress, jt_shop_prov, jt_shop_district, jt_shop_ward, target_user_id];
        const result = await db.promise().execute(sql, params);
        const header = Array.isArray(result) ? result[0] : result;

        if (header && (header.affectedRows > 0 || header.changedRows >= 0)) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: "Không có thay đổi nào được thực hiện." });
        }
    } catch (err) {
        console.error("Lỗi DB chi tiết:", err);
        res.status(500).json({ success: false, message: "Lỗi hệ thống: " + err.message });
    }
});

module.exports = router;
