require('dotenv').config({ quiet: true });
const path = require('path');
const { ROOT } = require('./paths');

function requireEnv(name) {
    const v = process.env[name];
    if (v === undefined || v === '') {
        console.error(`[CONFIG] Thiếu biến môi trường bắt buộc: ${name} (xem file .env.example)`);
        process.exit(1);
    }
    return v;
}

const JWT_SECRET = requireEnv('JWT_SECRET');

const SESSION_SECRET = requireEnv('SESSION_SECRET');

const JT_CONFIG = {
    pkey: requireEnv('JT_PKEY'),
    apiAccount: requireEnv('JT_API_ACCOUNT'),
    customerCode: requireEnv('JT_CUSTOMER_CODE'),
    password: requireEnv('JT_PASSWORD')
};

const GHN_CONFIG = {
    token: requireEnv('GHN_TOKEN'),
    shopId: requireEnv('GHN_SHOP_ID')
};

const JWT_EXPIRES_IN = '30d';

const BEHIND_PROXY = process.env.BEHIND_PROXY === '1';

const APP_PORT = Number(process.env.PORT || 3001);

const KEY_PATH = process.env.SSL_KEY_PATH || path.join(ROOT, 'tvship.vn-key.pem');

const CERT_PATH = process.env.SSL_CERT_PATH || path.join(ROOT, 'tvship.vn-chain.pem');

module.exports = { APP_PORT, BEHIND_PROXY, CERT_PATH, GHN_CONFIG, JT_CONFIG, JWT_EXPIRES_IN, JWT_SECRET, KEY_PATH, SESSION_SECRET, requireEnv };
