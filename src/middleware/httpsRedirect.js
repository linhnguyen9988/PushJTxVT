const { BEHIND_PROXY } = require('../config/env');

module.exports = (req, res, next) => {
    if (BEHIND_PROXY || req.path.startsWith('/.well-known/acme-challenge/')) {
        return next();
    }
    if (!req.secure) {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
};
