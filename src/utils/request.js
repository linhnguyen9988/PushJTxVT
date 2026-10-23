const { BEHIND_PROXY } = require('../config/env');

function getClientIp(req) {
    let ip = (BEHIND_PROXY ? req.ip : (req.socket && req.socket.remoteAddress)) || req.ip || '';
    ip = String(ip).replace(/^::ffff:/, '');
    if (ip === '::1') ip = '127.0.0.1';
    return ip.slice(0, 64);
}

function parseUserAgent(ua) {
    ua = String(ua || '');
    let os = 'Không rõ', type = 'desktop', m;

    if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1';
    else if (/Windows NT 6\.[12]/.test(ua)) os = 'Windows 7/8';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if ((m = ua.match(/Android ([\d.]+)/))) { os = 'Android ' + m[1]; type = 'mobile'; }
    else if (/iPad/.test(ua)) { os = 'iPadOS'; type = 'tablet'; }
    else if (/iPhone|iPod/.test(ua)) { m = ua.match(/OS (\d+)[_.]/); os = 'iOS' + (m ? ' ' + m[1] : ''); type = 'mobile'; }
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    let browser = 'Trình duyệt khác';
    if ((m = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/))) browser = 'Edge ' + m[1].split('.')[0];
    else if ((m = ua.match(/OPR\/([\d.]+)/))) browser = 'Opera ' + m[1].split('.')[0];
    else if ((m = ua.match(/SamsungBrowser\/([\d.]+)/))) browser = 'Samsung Internet ' + m[1].split('.')[0];
    else if ((m = ua.match(/(?:Firefox|FxiOS)\/([\d.]+)/))) browser = 'Firefox ' + m[1].split('.')[0];
    else if ((m = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/))) browser = 'Chrome ' + m[1].split('.')[0];
    else if (/Safari\//.test(ua) && (m = ua.match(/Version\/([\d.]+)/))) browser = 'Safari ' + m[1].split('.')[0];
    else if (/okhttp|Dalvik|CFNetwork|Dart|Expo|ReactNative/i.test(ua)) { browser = 'Ứng dụng di động'; if (type === 'desktop') type = 'mobile'; }
    else if (!ua) browser = 'Không rõ';

    let model = '';
    if ((m = ua.match(/Android [\d.]+; ([^;)]+)/)) && m[1].trim() !== 'K') model = m[1].trim();

    const label = browser + ' · ' + os + (model ? ' (' + model + ')' : '');
    return { label: label.slice(0, 255), type };
}

module.exports = { getClientIp, parseUserAgent };
