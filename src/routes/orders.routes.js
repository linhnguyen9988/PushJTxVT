const ExcelJS = require('exceljs');
const axios = require('axios');
const express = require('express');
const { db } = require('../lib/db');
const { getBadge } = require('../utils/orderStatus');
const { isAuth } = require('../middleware/auth');
const { createOrderCore } = require('../services/orders');
const { BULK_COLUMNS, BULK_MAX_ROWS, buildBulkTemplate, normalizeBulkRow, parseBulkWorkbook, uploadBulkExcel } = require('../services/bulkOrders');
const { resolveAddress } = require('../services/address');
const { GHN_CONFIG, JT_CONFIG } = require('../config/env');
const { md5ToBase64 } = require('../services/jt');

const router = express.Router();

router.get('/orders', async (req, res) => {
    if (!req.app_user) return res.redirect('/login');
    const username = req.app_user;
    const { search, status, provider, startDate, endDate, dateType, printed } = req.query;
    const dateField = dateType === 'pickup' ? 'pickup_date' : 'created_at';

    try {
        const [userRows] = await db.promise().query(`SELECT id FROM users WHERE username = ?`, [username]);
        if (userRows.length === 0) return res.redirect('/login');
        const userId = userRows[0].id;

        let baseConditions = ["user_id =?"];
        let baseParams = [userId];
        baseConditions.push("(parent_billcode IS NULL OR parent_billcode = '')");

        if (startDate && endDate) {
            baseConditions.push(`DATE(${dateField}) BETWEEN ? AND ?`);
            baseParams.push(startDate, endDate);
        } else if (!search) {
            baseConditions.push(`DATE(${dateField}) >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`);
        }

        let multiCodes2 = null;
        if (search) {
            const codes = search.split(',').map(s => s.trim()).filter(Boolean);
            if (codes.length > 1) {
                multiCodes2 = codes;
                const placeholders = codes.map(() => '?').join(',');
                baseConditions.push(`(order_code IN (${placeholders}) OR realjtbillcode IN (${placeholders}))`);
                baseParams.push(...codes, ...codes);
            } else if (search.length <= 6) {
                baseConditions.push("customer_phone LIKE?");
                baseParams.push(`%${search}`);
            } else {
                baseConditions.push("(customer_phone LIKE? OR order_code LIKE? OR realjtbillcode LIKE? OR customer_name LIKE?)");
                const s = `%${search}%`;
                baseParams.push(s, s, s, s);
            }
        }
        if (provider) {
            baseConditions.push("provider =?");
            baseParams.push(provider);
        }

        const baseSql = baseConditions.length > 0 ? " WHERE " + baseConditions.join(" AND ") : "";

        const [countRows] = await db.promise().query(
            `SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status IN ('picked_up', 'delivering') THEN 1 ELSE 0 END) as shipping,
                SUM(CASE WHEN status = 'out_for_delivery' THEN 1 ELSE 0 END) as delivery,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status IN ('returning', 'returned') THEN 1 ELSE 0 END) as returned,
                SUM(CASE WHEN status = 'issue' THEN 1 ELSE 0 END) as issue,
                SUM(CASE WHEN status = 'cancel' THEN 1 ELSE 0 END) as cancel,
                SUM(CASE WHEN is_printed > 0 THEN 1 ELSE 0 END) as printed,
                SUM(CASE WHEN is_printed = 0 THEN 1 ELSE 0 END) as not_printed
            FROM orders ${baseSql}`,
            baseParams
        );
        const counts = countRows[0] || { total: 0, pending: 0, shipping: 0, delivery: 0, completed: 0, returned: 0, issue: 0, cancel: 0, printed: 0, not_printed: 0 };

        let finalConditions = [...baseConditions];
        let finalParams = [...baseParams];

        if (status) {
            if (status === 'delivering') {
                finalConditions.push("status IN ('picked_up', 'delivering')");
            } else if (status === 'returned') {
                finalConditions.push("status IN ('returning', 'returned')");
            } else {
                finalConditions.push("status = ?");
                finalParams.push(status);
            }
        }

        if (printed === '1') {
            finalConditions.push("is_printed > 0");
        } else if (printed === '0') {
            finalConditions.push("is_printed = 0");
        }

        const finalWhereClause = " WHERE " + finalConditions.join(" AND ");

        let finalSql;
        let finalSqlParams;
        if (multiCodes2 && multiCodes2.length > 1) {
            const fp = multiCodes2.map(() => '?').join(',');
            finalSql = `SELECT * FROM orders ${finalWhereClause} ORDER BY FIELD(order_code, ${fp}), FIELD(realjtbillcode, ${fp})`;
            finalSqlParams = [...finalParams, ...multiCodes2, ...multiCodes2];
        } else {
            finalSql = `SELECT * FROM orders ${finalWhereClause} ORDER BY created_at DESC`;
            finalSqlParams = [...finalParams];
        }

        const isFiltering = !!(search || status || provider || startDate || endDate || printed !== undefined);

        const [orders] = await db.promise().query(finalSql, finalSqlParams);

        const [fullUser] = await db.promise().query(`SELECT * FROM users WHERE id = ?`, [userId]);
        const [customerRows] = await db.promise().query('SELECT * FROM customers WHERE user_id = ?', [userId]);
        const [noteRows] = await db.promise().query('SELECT content FROM order_notes WHERE user_id = ? ORDER BY created_at DESC', [userId]);
        const [productRows] = await db.promise().query('SELECT product_name FROM order_products WHERE user_id = ? ORDER BY created_at DESC', [userId]);

        res.render('orders', {
            getBadge,
            orders,
            stats: fullUser[0] || {},
            counts,
            customers: customerRows || [],
            notes: noteRows || [],
            products: productRows || [],
            search: search || '',
            status: status || '',
            provider: provider || '',
            startDate: startDate || '',
            endDate: endDate || '',
            dateType: dateType || 'created',
            printed: printed !== undefined ? printed : '',
            isFiltering,
            use_socket_print: fullUser[0] ? (fullUser[0].use_socket_print || 0) : 0,
            user: username,
            active: 'orders'
        });

    } catch (err) {
        console.error("Lỗi:", err);
        res.status(500).send("Lỗi hệ thống");
    }
});

