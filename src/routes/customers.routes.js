const axios = require('axios');
const express = require('express');
const { isAuth } = require('../middleware/auth');
const { db } = require('../lib/db');
const { applyAddressFixes, cleanSearchTerm, normalizeSQL } = require('../services/address');
const { createLog } = require('../services/auditLog');

const router = express.Router();

router.get('/api/customers', isAuth, async (req, res) => {
    const username = req.app_user;
    const search = req.query.search || '';

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    try {
        const [userRows] = await db.promise().query('SELECT id FROM users WHERE username = ?', [username]);
        if (userRows.length === 0) return res.status(401).json([]);
        const userId = userRows[0].id;

        let sql = `SELECT * FROM customers WHERE user_id = ?`;
        let params = [userId];

        if (search) {
            sql += ` AND (name LIKE ? OR phone LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [customers] = await db.promise().query(sql, params);

        res.json(customers);

    } catch (err) {
        console.error("Lỗi API Customers:", err);
        res.status(500).json([]);
    }
});

router.get('/customers', isAuth, async (req, res) => {
    const username = req.app_user;
    const search = req.query.search || '';

    try {
        const [userRows] = await db.promise().query(
            `SELECT id, vtp_shop_phone, vtp_shop_address, base_price, step_price, 
                    jt_sdt, jt_shopname, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov 
             FROM users WHERE username = ?`,
            [username]
        );

        if (userRows.length === 0) return res.redirect('/login');

        const userData = userRows[0];
        const userId = userData.id;

        const stats = {
            vtp_shop_phone: userData.vtp_shop_phone || 'Chưa cấu hình',
            vtp_shop_address: userData.vtp_shop_address || 'Chưa cấu hình',
            base_price: userData.base_price || 0,
            step_price: userData.step_price || 0,
            jt_sdt: userData.jt_sdt || '',
            jt_shopname: userData.jt_shopname || '',
            jt_shopaddress: userData.jt_shopaddress || '',
            jt_shop_ward: userData.jt_shop_ward || '',
            jt_shop_district: userData.jt_shop_district || '',
            jt_shop_prov: userData.jt_shop_prov || ''
        };

        const [noteRows] = await db.promise().query(
            'SELECT content FROM order_notes WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        const [productRows] = await db.promise().query(
            'SELECT product_name FROM order_products WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );

        let customersSql = `SELECT * FROM customers WHERE user_id = ?`;
        let params = [userId];

        if (search) {
            customersSql += ` AND (name LIKE ? OR phone LIKE ?) ORDER BY created_at DESC`;
            params.push(`%${search}%`, `%${search}%`);
        } else {
            customersSql += ` ORDER BY created_at DESC LIMIT 50`;
        }

        const [customers] = await db.promise().query(customersSql, params);

        res.render('customers', {
            user: username,
            customers: customers,
            search: search,
            isFiltering: !!search,
            stats: stats,
            notes: noteRows || [],
            products: productRows || [],
            active: 'customers'
        });
    } catch (err) {
        console.error("Lỗi trang khách hàng:", err);
        res.status(500).send("Lỗi hệ thống");
    }
});

router.post('/customers/edit', isAuth, async (req, res) => {
    const { id, name, phone, address, tag } = req.body;
    const username = req.app_user;

    const ALLOWED_TAGS = ['bom_hang', 'xa_hang', 'than_thiet'];
    const safeTag = ALLOWED_TAGS.includes(tag) ? tag : null;

    if (!name || !phone || !address) {
        return res.json({ success: false, message: "Tên, SĐT, địa chỉ không được để trống!" });
    }
    if (phone.length != 10) {
        return res.json({ success: false, message: "SĐT không hợp lệ!" });
    }

    try {
        const [tokenRows] = await db.promise().query(
            'SELECT vtp_token FROM viettel_connect WHERE id = 1 LIMIT 1'
        );

        if (tokenRows.length === 0 || !tokenRows[0].vtp_token) {
            return res.json({ success: false, message: "Hệ thống chưa cấu hình Token Viettel!" });
        }
        const systemToken = tokenRows[0].vtp_token;

        const vtpRes = await axios.post(`https://partner.viettelpost.vn/v2/order/getPriceAllNlp`, {
            "SENDER_ADDRESS": "Long Bình, biên Hòa, Đồng Nai",
            "RECEIVER_ADDRESS": address,
            "PRODUCT_TYPE": "HH",
            "PRODUCT_WEIGHT": 100,
            "TYPE": 1
        }, {
            headers: { 'Content-Type': 'application/json', 'token': systemToken },
            timeout: 10000
        });

        const body = vtpRes.data;
        if (body.error == true || !body.RECEIVER_ADDRESS || !body.RECEIVER_ADDRESS.WARD_ID) {
            return res.json({ success: false, message: "Lỗi: Viettel không nhận diện được địa chỉ này" });
        }

        let tinh = "", huyen = "", xa = "";

        const [resTinh, resHuyen, resXa] = await Promise.all([
            axios.get(`https://partner.viettelpost.vn/v2/categories/listProvinceById?provinceId=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/districtByIdAndProvince?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&provinceById=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/wardByDistrictAndId?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&wardsId=${body.RECEIVER_ADDRESS.WARD_ID}`)
        ]);

        tinh = resTinh.data.data?.[0]?.PROVINCE_NAME || "";
        huyen = resHuyen.data.data?.DISTRICT_NAME || "";

        if (resXa.data.message?.includes('No suitable data found')) {
            return res.json({ success: false, message: "Lỗi: Thông tin phường xã đã bị Viettel thay đổi" });
        }
        xa = resXa.data.data?.WARDS_NAME || "";

        const sProv = cleanSearchTerm(tinh);
        let sDist = cleanSearchTerm(huyen);
        let sWard = cleanSearchTerm(xa);
        sWard = sWard.replace(/phường|xã/gi, "").trim();
        ({ sWard, sDist } = applyAddressFixes(sWard, sDist));

        console.log(`${sWard} - ${sDist} - ${sProv}`)

        const findJT = `
    SELECT * 
    FROM jtaddress
    WHERE 
        ${normalizeSQL('LOWER(prov)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND ${normalizeSQL('LOWER(district)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND (
            ${normalizeSQL('LOWER(ward)')} LIKE ${normalizeSQL('LOWER(?)')}
        )
    ORDER BY 
        (LOWER(ward) LIKE ?) DESC,
        (LOWER(district) = ?) DESC,
        LENGTH(ward) ASC
    LIMIT 1`;
        const [jtRows] = await db.promise().query(findJT, [
            `%${sProv}%`,
            `%${sDist}%`,
            `%${sWard}%`,
            `${sWard}%`,
            sDist
        ]);
        if (jtRows.length > 0) {
            const jt = jtRows[0];
            const sqlUpdate = `
                UPDATE customers 
                SET name = ?, phone = ?, address = ?, prov = ?, district = ?, ward = ?, newward = ?, newprov = ?, tag = ?  
                WHERE id = ?`;
            await db.promise().query(sqlUpdate, [name, phone, address, jt.prov, jt.district, jt.ward, jt.newward, jt.newprov, safeTag, id]);

            createLog(`Sửa thông tin khách hàng: ${name}`, username);

            return res.json({
                success: true,
                tinh: jt.prov,
                huyen: jt.district,
                xa: jt.ward,
                newward: jt.newward,
                newprov: jt.newprov,
                message: `Đã sửa thông tin khách hàng ${name} thành công!`
            });
        } else {
            return res.json({
                success: false,
                message: `J&T không có dữ liệu cho địa chỉ: ${xa} - ${huyen} - ${tinh}.`
            });
        }

    } catch (error) {
        console.error("LỖI EDIT CUSTOMER:", error.message);
        return res.json({ success: false, message: "Lỗi hệ thống: " + error.message });
    }
});

