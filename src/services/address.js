const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { db } = require('../lib/db');
const { ROOT } = require('../config/paths');

function extractWardCode(ward) {
    const m = (ward || '').toString().match(/-\s*(\d+TPB\d+)\s*$/i);
    return m ? m[1].toUpperCase() : null;
}

async function isBienHoaWardOpen(ward, district) {
    const d = (district || '').toString().toLowerCase().normalize('NFC').replace(/oà/g, 'òa');
    if (!d.includes('biên hòa')) return false;
    const code = extractWardCode(ward);
    if (!code) return false;
    const [rows] = await db.promise().query('SELECT is_open FROM bienhoa_route_wards WHERE ward_code = ? LIMIT 1', [code]);
    return rows.length > 0 && !!rows[0].is_open;
}

function applyAddressFixes(sWard, sDist) {

    sWard = (sWard || '').toLowerCase().normalize('NFC').trim();
    sDist = (sDist || '').toLowerCase().normalize('NFC').trim();

    sWard = sWard.replace(/\s*-\s*(h\.|huyện|quận|tt|tx|thị trấn|trấn trấn|thị xã|tt.).*$/i, '').trim();

    //if (sWard === 'trung nghĩa' && sDist === 'hưng yên') sWard = 'yên trung';
    if (sWard === 'cần guộc') sWard = 'cần giuộc';
    if (sWard === 'eatling') sWard = 'ea tling';
    if (sDist === 'phú xuân') sDist = 'huế';
    if (sDist === 'gò vấp' && ['1', '3', '4', '5', '7'].includes(sWard)) sWard = '0' + sWard;
    if (sDist === 'bình giang' && sWard === 'thái minh') sWard = 'bình minh';
    if (sDist === 'nghĩa hưng' && sWard === 'đông thịnh') sWard = 'nghĩa Đồng';
    if (sDist === 'xuân trường' && sWard === 'xuân phúc') sWard = 'xuân hòa';
    if (sDist === 'quỳ châu' && sWard === 'quỳ châu') sWard = 'tân lạc';
    if (sDist === 'đạ huoai' && sWard === 'quốc oai') sDist = 'đạ tẻh';
    if (sDist === 'đạ huoai' && sWard === 'quảng trị') { sDist = 'đạ tẻh'; sWard = 'Triệu Hải' }
    if (sDist === 'gia lộc' && sWard === 'gia tiến') sWard = 'Gia Lương';
    if (sDist === 'ý yên' && sWard === 'tân minh') sWard = 'yên minh';
    if (sDist === 'đạ huoai' && sWard === 'mỹ đức') sDist = 'đạ tẻh';
    if (sDist === 'đạ huoai' && sWard === 'đạ kho') sDist = 'đạ tẻh';
    if (sDist === 'đạ huoai' && sWard === 'đạ lây') sDist = 'đạ tẻh';
    if (sDist === 'long điền' && sWard === 'tam an') sWard = 'an ngãi';
    if (sWard === 'đạ tẻh' && sDist === 'đạ huoai') sDist = 'đạ tẻh';
    if (sDist === 'đạ huoai' && sWard === 'quảng ngãi') sDist = 'cát tiên';
    if (sDist === 'đạ huoai' && sWard === 'đức phổ') sDist = 'cát tiên';
    if (sDist === 'đạ huoai' && sWard === 'phước cát') sDist = 'cát tiên';
    if (sDist === 'đạ huoai' && sWard === 'tiên hoàng') sDist = 'cát tiên';
    if (sDist === 'đạ huoai' && sWard === 'cát tiên') sDist = 'cát tiên';
    if (sDist === 'phú lộc' && sWard === 'hương lộc') sDist = 'nam đông';
    if (sDist === 'ninh giang' && sWard === 'đức phúc') sWard = 'vạn phúc';
    if (sDist === 'huế' && sWard === 'long hồ') sWard = 'Hương Hồ';
    if (sDist === 'giao thủy' && sWard === 'giao thủy') sWard = 'ngô đồng';
    if (sDist === 'cẩm giàng' && sWard === 'phúc điền') sWard = 'cẩm phúc';
    if (sDist === 'kim thành' && sWard === 'hòa bình') sWard = 'Liên Hòa';
    if (sDist === 'kim thành' && sWard === 'vũ dũng') sWard = 'cổ dũng';
    if (sDist === 'nam trực' && sWard === 'nam điền') sWard = 'nam mỹ';
    if (sDist === 'gia lộc' && sWard === 'quang đức') sWard = 'quang minh';
    if (sDist === 'nam sách' && sWard === 'an phú') sWard = 'an lâm';
    if (sDist === 'nam sách' && sWard === 'trần phú') sWard = 'nam trung';
    if (sDist === 'sơn dương' && sWard === 'hồng sơn') sWard = 'hồng lạc';
    if (sDist === 'hớn quản' && sWard === "tân quang") sWard = 'tân quan';
    if (sDist === 'cư mgar' && sWard === "cư m'ga") sWard = 'cư mgar';
    if (sDist === 'chũ' && sWard === 'trù hựu') sDist = 'lục ngạn';
    if (sDist === 'chũ' && sWard === 'quý sơn') sDist = 'lục ngạn';
    if (sDist === 'chũ' && sWard === 'chũ') sDist = 'lục ngạn';
    if (sDist === 'chũ' && sWard === 'thanh hải') sDist = 'lục ngạn';
    if (sDist === 'chũ' && sWard === 'hồng giang') sDist = 'lục ngạn';
    if (sDist === 'thanh chương' && sWard === 'dùng') sWard = 'thanh chương';
    if (sDist === 'đạ huoai' && sWard === "đồng nai thượng") sDist = 'cát tiên';
    if (sDist === 'đạ huoai' && sWard === "đạp'loa") sWard = 'đoàn kết';
    if (sDist === 'bảo lâm' && sWard === 'lộc tlâm') sWard = 'lộc lâm';
    if (sDist === 'chũ' && sWard === 'phượng sơn') sDist = 'lục ngạn';
    if (sDist === 'phú lộc' && sWard === 'khe tre') sDist = 'nam đông';
    if (sDist === 'phú lộc' && sWard === 'thượng nhật') sDist = 'nam đông';
    if (sDist === 'cẩm phả' && sWard === 'hải hòa') sWard = 'cẩm hải';
    if (sDist === 'tứ kỳ' && sWard === 'dân an') sWard = 'Dân Chủ';
    if (sDist === 'phú lộc' && sWard === 'hương phú') sDist = 'nam đông';
    if (sDist === 'nam định' && sWard === 'mỹ lộc') { sDist = 'mỹ lộc'; sWard = 'mỹ tiến'; }
    if (sDist === 'xuân trường' && sWard === 'xuân giang') sWard = 'xuân đài';

    if (sDist.includes('chư') && sDist.includes('pưh')) sDist = 'chư pưh';
    if (sWard.includes('đồng sơn') && sDist.includes('đồng hới')) sWard = 'đồng sơn';
    if (sDist === 'long điền' && ['đất đỏ', 'láng dài', 'lộc an', 'long mỹ', 'long tân', 'phước long thọ', 'phước hải', 'phước hội'].includes(sWard)) {
        sDist = 'đất đỏ';
    }
    return { sWard, sDist };
}