router.get('/part-orders', async (req, res) => {
    if (!req.app_user) return res.redirect('/login');
    const username = req.app_user;
    const { search, status, startDate, endDate } = req.query;

    try {
        const [userRows] = await db.promise().query(`SELECT * FROM users WHERE username = ?`, [username]);
        if (userRows.length === 0) return res.redirect('/login');
        const userId = userRows[0].id;

        const conditions = ["user_id = ?", "parent_billcode IS NOT NULL", "parent_billcode <> ''"];
        const params = [userId];

        if (startDate && endDate) {
            conditions.push("DATE(created_at) BETWEEN ? AND ?");
            params.push(startDate, endDate);
        }
        if (search) {
            const s = `%${search.trim()}%`;
            conditions.push("(order_code LIKE ? OR realjtbillcode LIKE ? OR parent_billcode LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)");
            params.push(s, s, s, s, s);
        }

        const baseSql = " WHERE " + conditions.join(" AND ");
        const [countRows] = await db.promise().query(
            `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('pending','picked_up','delivering') THEN 1 ELSE 0 END) AS shipping,
                SUM(CASE WHEN status = 'out_for_delivery' THEN 1 ELSE 0 END) AS delivery,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status IN ('returning','returned') THEN 1 ELSE 0 END) AS returned,
                SUM(CASE WHEN status = 'issue' THEN 1 ELSE 0 END) AS issue
             FROM orders ${baseSql}`, params
        );
        const counts = countRows[0] || {};

        const finalConditions = [...conditions];
        const finalParams = [...params];
        if (status) {
            if (status === 'shipping') finalConditions.push("status IN ('pending','picked_up','delivering')");
            else if (status === 'returned') finalConditions.push("status IN ('returning','returned')");
            else { finalConditions.push("status = ?"); finalParams.push(status); }
        }

        const [orders] = await db.promise().query(
            `SELECT * FROM orders WHERE ${finalConditions.join(' AND ')} ORDER BY created_at DESC LIMIT 500`,
            finalParams
        );

        res.render('part_orders', {
            orders,
            counts,
            search: search || '',
            status: status || '',
            startDate: startDate || '',
            endDate: endDate || '',
            use_socket_print: userRows[0].use_socket_print || 0,
            user: username,
            active: 'part_orders'
        });
    } catch (err) {
        console.error("Lỗi trang đơn 1 phần:", err);
        res.status(500).send("Lỗi hệ thống");
    }
});