router.post('/customers/add', isAuth, async (req, res) => {
    const { name, phone, address, tag } = req.body;
    const username = req.app_user;

    const ALLOWED_TAGS = ['bom_hang', 'xa_hang', 'than_thiet'];
    const safeTag = ALLOWED_TAGS.includes(tag) ? tag : null;

    if (!name || !phone || !address) {
        return res.json({ success: false, message: "Tên, SĐT, địa chỉ không được để trống!" });
    }
    if (phone.length != 10) {
        return res.json({ success: false, message: "SĐT phải đủ 10 số!" });
    }

    try {
        const [tokenRows] = await db.promise().query(
            'SELECT vtp_token FROM viettel_connect WHERE id = 1 LIMIT 1'
        );

        if (tokenRows.length === 0 || !tokenRows[0].vtp_token) {
            return res.json({ success: false, message: "Hệ thống chưa cấu hình Token Viettel!" });
        }
        const systemToken = tokenRows[0].vtp_token;

        const vtpRes = await axios.post(`https://partner.viettelpost.vn/v2/order/getPriceAllNlp`, {
            "SENDER_ADDRESS": "Long Bình, biên Hòa, Đồng Nai",
            "RECEIVER_ADDRESS": address,
            "PRODUCT_TYPE": "HH",
            "PRODUCT_WEIGHT": 100,
            "TYPE": 1
        }, {
            headers: { 'Content-Type': 'application/json', 'token': systemToken },
            timeout: 10000
        });

        const body = vtpRes.data;
        if (body.error == true || !body.RECEIVER_ADDRESS || !body.RECEIVER_ADDRESS.WARD_ID) {
            return res.json({ success: false, message: "Lỗi: Không nhận diện được địa chỉ hoặc sai xã phường" });
        }

        let tinh = "", huyen = "", xa = "";

        const [resTinh, resHuyen, resXa] = await Promise.all([
            axios.get(`https://partner.viettelpost.vn/v2/categories/listProvinceById?provinceId=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/districtByIdAndProvince?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&provinceById=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/wardByDistrictAndId?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&wardsId=${body.RECEIVER_ADDRESS.WARD_ID}`)
        ]);

        tinh = resTinh.data.data?.[0]?.PROVINCE_NAME || "";
        huyen = resHuyen.data.data?.DISTRICT_NAME || "";

        if (resXa.data.message?.includes('No suitable data found')) {
            return res.json({ success: false, message: "Lỗi: Thông tin phường bị thay đổi, phải lên đơn tay" });
        }
        xa = resXa.data.data?.WARDS_NAME || "";

        const sProv = cleanSearchTerm(tinh);
        let sDist = cleanSearchTerm(huyen);
        let sWard = cleanSearchTerm(xa);
        sWard = sWard.replace(/phường|xã/gi, "").trim();
        ({ sWard, sDist } = applyAddressFixes(sWard, sDist));
        const findJT = `
    SELECT * 
    FROM jtaddress
    WHERE 
        ${normalizeSQL('LOWER(prov)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND ${normalizeSQL('LOWER(district)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND (
            ${normalizeSQL('LOWER(ward)')} LIKE ${normalizeSQL('LOWER(?)')}
        )
    ORDER BY 
        (LOWER(ward) LIKE ?) DESC,
        (LOWER(district) = ?) DESC,
        LENGTH(ward) ASC
    LIMIT 1`;

        const [jtRows] = await db.promise().query(findJT, [
            `%${sProv}%`,
            `%${sDist}%`,
            `%${sWard}%`,
            `${sWard}%`,
            sDist
        ]);

        if (jtRows.length > 0) {
            const jt = jtRows[0];
            const sqlInsert = `
                INSERT INTO customers (user_id, name, phone, address, prov, district, ward, newward, newprov, tag) 
                VALUES ((SELECT id FROM users WHERE username = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

            await db.promise().query(sqlInsert, [username, name, phone, address, jt.prov, jt.district, jt.ward, jt.newward, jt.newprov, safeTag]);

            createLog(`Đã thêm khách hàng mới: ${name}`, username);

            return res.json({
                success: true,
                tinh: jt.prov,
                huyen: jt.district,
                xa: jt.ward,
                newward: jt.newward,
                newprov: jt.newprov,
                message: `Đã thêm khách hàng ${name} thành công!`
            });
        } else {
            return res.json({
                success: false,
                message: `Địa chỉ này Viettel hiểu nhưng J&T không có: ${xa} - ${huyen} - ${tinh}.`
            });
        }

    } catch (error) {
        console.error("CRASH TRONG CUSTOMERS/ADD:", error);
        return res.json({ success: false, message: "Lỗi hệ thống: " + error.message });
    }
});

router.post('/customers/delete/:id', isAuth, async (req, res) => {
    const customerId = req.params.id;

    try {
        const sql = `DELETE FROM customers WHERE id = ?`;
        await db.promise().query(sql, [customerId]);

        res.json({ success: true, message: "Đã xóa khách hàng thành công!" });
    } catch (err) {
        console.error("Lỗi Delete Customer:", err);
        res.json({ success: false, message: "Không thể xóa khách hàng này (có thể do đang có đơn hàng liên quan)." });
    }
});

module.exports = router;
