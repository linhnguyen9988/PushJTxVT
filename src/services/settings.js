const { db } = require('../lib/db');

function getRegistrationLocked(cb) {
    db.query('SELECT registration_locked FROM app_settings WHERE id = 1', (err, results) => {
        if (err || !results || results.length === 0) return cb(false);
        cb(!!results[0].registration_locked);
    });
}

module.exports = { getRegistrationLocked };
