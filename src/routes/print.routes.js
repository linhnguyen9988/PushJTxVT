const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const express = require('express');
const { db } = require('../lib/db');
const { isAuth } = require('../middleware/auth');
const { queryOrdersByIds } = require('../services/orders');
const { getLogoBase64, formatSortCode, generateFullHtml, renderLabelsToPdfBuffer, setPrintSkipHeaders, splitPrintableOrders } = require('../services/labels');
const { io } = require('../core/server');

const router = express.Router();

router.get('/api/print-order/:id', async (req, res) => {//hiện tại ko xài cái này, 
    try {
        const [rows] = await db.promise().query('SELECT * FROM orders WHERE realjtbillcode = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).send("Không thấy đơn");

        const order = rows[0];
        const sort = order.sortLine ? order.sortLine.split('-') : ['', '', '', ''];

        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [order.user_id]);
        const user = users[0];
        const barcodeBuffer = await bwipjs.toBuffer({
            bcid: 'code128',
            text: order.realjtbillcode,
            scale: 3,
            height: 10,
            includetext: false,
        });
        const barcodeBase64 = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;

        const qrBase64 = await QRCode.toDataURL(order.realjtbillcode, {
            margin: 1,
            width: 150
        });

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                @page { size: 80mm 80mm; margin: 0; }
                * { box-sizing: border-box; margin: 0; padding: 0; line-height: 1.1; }
                body { width: 80mm; height: 80mm; font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; }
                .label-container { width: 76mm; height: 76mm; border: 2px solid #000; display: flex; flex-direction: column; overflow: hidden; background: #fff; }
                
                /* Barcode */
                .section-barcode { height: 14mm; border-bottom: 2px solid #000; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1mm 0; }
                .barcode-img { width: 85%; height: 8mm; }
                .order-id { font-size: 12px; font-weight: bold; margin-top: 1px; }

                /* Sortline: 620 | B256C03 | 002 */
                .section-sortline { height: 10mm; border-bottom: 2.5px solid #000; display: grid; grid-template-columns: 1fr 1.5fr 1fr; text-align: center; font-weight: bold; }
                .sort-item { display: flex; align-items: center; justify-content: center; border-right: 1.5px solid #000; font-size: 20px; }
                .sort-item:last-child { border-right: none; }
                .sub-code { font-size: 14px; }

                /* Địa chỉ */
                .section-addresses { height: 24mm; border-bottom: 1.5px solid #000; padding: 4px; font-size: 11px; display: flex; flex-direction: column; justify-content: space-around; }

                /* Bottom: Note & QR */
                .section-bottom { height: 20mm; display: grid; grid-template-columns: 1fr 20mm; border-bottom: 2.5px solid #000; }
                .note-box { padding: 3px; font-size: 9px; font-weight: bold; text-transform: uppercase; border-right: 1.5px solid #000; display: flex; align-items: center; text-align: center; }
                .qr-box { display: flex; flex-direction: column; align-items: center; justify-content: center; }
                .qr-img { width: 17mm; height: 17mm; }

                /* COD */
                .section-cod { flex-grow: 1; padding-left: 8px; display: flex; align-items: center; font-size: 15px; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="label-container">
                <div class="section-barcode">
                    <img src="${barcodeBase64}" class="barcode-img">
                    <div class="order-id">${order.realjtbillcode}</div>
                </div>
                <div class="section-sortline">
                    <div class="sort-item">${sort[0]}</div>
                    <div class="sort-item">${sort[1]}</div>
                    <div class="sort-item">${sort[2]}</div>
                </div>
                <div class="section-addresses">
                    <div><b>GỬI: ${user.jt_shopname}</b> - ${user.jt_sdt}</div>
                    <div><b>NHẬN: ${order.customer_name}</b> - ${order.customer_phone}<br>${order.customer_address}</div>
                </div>
                <div class="section-bottom">
                    <div class="note-box">${order.note || 'KHÔNG CHO XEM HÀNG'}<br><br>${order.product_name}</div>
                    <div class="qr-box">
                        <img src="${qrBase64}" class="qr-img">
                    </div>
                </div>
                <div class="section-cod">TIỀN THU HỘ: ${Number(order.price).toLocaleString()} VNĐ</div>
            </div>
            <script>
                window.onload = () => {
                    window.print();
                    window.onafterprint = () => { window.parent.postMessage('close-print-frame', '*'); };
                    setTimeout(() => { window.parent.postMessage('close-print-frame', '*'); }, 2000);
                };
            </script>
        </body>
        </html>`;

        res.send(htmlContent);
    } catch (err) { res.status(500).send(err.message); }
});

router.post('/api/print-orders-multi-mobile', isAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).send("ID không hợp lệ");

        const foundOrders = await queryOrdersByIds(ids);
        if (foundOrders.length === 0) return res.status(404).send("Không thấy đơn nào");

        const { printable: orders, invalid } = splitPrintableOrders(foundOrders, req.app_role);
        setPrintSkipHeaders(res, invalid);
        if (orders.length === 0) return res.status(403).send("Không có đơn nào hợp lệ để in");

        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [orders[0].user_id]);
        const user = users[0] || {};
        const showCod = user.show_cod !== undefined ? user.show_cod : 1;

        const pdfBuffer = await renderLabelsToPdfBuffer(orders, user, showCod);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename=tem-80x80.pdf');
        res.send(pdfBuffer);
    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).send("Lỗi Server");
    }
});

router.post('/api/print-orders-multi-mobile2', isAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).send("Danh sách ID không hợp lệ");

        const foundOrders = await queryOrdersByIds(ids);
        if (foundOrders.length === 0) return res.status(404).send("Không thấy đơn nào");

        const { printable: orders, invalid } = splitPrintableOrders(foundOrders, req.app_role);
        setPrintSkipHeaders(res, invalid);
        if (orders.length === 0) return res.status(403).send("Không có đơn nào hợp lệ để in");

        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [orders[0].user_id]);
        const user = users[0] || {};
        const showCod = user.show_cod !== undefined ? user.show_cod : 1;

        const pdfBuffer = await renderLabelsToPdfBuffer(orders, user, showCod);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename=tem-80x80.pdf');
        res.send(pdfBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi server: " + err.message);
    }
});

router.post('/api/print-orders-multi', isAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).send("Danh sách ID không hợp lệ");

        const foundOrders = await queryOrdersByIds(ids);
        if (foundOrders.length === 0) return res.status(404).send("Không thấy đơn nào");

        const { printable: orders, invalid } = splitPrintableOrders(foundOrders, req.app_role);
        setPrintSkipHeaders(res, invalid);
        if (orders.length === 0) return res.status(403).send("Không có đơn nào hợp lệ để in");

        const firstOrder = orders[0];
        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [firstOrder.user_id]);
        const user = users[0] || {};
        const showCod = user.show_cod !== undefined ? user.show_cod : 1;

        const logoUrl = getLogoBase64() || "https://tvship.vn/logo_tem.png";
        const labels = await Promise.all(orders.map(async (order) => {
            const sort = formatSortCode(order.sortLine);
            const code = order.realjtbillcode || order.order_code;
            const [barcodeBuffer, qrBase64] = await Promise.all([
                bwipjs.toBuffer({ bcid: 'code128', text: code, scale: 3, height: 10, includetext: false }),
                QRCode.toDataURL(code, { margin: 1, width: 150 })
            ]);
            const barcodeBase64 = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;
            return `
            <div class="page-break">
                <div class="label-container">
                    <div class="section-barcode">
                        <div class="logo-box"><img src="${logoUrl}" class="logo-img"></div>
                        <div class="barcode-box">
                            <img src="${barcodeBase64}" class="barcode-img">
                            <div class="order-id">${code}</div>
                        </div>
                    </div>
                    <div class="section-sortline">
                        <div class="sort-item">${sort[0] || ''}</div>
                        <div class="sort-item">${sort[1] || ''}</div>
                        <div class="sort-item">${sort[2] || ''}</div>
                    </div>
                    <div class="section-addresses">
                        <div><b>GỬI: ${user.jt_shopname || 'N/A'} - ${user.jt_sdt || ''}</b></div>
                        <div class="receiver-info">
                            <b>NHẬN: ${order.customer_name} - ${order.customer_phone}</b><br>
                            ${order.customer_address}
                        </div>
                    </div>
                    <div class="section-bottom">
                        <div class="note-box">
                            ${order.note || 'KHÔNG CHO XEM HÀNG'}<br><br>
                            <span style="font-weight:normal; font-size:10px; text-transform: none;">Hàng hóa: ${order.product_name || ''} x ${order.weight} KG</span>
                        </div>
                        <div class="qr-box"><img src="${qrBase64}" class="qr-img"></div>
                    </div>
                    <div class="section-cod">TIỀN THU HỘ: ${Number(order.price).toLocaleString()} VNĐ</div>
                </div>
            </div>`;
        }));
        res.send(generateFullHtml(labels.join(''), true, showCod));
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi server: " + err.message);
    }
});

router.post('/api/orders/get-jt-print-data', isAuth, async (req, res) => {
    try {
        const { orderCodes } = req.body;

        if (!orderCodes || orderCodes.length === 0) {
            return res.json({ success: false, message: "Không có mã đơn" });
        }

        const [rows] = await db.promise().execute(
            `SELECT billcode, base64 FROM jtbill WHERE billcode IN (${orderCodes.map(() => '?').join(',')})`,
            orderCodes
        );

        if (rows.length === 0) {
            return res.json({ success: false, message: "Không tìm thấy dữ liệu in trong jtbill" });
        }

        const printMap = {};
        rows.forEach(row => {
            printMap[row.billcode] = row.base64;
        });

        res.json({ success: true, printData: printMap });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Lỗi server" });
    }
});

router.post('/api/printer-status', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Thiếu userId' });
    const userRoom = `USER_ROOM_${userId}`;
    const clients = io.sockets.adapter.rooms.get(userRoom);
    const online = !!(clients && clients.size > 0);
    res.json({ success: true, online, clients: online ? clients.size : 0 });
});

router.post('/api/print-orders-socket', isAuth, async (req, res) => {
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 300;

    try {
        const { ids, userId } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Danh sách mã đơn không hợp lệ' });
        }
        if (!userId) {
            return res.status(400).json({ success: false, message: 'Thiếu userId' });
        }

        const userRoom = `USER_ROOM_${userId}`;
        const clients = io.sockets.adapter.rooms.get(userRoom);
        if (!clients || clients.size === 0) {
            return res.status(404).json({ success: false, message: 'App C# của bạn chưa Online. Vui lòng mở ứng dụng trên máy tính!' });
        }

        const foundOrders = await queryOrdersByIds(ids);
        if (foundOrders.length === 0) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng nào' });
        }

        const { printable: orders, invalid } = splitPrintableOrders(foundOrders, req.app_role);
        if (orders.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'Không có đơn nào hợp lệ để in',
                skipped: invalid.length
            });
        }

        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [orders[0].user_id]);
        const user = users[0] || {};
        const showCod = user.show_cod !== undefined ? user.show_cod : 1;
        const printerConfig = {
            printerName: user.printer_name || "Xprinter XP-N160II",
            widthMm: 80,
            heightMm: 80,
            marginTopPx: 0
        };

        const totalBatches = Math.ceil(orders.length / BATCH_SIZE);

        res.json({
            success: true,
            message: `Đang xử lý ${orders.length} tem (${totalBatches} batch × ${BATCH_SIZE})...`,
            total: orders.length,
            batches: totalBatches,
            skipped: invalid.length
        });

        (async () => {
            for (let i = 0; i < orders.length; i += BATCH_SIZE) {
                const batch = orders.slice(i, i + BATCH_SIZE);
                const batchIndex = Math.floor(i / BATCH_SIZE) + 1;

                try {
                    const pdfBuffer = await renderLabelsToPdfBuffer(batch, user, showCod);

                    io.to(userRoom).emit("print-now", {
                        base64: pdfBuffer.toString('base64'),
                        config: printerConfig,
                        batchInfo: { current: batchIndex, total: totalBatches, count: batch.length }
                    });

                    console.log(`[Socket Print] User ${userId} — Batch ${batchIndex}/${totalBatches} (${batch.length} tem) — ${clients.size} máy nhận`);
                } catch (batchErr) {
                    console.error(`[Socket Print] Lỗi batch ${batchIndex}:`, batchErr.message);
                    io.to(userRoom).emit("print-error", {
                        message: `Lỗi batch ${batchIndex}/${totalBatches}: ${batchErr.message}`
                    });
                }

                if (i + BATCH_SIZE < orders.length) {
                    await new Promise(r => setTimeout(r, BATCH_DELAY));
                }
            }
            console.log(`[Socket Print] User ${userId} — Hoàn tất ${orders.length} tem / ${totalBatches} batch`);
        })();

    } catch (err) {
        console.error('[Socket Print Error]', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
        }
    }
});

router.post('/api/print-order', (req, res) => {
    const { userId, pdfBase64, printerName } = req.body;

    if (!userId || !pdfBase64) {
        return res.status(400).json({ success: false, message: "Thiếu userId hoặc dữ liệu Base64" });
    }

    const userRoom = `USER_ROOM_${userId}`;

    const clients = io.sockets.adapter.rooms.get(userRoom);
    const isOnline = clients && clients.size > 0;

    if (isOnline) {
        io.to(userRoom).emit("print-now", {
            base64: pdfBase64,
            config: {
                printerName: printerName || "Xprinter XP-N160II",
                widthMm: 75,
                heightMm: 82,
                marginTopPx: -5
            }
        });

        //console.log(`[Lệnh in] Đã đẩy xuống User ${userId} (${clients.size} máy nhận)`);
        res.json({ success: true, message: "Đã gửi lệnh in" });
    } else {
        console.log(`[Lệnh in] Thất bại. User ${userId} chưa bật App C#`);
        res.status(404).json({ success: false, message: "Máy in của User chưa Online" });
    }
});

module.exports = router;
