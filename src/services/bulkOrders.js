const ExcelJS = require('exceljs');
const multer = require('multer');

const BULK_MAX_ROWS = 100;

const BULK_COLUMNS = [
    { key: 'provider', header: 'Đơn vị vận chuyển (*)', width: 22 },
    { key: 'customer_name', header: 'Họ tên người nhận (*)', width: 26 },
    { key: 'customer_phone', header: 'Số điện thoại (*)', width: 16 },
    { key: 'address', header: 'Địa chỉ nhận hàng (*)', width: 52 },
    { key: 'product_name', header: 'Tên hàng (*)', width: 24 },
    { key: 'cod', header: 'COD (vnđ)', width: 14 },
    { key: 'weight', header: 'Cân nặng (kg)', width: 14 },
    { key: 'note', header: 'Ghi chú giao hàng', width: 30 },
    { key: 'is_partial_delivery', header: 'Giao 1 phần (Có/Không)', width: 22 }
];

const uploadBulkExcel = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

function bulkCellText(cell) {
    let v = cell ? cell.value : null;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('').trim();
        if (v.result !== undefined && v.result !== null) return String(v.result).trim();
        if (v.text !== undefined) return String(v.text).trim();
        return '';
    }
    return String(v).trim();
}

function bulkPlain(str) {
    return String(str || '').toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/\s+/g, '');
}

function normalizeBulkProvider(v) {
    const k = bulkPlain(v);
    if (['j&t', 'jt', 'j&texpress', 'jtexpress'].includes(k)) return 'J&T';
    if (['viettel', 'vtp', 'viettelpost'].includes(k)) return 'Viettel';
    if (['nb', 'bienhoa', 'noibo'].includes(k)) return 'NB';
    return '';
}

function normalizeBulkRow(raw) {
    const errors = [];

    const provider = normalizeBulkProvider(raw.provider);
    if (!provider) errors.push('Đơn vị vận chuyển không hợp lệ (chỉ nhận J&T, Viettel hoặc NB)');

    const customer_name = String(raw.customer_name ?? '').trim();
    if (!customer_name) errors.push('Thiếu họ tên người nhận');

    let phone = String(raw.customer_phone ?? '').replace(/[\s.\-()]/g, '');
    if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
    else if (phone.startsWith('84') && phone.length === 11) phone = '0' + phone.slice(2);
    else if (/^\d{9}$/.test(phone)) phone = '0' + phone;
    if (!/^0\d{9}$/.test(phone)) errors.push('Số điện thoại không hợp lệ (cần đủ 10 số, bắt đầu bằng 0)');

    const address = String(raw.address ?? '').trim();
    if (!address) errors.push('Thiếu địa chỉ nhận hàng');

    const product_name = String(raw.product_name ?? '').trim();
    if (!product_name) errors.push('Thiếu tên hàng');

    let cod = 0;
    const codRaw = String(raw.cod ?? '').trim();
    if (codRaw !== '') {
        const digits = codRaw.replace(/[^\d]/g, '');
        if (!digits) errors.push('COD không hợp lệ');
        else cod = Number(digits);
    }

    let weight = '1';
    const wRaw = String(raw.weight ?? '').trim().replace(',', '.');
    if (wRaw !== '') {
        const w = Number(wRaw);
        if (!(w > 0)) errors.push('Cân nặng không hợp lệ (phải lớn hơn 0)');
        else weight = String(w);
    }

    const note = String(raw.note ?? '').trim();

    const partial = bulkPlain(raw.is_partial_delivery);
    const is_partial_delivery = ['khong', '0', 'no', 'false', 'n', 'k'].includes(partial) ? 0 : 1;

    return {
        data: { provider, customer_name, customer_phone: phone, address, product_name, cod, weight, note, is_partial_delivery },
        error: errors.join('; ')
    };
}