function normalizeSQL(field) {
    const pairs = [
        ['đặ pék', 'đắk pék'], ['kong dỡng', 'kon dỡng'], ['kon chro', 'Kông Chro'], ['iakha', 'ia kha'],
        ['iii', '3'], ['ba', '3'], ['ii', '2'], ['i', '1'],
        ['krông ana', 'krông a na'], ['mdrăk', 'mđrăk'], ['cư drăm', 'cư đrăm'], ['ia sao', 'iasao'],
        ['đất đỏ', 'long đất'], ['long điền', 'long đất'],
        ['cần guộc', 'cần giuộc'], ['bàu hàm 1', 'bàu hàm'],
        ['hoà', 'hòa'], ['hoả', 'hỏa'], ['hoã', 'hỏa'], ['hoạ', 'họa'],
        ['oà', 'òa'], ['oả', 'ỏa'], ['oã', 'ỏa'], ['oạ', 'òa'],
        ['uý', 'úy'], ['uỳ', 'ùy'], ['uỷ', 'ủy'], ['uỹ', 'ũy'], ['uỵ', 'ụy'],
        ['thuý', 'thúy'], ['thuỷ', 'thủy'], ['thuỵ', 'thụy'],
        ['mĩ', 'mỹ'], ['kĩ', 'kỹ'], ['kì', 'kỳ'], ['kí', 'ký'], ['vĩ', 'vỹ'], ['hĩ', 'hỹ'], ['ngĩ', 'nghĩ'],
        ['quí', 'quý'], ['quì', 'quỳ'], ['quỉ', 'quỷ'], ['quĩ', 'quỹ'], ['quị', 'quỵ'], ['qui', 'quy'],
        ['mí', 'mỹ'], ['hì', 'hỳ'], ['tí', 'tý'],
        ['sĩ', 'sỹ'], ['đông xá', 'Ðông Xá'], ['vân đồn', 'Vân Đồn'], ['10', 'mười']
    ];

    let sql = field;
    pairs.forEach(p => {
        sql = `REPLACE(${sql}, '${p[0]}', '${p[1]}')`;
    });
    return sql;
}

