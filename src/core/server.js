const fs = require('fs');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { createSslRenewer } = require('../../ssl-renew');
const { BEHIND_PROXY, CERT_PATH, KEY_PATH } = require('../config/env');
const { app } = require('./app');

const options = (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH))
    ? { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) }
    : {};

const httpServer = http.createServer(app);

const httpsServer = BEHIND_PROXY ? httpServer : https.createServer(options, app);

const sslRenewer = createSslRenewer({
    domains: (process.env.SSL_DOMAINS || 'tvship.vn').split(',').map(d => d.trim()).filter(Boolean),
    email: BEHIND_PROXY ? undefined : process.env.SSL_EMAIL,
    keyPath: KEY_PATH,
    certPath: CERT_PATH,
    staging: process.env.SSL_STAGING === '1',
    log: BEHIND_PROXY ? { log() {}, warn() {}, error() {} } : console,
    onReload: ({ key, cert }) => { if (!BEHIND_PROXY) httpsServer.setSecureContext({ key, cert }); }
});

const io = new Server(httpsServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e7
});

module.exports = { httpServer, httpsServer, io, sslRenewer };
