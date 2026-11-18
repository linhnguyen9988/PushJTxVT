'use strict';
// One PM2 fork process; events contain no customer data.
const subscribers = new Map();
function notifyCustomers(username) {
    for (const client of subscribers.get(username) || []) client.send('customers-changed');
}
function subscribeCustomers(req, res) {
    const username = req.app_user;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let closed = false;
    let heartbeat, lifetime;
    const clients = subscribers.get(username) || new Set();
    subscribers.set(username, clients);
    function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        clients.delete(client);
        if (!clients.size) subscribers.delete(username);
        res.end();
    }
    function write(data) {
        if (closed) return;
        try { if (res.destroyed || !res.write(data)) close(); }
        catch (_) { close(); }
    }
    const client = { send: event => write(`event: ${event}\ndata: {}\n\n`) };
    clients.add(client);
    res.on('close', close);
    res.on('error', close);
    heartbeat = setInterval(() => write(': heartbeat\n\n'), 15000);
    // Reconnect periodically through isAuth, including session revocation checks.
    lifetime = setTimeout(close, 60000);
    write('retry: 2000\n\n');
    client.send('ready');
}
module.exports = { subscribeCustomers, notifyCustomers };