function cleanSearchTerm(str) {
    if (!str) return "";
    let cleaned = str.toLowerCase().normalize('NFC').trim();
    if (cleaned.length > 10 && cleaned.charAt(cleaned.length - 9) === '-') {
        cleaned = cleaned.slice(0, -9).trim();
    }
    return cleaned
        .replace(/(kcn|phường|xã|quận|huyện|thị xã|thị trấn|tt|tx|thành phố|thi xã|thi trấn|đảo|p.) (?!\d)/gi, "")
        .replace('trấn trấn', '')
        .replace('iapal', 'ia pal')
        .replace('nghìn tường', 'nghinh tường')
        .replace('nam  yang', 'nam yang')
        .replace('tt bảy ngàn', 'bảy ngàn')
        .replace('tt. bảy ngàn', 'bảy ngàn')
        .replace('đường mười', 'Đường 10')
        .replace('p mông dương', 'mông dương')
        .replace('.', '')
        .replace('cư jang', 'cư yang')
        .replace('lương thế chân', 'lương thế trân')
        .replace('đăk drong', 'Đăk Đrông')
        .replace('đăk taley', 'đăk ta ley')
        .replace('đakpơ', 'Đak Pơ')
        .replace('cư ê wi', 'cư êwi')
        .replace('lộc thạch', 'Lộc Thạnh')
        .replace('ea knăng', 'ea kuăng')
        .replace('chi lễ', 'tri lễ')
        .replace('buôn choach', 'buôn choah')
        .replace('si phìn', 'si pa phìn')
        .replace('chưpơng', 'chư pơng')
        .replace(' (gia kiệm)', '')
        .replace('bà rịa - vũng tàu', 'bà rịa – vũng tàu')
        .replace('thừa thiên - huế', 'thừa thiên – huế')
        .replace("đăknhau", 'đăk nhau')
        .replace("ba bể (chợ rã)", 'chợ rã')
        .replace("đambri", 'Đạm Bri')
        .replace("ð", 'đ')
        .replace("eacharang", 'Ea Chà Rang')
        .replace("cư niê", 'cư ni')
        .replace("b'lá", 'blá')
        .replace("bun tở", 'bum tở')
        .replace("h'leo", 'hleo')
        .replace("vình an", 'vĩnh an')
        .replace("eabar", 'ea bar')
        .replace("yên  phú", 'yên phú')
        .replace("đăk jrăng", 'Ðắk Drjăng')
        .replace("lai khê", 'lai vu')
        .replace("cẩm đông", 'Cẩm Ðông')
        .replace("bhinh", 'bhing')
        .replace("h'đing", 'hđinh')
        .replace("đăk ýa", 'Ðắk Ya')
        .replace("iale", 'ia le')
        .replace("chu chinh", 'chu trinh')
        .replace("đắk rtih", 'Đắk RTíh')
        .replace("sơ lang", 'sơn lang')
        .replace("đạ k'năng", 'đạ knăng')
        .replace("n'thôn hạ", 'NThol Hạ')
        .replace("h'neng", 'hneng')
        .replace("iachía", 'ia chia')
        .replace("ealy", 'ea ly')
        .replace("nậm pan", 'nậm ban')
        .replace("bát sát", 'bát xát')
        .replace("đăk môi", 'đăk môl')
        .replace("đưng k'nớh", 'đưng knớ')
        .replace("k'đơn", 'ka đơn')
        .replace("iasao", 'ia sao')
        .replace("nghãi", 'ngãi')
        .replace("- h chư pưh", '')
        .replace("iako", 'ia ko')
        .replace("iaka", 'ia ka')
        .replace("iarsươm", 'ia rsươm')
        .replace("cư dliê m'nông", 'Cư Dliê Mnông')
        .replace("iabăng", 'ia băng')
        .replace("iabang", 'ia bang')
        .replace("iadin", 'ia din')
        .replace("nà trì", 'nà chì')
        .replace("liêng s'rônh", 'Liêng Srônh')
        .replace("linh đông", 'Linh Ðông')
        .replace("đất quốc", 'đất cuốc')
        .replace("đăk r'moan", 'đăk rmoan')
        .replace("hà ra", 'hra')
        .replace("ia gar", 'ia ga')
        .replace("chà vài", 'chà vàl')
        .replace('iakring', 'ia kring')
        .replace('iakênh', 'ia kênh')
        .replace('chưhdrông', 'chư hdrông')
        .replace('iake', 'ia ake')
        .replace('iamơrơn', 'ia mrơn')
        .replace('nham biền', 'nham bền')
        .replace('eakao', 'ea kao')
        .replace('eapô', 'ea pô')
        .replace("h'nol", 'hnol')
        .replace("p quang hanh", 'quang hanh')
        .replace('thuận hóa', 'huế')
        .replace('cuebuor', 'xã cư êbur')
        .replace('chưr căm', 'chư rcăm')
        .replace('madaguoil', 'ma đa guôi')
        .replace('madagoil', 'ma đa guôi')
        .replace("đạm'ri", 'đạ mri')
        .replace('lâm ðồng', 'lâm đồng')
        .replace('bình ðịnh', 'bình định')
        .replace('krông pắk', 'krông pắc')
        .replace('ea kmêc', 'ea knuêc')
        .replace("ea m'nang", 'ea mnang')
        .replace("cư m'gar", 'cư mgar')
        .replace("m'đrắk", 'mdrăk')
        .replace("cư m'ta", 'cư mta')
        .replace("mỹ đình ii", 'mỹ đình 2')
        .replace("mỹ đình i", 'mỹ đình 1')
        .replace("an hoà", 'an hòa')
        .replace("đắk rô", 'đắk drô')
        .replace("eatu", 'ea tu')
        .replace("eatam", 'ea tam')
        .replace("ngọc bay", 'ngọk bay')
        .replace("cuôr dăng", 'cuôr đăng')
        .replace("long hoà", 'long hòa')
        .replace("an qui", 'an quy')
        .replace("long đất", 'long điền')
        .replace("nâm n jang", 'nâm njang')
        .replace("thuận hóa", 'huế')
        .replace("nam ðịnh", 'nam định')
        .replace("đliê ya", 'dliê ya')
        .replace("simacai", 'si ma cai')
        .replace("đà tẻh", 'đạ tẻh')
        .replace("pơngdrang", 'pơng drang')
        .replace("tông lệnh", 'tông lạnh')
        .replace("thứ 11", 'thứ mười một')
        .replace("tân hội cơ", 'tân hộ cơ')
        .replace("ia h'drai", 'ia hdrai')
        .replace("lạc phượng", 'phượng kỳ')
        .trim();
}

