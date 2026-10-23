const CryptoJS = require('crypto-js');
const axios = require('axios');
const { JT_STATUS_VN } = require('../config/constants');
const { JT_CONFIG } = require('../config/env');
const { db } = require('../lib/db');

function jtTypeName(code, name) {
    let n = JT_STATUS_VN[code] || name || 'Hành trình mới';
    if (n === '中心到件') n = 'Hàng đến TTKT';
    else if (n === '取件失败') n = 'Nhận hàng không thành công';
    return n;
}

function jtPics(d) {
    d = d || {};
    const urls = [];
    const addLoose = v => {
        if (Array.isArray(v)) v.forEach(addLoose);
        else if (typeof v === 'string' && v.trim() !== '') urls.push(v.trim());
    };
    const addStrict = v => {
        if (Array.isArray(v)) v.forEach(addStrict);
        else if (typeof v === 'string') v.split(/,(?=https?:\/\/)/i).map(x => x.trim()).forEach(u => { if (/^https?:\/\//i.test(u)) urls.push(u); });
    };
    addLoose(d.pictureUrl);
    addLoose(d.sigPicUrl);
    for (const [k, v] of Object.entries(d)) {
        if (k === 'pictureUrl' || k === 'sigPicUrl') continue;
        if (/pic|image|img|photo/i.test(k)) addStrict(v);
    }
    const uniq = [...new Set(urls)];
    return uniq.length ? JSON.stringify(uniq) : null;
}

function toJourneyRow(d) {
    const phone = d.staffContact || d.scanByContact || null;
    let code = Number(d.scanTypeCode);
    if (!code && d.scanTypeName === '中心到件') code = 110;
    let typeName = jtTypeName(code, d.scanTypeName);
    if (code === 110 && /^TTKT/i.test(String(d.scanNetworkName || ''))) typeName = 'Hàng đến TTKT';
    return {
        scantypename: typeName,
        scantime: d.scanTime ? String(d.scanTime).replace(' ', 'T') : null,
        scanpost: d.scanNetworkName || null,
        scanward: d.scanNetworkArea || null,
        scancity: d.scanNetworkCity || null,
        scanprov: d.scanNetworkProvince || null,
        scanbyname: d.staffName || d.scanByName || null,
        scanbycontact: phone ? phone.replace('+84', '0') : null,
        issuename: d.reason || d.abnormalPieceName || null,
        sigpic: jtPics(d)
    };
}

function md5ToBase64(input) {
    const md5Hash = CryptoJS.MD5(input);
    const wordArray = md5Hash;
    const base64String = CryptoJS.enc.Base64.stringify(wordArray);
    return base64String;
}

async function GetBillJT(orderid) {
    const pkey = JT_CONFIG.pkey;
    const apiAccount = JT_CONFIG.apiAccount;
    const oderjson = JSON.stringify({
        "customerCode": JT_CONFIG.customerCode,
        "password": JT_CONFIG.password,
        "txlogisticId": orderid
    });
    const digest = md5ToBase64(oderjson + pkey);
    const url = 'https://ylopenapi.jtexpress.vn/webopenplatformapi/api/order/printOrder';
    try {
        const params = new URLSearchParams();
        params.append('bizContent', oderjson);
        const response = await axios.post(url, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'apiAccount': apiAccount,
                'digest': digest,
                'timestamp': Date.now().toString()
            },
            timeout: 3000
        });

        const body = response.data;
        if (body.msg === 'success' && body.data?.base64EncodeContent) {
            const sqlOrder = `INSERT INTO jtbill (billcode, base64) VALUES (?, ?)`;
            await db.promise().query(sqlOrder, [orderid, body.data.base64EncodeContent]);
            console.log(`✅ Đã lấy và lưu Bill J&T cho đơn: ${body.data.billCode}`);
            //console.log(body)// lấy thông tin mã vùng các kiểu
            return true;
        } else {
            console.error(`❌ Lỗi lấy Bill J&T (${orderid}):`, body.msg);
            return false;
        }
    } catch (error) {
        console.error(`❌ Lỗi kết nối lấy Bill J&T:`, error.message);
        return false;
    }
}

function mapJtStatusByCode(code, typeName, desc) {
    switch (Number(code)) {
        case 103: return 'pending';
        case 105: return 'cancel';
        case 106: return 'picked_up';
        case 109:
        case 110: return 'delivering';
        case 112: return 'out_for_delivery';
        case 113: return 'completed';
        case 116: return 'returning';
        case 117: return 'returned';
        case 118:
        case 120: return 'issue';
    }
    return mapJtStatusFromTrace(typeName, desc);
}

function mapJtStatusFromTrace(typeName, desc) {
    const t = ((typeName || '') + ' ' + (desc || '')).toLowerCase();
    if (t.includes('hủy')) return 'cancel';
    if (t.includes('vấn đề')) return 'issue';

    const isReturnFlow = /chuyển\s*hoàn|hoàn\s*trả|hoàn\s*hàng|trả\s*hàng/.test(t);

    if (isReturnFlow) {
        if (t.includes('nhận hoàn trả') || t.includes('đã hoàn')) return 'returned';
        return 'returning';
    }

    if (t.includes('hoàn thành') || t.includes('thành công')) return 'completed';

    if (t.includes('phát hàng')) return 'out_for_delivery';
    if (t.includes('đến')) return 'delivering';
    if (t.includes('gửi hàng') || t.includes('khứ hồi')) return 'delivering';
    if (t.includes('nhận hàng') || t.includes('lấy hàng')) return 'picked_up';
    return null;
}

module.exports = { jtPics, mapJtStatusByCode, mapJtStatusFromTrace, md5ToBase64, toJourneyRow };
