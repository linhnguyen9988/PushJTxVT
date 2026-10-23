const ExcelJS = require('exceljs');
const express = require('express');
const { isManager } = require('../middleware/auth');
const { db } = require('../lib/db');
const { getBadge } = require('../utils/orderStatus');

const router = express.Router();

router.get('/admin/orders', isManager, async (req, res) => {
    if (!req.app_user) return res.redirect('/login');
    const username = req.app_user;
    const { search, status, provider, startDate, endDate, dateType, printed } = req.query;
    const dateField = dateType === 'pickup' ? 'pickup_date' : 'created_at';

    try {
        const [userRows] = await db.promise().query(`SELECT * FROM users WHERE username = ?`, [username]);
        if (userRows.length === 0) return res.redirect('/login');
        const currentUser = userRows[0];

        let baseConditions = [];
        let baseParams = [];

        if (startDate && endDate) {
            baseConditions.push(`DATE(${dateField}) BETWEEN ? AND ?`);
            baseParams.push(startDate, endDate);
        } else if (!search) {
            baseConditions.push(`DATE(${dateField}) >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)`);
        }

        let multiCodes = null;

        if (search) {
            const codes = search.split(',').map(s => s.trim()).filter(Boolean);
            if (codes.length > 1) {
                multiCodes = codes;
                const placeholders = codes.map(() => '?').join(',');
                baseConditions.push(`(order_code IN (${placeholders}) OR realjtbillcode IN (${placeholders}))`);
                baseParams.push(...codes, ...codes);
            } else if (search.length <= 6) {
                baseConditions.push("customer_phone LIKE ?");
                baseParams.push(`%${search}`);
            } else {
                baseConditions.push("(order_code LIKE ? OR realjtbillcode LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)");
                const s = `%${search}%`;
                baseParams.push(s, s, s, s);
            }
        }
        if (provider) {
            baseConditions.push("provider = ?");
            baseParams.push(provider);
        }

        const baseSql = baseConditions.length > 0 ? " WHERE " + baseConditions.join(" AND ") : "";

        const countSql = `SELECT 
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
            FROM orders ${baseSql}`;

        const [countRows] = await db.promise().query(countSql, baseParams);
        const counts = countRows[0] || { total: 0, pending: 0, shipping: 0, delivery: 0, completed: 0, returned: 0, issue: 0, cancel: 0, printed: 0, not_printed: 0 };

        let finalConditions = [...baseConditions];
        let finalParams = [...baseParams];

        if (status) {
            if (status === 'delivering') finalConditions.push("status IN ('picked_up', 'delivering')");
            else if (status === 'returned') finalConditions.push("status IN ('returning', 'returned')");
            else { finalConditions.push("status = ?"); finalParams.push(status); }
        }

        if (printed === '1') {
            finalConditions.push("is_printed > 0");
        } else if (printed === '0') {
            finalConditions.push("is_printed = 0");
        }

        const finalWhereClause = finalConditions.length > 0 ? " WHERE " + finalConditions.join(" AND ") : "";

        let orderByClause;
        let orderSqlParams;
        if (multiCodes && multiCodes.length > 1) {
            const fieldPlaceholders = multiCodes.map(() => '?').join(',');
            orderByClause = `ORDER BY FIELD(o.order_code, ${fieldPlaceholders}), FIELD(o.realjtbillcode, ${fieldPlaceholders})`;
            orderSqlParams = [...finalParams, ...multiCodes, ...multiCodes];
        } else {
            orderByClause = `ORDER BY o.created_at DESC`;
            orderSqlParams = [...finalParams];
        }

        const orderSql = `
            SELECT o.*, u.shopname
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.id
            ${finalWhereClause}
            ${orderByClause}`;

        const [orders] = await db.promise().query(orderSql, orderSqlParams);
        const [customerRows] = await db.promise().query('SELECT * FROM customers WHERE user_id = ?', [currentUser.id]);
        const [noteRows] = await db.promise().query('SELECT content FROM order_notes WHERE user_id = ? ORDER BY created_at DESC', [currentUser.id]);
        const [productRows] = await db.promise().query('SELECT product_name FROM order_products WHERE user_id = ? ORDER BY created_at DESC', [currentUser.id]);

        res.render('admin_orders', {
            getBadge,
            orders: orders,
            stats: currentUser,
            counts: counts,
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
            isFiltering: !!(search || status || provider || startDate || endDate || printed !== undefined),
            currentRole: req.app_role,
            use_socket_print: currentUser.use_socket_print || 0,
            user: username,
            active: 'orders'
        });

    } catch (err) {
        console.error("LỖI NGHIÊM TRỌNG TẠI ROUTE ADMIN:", err);
        res.status(500).send("Lỗi hệ thống: " + err.message);
    }
});