router.get('/api/orders', isAuth, async (req, res) => {
    try {
        const username = req.app_user;

        const [userRows] = await db.promise().query(`SELECT id FROM users WHERE username = ?`, [username]);
        if (userRows.length === 0) return res.status(404).json([]);

        const userId = userRows[0].id;
        const [orders] = await db.promise().query(
            `SELECT * FROM orders WHERE user_id = ? AND (parent_billcode IS NULL OR parent_billcode = '') ORDER BY created_at DESC LIMIT 50`,
            [userId]
        );

        res.json(orders);
    } catch (err) {
        res.status(500).json([]);
    }
});

router.post('/api/orders/create', isAuth, async (req, res) => {
    const { status, ...payload } = await createOrderCore(req.app_user, req.body);
    return res.status(status || 200).json(payload);
});

router.get('/api/orders/bulk-template', isAuth, async (req, res) => {
    try {
        const wb = await buildBulkTemplate();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="mau-len-don-hang-loat.xlsx"');
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Lỗi tạo file mẫu:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Không tạo được file mẫu: ' + err.message });
    }
});

router.post('/api/orders/bulk-parse', isAuth, (req, res, next) => {
    uploadBulkExcel.single('file')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File quá lớn (tối đa 5MB).' : 'Lỗi upload: ' + err.message;
            return res.json({ success: false, message: msg });
        }
        next();
    });
}, async (req, res) => {
    if (!req.file) return res.json({ success: false, message: 'Chưa chọn file.' });
    if (!/\.xlsx$/i.test(req.file.originalname || '')) {
        return res.json({ success: false, message: 'Chỉ nhận file .xlsx (Excel 2007 trở lên).' });
    }
    try {
        const result = await parseBulkWorkbook(req.file.buffer);
        if (result.error) return res.json({ success: false, message: result.error });
        return res.json({ success: true, rows: result.rows });
    } catch (err) {
        console.error('Lỗi đọc file Excel:', err.message);
        return res.json({ success: false, message: 'Không đọc được file Excel, file có thể bị hỏng hoặc sai định dạng.' });
    }
});

router.post('/api/orders/bulk-create-one', isAuth, async (req, res) => {
    const username = req.app_user;
    const { data, error } = normalizeBulkRow(req.body || {});
    if (error) return res.json({ success: false, message: error });
    const withRow = (payload) => ({ ...payload, normalized: data });

    try {
        const addr = await resolveAddress(data.address, data.customer_name, data.customer_phone, username);
        if (!addr.success) return res.json(withRow({ success: false, message: addr.message }));

        const [userRows] = await db.promise().query(
            'SELECT jt_shopname, jt_sdt, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov FROM users WHERE username = ?',
            [username]
        );
        const u = userRows[0] || {};

        const { status, ...payload } = await createOrderCore(username, {
            ...data,
            cod: String(data.cod),
            province: addr.data.prov,
            district: addr.data.district,
            ward: addr.data.ward,
            newward: addr.data.newward,
            newprov: addr.data.newprov,
            is_new_address: false,
            jt_shopname: u.jt_shopname,
            jt_sdt: u.jt_sdt,
            jt_shopaddress: u.jt_shopaddress,
            jt_shop_ward: u.jt_shop_ward,
            jt_shop_district: u.jt_shop_district,
            jt_shop_prov: u.jt_shop_prov
        });
        return res.status(status || 200).json(withRow(payload));
    } catch (err) {
        console.error('Lỗi bulk-create-one:', err.message);
        return res.status(500).json({ success: false, message: 'Lỗi hệ thống: ' + err.message });
    }
});

