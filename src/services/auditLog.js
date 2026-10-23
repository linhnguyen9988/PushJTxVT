const { db } = require('../lib/db');

function createLog(action, user) {
    console.log(`[LOG SYSTEM]: ${user} - ${action}`);

    db.query('INSERT INTO logs (action, performed_by) VALUES (?, ?)', [action, user || 'Hệ thống'], (err) => {
        if (err) {
            console.error("LỖI SQL KHI GHI LOG:", err.message);
        }
    });
}

module.exports = { createLog };
