const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../config/paths');

let _logoBuffer = null;

let _logoBase64 = null;

function getLogoBuffer() {
    if (_logoBuffer) return _logoBuffer;
    const logoPath = path.join(ROOT, 'public', 'logo_tem.png');
    if (fs.existsSync(logoPath)) {
        _logoBuffer = fs.readFileSync(logoPath);
        _logoBase64 = 'data:image/png;base64,' + _logoBuffer.toString('base64');
    }
    return _logoBuffer;
}

function getLogoBase64() {
    return _logoBase64;
}

getLogoBuffer();

async function renderLabelsToPdfBuffer(orders, user, showCod) {
    const size80mm = 226.77;
    const doc = new PDFDocument({ size: [size80mm, size80mm], margins: { top: 0, left: 0, right: 0, bottom: 0 } });

    const fontPath = path.join(ROOT, 'public', 'Tahoma-Bold.ttf');
    const fontRegularPath = path.join(ROOT, 'public', 'Tahoma.ttf');
    const colWidth = 216.77 / 3;
    const firstColumnX = 5 + colWidth;
    const logoBuffer = getLogoBuffer();

    const assets = await Promise.all(orders.map(async (order) => {
        const code = order.realjtbillcode || order.order_code;
        const [barcodeBuf, qrBuf] = await Promise.all([
            bwipjs.toBuffer({ bcid: 'code128', text: code, scale: 3, height: 10, includetext: false }),
            QRCode.toBuffer(code, { margin: 1, width: 100 })
        ]);
        return { order, code, barcodeBuf, qrBuf };
    }));

    for (let i = 0; i < assets.length; i++) {
        if (i > 0) doc.addPage();
        const { order, code, barcodeBuf, qrBuf } = assets[i];
        const sort = formatSortCode(order.sortLine);

        doc.lineWidth(1.5).rect(5, 5, 216.77, 216.77).stroke();

        doc.moveTo(5, 45).lineTo(221.77, 45).stroke();
        doc.moveTo(firstColumnX, 5).lineTo(firstColumnX, 45).stroke();
        if (logoBuffer) {
            doc.image(logoBuffer, 10, 8, { fit: [colWidth - 10, 32], align: 'center', valign: 'center' });
        }
        doc.image(barcodeBuf, firstColumnX + 10, 10, { width: 125, height: 20 });
        doc.font(fontPath).fontSize(9).text(code, firstColumnX, 32, { width: 221.77 - firstColumnX, align: 'center' });

        doc.moveTo(5, 75).lineTo(221.77, 75).stroke();
        const sortY = 50;
        doc.font(fontPath).fontSize(14);
        doc.text(sort[0] || '', 5, sortY, { width: colWidth, align: 'center' });
        doc.moveTo(firstColumnX, 45).lineTo(firstColumnX, 75).stroke();
        doc.text(sort[1] || '', firstColumnX, sortY, { width: colWidth, align: 'center' });
        doc.moveTo(firstColumnX + colWidth, 45).lineTo(firstColumnX + colWidth, 75).stroke();
        doc.text(sort[2] || '', firstColumnX + colWidth, sortY, { width: colWidth, align: 'center' });

        doc.moveTo(5, 143).lineTo(221.77, 143).stroke();
        doc.font(fontPath).fontSize(9).text(`GỬI: ${user.jt_shopname || 'N/A'} - ${user.jt_sdt || ''}`, 10, 82);
        doc.moveDown(0.4);
        doc.text(`NHẬN: ${order.customer_name} - ${order.customer_phone}`);
        doc.font(fontRegularPath).fontSize(8.5).text(order.customer_address, { width: 205, lineGap: 1 });

        const qrX = 160;
        doc.moveTo(qrX, 143).lineTo(qrX, 199).stroke();
        doc.moveTo(5, 199).lineTo(221.77, 199).stroke();
        doc.font(fontPath).fontSize(8).text(order.note || 'KHÔNG CHO XEM HÀNG', 10, 148, { width: qrX - 15 });
        doc.font(fontRegularPath).fontSize(12).text(`Hàng hóa: ${order.product_name || ''} x ${order.weight} KG`, 10, 185);
        doc.image(qrBuf, qrX + 4, 145, { width: 52, height: 52 });

        if (showCod) {
            doc.fillColor('#000000').font(fontPath).fontSize(13)
                .text(`TIỀN THU HỘ: ${Number(order.price).toLocaleString()} VNĐ`, 5, 205, { align: 'center', width: 216 });
        }
    }

    return new Promise((resolve, reject) => {
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

function canPrintOrder(role, status) {
    const st = String(status || '').toLowerCase();
    if (role === 'admin' || role === 'manager') return st !== 'cancel';
    return st === 'pending';
}

function splitPrintableOrders(orders, role) {
    const printable = [];
    const invalid = [];
    for (const o of orders) {
        (canPrintOrder(role, o.status) ? printable : invalid).push(o);
    }
    return { printable, invalid };
}

function setPrintSkipHeaders(res, invalid) {
    res.setHeader('X-Print-Invalid-Count', String(invalid.length));
    if (invalid.length > 0) {
        res.setHeader('X-Print-Invalid-Codes', invalid.slice(0, 50)
            .map(o => String(o.realjtbillcode || o.order_code || '').replace(/[^\w\-]/g, ''))
            .join(','));
    }
}

function formatSortCode(sortString) {
    if (!sortString) return ['', '', ''];
    const parts = sortString.split('-').map(p => p.trim());

    if (parts.length === 5) {
        return [parts[0], `${parts[1]}-${parts[2]}-${parts[3]}`, parts[4]];
    }
    if (parts.length === 4) {
        return [parts[0], `${parts[1]}-${parts[2]}`, parts[3]];
    }
    return [parts[0] || '', parts[1] || '', parts[2] || ''];
}

function generateFullHtml(content, isDesktop = false, showCod = 1) {
    const printScript = isDesktop ? `
    <script>
        window.onload = () => {
            window.print();
            window.onafterprint = () => window.parent.postMessage('close-print-frame', '*');
        };
    </script>` : "";

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    @page { size: 80mm 80mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; line-height: 1.1; font-family: "Tahoma", sans-serif; }
    .page-break { height: 79.5mm; width: 80mm; display: flex; justify-content: center; align-items: center; page-break-after: always; overflow: hidden; break-after: page; }
    .page-break:last-child { page-break-after: avoid; break-after: avoid; }
    .label-container { width: 76mm; height: 76mm; border: 2px solid #000; display: flex; flex-direction: column; overflow: hidden; background: #fff; }
    .section-barcode { height: 14mm; border-bottom: 2px solid #000; display: grid; grid-template-columns: 80px 1fr; }
    .logo-box { display: flex; align-items: center; justify-content: center; border-right: 1px solid #000; padding: 3px; }
    .logo-img { max-width: 100%; max-height: 12mm; object-fit: contain; }
    .barcode-box { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1mm 0; }
    .barcode-img { width: 85%; height: 5.5mm; }
    .order-id { font-size: 10px; font-weight: bold; margin-top: 2.5mm; }
    .section-sortline { height: 10mm; border-bottom: 2.5px solid #000; display: grid; grid-template-columns: 1fr 1.5fr 1fr; text-align: center; font-weight: bold; }
    .sort-item { display: flex; align-items: center; justify-content: center; border-right: 1.5px solid #000; font-size: 20px; }
    .sort-item:last-child { border-right: none; }
    .section-addresses { height: 24mm; border-bottom: 1.5px solid #000; padding: 4px; font-size: 11px; display: flex; flex-direction: column; justify-content: space-around; }
    .section-bottom { height: 20mm; display: grid; grid-template-columns: 1fr 22mm; border-bottom: 2.5px solid #000; }
    .note-box { padding: 4px; font-size: 9px; font-weight: bold; text-transform: uppercase; border-right: 1.5px solid #000; display: flex; flex-direction: column; justify-content: flex-start; text-align: left; overflow: hidden; }
    .qr-box { display: flex; align-items: center; justify-content: center; }
    .qr-img { width: 18mm; height: 18mm; }
    .section-cod { flex-grow: 1; padding-left: 8px; display: flex; align-items: center; font-size: 16px; font-weight: bold; }
    ${!showCod ? ".section-cod { display: none !important; }" : ""}
    </style></head><body>${content}${printScript}</body></html>`;
}

module.exports = { getLogoBase64, formatSortCode, generateFullHtml, renderLabelsToPdfBuffer, setPrintSkipHeaders, splitPrintableOrders };