router.post('/api/orders/bulk-error-file', isAuth, async (req, res) => {
    try {
        const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows.slice(0, BULK_MAX_ROWS) : [];
        if (rows.length === 0) return res.status(400).json({ success: false, message: 'Không có đơn lỗi để xuất.' });

        const wb = await buildBulkTemplate();
        const ws = wb.getWorksheet('Đơn hàng');
        const reasonCol = BULK_COLUMNS.length + 1;
        ws.getColumn(reasonCol).width = 60;

        const hc = ws.getRow(1).getCell(reasonCol);
        hc.value = 'Lý do lỗi (tự bỏ qua khi upload lại)';
        hc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } };
        hc.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

        rows.forEach((r, i) => {
            const row = ws.getRow(i + 2);
            BULK_COLUMNS.forEach((c, idx) => {
                let v = r[c.key];
                if (c.key === 'is_partial_delivery') v = Number(v) === 0 ? 'Không' : 'Có';
                if (c.key === 'cod') v = Number(v) || 0;
                row.getCell(idx + 1).value = (v === undefined || v === null) ? '' : v;
            });
            const rc = row.getCell(reasonCol);
            rc.value = String(r.message || '').slice(0, 1000);
            rc.font = { bold: true, color: { argb: 'FFC00000' } };
            rc.alignment = { wrapText: true, vertical: 'top' };
            for (let c = 1; c <= reasonCol; c++) {
                row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2E2' } };
            }
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="don-hang-loi.xlsx"');
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Lỗi xuất file đơn lỗi:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Không xuất được file: ' + err.message });
    }
});