let addressData = [];

function normalizeAddr(str) {
    return str.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'd');
}

try {
    const raw = fs.readFileSync(path.join(ROOT, 'addresses3cap.json'), 'utf-8');
    addressData = JSON.parse(raw).map(item => {
        const wardClean = item.ward.replace(/-[A-Z0-9]+$/, '').trim();
        const full = `${wardClean}, ${item.district}, ${item.province}`;
        return {
            ward: wardClean,
            district: item.district,
            province: item.province,
            full: full,
            norm: normalizeAddr(full)
        };
    });
    console.log(`[Address] Đã load ${addressData.length} địa chỉ`);
} catch (e) {
    console.warn('[Address] Không load được addresses3cap.json:', e.message);
}

async function resolveAddress(address, name, phone, username) {

    if (!address) return ({ success: false, message: "Thiếu địa chỉ!" });
    if (!phone || phone.length != 10) return ({ success: false, message: "Sai số điện thoại, kiểm tra lại!" });
    try {
        const [tokenRows] = await db.promise().query('SELECT vtp_token FROM viettel_connect LIMIT 1');
        if (tokenRows.length === 0 || !tokenRows[0].vtp_token) {
            return ({ success: false, message: "Hệ thống chưa có Token Viettel!" });
        }
        const systemToken = tokenRows[0].vtp_token;

        const vtpRes = await axios.post(`https://partner.viettelpost.vn/v2/order/getPriceAllNlp`, {
            "SENDER_ADDRESS": "Long Bình, Biên Hòa, Đồng Nai",
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
            return ({ success: false, message: "Không nhận diện được địa chỉ này!" });
        }

        let tinh = "", huyen = "", xa = "";
        const [res1, res2, res3] = await Promise.all([
            axios.get(`https://partner.viettelpost.vn/v2/categories/listProvinceById?provinceId=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/districtByIdAndProvince?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&provinceById=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/wardByDistrictAndId?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&wardsId=${body.RECEIVER_ADDRESS.WARD_ID}`)
        ]);

        tinh = res1.data.data?.[0]?.PROVINCE_NAME || "";
        huyen = res2.data.data?.DISTRICT_NAME || "";
        xa = res3.data.data?.WARDS_NAME || "";

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

        if (jtRows && jtRows.length > 0) {
            const jt = jtRows[0];
            const upsertSql = `
    INSERT INTO customers (user_id, phone, prov, district, ward, name, address, newward, newprov)
    SELECT id, ?, ?, ?, ?, ?, ?, ?, ?
    FROM users 
    WHERE username = ?
    ON DUPLICATE KEY UPDATE 
        address = VALUES(address),
        prov = VALUES(prov), 
        district = VALUES(district),
        ward = VALUES(ward),
        name = VALUES(name),
        newward = VALUES(newward),
        newprov = VALUES(newprov)
`;

            await db.promise().query(upsertSql, [
                phone,        // 1
                jt.prov,      // 2
                jt.district,  // 3
                jt.ward,      // 4
                name,         // 5
                address,      // 6
                jt.newward,   // 7
                jt.newprov,   // 8
                username      // 9 
            ]);
            return ({
                success: true,
                data: {
                    prov: jt.prov,
                    district: jt.district,
                    ward: jt.ward,
                    newward: jt.newward,
                    newprov: jt.newprov,
                    fullStr: `${jt.ward}, ${jt.district}, ${jt.prov}`
                }
            });
        } else {
            return ({ success: false, message: "Địa chỉ Viettel hiểu nhưng J&T chưa có dữ liệu vùng này!" });
        }

    } catch (e) {
        console.error("Lỗi Validate Address:", e.message);
        return ({ success: false, message: "Lỗi kết nối hoặc hệ thống bận!" });
    }
}

module.exports = { addressData, applyAddressFixes, cleanSearchTerm, isBienHoaWardOpen, normalizeAddr, normalizeSQL, resolveAddress };