async function buildBulkTemplate() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Đơn hàng', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = BULK_COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));

    const head = ws.getRow(1);
    head.height = 30;
    head.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E9E' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    ws.getColumn('C').numFmt = '@';
    ws.getColumn('F').numFmt = '#,##0';

    for (let r = 2; r <= BULK_MAX_ROWS + 1; r++) {
        const a = ws.getCell(`A${r}`);
        a.value = 'J&T';
        a.dataValidation = { type: 'list', allowBlank: true, formulae: ['"J&T,Viettel,NB"'] };
        ws.getCell(`C${r}`).numFmt = '@';
        ws.getCell(`F${r}`).numFmt = '#,##0';
        ws.getCell(`I${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Có,Không"'] };
    }

    const guide = wb.addWorksheet('Hướng dẫn');
    guide.columns = [{ width: 28 }, { width: 90 }];
    const rules = [
        ['Cách dùng', `Nhập đơn ở sheet "Đơn hàng", mỗi dòng 1 đơn (tối đa ${BULK_MAX_ROWS} đơn/lần). Không đổi tên/thứ tự các cột ở dòng tiêu đề.`],
        ['Đơn vị vận chuyển (*)', 'Mặc định là J&T. Bấm vào ô để chọn J&T, Viettel hoặc NB (Biên Hòa).'],
        ['Họ tên người nhận (*)', 'Bắt buộc.'],
        ['Số điện thoại (*)', 'Đủ 10 số, bắt đầu bằng 0. Ví dụ: 0987654321.'],
        ['Địa chỉ nhận hàng (*)', 'Ghi đầy đủ: số nhà, đường, phường/xã, quận/huyện, tỉnh/thành. Hệ thống tự nhận diện vùng giao.'],
        ['Tên hàng (*)', 'Bắt buộc. Ví dụ: Quần áo.'],
        ['COD (vnđ)', 'Số tiền thu hộ, ô tự hiển thị dạng tiền (100,000). Để trống hoặc 0 nếu không thu. Gõ 100000, 100,000 hay 100.000 đều được.'],
        ['Cân nặng (kg)', 'Để trống = 1 kg. Có thể dùng số lẻ, ví dụ 0.5.'],
        ['Ghi chú giao hàng', 'Không bắt buộc.'],
        ['Giao 1 phần', 'Có / Không. Để trống = Có. Chỉ áp dụng cho J&T.'],
        ['', ''],
        ['Ví dụ (không nhập ở đây)', 'J&T | Nguyễn Văn A | 0987654321 | 12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh | Quần áo | 350000 | 1 | Cho xem hàng | Có']
    ];
    rules.forEach(r => guide.addRow(r));
    guide.getColumn(1).font = { bold: true };
    guide.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

    return wb;
}

async function parseBulkWorkbook(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Đơn hàng') || wb.worksheets[0];
    if (!ws) return { error: 'File Excel không có sheet nào.' };

    const h = (c) => bulkCellText(ws.getRow(1).getCell(c)).normalize('NFC').toLowerCase();
    if (!(h(2).includes('họ tên') && h(3).includes('điện thoại') && h(4).includes('địa chỉ'))) {
        return { error: 'File không đúng mẫu. Vui lòng tải file mẫu và nhập theo đúng các cột.' };
    }

    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const raw = {};
        BULK_COLUMNS.forEach((c, idx) => { raw[c.key] = bulkCellText(row.getCell(idx + 1)); });
        if (BULK_COLUMNS.every(c => c.key === 'provider' || raw[c.key] === '')) return;
        const { data, error } = normalizeBulkRow(raw);
        rows.push({ row: rowNumber, ...data, error });
    });

    if (rows.length === 0) return { error: 'File không có dữ liệu đơn hàng.' };
    if (rows.length > BULK_MAX_ROWS) return { error: `File có ${rows.length} dòng, tối đa ${BULK_MAX_ROWS} đơn mỗi lần. Vui lòng chia nhỏ file.` };
    return { rows };
}

module.exports = { BULK_COLUMNS, BULK_MAX_ROWS, buildBulkTemplate, normalizeBulkRow, parseBulkWorkbook, uploadBulkExcel };
