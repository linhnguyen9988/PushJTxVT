const express = require('express');
const { logPartReturnEvent, logPartSignToFile } = require('../lib/logger');
const { createPartReturnOrder, isPartReturnBill, syncPartReturnPhotos, upsertPartJourneyRow } = require('../services/partReturn');
const { db } = require('../lib/db');
const { mapJtStatusByCode, toJourneyRow } = require('../services/jt');

const router = express.Router();

router.post('/ghn', function (req, res) {
    console.log(req.body)
    res.sendStatus(200);
});

router.post('/jtex', function (req, res) {
    res.json({ "code": "1", "msg": "success", "data": null });

    try {
        const { bizContent } = req.body;
        if (!bizContent) return;

        const data = JSON.parse(bizContent);
        const billCode = data.billCode;
        const details = data.details[0];
        const partSign = Number(details?.partSign?? data?.partSign?? 0)
        if (partSign === 1) {
            console.log(`[Webhook J&T] KÝ NHẬN 1 PHẦN (partSign=1) - Bill: ${billCode}`);
            logPartSignToFile(billCode, partSign, details);
            if (!isPartReturnBill(billCode)) createPartReturnOrder(billCode);
        }
        //console.log('nhan wh: '+billCode) //lau lau no ko nhan dc webhook vi chay node app.js chua hieu tai sao
        const statusMapVn = {
            103: "Tạo đơn thành công",
            105: "Đã hủy đơn",
            106: "Bưu tá đã lấy hàng",
            109: "Xuất kho trung chuyển",
            110: "Hàng đã đến bưu cục",
            112: "Đang giao hàng",
            113: "Giao hàng thành công",
            116: "Đang chuyển hoàn",
            117: "Đã ký nhận hoàn trả",
            118: "Kiện vấn đề (Giao)",
            120: "Kiện vấn đề (Hoàn)"
        };
        let currentTypeName = statusMapVn[details.scanTypeCode] || details.scanTypeName || "Hành trình mới";
        if (currentTypeName == '中心到件') currentTypeName = 'Hàng đến TTKT';
        else if (currentTypeName == '取件失败') currentTypeName = 'Nhận hàng không thành công';

        let scanbyphone = details.staffContact || details.scanByContact || null;
        if (scanbyphone) scanbyphone = scanbyphone.replace("+84", "0");

        let picsArr = [];
        if (Array.isArray(details.pictureUrl)) picsArr = details.pictureUrl;
        else if (details.pictureUrl) picsArr = [details.pictureUrl];
        else if (Array.isArray(details.sigPicUrl)) picsArr = details.sigPicUrl;
        else if (details.sigPicUrl) picsArr = [details.sigPicUrl];
        picsArr = picsArr.filter(u => typeof u === 'string' && u.trim() !== '');
        const sigpicValue = picsArr.length > 0 ? JSON.stringify(picsArr) : null;

        const waybillParams = [
            billCode,
            details.scanByCode || null,
            scanbyphone,
            details.staffName || details.scanByName || null,
            details.scanNetworkArea || null,
            details.scanNetworkCity || null,
            details.scanNetworkProvince || null,
            details.scanNetworkName || null,
            details.scanTime,
            currentTypeName,
            details.reason || details.abnormalPieceName || null,
            sigpicValue,
        ];
        if (sigpicValue) {
            console.log("[Webhook J&T] Nhận " + picsArr.length + " ảnh cho billCode " + billCode);
        }
        const sqlInsertWaybill = `INSERT INTO jtwaybill
            (billcode, scanbycode, scanbycontact, scanbyname, scanward, scancity, scanprov, scanpost, scantime, scantypename, issuename, sigpic)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

        if (!isPartReturnBill(billCode)) {
            db.query(sqlInsertWaybill, waybillParams, (err) => {
                if (err) console.error('[Webhook J&T] Lỗi INSERT jtwaybill:', err);
            });
        } else {
            upsertPartJourneyRow(billCode, toJourneyRow(details))
                .catch(e => console.error('[Webhook J&T] Lỗi lưu hành trình đơn 1 phần:', e.message));
        }

        const scanCode = Number(details.scanTypeCode);
        let updateSql = "";
        let params = [];

        switch (scanCode) {
            case 103:
                updateSql = "UPDATE orders SET status = 'pending' WHERE realjtbillcode =?";
                params = [billCode];
                break;

            case 105:
                updateSql = "UPDATE orders SET status = 'cancel' WHERE realjtbillcode =?";
                params = [billCode];
                break;

            case 106:
                updateSql = "UPDATE orders SET status = 'picked_up', pickup_date = NOW() WHERE realjtbillcode =?";
                params = [billCode];
                //updateSql = "UPDATE orders SET status = 'picked_up', weight =?, pickup_date = NOW() WHERE realjtbillcode =?";
                //params = [details.weight || 0, billCode];
                break;

            case 109:
            case 110:
                updateSql = `UPDATE orders
                    SET status = 'delivering', issue = null,
                        pickup_date = COALESCE(pickup_date, NOW())
                    WHERE realjtbillcode =? AND status NOT IN ('completed', 'cancel', 'returned')`;
                params = [billCode];
                break;

            case 112:
                updateSql = `UPDATE orders
                    SET status = 'out_for_delivery', issue = null
                    WHERE realjtbillcode =? AND status NOT IN ('completed', 'cancel', 'returned')`;
                params = [billCode];
                break;

            case 113:
                updateSql = `UPDATE orders
                    SET status = 'completed', issue = null WHERE realjtbillcode =?`;
                params = [billCode];
                break;

            case 116:
                updateSql = `UPDATE orders
                    SET status = 'returning', issue = null
                    WHERE realjtbillcode =? AND status NOT IN ('completed', 'cancel', 'returned')`;
                params = [billCode];
                break;

            case 117:
                updateSql = `UPDATE orders
                    SET status = 'returned', issue = null
                    WHERE realjtbillcode =?`;
                params = [billCode];
                break;

            case 118:
            case 120:
                updateSql = `UPDATE orders
                    SET status = 'issue', issue =?
                    WHERE realjtbillcode =?`;
                params = [details.abnormalPieceName, billCode];
                break;

            default:
            //console.log(details.scanTypeName);
        }

        if (isPartReturnBill(billCode)) {
            logPartReturnEvent('webhook', billCode, {
                scanTypeCode: details.scanTypeCode, scanTypeName: details.scanTypeName, desc: details.desc,
                mappedStatus: mapJtStatusByCode(details.scanTypeCode, details.scanTypeName, details.desc),
                switchHandled: !!updateSql, raw: details
            });
        }

        if (updateSql) {
            db.query(updateSql, params, (err, result) => {
                if (isPartReturnBill(billCode)) {
                    logPartReturnEvent('webhook-update', billCode, { err: err ? err.message : null, affectedRows: result ? result.affectedRows : null });
                }
                if (err) {
                    console.error('[Webhook J&T] Lỗi thực thi SQL:', err.message);
                } else if (result.affectedRows === 0) {
                    console.warn(`[Webhook J&T] KHÔNG TÌM THẤY đơn hàng. Bill: ${billCode}`);
                }
            });
        }
        
        if (isPartReturnBill(billCode) && (scanCode === 113 || scanCode === 117)) {
            if (!toJourneyRow(details).sigpic) setTimeout(() => syncPartReturnPhotos(billCode), 3000);
        }

        if (scanCode >= 106 && scanCode !== 105) {
            db.query(
                "UPDATE orders SET pickup_date = COALESCE(pickup_date, NOW()) WHERE realjtbillcode =? AND pickup_date IS NULL",
                [billCode]
            );
        }

    } catch (error) {
        console.error('Lỗi Webhook J&T:', error);
    }
});

module.exports = router;
