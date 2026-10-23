const { APP_PORT, BEHIND_PROXY } = require('./src/config/env');

const { app } = require('./src/core/app');
const { httpServer, httpsServer, sslRenewer } = require('./src/core/server');
const httpsRedirect = require('./src/middleware/httpsRedirect');
const applyBaseMiddleware = require('./src/middleware/base');
const { isAuth } = require('./src/middleware/auth');
const { publicRoutes, protectedRoutes } = require('./src/routes');

require('./src/sockets/printer');

app.get('/.well-known/acme-challenge/:token', sslRenewer.challengeHandler);
app.use(httpsRedirect);
applyBaseMiddleware(app);

app.use(publicRoutes);
app.use(isAuth);
app.use(protectedRoutes);

if (BEHIND_PROXY) {
    httpServer.listen(APP_PORT, '127.0.0.1', () => {
        console.log(`HTTP (sau nginx): 127.0.0.1:${APP_PORT}`);
    });
} else {
    httpServer.listen(80, () => {
        console.log('HTTP: 80');
    });

    httpsServer.listen(443, () => {
        console.log('HTTPS: 443');
    });

    sslRenewer.start();
}
