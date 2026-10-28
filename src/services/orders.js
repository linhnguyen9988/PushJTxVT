const axios = require('axios');
const { db } = require('../lib/db');
const { isBienHoaWardOpen } = require('./address');
const { GHN_CONFIG, JT_CONFIG } = require('../config/env');
const { md5ToBase64 } = require('./jt');

function isNumeric(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
}

async function createOrderCore(username, input) {
    const {
        provider, customer_name, customer_phone, address, product_name, weight,
        note, ward, district, province, is_partial_delivery, is_new_address, newward, newprov,
        jt_shopname, jt_sdt, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov
    } = input;
    let tinh = province
    let xa = ward;
    let huyen = district;
    if (!username) return { success: false, status: 401, message: "Hết phiên làm việc!" };

    if (!ward) return ({ success: false, message: "Bấm nút kiểm tra địa chỉ trước nha." });
    if (!newward || !newprov) return ({ success: false, message: "Địa chỉ chưa được kiểm tra hoặc không tìm thấy vùng J&T, vui lòng bấm \"Kiểm tra địa chỉ\" lại!" });
    if (!customer_name || !customer_phone || !address) return ({ success: false, message: "Thiếu thông tin khách hàng!" });
    if (customer_phone.length != 10) return ({ success: false, message: "Số điện thoại khách hàng sai!" });

    var cod = String(input.cod ?? '0').replaceAll(".", '');
    if (!isNumeric(cod)) {
        cod = 0;
    }
    const typecod = Number(cod) > 0 ? 3 : 1;

    try {
        const [userRows] = await db.promise().query('SELECT * FROM users WHERE username = ?', [username]);
        const [vtpRows] = await db.promise().query('SELECT vtp_token, vtp_cusid FROM viettel_connect WHERE id = 1');

        const user = userRows[0];
        const vtpConfig = vtpRows[0];

        const inputWeight = parseFloat(weight) || 0.5;
        const uBasePrice = Number(user.base_price) || 20000;
        const uStepPrice = Number(user.step_price) || 5000;
        const uBaseWeight = Number(user.base_weight) || 2;

        let calculatedFee = uBasePrice;

        const billableWeight = Math.ceil(inputWeight);

        if (billableWeight > uBaseWeight && uStepPrice > 0) {
            const extraKg = billableWeight - uBaseWeight;
            calculatedFee += extraKg * uStepPrice;
        }

        const upsertSql = `
                INSERT INTO customers (user_id, phone, address, prov, district, ward, name, newward, newprov)
                VALUES ((SELECT id FROM users WHERE username = ?), ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    prov = VALUES(prov), 
                    district = VALUES(district), 
                    ward = VALUES(ward),
                    name = VALUES(name),
                    newward = VALUES(newward),
                    newprov = VALUES(newprov)
                `;

        await db.promise().query(upsertSql, [username, customer_phone, address, province, district, ward, customer_name, newward, newprov]);

        if (provider === 'Viettel') {
            if (!user || !user.vtp_inventory_id) return ({ success: false, message: "Chưa gán kho hàng cho tài khoản này!" });
            if (!vtpConfig || !vtpConfig.vtp_token) return ({ success: false, message: "Hệ thống chưa cấu hình kết nối Viettel!" });
            const vtp_data = {
                "ORDER_NUMBER": "TV" + Date.now(),
                "GROUPADDRESS_ID": user.vtp_inventory_id,
                "CUS_ID": vtpConfig.vtp_cusid,
                "SENDER_FULLNAME": user.vtp_shop_name,
                "SENDER_ADDRESS": user.vtp_shop_address,
                "SENDER_PHONE": user.vtp_shop_phone,
                "RECEIVER_FULLNAME": customer_name,
                "RECEIVER_ADDRESS": address,
                "RECEIVER_PHONE": customer_phone,
                "PRODUCT_NAME": product_name,
                "PRODUCT_DESCRIPTION": product_name,
                "PRODUCT_QUANTITY": 1,
                "PRODUCT_PRICE": cod,
                "PRODUCT_WEIGHT": Number(inputWeight) * 1000,
                "PRODUCT_LENGTH": 1, "PRODUCT_WIDTH": 1, "PRODUCT_HEIGHT": 1,
                "PRODUCT_TYPE": "HH",
                "ORDER_PAYMENT": typecod,
                "ORDER_SERVICE": "VSL7",
                "ORDER_NOTE": note,
                "MONEY_COLLECTION": cod,
                "IS_ADDRESS_NEW": false
            };

            const response = await axios.post('https://partner.viettelpost.vn/v2/order/createOrder', vtp_data, {
                headers: { 'Content-Type': 'application/json', 'Token': vtpConfig.vtp_token },
                timeout: 15000
            });

            const result = response.data;
            if (result && result.status === 200) {
                const vtp_code = result.data.ORDER_NUMBER;
                const sqlOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, original_cod, newward, newprov, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
                await db.promise().query(sqlOrder, [user.id, vtp_code, provider, customer_name, customer_phone, address, product_name, cod, calculatedFee, inputWeight, 'pending', cod, newward, newprov]);
                return ({ success: true, order_code: vtp_code, internal_fee: calculatedFee });
            } else {
                return ({ success: false, message: result.message || "Viettel Post từ chối đơn hàng" });
            }

        } else if (provider === 'J&T') {// check kho jt trước khi cho đẩy đơn
            const isNBWardOpen = await isBienHoaWardOpen(ward, district);
            if (isNBWardOpen) {
                const maNB = 'BH' + Date.now();
                const sqlNBOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, realjtbillcode, original_cod, jt_ward, jt_district, jt_prov, sortLine, note, newward, newprov, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
                await db.promise().query(sqlNBOrder, [user.id, maNB, 'NB', customer_name, customer_phone, address, product_name, cod, calculatedFee, weight, 'pending', null, cod, ward, district, province, 'NB-TVSHIP-BH', note, newward, newprov]);
                return ({ success: true, message: `✅ Địa chỉ nội thành Biên Hòa — tự động chuyển sang đơn Nội Bộ`, order_code: maNB });
            }

            if (is_new_address) {
                tinh = newprov;
                xa = newward;
                huyen = '';
            }
            const pkey = JT_CONFIG.pkey;
            const apiAccount = JT_CONFIG.apiAccount;
            const matuquan = "TV" + Date.now();
            if (!jt_sdt || !jt_shopname || !jt_shopaddress) return ({ success: false, message: "Thiếu thông tin người gửi J&T!" });
            const oderjson = JSON.stringify({
                "customerCode": JT_CONFIG.customerCode,
                "password": JT_CONFIG.password,
                "txlogisticId": matuquan,
                "productType": "EXPRESS",
                "orderType": "1",
                "serviceType": "1",
                "partSign": is_partial_delivery,
                "deliveryType": "1",
                "isCallBeforeReturn": 1,
                "totalQuantity": 1,
                "sender": { "name": jt_shopname, "mobile": jt_sdt, "prov": jt_shop_prov, "city": jt_shop_district, "area": jt_shop_ward, "address": jt_shopaddress },
                "receiver": { "name": customer_name, "mobile": customer_phone, "prov": tinh, "city": huyen, "area": xa, "address": address },
                "payType": "PP_PM",
                "goodsType": "bm000010",
                "goodsValue": cod.toString(),
                "codMoney": cod.toString(),
                "itemsValue": cod.toString(),
                "remark": note,
                "englishName": "none",
                "packageInfo": { "weight": weight, "length": 10, "width": 10, "height": 10, "volume": "10" },
                "items": [{ "itemName": product_name, "englishName": "None", "number": 1, "itemValue": cod }]
            });

            const digest = md5ToBase64(oderjson + pkey);
            const params = new URLSearchParams();
            params.append('bizContent', oderjson);

            const response = await axios.post('https://ylopenapi.jtexpress.vn/webopenplatformapi/api/order/addOrder', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'apiAccount': apiAccount,
                    'digest': digest,
                    'timestamp': Date.now().toString()
                },
                timeout: 5000
            });

            const body = response.data;
            if (body.msg === 'success') {
                const sqlOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, realjtbillcode, original_cod, jt_ward, jt_district, jt_prov, sortLine, note, newward, newprov, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
                await db.promise().query(sqlOrder, [user.id, matuquan, provider, customer_name, customer_phone, address, product_name, cod, calculatedFee, weight, 'pending', body.data.billCode, cod, ward, district, province, body.data.sortLine, note, newward, newprov]);
                //GetBillJT(matuquan);//tạm thời ko lấy bill lưu vào DB, bill nó quá nặng
                //console.log(`✅${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}: ${jt_shopname} Lên đơn J&T thành công: ${body.data.billCode}`);
                return ({ success: true, message: "Lên đơn J&T thành công", order_code: body.data.billCode });
            } else {
                return ({ success: false, message: "J&T từ chối: " + body.msg });
            }
        } else if (provider === 'GHN') {
            const ghn_token = GHN_CONFIG.token;
            const ghn_shopid = GHN_CONFIG.shopId;

            const ghn_data = {
                "payment_type_id": 1, //1 là người gửi trả cước, 2 là người nhận
                "note": note || "Không cho xem hàng!",
                "required_note": "KHONGCHOXEMHANG",
                "return_phone": user.vtp_shop_phone || "0332190158",
                "return_address": user.vtp_shop_address || "39 NTT",
                "from_name": user.vtp_shop_name || "TinTest124",
                "from_phone": user.vtp_shop_phone || "0987654321",
                "from_address": user.vtp_shop_address || "72 Thành Thái, Quận 10, HCM",
                "to_name": customer_name,
                "to_phone": customer_phone,
                "to_address": address,
                "to_ward_name": ward,//cần lấy chuẩn lại GHN theo query của JT, hoặc code thêm cột cho bảng customers
                "to_district_name": district,
                "to_province_name": province,
                "cod_amount": Number(cod),
                "content": product_name,
                "weight": Math.round(Number(inputWeight) * 1000), // GHN dùng gram
                "length": 10,
                "width": 10,
                "height": 10,
                "insurance_value": Number(cod), // BH theo COD
                "service_type_id": 2, // Hàng nhẹ/Chuẩn
                "items": [
                    {
                        "name": product_name,
                        "quantity": 1,
                        "price": Number(cod),
                        "weight": Math.round(Number(inputWeight) * 1000)
                    }
                ]
            };

            const response = await axios.post('https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create', ghn_data, {
                headers: {
                    'Content-Type': 'application/json',
                    'ShopId': ghn_shopid,
                    'Token': ghn_token
                },
                timeout: 5000
            });

            const result = response.data;

            if (result && result.code === 200) {
                const ghn_order_code = result.data.order_code;
                const ghn_fee = result.data.total_fee;

                const sqlOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, original_cod, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;

                await db.promise().query(sqlOrder, [
                    user.id,
                    ghn_order_code,
                    provider,
                    customer_name,
                    customer_phone,
                    address,
                    product_name,
                    cod,
                    calculatedFee,
                    inputWeight,
                    'pending',
                    cod,
                    note
                ]);

                return ({
                    success: true,
                    message: result.message_display, // "Tạo đơn hàng thành công. Mã đơn hàng: ..."
                    order_code: ghn_order_code,
                    ghn_fee: ghn_fee,
                    internal_fee: calculatedFee
                });
            } else {
                return ({
                    success: false,
                    message: "GHN từ chối: " + (result.message || "Lỗi không xác định")
                });
            }
        } else if (provider === 'NB') {
            const matuquan = "BH" + Date.now();
            const sqlOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, realjtbillcode, original_cod, jt_ward, jt_district, jt_prov, sortLine, note, newward, newprov, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
            await db.promise().query(sqlOrder, [user.id, matuquan, provider, customer_name, customer_phone, address, product_name, cod, calculatedFee, weight, 'pending', null, cod, ward, district, province, 'NB-TVSHIP-BH', note, newward, newprov]);
            return ({ success: true, message: "Lên đơn Biên Hòa thành công", order_code: matuquan });
        }
        return { success: false, message: "Đơn vị vận chuyển không hợp lệ!" };
    } catch (err) {
        console.error("Lỗi Create Order:", err.message);
        return { success: false, status: 500, message: "Lỗi hệ thống: " + err.message };
    }
}

async function queryOrdersByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const sql = `
        SELECT * FROM orders
        WHERE order_code IN (${placeholders}) OR realjtbillcode IN (${placeholders})
        GROUP BY id
    `;
    const [rows] = await db.promise().query(sql, [...ids, ...ids]);
    const indexMap = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => {
        const ia = indexMap.has(a.realjtbillcode) ? indexMap.get(a.realjtbillcode) : (indexMap.get(a.order_code) ?? 9999);
        const ib = indexMap.has(b.realjtbillcode) ? indexMap.get(b.realjtbillcode) : (indexMap.get(b.order_code) ?? 9999);
        return ia - ib;
    });
    return rows;
}

module.exports = { createOrderCore, queryOrdersByIds };
