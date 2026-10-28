const axios = require('axios');
const { db } = require('../lib/db');
const { JT_CONFIG } = require('../config/env');
const { jtPics, mapJtStatusByCode, md5ToBase64, toJourneyRow } = require('./jt');
const { logPartReturnEvent } = require('../lib/logger');

function isPartReturnBill(code) {
    return /^\d+-\d{3}$/.test(String(code || ''));
}

const partJourneyLocks = new Map();

function withPartJourneyLock(key, fn) {
    const prev = partJourneyLocks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    partJourneyLocks.set(key, tail);
    tail.then(() => { if (partJourneyLocks.get(key) === tail) partJourneyLocks.delete(key); });
    return run;
}

function upsertPartJourneyRow(childBill, t) {
    return withPartJourneyLock(childBill, () => upsertPartJourneyRowUnsafe(childBill, t));
}

async function upsertPartJourneyRowUnsafe(childBill, t) {
    const parentBill = childBill.replace(/-\d{3}$/, '');
    await db.promise().query(
        `INSERT INTO part_return_journeys
            (child_bill, parent_bill, scantypename, scantime, scanpost, scanward, scancity, scanprov, scanbyname, scanbycontact, issuename, sigpic)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,? FROM DUAL
         WHERE NOT EXISTS (
            SELECT 1 FROM part_return_journeys WHERE child_bill = ? AND scantime <=> ? AND scantypename <=> ?
         )`,
        [childBill, parentBill, t.scantypename, t.scantime, t.scanpost, t.scanward, t.scancity, t.scanprov,
         t.scanbyname, t.scanbycontact, t.issuename, t.sigpic,
         childBill, t.scantime, t.scantypename]
    );
    if (t.sigpic) {
        await db.promise().query(
            `UPDATE part_return_journeys SET sigpic = ?
             WHERE child_bill = ? AND scantime <=> ? AND scantypename <=> ? AND (sigpic IS NULL OR sigpic = '')`,
            [t.sigpic, childBill, t.scantime, t.scantypename]
        );
    }
}

async function createPartReturnOrder(billCode) {
    const childBill = billCode + '-001';
    try {
        await db.promise().query('UPDATE orders SET part_sign = 1 WHERE realjtbillcode = ?', [billCode]);
        const [r] = await db.promise().query(
            `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, realjtbillcode, original_cod, jt_ward, jt_district, jt_prov, sortLine, note, newward, newprov, parent_billcode, created_at)
             SELECT p.user_id, CONCAT(p.order_code, '-001'), p.provider, p.customer_name, p.customer_phone, p.customer_address, p.product_name, 0, 0, p.weight, 'returning', ?, 0, p.jt_ward, p.jt_district, p.jt_prov, p.sortLine, p.note, p.newward, p.newprov, ?, NOW()
             FROM orders p
             WHERE p.realjtbillcode = ?
               AND NOT EXISTS (SELECT 1 FROM orders c WHERE c.realjtbillcode = ?)
             LIMIT 1`,
            [childBill, billCode, billCode, childBill]
        );
    } catch (e) {
        console.error('[Webhook J&T] Lỗi tạo đơn hoàn 1 phần:', e.message);
    }
}

async function fetchPartReturnTrace(childBill) {
    const pkey = JT_CONFIG.pkey;
    const apiAccount = JT_CONFIG.apiAccount;
    const oderjson = JSON.stringify({
        "billCodes": childBill,
        "txlogisticId": "",
        "customerCode": JT_CONFIG.customerCode,
        "password": JT_CONFIG.password,
    });
    const digest = md5ToBase64(oderjson + pkey);
    const params = new URLSearchParams();
    params.append('bizContent', oderjson);

    const response = await axios.post('https://ylopenapi.jtexpress.vn/webopenplatformapi/api/logistics/trace', params, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'apiAccount': apiAccount,
            'digest': digest,
            'timestamp': Date.now().toString()
        },
        timeout: 10000
    });

    const body = response.data;
    if (body.code !== '1' || !Array.isArray(body.data) || body.data.length === 0) {
        return { ok: false, message: body.msg || "J&T chưa có dữ liệu hành trình cho đơn hoàn 1 phần!" };
    }
    const orderTrace = body.data.find(d => d.billCode === childBill) || body.data[0];
    const details = Array.isArray(orderTrace.details) ? orderTrace.details : [];
    if (details.length === 0) {
        return { ok: false, message: "Chưa có hành trình chi tiết cho đơn hoàn 1 phần." };
    }

    const sortedDesc = [...details].sort((a, b) => new Date(String(b.scanTime).replace(' ', 'T')) - new Date(String(a.scanTime).replace(' ', 'T')));
    const trackingData = sortedDesc.map(d => toJourneyRow(d));
    return { ok: true, trackingData, newest: sortedDesc[0], rawCodes: sortedDesc.map(d => `${d.scanTypeCode}:${d.scanTypeName}@${d.scanTime}`), sorted: sortedDesc };
}

async function loadPartJourneyFromDb(childBill) {
    const [rows] = await db.promise().query(
        `SELECT scantypename, scantime, scanpost, scanward, scancity, scanprov, scanbyname, scanbycontact, issuename, sigpic
         FROM part_return_journeys WHERE child_bill = ? ORDER BY scantime DESC, id DESC`,
        [childBill]
    );
    return rows;
}

async function savePartJourneyToDb(childBill, trackingData) {
    for (const t of trackingData) await upsertPartJourneyRow(childBill, t);
}

