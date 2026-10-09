const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const acme = require('acme-client');

function createSslRenewer(opts) {
    const {
        domains,
        email,
        keyPath,
        certPath,
        onReload,
        dataDir = path.join(__dirname, 'ssl-data'),
        renewBeforeDays = 30,
        checkEveryHours = 12,
        staging = false,
        directoryUrl,
        log = console
    } = opts;

    const tag = '[SSL]';
    const enabled = Array.isArray(domains) && domains.length > 0 && !!email && !!keyPath && !!certPath;
    if (!enabled) log.error(`${tag} Thiếu domains/email/keyPath/certPath, tính năng tự gia hạn SSL đang TẮT.`);

    const tokens = new Map();
    let renewing = null;
    let loadedFingerprint = null;
    let timer = null;
    const state = { lastCheck: null, lastResult: null, lastError: null, lastRenewed: null };

    function challengeHandler(req, res) {
        const keyAuth = tokens.get(req.params.token);
        if (!keyAuth) return res.status(404).type('text/plain').send('Not found');
        log.log(`${tag} Let's Encrypt đang kiểm tra token ${req.params.token.slice(0, 8)}...`);
        res.type('text/plain').send(keyAuth);
    }

    function readCertInfo() {
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
        try {
            const x = new crypto.X509Certificate(fs.readFileSync(certPath));
            const validTo = new Date(x.validTo);
            return {
                validTo,
                daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86400000),
                missingDomains: domains.filter(d => !x.checkHost(d)),
                fingerprint: x.fingerprint256,
                issuer: x.issuer.replace(/\n/g, ', ')
            };
        } catch (e) {
            log.error(`${tag} Không đọc được cert hiện tại: ${e.message}`);
            return null;
        }
    }

    function writeAtomic(file, data, mode) {
        const tmp = file + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, data, { mode });
        fs.renameSync(tmp, file);
    }

    function backupCurrent() {
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return;
        const dir = path.join(dataDir, 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(certPath, path.join(dir, 'fullchain.pem'));
        fs.copyFileSync(keyPath, path.join(dir, 'privkey.pem'));
        // chỉ giữ 5 bản backup gần nhất
        const root = path.join(dataDir, 'backup');
        const all = fs.readdirSync(root).sort();
        all.slice(0, Math.max(0, all.length - 5)).forEach(d => fs.rmSync(path.join(root, d), { recursive: true, force: true }));
    }

    async function getAccountKey() {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const file = path.join(dataDir, staging ? 'account-staging.key' : 'account.key');
        if (fs.existsSync(file)) return fs.readFileSync(file);
        const key = await acme.crypto.createPrivateKey();
        writeAtomic(file, key, 0o600);
        return key;
    }

    async function obtain() {
        const client = new acme.Client({
            directoryUrl: directoryUrl || (staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production),
            accountKey: await getAccountKey()
        });

        const [key, csr] = await acme.crypto.createCsr({ commonName: domains[0], altNames: domains });

        const cert = await client.auto({
            csr,
            email,
            termsOfServiceAgreed: true,
            challengePriority: ['http-01'],
            challengeCreateFn: async (authz, challenge, keyAuthorization) => {
                tokens.set(challenge.token, keyAuthorization);
            },
            challengeRemoveFn: async (authz, challenge) => {
                tokens.delete(challenge.token);
            }
        });

        return { key, cert: Buffer.from(cert) };
    }

    async function doRenew() {
        log.log(`${tag} Bắt đầu xin cert cho: ${domains.join(', ')}${staging ? ' (STAGING - chạy thử)' : ''}`);
        const { key, cert } = await obtain();

        if (staging) {
            const dir = path.join(dataDir, 'staging');
            fs.mkdirSync(dir, { recursive: true });
            writeAtomic(path.join(dir, 'fullchain.pem'), cert, 0o644);
            writeAtomic(path.join(dir, 'privkey.pem'), key, 0o600);
            log.log(`${tag} Staging OK: cert thử nghiệm lưu ở ${dir}. Cert đang dùng KHÔNG bị thay đổi.`);
            return { renewed: false, staging: true };
        }

        backupCurrent();
        writeAtomic(keyPath, key, 0o600);
        writeAtomic(certPath, cert, 0o644);

        const info = readCertInfo();
        loadedFingerprint = info ? info.fingerprint : null;
        onReload({ key, cert });
        state.lastRenewed = new Date();
        log.log(`${tag} Gia hạn thành công, cert mới hết hạn ${info ? info.validTo.toISOString() : '?'}. Đã nạp vào server (không cần restart).`);
        return { renewed: true, validTo: info && info.validTo };
    }

    async function runRenew(force) {
        state.lastCheck = new Date();
        try {
            const info = readCertInfo();
            let reason = null;
            if (force) reason = 'gia hạn thủ công';
            else if (!info) reason = 'chưa có cert';
            else if (info.missingDomains.length) reason = `cert chưa phủ domain: ${info.missingDomains.join(', ')}`;
            else if (info.daysLeft <= renewBeforeDays) reason = `còn ${info.daysLeft} ngày`;

            if (!reason) {
                if (info.fingerprint !== loadedFingerprint) {
                    onReload({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) });
                    loadedFingerprint = info.fingerprint;
                    log.log(`${tag} Phát hiện cert mới trên đĩa, đã nạp lại.`);
                }
                state.lastResult = `Cert còn ${info.daysLeft} ngày, chưa cần gia hạn.`;
                state.lastError = null;
                return { renewed: false, daysLeft: info.daysLeft };
            }

            log.log(`${tag} Cần gia hạn (${reason}).`);
            const r = await doRenew();
            state.lastResult = r.staging ? 'Chạy thử staging thành công.' : 'Gia hạn thành công.';
            state.lastError = null;
            return r;
        } catch (e) {
            state.lastError = e.message;
            state.lastResult = 'Thất bại';
            log.error(`${tag} Gia hạn thất bại: ${e.message}. Sẽ thử lại sau ${checkEveryHours} giờ.`);
            throw e;
        }
    }

    function renewNow({ force = false } = {}) {
        if (!enabled) return Promise.reject(new Error('Tính năng tự gia hạn SSL đang tắt (thiếu cấu hình).'));
        if (renewing) return renewing;
        renewing = runRenew(force).finally(() => {
            tokens.clear();
            renewing = null;
        });
        return renewing;
    }

    function start() {
        if (!enabled) return;
        const info = readCertInfo();
        loadedFingerprint = info ? info.fingerprint : null;
        if (info) log.log(`${tag} Cert hiện tại hết hạn ${info.validTo.toISOString()} (còn ${info.daysLeft} ngày).`);
        else log.warn(`${tag} Chưa có cert, sẽ tự xin sau 20 giây.`);

        const check = () => renewNow().catch(() => {});
        setTimeout(check, info ? 60 * 1000 : 20 * 1000).unref();
        timer = setInterval(check, checkEveryHours * 3600 * 1000);
        timer.unref();
    }

    function status() {
        const info = readCertInfo();
        return {
            enabled, staging, domains,
            certValidTo: info ? info.validTo : null,
            daysLeft: info ? info.daysLeft : null,
            issuer: info ? info.issuer : null,
            missingDomains: info ? info.missingDomains : domains,
            renewing: !!renewing,
            ...state
        };
    }

    return { challengeHandler, start, renewNow, status };
}

module.exports = { createSslRenewer };