router.get('/admin/export-orders', isManager, async (req, res) => {
    try {
        const { userId, start, end, dateType } = req.query;
        const dateField = dateType === 'pickup' ? 'pickup_date' : 'created_at';
        const query = `
            SELECT * FROM orders 
            WHERE user_id = ? 
            AND (parent_billcode IS NULL OR parent_billcode = '')
            AND ${dateField} >= ? AND ${dateField} <= ?
            ORDER BY created_at DESC
        `;
        const params = [userId, `${start} 00:00:00`, `${end} 23:59:59`];
        const [orders] = await db.promise().execute(query, params);

        if (orders.length === 0) {
            return res.status(404).json({ success: false, message: "Không có dữ liệu để xuất!" });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Danh sách vận đơn');

        worksheet.columns = [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'Mã nội bộ', key: 'order_code', width: 20 },
            { header: 'Mã J&T', key: 'realjt_billcode', width: 20 },
            { header: 'ĐVVC', key: 'provider', width: 15 },
            { header: 'Ngày tạo', key: 'created_at', width: 20 },
            { header: 'Ngày lấy hàng', key: 'pickup_date', width: 20 },
            { header: 'Khách hàng', key: 'customer_name', width: 20 },
            { header: 'SĐT', key: 'customer_phone', width: 15 },
            { header: 'Địa chỉ', key: 'customer_address', width: 35 },
            { header: 'Sản phẩm', key: 'product_name', width: 25 },
            { header: 'KL (kg)', key: 'weight', width: 12 },
            { header: 'COD', key: 'price', width: 12 },
            { header: 'COD gốc', key: 'original_cod', width: 12 },
            { header: 'Cước', key: 'internal_fee', width: 12 },
            { header: 'Trạng thái', key: 'status', width: 15 },
            { header: 'SL bản in', key: 'is_printed', width: 12 }
        ];

        orders.forEach(order => {
            const row = worksheet.addRow({
                id: order.id,
                order_code: order.order_code,
                realjt_billcode: order.realjtbillcode,
                provider: order.provider,
                created_at: new Date(order.created_at).toLocaleString('vi-VN'),
                pickup_date: order.pickup_date ? new Date(order.pickup_date).toLocaleString('vi-VN') : '',
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                customer_address: order.customer_address,
                product_name: order.product_name,
                weight: order.weight,
                price: Number(order.price),
                original_cod: Number(order.original_cod),
                internal_fee: Number(order.internal_fee),
                status: order.status,
                is_printed: order.is_printed || 0
            });

            row.getCell('customer_address').alignment = { wrapText: true, vertical: 'middle' };
            row.getCell('product_name').alignment = { wrapText: true, vertical: 'middle' };
        });

        const headerRow = worksheet.getRow(1);
        worksheet.columns.forEach((col, index) => {
            const cell = headerRow.getCell(index + 1);

            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: '4F81BD' }
            };
            cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 12 };

            cell.alignment = { vertical: 'middle', horizontal: 'center' };

            cell.border = {
                top: { style: 'thin' },
                left: { style: 'thin' },
                bottom: { style: 'thin' },
                right: { style: 'thin' }
            };
        });

        ['price', 'original_cod', 'internal_fee'].forEach(key => {
            worksheet.getColumn(key).numFmt = '#,##0';
        });

        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=Van_Don_${userId}.xlsx`
        );

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Lỗi xuất Excel:", error);
        res.status(500).send("Lỗi server khi xuất file");
    }
});

router.get('/api/admin/get-order', isManager, async (req, res) => {
    let { code } = req.query;
    if (!code) return res.status(400).json({ success: false, message: "Thiếu mã đơn" });

    try {
        const codeArray = code.split(',').map(item => item.trim()).filter(item => item !== "");

        let sql;
        let params;

        if (codeArray.length === 1) {
            const searchTerm = `%${codeArray[0]}%`;
            sql = "SELECT * FROM orders WHERE realjtbillcode LIKE ? OR order_code LIKE ? LIMIT 20";
            params = [searchTerm, searchTerm];
        } else {
            const placeholders = codeArray.map(() => '?').join(',');
            sql = `SELECT * FROM orders 
                   WHERE realjtbillcode IN (${placeholders}) 
                      OR order_code IN (${placeholders}) 
                   LIMIT 20`;
            params = [...codeArray, ...codeArray];
        }

        const [rows] = await db.promise().query(sql, params);

        if (rows && rows.length > 0) {
            res.json({ success: true, orders: rows });
        } else {
            res.json({ success: false, message: "Không tìm thấy vận đơn nào khớp!" });
        }
    } catch (err) {
        console.error("Lỗi search đơn:", err);
        res.status(500).json({ success: false, message: "Lỗi hệ thống: " + err.message });
    }
});

router.post('/api/admin/update-order', isManager, async (req, res) => {
    const {
        id, customer_name, customer_phone, customer_address,
        jt_prov, jt_district, jt_ward, price, kg, custId,
        status
    } = req.body;

    const isAdmin = req.app_role === 'admin';

    try {
        const [existingRows] = await db.promise().query('SELECT * FROM orders WHERE id = ?', [id]);
        if (existingRows.length === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng!' });
        const existingOrder = existingRows[0];

        if (!isAdmin && (existingOrder.status === 'completed' || existingOrder.status === 'returned')) {
            return res.status(403).json({ success: false, message: 'Chỉ Admin mới được sửa đơn đã Hoàn thành hoặc Đã hoàn!' });
        }

        const effectiveCustId = custId || existingOrder.user_id;
        const [userRows] = await db.promise().query('SELECT * FROM users WHERE id = ?', [effectiveCustId]);
        const user = userRows[0] || {};

        const [actorRows] = await db.promise().query('SELECT username, shopname FROM users WHERE username = ?', [req.app_user]);
        const actor = actorRows[0] || {};

        const canEditWeight = isAdmin || existingOrder.status === 'pending'
        const finalWeight = canEditWeight ? (parseFloat(kg) || 0.5) : existingOrder.weight;

        const inputWeight = finalWeight;
        const uBasePrice = Number(user.base_price) || 20000;
        const uStepPrice = Number(user.step_price) || 5000;
        const uBaseWeight = Number(user.base_weight) || 2;

        let calculatedFee;
        if (canEditWeight) {
            calculatedFee = uBasePrice;

            const billableWeight = Math.ceil(inputWeight);

            if (billableWeight > uBaseWeight && uStepPrice > 0) {
                const extraKg = billableWeight - uBaseWeight;
                calculatedFee += extraKg * uStepPrice;
            }
        } else {
            calculatedFee = existingOrder.internal_fee;
        }

        const statusMap = {
            'Chờ lấy hàng': 'pending',
            'Đang vận chuyển': 'picked_up',
            'Đang giao hàng': 'out_for_delivery',
            'Hoàn thành': 'completed',
            'Đã hoàn': 'returned',
        };

        let dbStatus = status ? (statusMap[status] || null) : null;

        if (dbStatus === 'pending' && existingOrder.status !== 'pending') {
            return res.status(400).json({ success: false, message: 'Không được chuyển ngược đơn về trạng thái Chờ lấy hàng!' });
        }

        if (!isAdmin && (dbStatus === 'completed' || dbStatus === 'returned')) {
            return res.status(403).json({ success: false, message: 'Chỉ Admin mới được set trạng thái Hoàn thành hoặc Đã hoàn!' });
        }

        let finalPrice = price;
        if (!isAdmin) {
            finalPrice = existingOrder.price;
        }

        let sql = `
            UPDATE orders SET 
                customer_name = ?, customer_phone = ?, customer_address = ?, 
                jt_prov = ?, jt_district = ?, jt_ward = ?, price = ?, weight = ?, internal_fee = ?
        `;
        const params = [
            customer_name, customer_phone, customer_address,
            jt_prov, jt_district, jt_ward, finalPrice, finalWeight, calculatedFee
        ];

        if (existingOrder.status === 'pending') {
            sql += `, original_cod = ?`;
            params.push(finalPrice);
        }

        if (dbStatus) {
            sql += `, status = ?`;
            params.push(dbStatus);
            if (dbStatus === 'picked_up' && existingOrder.status === 'pending') {
                sql += `, pickup_date = NOW()`;
            }
        }

        sql += ` WHERE id = ?`;
        params.push(id);

        await db.promise().execute(sql, params);

        if (existingOrder.provider === 'NB' && dbStatus) {
            const statusNameMap = {
                'pending': 'Chờ lấy hàng',
                'picked_up': 'Đã lấy hàng',
                'out_for_delivery': 'Đang giao hàng',
                'completed': 'Giao thành công',
                'returned': 'Đã hoàn hàng',
            };
            const scanTypeName = statusNameMap[dbStatus] || status;
            const billcode = existingOrder.realjtbillcode || existingOrder.order_code;
            const now = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '); // giờ VN (GMT+7)
            const orderWard = jt_ward || existingOrder.jt_ward || '';

            await db.promise().execute(
                `INSERT INTO jtwaybill 
                    (billcode, scanbycode, scanbycontact, scanbyname, scanward, scancity, scanprov, scanpost, scantime, scantypename, issuename)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    billcode,
                    actor.username || req.app_user,   // scanbycode
                    actor.username || req.app_user,   // scanbycontact (username thay SĐT)
                    actor.shopname || req.app_user,   // scanbyname (shopname)
                    orderWard,                         // scanward (ward của người nhận)
                    'Biên Hòa',                        // scancity
                    'Đồng Nai',                        // scanprov
                    'NB-TVSHIP-BH',                    // scanpost
                    now,                               // scantime
                    scanTypeName,                      // scantypename
                    null                               // issuename
                ]
            );
        }

        res.json({ success: true, message: 'Cập nhật đơn hàng thành công!' });
    } catch (err) {
        console.error('Lỗi update order:', err);
        res.status(500).json({ success: false, message: 'Lỗi DB: ' + err.message });
    }
});

module.exports = router;
