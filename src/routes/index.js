const publicRoutes = [
    require('./auth.routes'),
    require('./webhooks.routes'),
];

const protectedRoutes = [
    require('./admin.routes'),
    require('./account.routes'),
    require('./customers.routes'),
    require('./address.routes'),
    require('./adminOrders.routes'),
    require('./orders.routes'),
    require('./print.routes'),
    require('./tracking.routes'),
];

module.exports = { publicRoutes, protectedRoutes };