router.post('/api/orders/cancel', isAuth, async (req, res) => {
    const { order_code, provider } = req.body;
    const role = req.app_role;

    try {
        if (provider === "NB") {
            if (role !== 'admin') return res.status(403).json({ success: false, message: "Chỉ Admin mới được hủy đơn nội bộ!" });

            const [nbRows] = await db.promise().query('SELECT status FROM orders WHERE order_code = ?', [order_code]);
            if (nbRows.length === 0) return res.status(404).json({ success: false, message: "Không tìm thấy đơn hàng!" });
            if (nbRows[0].status !== 'pending') {
                return res.status(400).json({ success: false, message: "Chỉ được hủy đơn ở trạng thái Chờ lấy hàng!" });
            }

            await db.promise().query('UPDATE orders SET status = "cancel" WHERE order_code = ?', [order_code]);
            return res.json({ success: true, message: "Đã hủy đơn nội bộ thành công!" });

        } else if (provider === "Viettel") {
            const [vtpRows] = await db.promise().query('SELECT vtp_token FROM viettel_connect WHERE id = 1');
            const vtpConfig = vtpRows[0];
            if (!vtpConfig?.vtp_token) return res.json({ success: false, message: "Hệ thống chưa cấu hình Token!" });

            const response = await axios.post('https://partner.viettelpost.vn/v2/order/UpdateOrder', {
                "TYPE": 4,
                "ORDER_NUMBER": order_code,
                "NOTE": "Shop hủy đơn"
            }, {
                headers: { 'Content-Type': 'application/json', 'token': vtpConfig.vtp_token },
                timeout: 10000
            });

            if (response.data.status === 200) {
                await db.promise().query('UPDATE orders SET status = "cancel" WHERE order_code = ?', [order_code]);
                return res.json({ success: true, message: "Đã hủy đơn thành công trên Viettel" });
            }
            return res.json({ success: false, message: response.data.message || "Viettel từ chối hủy" });

        } else if (provider === "J&T") {
            const pkey = JT_CONFIG.pkey;
            const apiAccount = JT_CONFIG.apiAccount;
            const oderjson = JSON.stringify({
                "customerCode": JT_CONFIG.customerCode,
                "password": JT_CONFIG.password,
                "txlogisticId": order_code,
                "reason": "Shop hủy đơn"
            });
            const digest = md5ToBase64(oderjson + pkey);

            const params = new URLSearchParams();
            params.append('bizContent', oderjson);

            const response = await axios.post('https://ylopenapi.jtexpress.vn/webopenplatformapi/api/order/cancelOrder', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'apiAccount': apiAccount,
                    'digest': digest,
                    'timestamp': Date.now().toString()
                },
                timeout: 10000
            });

            const body = response.data;
            if (body.msg === 'success' || (body.data && body.data.success === 'true')) {
                await db.promise().query('UPDATE orders SET status = "cancel" WHERE order_code = ?', [order_code]);
                return res.json({ success: true, message: "Đã hủy đơn thành công trên J&T" });
            } else {
                let mess = body.msg || "Lỗi không xác định";
                if (mess.includes('order status can not be cancel')) mess = 'Không thể hủy đơn đã hủy hoặc đang vận chuyển!';
                return res.json({ success: false, message: "J&T báo: " + mess });
            }
        } else if (provider === "GHN") {
            const ghn_token = GHN_CONFIG.token;
            const ghn_shopid = GHN_CONFIG.shopId;

            const response = await axios.post('https://online-gateway.ghn.vn/shiip/public-api/v2/switch-status/cancel',
                {
                    "order_codes": [order_code]
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'ShopId': ghn_shopid,
                        'Token': ghn_token
                    },
                    timeout: 5000
                });

            const result = response.data;
            if (result && result.code === 200 && result.data && result.data.length > 0) {
                const orderResult = result.data[0];
                if (orderResult.result) {
                    await db.promise().query('UPDATE orders SET status = "cancel" WHERE order_code = ?', [order_code]);
                    return res.json({
                        success: true,
                        message: `Đã hủy đơn ${order_code} thành công trên GHN`
                    });
                } else {
                    return res.json({
                        success: false,
                        message: "GHN báo lỗi: " + (orderResult.message || "Không thể hủy đơn")
                    });
                }
            } else {
                return res.json({
                    success: false,
                    message: "Lỗi kết nối API GHN: " + (result.message || "Unknown Error")
                });
            }
        }
    } catch (err) {
        console.error("Lỗi Cancel Order:", err.message);
        return res.status(500).json({ success: false, message: "Lỗi hệ thống khi hủy đơn!" });
    }
});

