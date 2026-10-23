const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { checkTokenSession } = require('../services/session');

const verifyJWT = (token) => {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
};

const isAuth = (req, res, next) => {
    const tokenFromCookie = req.cookies && req.cookies.jwt_token;
    const authHeader = req.headers['authorization'];
    const tokenFromHeader = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const token = tokenFromCookie || tokenFromHeader;

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded && decoded.username) {
                return checkTokenSession(req, decoded, (valid, dbErr) => {
                    const apiStyle = req.xhr || req.path.startsWith('/api/');
                    if (dbErr) {
                        console.error('Lỗi kiểm tra phiên:', dbErr.message);
                        return apiStyle
                            ? res.status(500).json({ success: false, message: 'Lỗi hệ thống.' })
                            : res.status(500).send('Lỗi hệ thống.');
                    }
                    if (!valid) {
                        res.clearCookie('jwt_token');
                        if (apiStyle) {
                            return res.status(401).json({ success: false, message: 'Phiên đăng nhập đã bị đăng xuất, vui lòng đăng nhập lại!' });
                        }
                        req.flash('error_msg', 'Phiên đăng nhập đã bị đăng xuất, vui lòng đăng nhập lại.');
                        return res.redirect('/login');
                    }
                    req.app_user = decoded.username;
                    req.app_role = decoded.role;
                    req.app_sid = decoded.sid || null;
                    req.app_uid = decoded.userId || null;
                    next();
                });
            }
        } catch (e) {
            if (e.name === 'TokenExpiredError') {
                res.clearCookie('jwt_token');
                if (req.xhr || req.path.startsWith('/api/')) {
                    return res.status(401).json({ success: false, message: 'Token đã hết hạn, vui lòng đăng nhập lại!' });
                }
                req.flash('error_msg', 'Phiên làm việc đã hết hạn, vui lòng đăng nhập lại.');
                return res.redirect('/login');
            }
            console.error('Lỗi xác thực token:', e.message);
        }
    }

    if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: 'Hết phiên làm việc, vui lòng đăng nhập lại!' });
    }

    req.flash('error_msg', 'Vui lòng đăng nhập để tiếp tục.');
    res.redirect('/login');
};

const isAdmin = (req, res, next) => {
    if (req.app_role === 'admin') return next();
    req.flash('error_msg', 'Bạn không có quyền quản trị.');
    res.redirect('/orders');
};

const isManager = (req, res, next) => {
    if (req.app_role === 'manager' || req.app_role === 'admin') return next();
    req.flash('error_msg', 'Bạn không có quyền thực hiện thao tác này.');
    res.redirect('/orders');
};

const redirectIfLoggedIn = (req, res, next) => {
    const token = req.cookies && req.cookies.jwt_token;
    if (token) {
        const decoded = verifyJWT(token);
        if (decoded) {
            return checkTokenSession(req, decoded, (valid) => {
                if (valid) return res.redirect(decoded.role === 'admin' ? '/admin/dashboard' : '/orders');
                res.clearCookie('jwt_token');
                next();
            });
        }
    }
    next();
};

module.exports = { isAdmin, isAuth, isManager, redirectIfLoggedIn, verifyJWT };
