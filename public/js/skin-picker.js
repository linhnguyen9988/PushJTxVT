(function () {
    'use strict';
    const form = document.getElementById('skin-form');
    const picker = document.getElementById('skin-color');
    const input = document.getElementById('skin-hex');
    const status = document.getElementById('skin-status');
    let saved = window.TVShipSkin.get();
    function preview(color) {
        if (!window.TVShipSkin.apply(color)) return;
        input.value = picker.value = color.toLowerCase();
        status.textContent = color.toLowerCase() === saved ? '' : 'Đang xem thử — chưa lưu.';
    }
    preview(saved);
    picker.addEventListener('input', () => preview(picker.value));
    input.addEventListener('input', () => preview(input.value));
    form.querySelectorAll('[data-skin]').forEach(button => button.addEventListener('click', () => preview(button.dataset.skin)));
    document.getElementById('skin-reset').addEventListener('click', () => preview('#b78238'));
    document.getElementById('skin-cancel').addEventListener('click', () => preview(saved));
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const color = input.value.toLowerCase();
        const controls = Array.from(form.querySelectorAll('input, button'));
        controls.forEach(control => { control.disabled = true; });
        status.textContent = 'Đang lưu...';
        try {
            const response = await fetch('/api/profile/skin', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-Skin-CSRF': document.querySelector('meta[name="skin-csrf"]').content },
                body: JSON.stringify({ color })
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Không lưu được màu.');
            saved = data.color;
            preview(saved);
            status.textContent = 'Đã lưu màu cho tài khoản của bạn.';
        } catch (error) {
            status.textContent = error.message + ' Màu xem thử chưa được lưu.';
        } finally {
            controls.forEach(control => { control.disabled = false; });
        }
    });
})();
