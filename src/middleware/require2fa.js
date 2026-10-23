const { db } = require('../lib/db');
const { verify2FACode } = require('../services/twofa');

function require2FA(req, res, next) {
    if (req.app_role !== 'admin') return next();

    const isApiStyle = req.xhr || req.path.startsWith('/api/') ||
        (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

    const respondFail = (status, message, extra) => {
        if (isApiStyle) return res.status(status).json(Object.assign({ success: false, message }, extra || {}));
        req.flash('error_msg', message);
        return res.redirect('/admin/dashboard');
    };

    db.query('SELECT totp_secret, totp_enabled FROM users WHERE username = ?', [req.app_user], async (err, results) => {
        if (err || !results || !results.length) {
            return respondFail(500, 'Lỗi xác thực 2FA.');
        }
        const admin = results[0];
        if (!admin.totp_enabled || !admin.totp_secret) {
            return respondFail(403, 'Bạn cần bật Xác thực 2 lớp (2FA) trong Trang cá nhân trước khi thực hiện thao tác này.', { require2FASetup: true });
        }

        const code = req.body.totpCode || req.body.totp_code;
        if (!code) {
            return respondFail(400, 'Vui lòng nhập mã 2FA để xác nhận thao tác.', { require2FACode: true });
        }

        const ok = await verify2FACode(req.app_user, admin.totp_secret, code);
        if (!ok) {
            return respondFail(400, 'Mã 2FA không đúng hoặc đã hết hạn.');
        }
        next();
    });
}

module.exports = { require2FA };
