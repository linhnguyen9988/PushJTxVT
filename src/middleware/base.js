const cookieParser = require('cookie-parser');
const cors = require('cors');
const express = require('express');
const flash = require('connect-flash');
const session = require('express-session');
const { SESSION_SECRET } = require('../config/env');
const { verifyJWT } = require('./auth');
const { checkTokenSession } = require('../services/session');
const { db } = require('../lib/db');
const { randomBytes } = require('crypto');
const { DEFAULT_SKIN, normalizeSkin } = require('../services/skin');

module.exports = function applyBaseMiddleware(app) {
app.set('view engine', 'ejs');
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use((req, res, next) => { if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.body) req.body = {}; next(); });
app.use(express.static('public'));
app.use(cookieParser());
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 10 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
    }
}));
app.use(flash());
app.use(cors());
app.use((req, res, next) => {
    res.locals.skinColor = DEFAULT_SKIN;
    if (!req.session.skinCsrf) req.session.skinCsrf = randomBytes(32).toString('hex');
    res.locals.skinCsrf = req.session.skinCsrf;
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');

    const token = req.cookies && req.cookies.jwt_token;
    if (token) {
        const decoded = verifyJWT(token);
        if (decoded) {
            checkTokenSession(req, decoded, (valid) => {
                if (!valid) {
                    res.locals.user = undefined;
                    res.locals.role = undefined;
                    res.locals.avatar = undefined;
                    return next();
                }
                db.query('SELECT avatar FROM users WHERE username = ?', [decoded.username], (err, results) => {
                    if (err) return next();
                    res.locals.user = decoded.username;
                    res.locals.role = decoded.role;
                    res.locals.avatar = (results && results.length > 0 && results[0].avatar) ? results[0].avatar : '';
                    db.query('SELECT s.color FROM user_skins s JOIN users u ON u.id = s.user_id WHERE u.username = ?', [decoded.username], (skinErr, skins) => {
                        if (skinErr) console.error('Không tải được skin:', skinErr.code);
                        res.locals.skinColor = !skinErr && skins.length
                            ? normalizeSkin(skins[0].color) || DEFAULT_SKIN : DEFAULT_SKIN;
                        next();
                    });
                });
            });
            return;
        }
    }

    res.locals.user = undefined;
    res.locals.role = undefined;
    res.locals.avatar = undefined;
    next();
});
};