router.get('/api/orders/export-excel', isAuth, async (req, res) => {
    try {
        const { startDate, endDate, userId, dateType, status, search, provider } = req.query;
        const actualRole = req.app_role;
        const actualUser = req.app_user;
        const dateField = dateType === 'pickup' ? 'pickup_date' : 'created_at';

        let conditions = [];
        let exportParams = [];

        if (actualRole === 'admin') {
        } else {
            const [selfRows] = await db.promise().query('SELECT id FROM users WHERE username = ?', [actualUser]);
            const selfId = selfRows[0]?.id;
            conditions.push('o.user_id = ?');
            exportParams.push(selfId);
        }

        conditions.push("(o.parent_billcode IS NULL OR o.parent_billcode = '')");

        if (startDate && endDate) {
            conditions.push(`DATE(o.${dateField}) BETWEEN ? AND ?`);
            exportParams.push(startDate, endDate);
        }

        if (status) {
            if (status === 'delivering') conditions.push("o.status IN ('picked_up', 'delivering')");
            else if (status === 'returned') conditions.push("o.status IN ('returning', 'returned')");
            else { conditions.push('o.status = ?'); exportParams.push(status); }
        }

        if (search) {
            const codes = search.split(',').map(s => s.trim()).filter(Boolean);
            if (codes.length > 1) {
                const placeholders = codes.map(() => '?').join(',');
                conditions.push(`(o.order_code IN (${placeholders}) OR o.realjtbillcode IN (${placeholders}))`);
                exportParams.push(...codes, ...codes);
            } else if (search.length <= 6) {
                conditions.push('o.customer_phone LIKE ?');
                exportParams.push(`%${search}`);
            } else {
                conditions.push('(o.order_code LIKE ? OR o.realjtbillcode LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)');
                const s = `%${search}%`;
                exportParams.push(s, s, s, s);
            }
        }

        if (provider) {
            conditions.push('o.provider = ?');
            exportParams.push(provider);
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const exportQuery = `SELECT o.*, u.shopname, u.jt_sdt FROM orders o LEFT JOIN users u ON o.user_id = u.id ${whereClause} ORDER BY o.created_at DESC`;

        const [orders] = await db.promise().query(exportQuery, exportParams);

        const statusLabel = {
            pending: 'Chờ lấy hàng',
            cancel: 'Đã hủy đơn',
            picked_up: 'Đã lấy hàng',
            delivering: 'Đang vận chuyển',
            out_for_delivery: 'Đang giao hàng',
            completed: 'Thành công',
            returning: 'Đang hoàn',
            returned: 'Đã hoàn hàng',
            issue: 'Kiện vấn đề'
        };

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Tất cả đơn hàng');

        worksheet.columns = [
            { header: 'Mã vận đơn', key: 'bill_code', width: 22 },
            { header: 'ĐVVC', key: 'provider', width: 12 },
            { header: 'Tên shop', key: 'shopname', width: 25 },
            { header: 'SĐT shop', key: 'shop_phone', width: 15 },
            { header: 'Tên khách hàng', key: 'customer_name', width: 25 },
            { header: 'SĐT khách', key: 'customer_phone', width: 15 },
            { header: 'Địa chỉ khách', key: 'customer_address', width: 50 },
            { header: 'Tên sản phẩm', key: 'product_name', width: 25 },
            { header: 'COD', key: 'price', width: 15 },
            { header: 'KG', key: 'weight', width: 10 },
            { header: 'Trạng thái', key: 'status', width: 20 },
            { header: 'Ngày tạo đơn', key: 'created_at', width: 20 },
            { header: 'Ngày lấy hàng', key: 'pickup_date', width: 20 },
            { header: 'Phí nội bộ', key: 'internal_fee', width: 15 },
            { header: 'SL bản in', key: 'is_printed', width: 12 }
        ];

        orders.forEach(order => {
            const billCode = order.realjtbillcode || order.order_code || '';
            worksheet.addRow({
                bill_code: billCode,
                provider: order.provider || '',
                shopname: order.shopname || '',
                shop_phone: order.jt_sdt || '',
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                customer_address: order.customer_address,
                product_name: order.product_name,
                price: order.price != null ? Math.round(Number(order.price)) : '',
                weight: order.weight,
                status: statusLabel[order.status] || order.status,
                created_at: new Date(order.created_at).toLocaleString('vi-VN'),
                pickup_date: order.pickup_date ? new Date(order.pickup_date).toLocaleString('vi-VN') : '',
                internal_fee: order.internal_fee,
                is_printed: order.is_printed || 0
            });
        });

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Export_Orders_${startDate}_${endDate}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Lỗi xuất Excel:", error);
        res.status(500).send("Không thể xuất file Excel.");
    }
});

router.post('/api/orders/mark-printed', isAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Không có mã đơn nào' });
        }

        const placeholders = ids.map(() => '?').join(',');
        const sql = `
            UPDATE orders
            SET is_printed = is_printed + 1,
                printed_at  = COALESCE(printed_at, NOW())
            WHERE order_code IN (${placeholders})
               OR realjtbillcode IN (${placeholders})
        `;
        const [result] = await db.promise().query(sql, [...ids, ...ids]);

        return res.json({ success: true, updated: result.affectedRows });
    } catch (err) {
        console.error('[mark-printed] Lỗi:', err.message);
        return res.status(500).json({ success: false, message: 'Lỗi hệ thống' });
    }
});

module.exports = router;
