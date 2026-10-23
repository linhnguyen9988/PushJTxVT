const fs = require('fs');
const path = require('path');
const { ROOT } = require('../config/paths');

const LOG_DIR = path.join(ROOT, 'logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logPartSignToFile(billCode, partSign, details) {
    const now = new Date();
    const fileName = `partsign-${now.toISOString().slice(0,10)}.log`;
    const filePath = path.join(LOG_DIR, fileName);
    
    const line = `[${now.toLocaleString('vi-VN')}] Bill: ${billCode} | partSign=${partSign} | scan: ${details.scanTypeName} (${details.scanTypeCode}) | time: ${details.scanTime}\n`;
    
    fs.appendFile(filePath, line, (err) => {
        if (err) console.error('Lỗi ghi file partsign:', err);
    });
}

function logPartReturnEvent(kind, billCode, info) {
    try {
        const now = new Date();
        const filePath = path.join(LOG_DIR, `partreturn-${now.toISOString().slice(0, 10)}.log`);
        const line = `[${now.toLocaleString('vi-VN')}] ${kind} | ${billCode} | ${JSON.stringify(info)}\n`;
        fs.appendFile(filePath, line, (err) => {
            if (err) console.error('Lỗi ghi file partreturn:', err.message);
        });
    } catch (e) {
        console.error('Lỗi ghi log partreturn:', e.message);
    }
}

module.exports = { logPartReturnEvent, logPartSignToFile };
