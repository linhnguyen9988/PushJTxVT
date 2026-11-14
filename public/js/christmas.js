document.addEventListener('DOMContentLoaded', () => {
    if (!document.documentElement.classList.contains('christmas')) return;
    const pageVariant = Array.from(location.pathname).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    document.querySelectorAll('table').forEach((table, index) => {
        const frame = table.closest('.table-responsive') || table;
        if (frame.previousElementSibling?.classList.contains('noel-garland')) return;
        const garland = document.createElement('div');
        garland.className = `noel-garland noel-arrangement-${(pageVariant + index) % 3}`;
        garland.setAttribute('aria-hidden', 'true');
        frame.before(garland);
    });
    document.querySelectorAll('.btn').forEach(button => {
        if (button.matches('.btn-close, .btn-link')) return;
        const label = button.textContent.trim();
        const isCreate = /thêm|tạo|đăng ký|đăng nhập|xác nhận|lưu/i.test(label) || button.querySelector('.fa-plus, .fa-plus-circle, .fa-circle-plus');
        if (!isCreate) {
            if (/tìm|lọc|excel|^in\b/i.test(label) || button.querySelector('.fa-filter')) button.classList.add('noel-secondary');
        } else if (!button.closest('table, nav, .navbar') && !button.matches('a[href*="status="]')) {
            button.classList.add('noel-main');
        }
        button.classList.add('noel-snow-button');
        const snow = document.createElement('span');
        snow.className = 'noel-snow-cap';
        snow.setAttribute('aria-hidden', 'true');
        button.append(snow);
    });
    const icons = [[/đăng xuất/i, 'fa-right-from-bracket'], [/cập nhật ảnh/i, 'fa-camera'], [/làm mới|về vàng đồng/i, 'fa-rotate-left'], [/thêm|tạo/i, 'fa-plus'], [/tìm|kiểm tra/i, 'fa-magnifying-glass'], [/lưu|cập nhật/i, 'fa-floppy-disk'], [/lọc/i, 'fa-filter'], [/in đơn|^in$/i, 'fa-print'], [/xuất|tải/i, 'fa-download'], [/đăng nhập|vào hệ thống/i, 'fa-right-to-bracket'], [/đăng ký/i, 'fa-user-plus'], [/hủy|đóng/i, 'fa-xmark'], [/xác nhận/i, 'fa-check'], [/sửa/i, 'fa-pen'], [/quay lại/i, 'fa-arrow-left']];
    document.querySelectorAll('button, a.btn').forEach(button => {
        if (button.querySelector('i, svg, img') || !button.textContent.trim()) return;
        const match = icons.find(([pattern]) => pattern.test(button.textContent));
        if (!match) return;
        const icon = document.createElement('i');
        icon.className = `fas ${match[1]} me-1`;
        icon.setAttribute('aria-hidden', 'true');
        button.prepend(icon);
    });
});