async function syncPartReturnJourney(childBill) {
    try {
        const r = await fetchPartReturnTrace(childBill);
        if (!r.ok) return { ok: false, message: r.message };
        await savePartJourneyToDb(childBill, r.trackingData);
        let appliedStatus = null;

        for (const d of r.sorted.filter(x => [113, 117].includes(Number(x.scanTypeCode)))) {
            logPartReturnEvent('sync-signed', childBill, {
                code: d.scanTypeCode, scanTime: d.scanTime,
                picKeys: Object.keys(d).filter(k => /pic|image|img|photo|sign/i.test(k)),
                pics: jtPics(d)
            });
        }

        const latest = r.sorted.find(d => mapJtStatusByCode(d.scanTypeCode, null, null));
        if (latest) {
            const mapped = mapJtStatusByCode(latest.scanTypeCode, null, null);
            const traceNewest = String(r.sorted[0].scanTime).replace(' ', 'T');
            const [mxRows] = await db.promise().query('SELECT MAX(scantime) AS m FROM part_return_journeys WHERE child_bill = ?', [childBill]);
            const dbNewest = mxRows[0] && mxRows[0].m;
            if (dbNewest && dbNewest > traceNewest) {
                logPartReturnEvent('sync-status-skip', childBill, { reason: 'trace cũ hơn DB', traceNewest, dbNewest });
            } else {
                const issue = mapped === 'issue' ? (latest.reason || latest.abnormalPieceName || 'Kiện vấn đề') : null;
                const [upd] = await db.promise().query('UPDATE orders SET status = ?, issue = ? WHERE realjtbillcode = ?', [mapped, issue, childBill]);
                logPartReturnEvent('sync-status', childBill, { latest: `${latest.scanTypeCode}:${latest.scanTypeName}@${latest.scanTime}`, mapped, affectedRows: upd.affectedRows });
                appliedStatus = mapped;
            }
        }
        console.log(`[Webhook J&T] Đã đồng bộ hành trình đơn 1 phần ${childBill} vào DB`);
        return { ok: true, mapped: appliedStatus };
    } catch (e) {
        console.error('[Webhook J&T] Lỗi lưu hành trình đơn 1 phần:', e.message);
        return { ok: false, message: e.message };
    }
}

async function syncPartReturnPhotos(childBill, retriesLeft = 1) {
    try {
        const r = await fetchPartReturnTrace(childBill);
        if (!r.ok) throw new Error(r.message || 'Không lấy được hành trình');
        const signed = r.sorted.filter(d => [113, 117].includes(Number(d.scanTypeCode)));
        let withPics = 0;
        for (const d of signed) {
            const row = toJourneyRow(d);
            await upsertPartJourneyRow(childBill, row);
            if (row.sigpic) withPics++;
        }
        logPartReturnEvent('photos', childBill, { signed: signed.length, withPics, retriesLeft });
        if (withPics === 0 && retriesLeft > 0) {
            setTimeout(() => syncPartReturnPhotos(childBill, retriesLeft - 1), 2 * 60 * 1000);
        }
    } catch (e) {
        console.error('[Webhook J&T] Lỗi lấy ảnh đơn 1 phần:', e.message);
        logPartReturnEvent('photos-error', childBill, { message: e.message, retriesLeft });
        if (retriesLeft > 0) setTimeout(() => syncPartReturnPhotos(childBill, retriesLeft - 1), 2 * 60 * 1000);
    }
}

async function getPartReturnJourney(childBill) {
    const saved = await loadPartJourneyFromDb(childBill);
    return { success: true, childBill, trackingData: saved, updatedStatus: null, source: 'db' };
}

async function backfillPartReturnJourneys(all) {
    if (backfillPartReturnJourneys.running) return { started: false, message: 'Tiến trình kéo bù đang chạy, xem logs/partreturn-*.log' };
    const statusFilter = all ? "status <> 'cancel'" : "status NOT IN ('cancel', 'completed', 'returned')";
    const [rows] = await db.promise().query(
        `SELECT realjtbillcode, status FROM orders
         WHERE realjtbillcode REGEXP '^[0-9]+-[0-9]{3}$' AND ${statusFilter}
         ORDER BY created_at DESC`
    );
    backfillPartReturnJourneys.running = true;
    (async () => {
        const stat = { total: rows.length, changed: 0, failed: 0 };
        try {
            for (const row of rows) {
                try {
                    const res = await syncPartReturnJourney(row.realjtbillcode);
                    if (!res || !res.ok) {
                        stat.failed++;
                        logPartReturnEvent('backfill-run', row.realjtbillcode, { ok: false, message: res && res.message });
                    } else if (res.mapped && res.mapped !== row.status) {
                        stat.changed++;
                        logPartReturnEvent('backfill-run', row.realjtbillcode, { from: row.status, to: res.mapped });
                    }
                } catch (e) {
                    stat.failed++;
                    logPartReturnEvent('backfill-run', row.realjtbillcode, { ok: false, message: e.message });
                }
                await new Promise(resolve => setTimeout(resolve, 400));
            }
        } finally {
            backfillPartReturnJourneys.running = false;
            logPartReturnEvent('backfill-done', 'ALL', stat);
            console.log('[Backfill đơn 1 phần] Xong:', JSON.stringify(stat));
        }
    })();
    return { started: true, total: rows.length };
}

module.exports = { backfillPartReturnJourneys, createPartReturnOrder, getPartReturnJourney, isPartReturnBill, loadPartJourneyFromDb, syncPartReturnPhotos, upsertPartJourneyRow };
