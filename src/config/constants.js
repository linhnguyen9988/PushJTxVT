const STATUS_MAP = {
    pending: { text: 'Chờ lấy hàng', class: 'bg-warning-subtle text-warning-emphasis border border-warning' },
    cancel: { text: 'Đã hủy đơn', class: 'bg-secondary-subtle text-secondary border border-secondary' },
    picked_up: { text: 'Đã lấy hàng', class: 'bg-info-subtle text-info-emphasis border border-info' },
    delivering: { text: 'Đang vận chuyển', class: 'bg-primary-subtle text-primary border border-primary' },
    out_for_delivery: { text: 'Đang giao hàng', class: 'bg-primary border text-white' },
    completed: { text: 'Thành công', class: 'bg-success-subtle text-success border border-success' },
    returning: { text: 'Đang hoàn', class: 'bg-danger-subtle text-danger border border-danger' },
    returned: { text: 'Đã hoàn hàng', class: 'bg-dark-subtle text-dark border border-dark' },
    issue: { text: 'Kiện vấn đề', class: 'bg-danger text-white border border-danger' }
};

const APP_2FA_ISSUER = 'TV Ship';

const JT_STATUS_VN = {
    103: "Tạo đơn thành công", 105: "Đã hủy đơn", 106: "Bưu tá đã lấy hàng",
    109: "Xuất kho trung chuyển", 110: "Hàng đã đến bưu cục", 112: "Đang giao hàng",
    113: "Giao hàng thành công", 116: "Đang chuyển hoàn", 117: "Đã ký nhận hoàn trả",
    118: "Kiện vấn đề (Giao)", 120: "Kiện vấn đề (Hoàn)"
};

module.exports = { APP_2FA_ISSUER, JT_STATUS_VN, STATUS_MAP };
