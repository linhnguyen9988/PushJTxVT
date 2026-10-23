const axios = require('axios');
const express = require('express');
const { db } = require('../lib/db');
const { getPartReturnJourney, isPartReturnBill, loadPartJourneyFromDb } = require('../services/partReturn');
const { JT_CONFIG } = require('../config/env');
const { mapJtStatusFromTrace, md5ToBase64 } = require('../services/jt');

const router = express.Router();

router.get('/api/viettel/trace', async (req, res) => {
    const username = req.app_user;
    if (!username) return res.status(401).json({ success: false, msg: "Chưa đăng nhập" });

    const { billCode } = req.query;
    if (!billCode) return res.json({ success: false, msg: "Thiếu mã vận đơn" });

    try {
        const [tokenRows] = await db.promise().query(
            "SELECT vtp_token FROM viettel_connect LIMIT 1", [username]
        );

        if (!tokenRows.length || !tokenRows[0].vtp_token) {
            return res.json({ success: false, msg: "Chưa cấu hình Token Viettel!" });
        }

        const vtpToken = tokenRows[0].vtp_token;
        const queryUrl = `https://partner.viettelpost.vn/v2/order/detail-v2?o=${billCode}`;

        const response = await axios.get(encodeURI(queryUrl), {
            headers: { 'Content-Type': 'application/json', 'token': vtpToken },
            timeout: 3000
        });

        const body = response.data;
        if (body.error === true) return res.json({ success: false, msg: 'Token Viettel lỗi/hết hạn' });

        let status = body.data ? body.data.ORDER_STATUS : 100;
        const statusMap = {
            100: 'pending', 101: 'cancel', 102: 'pending', 105: 'picked_up',
            107: 'cancel', 300: 'Đang vận chuyển', 501: 'Thành công', 504: 'Đã trả hàng'
        };
        let text = statusMap[status] || 'Đang xử lý';

        if (body.data) {
            await db.promise().query(
                'UPDATE orders SET status=?, price=? WHERE order_code=?',
                [text, body.data.MONEY_COLLECTION, body.data.ORDER_NUMBER]
            );
        }

        return res.json({
            success: true,
            code: '1',
            data: { status: text, note: body.data ? `COD: ${body.data.MONEY_COLLECTION.toLocaleString('vi-VN')} đ` : '', details: [] }
        });

    } catch (err) {
        console.error("Lỗi Viettel:", err.message);
        return res.json({ success: false, msg: "Lỗi kết nối Viettel Post" });
    }
});

router.get('/api/orders/track-jt/:billCode', async (req, res) => {
    try {
        const { billCode } = req.params;
        const [orderInfo] = await db.promise().execute(
            `SELECT status, provider FROM orders WHERE realjtbillcode = ? OR order_code = ? LIMIT 1`,
            [billCode, billCode]
        );
        // Đơn hoàn 1 phần (mã cũ-001): hành trình nằm ở part_return_journeys, không phải jtwaybill
        if (isPartReturnBill(billCode)) {
            return res.json({
                success: true,
                currentStatus: orderInfo[0]?.status || 'N/A',
                trackingData: await loadPartJourneyFromDb(billCode)
            });
        }
        const [trackingData] = await db.promise().execute(
            `SELECT * FROM jtwaybill WHERE billcode = ? ORDER BY id DESC`,
            [billCode]
        );
        res.json({
            success: true,
            currentStatus: orderInfo[0]?.status || 'N/A',
            trackingData: trackingData
        });
    } catch (error) {
        console.error("Lỗi lấy hành trình:", error);
        res.status(500).json({ success: false });
    }
});

router.post('/api/orders/part-return/:billCode', async (req, res) => {
    const parentBill = String(req.params.billCode || '').trim();
    if (!/^\d+$/.test(parentBill)) return res.json({ success: false, message: "Mã vận đơn không hợp lệ" });
    const childBill = parentBill + '-001';

    try {
        return res.json(await getPartReturnJourney(childBill));
    } catch (err) {
        console.error("Lỗi Trace J&T đơn 1 phần:", err.message);
        return res.status(500).json({ success: false, message: "Lỗi hệ thống khi tra hành trình đơn 1 phần!" });
    }
});

router.post('/api/orders/track-jt/:billCode/refresh', async (req, res) => {
    const { billCode } = req.params;
    if (!billCode) return res.json({ success: false, message: "Thiếu mã vận đơn" });

    if (isPartReturnBill(billCode)) {
        try {
            return res.json(await getPartReturnJourney(billCode));
        } catch (err) {
            console.error("Lỗi Trace J&T đơn 1 phần:", err.message);
            return res.status(500).json({ success: false, message: "Lỗi hệ thống khi tra hành trình đơn 1 phần!" });
        }
    }

    // Đơn hoàn 1 phần (mã cũ-001): không ghi vào jtwaybill, dùng luồng riêng
    if (isPartReturnBill(billCode)) {
        try {
            return res.json(await getPartReturnJourney(billCode));
        } catch (err) {
            console.error("Lỗi Trace J&T đơn 1 phần:", err.message);
            return res.status(500).json({ success: false, message: "Lỗi hệ thống khi tra hành trình đơn 1 phần!" });
        }
    }

    try {
        const pkey = JT_CONFIG.pkey;
        const apiAccount = JT_CONFIG.apiAccount;

        const oderjson = JSON.stringify(
            {
                "billCodes": billCode,
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
            return res.json({ success: false, message: body.msg || "J&T chưa có dữ liệu hành trình cho đơn này!" });
        }

        const orderTrace = body.data.find(d => d.billCode === billCode) || body.data[0];
        const details = Array.isArray(orderTrace.details) ? orderTrace.details : [];

        if (details.length === 0) {
            return res.json({ success: false, message: "Chưa có hành trình chi tiết cho đơn này." });
        }

        const sortedAsc = [...details].sort((a, b) => new Date(a.scanTime) - new Date(b.scanTime));
        const newest = sortedAsc[sortedAsc.length - 1];

        const insertSql = `INSERT INTO jtwaybill
            (billcode, scanbycode, scanbycontact, scanbyname, scanward, scancity, scanprov, scanpost, scantime, scantypename, issuename, sigpic)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

        const conn = await db.promise().getConnection();
        try {
            await conn.beginTransaction();
            await conn.query('DELETE FROM jtwaybill WHERE billcode = ?', [billCode]);

            for (const d of sortedAsc) {
                let scanbyphone = d.staffContact || null;
                if (scanbyphone) scanbyphone = scanbyphone.replace('+84', '0');

                let picsArr = [];
                if (Array.isArray(d.pictureUrl)) picsArr = d.pictureUrl;
                else if (d.pictureUrl) picsArr = [d.pictureUrl];
                else if (Array.isArray(d.sigPicUrl)) picsArr = d.sigPicUrl;
                else if (d.sigPicUrl) picsArr = [d.sigPicUrl];
                picsArr = picsArr.filter(u => typeof u === 'string' && u.trim() !== '');
                const sigpicValue = picsArr.length > 0 ? JSON.stringify(picsArr) : null;

                await conn.query(insertSql, [
                    billCode,
                    null,
                    scanbyphone,
                    d.staffName || null,
                    d.scanNetworkArea || null,
                    d.scanNetworkCity || null,
                    d.scanNetworkProvince || null,
                    d.scanNetworkName || null,
                    d.scanTime,
                    d.scanTypeName || 'Cập nhật hành trình',
                    d.reason || null,
                    sigpicValue
                ]);
            }

            await conn.commit();
        } catch (dbErr) {
            await conn.rollback();
            throw dbErr;
        } finally {
            conn.release();
        }

        const [trackingData] = await db.promise().execute(
            `SELECT * FROM jtwaybill WHERE billcode = ? ORDER BY id DESC`,
            [billCode]
        );

        let updatedStatus = null;
        let updatedIssue = null;
        const mappedStatus = mapJtStatusFromTrace(newest.scanTypeName, newest.desc);

        if (mappedStatus) {
            let updateSql = null;
            let updateParams = null;

            switch (mappedStatus) {
                case 'cancel':
                    updateSql = "UPDATE orders SET status='cancel' WHERE realjtbillcode=?";
                    updateParams = [billCode];
                    break;
                case 'picked_up':
                    updateSql = `UPDATE orders SET status='picked_up', pickup_date = COALESCE(pickup_date, NOW())
                        WHERE realjtbillcode=? AND status NOT IN ('completed','cancel','returned')`;
                    updateParams = [billCode];
                    break;
                case 'delivering':
                    updateSql = `UPDATE orders SET status='delivering', issue=NULL, pickup_date = COALESCE(pickup_date, NOW())
                        WHERE realjtbillcode=? AND status NOT IN ('completed','cancel','returned')`;
                    updateParams = [billCode];
                    break;
                case 'out_for_delivery':
                    updateSql = `UPDATE orders SET status='out_for_delivery', issue=NULL
                        WHERE realjtbillcode=? AND status NOT IN ('completed','cancel','returned')`;
                    updateParams = [billCode];
                    break;
                case 'completed':
                    updateSql = "UPDATE orders SET status='completed', issue=NULL WHERE realjtbillcode=?";
                    updateParams = [billCode];
                    break;
                case 'returning':
                    updateSql = "UPDATE orders SET status='returning', issue=NULL WHERE realjtbillcode=?";
                    updateParams = [billCode];
                    break;
                case 'returned':
                    updateSql = "UPDATE orders SET status='returned', issue=NULL WHERE realjtbillcode=?";
                    updateParams = [billCode];
                    break;
                case 'issue':
                    updatedIssue = newest.reason || newest.desc || newest.scanTypeName || 'Kiện vấn đề';
                    updateSql = "UPDATE orders SET status='issue', issue=? WHERE realjtbillcode=?";
                    updateParams = [updatedIssue, billCode];
                    break;
            }

            if (updateSql) {
                try {
                    const [updResult] = await db.promise().query(updateSql, updateParams);
                    if (updResult.affectedRows > 0) {
                        updatedStatus = mappedStatus;
                    }
                } catch (updErr) {
                    console.error('[Refresh J&T] Lỗi cập nhật trạng thái đơn:', updErr.message);
                }
            }
        }

        return res.json({
            success: true,
            message: "Đã cập nhật hành trình mới nhất!",
            trackingData,
            updatedStatus,
            updatedIssue
        });

    } catch (err) {
        console.error("Lỗi Trace J&T:", err.message);
        return res.status(500).json({ success: false, message: "Lỗi hệ thống khi tra hành trình!" });
    }
});

module.exports = router;
