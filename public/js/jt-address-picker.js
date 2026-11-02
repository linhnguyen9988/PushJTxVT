/*
 * JtAddressPicker — 3 ô select Tỉnh / Huyện / Xã nằm hàng ngang.
 * Dùng khi validate địa chỉ thất bại (Viettel hiểu nhưng J&T không tra được trong DB):
 *   - Server trả hint { prov, district } (tên đúng như bảng jtaddress).
 *   - Có tỉnh -> điền sẵn tỉnh; có huyện -> điền sẵn huyện; khách tự chọn xã.
 *
 * Dùng:
 *   const picker = JtAddressPicker.create(document.getElementById('addr_picker'), {
 *       onSelect: ({ prov, district, ward }) => { ... },   // khi đã chọn đủ 3 ô
 *       onReset:  () => { ... }                            // khi đổi tỉnh/huyện làm mất lựa chọn xã
 *   });
 *   picker.show({ prov, district });   // hiện + điền sẵn
 *   picker.hide();                     // ẩn + xóa lựa chọn
 *
 * Dữ liệu lấy từ /api/address/provinces | districts | wards.
 */
(function (global) {
    'use strict';

    var STYLE_ID = 'jt-address-picker-style';
    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent =
            '.jt-picker{margin-top:8px}' +
            '.jt-picker-row{display:flex;flex-wrap:nowrap;gap:6px}' +
            '.jt-picker-row select{flex:1 1 0;min-width:0;width:100%;padding-right:2rem;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}' +
            '.jt-picker-note{font-size:.8rem;margin-bottom:4px}' +
            '@media (max-width:480px){' +
            '.jt-picker-row{gap:4px}' +
            '.jt-picker-row select{font-size:.75rem;padding-left:.4rem;padding-right:1.35rem;' +
            'background-position:right .3rem center;background-size:11px 8px;text-overflow:ellipsis}}';
        document.head.appendChild(st);
    }

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function fillOptions(select, placeholder, values, selected) {
        select.innerHTML = '';
        var ph = el('option', '', placeholder);
        ph.value = '';
        select.appendChild(ph);
        (values || []).forEach(function (v) {
            var o = el('option', '', v);
            o.value = v;
            if (v === selected) o.selected = true;
            select.appendChild(o);
        });
        if (selected && (values || []).indexOf(selected) === -1) select.value = '';
    }

    async function getList(url) {
        try {
            var r = await fetch(url, { credentials: 'same-origin' });
            if (!r.ok) return [];
            var data = await r.json();
            return Array.isArray(data) ? data : [];
        } catch (e) {
            return [];
        }
    }

    function create(container, opts) {
        opts = opts || {};
        injectStyle();

        var wrap = el('div', 'jt-picker');
        wrap.style.display = 'none';
        var note = el('div', 'jt-picker-note text-muted');
        var row = el('div', 'jt-picker-row');
        var selProv = el('select', 'form-select form-select-sm');
        var selDist = el('select', 'form-select form-select-sm');
        var selWard = el('select', 'form-select form-select-sm');
        selProv.setAttribute('aria-label', 'Tỉnh / Thành phố');
        selDist.setAttribute('aria-label', 'Quận / Huyện');
        selWard.setAttribute('aria-label', 'Phường / Xã');
        row.appendChild(selProv);
        row.appendChild(selDist);
        row.appendChild(selWard);
        wrap.appendChild(note);
        wrap.appendChild(row);
        container.appendChild(wrap);

        // Mỗi lần show/đổi ô tăng token, kết quả fetch cũ về muộn sẽ bị bỏ qua.
        var seq = 0;

        function emptyDist() { fillOptions(selDist, 'Quận / Huyện', [], ''); }
        function emptyWard() { fillOptions(selWard, 'Phường / Xã', [], ''); }

        function current() {
            return { prov: selProv.value, district: selDist.value, ward: selWard.value };
        }

        function notifyIfComplete() {
            var c = current();
            if (c.prov && c.district && c.ward && typeof opts.onSelect === 'function') opts.onSelect(c);
        }

        function notifyReset() {
            if (typeof opts.onReset === 'function') opts.onReset();
        }

        async function loadDistricts(prov, selected, token) {
            emptyDist(); emptyWard();
            if (!prov) return;
            var list = await getList('/api/address/districts?prov=' + encodeURIComponent(prov));
            if (token !== seq) return;
            fillOptions(selDist, 'Quận / Huyện', list, selected);
        }

        async function loadWards(prov, district, token) {
            emptyWard();
            if (!prov || !district) return;
            var list = await getList('/api/address/wards?prov=' + encodeURIComponent(prov) + '&district=' + encodeURIComponent(district));
            if (token !== seq) return;
            fillOptions(selWard, 'Phường / Xã', list, '');
        }

        selProv.addEventListener('change', async function () {
            var token = ++seq;
            notifyReset();
            await loadDistricts(selProv.value, '', token);
        });

        selDist.addEventListener('change', async function () {
            var token = ++seq;
            notifyReset();
            await loadWards(selProv.value, selDist.value, token);
        });

        selWard.addEventListener('change', function () {
            if (!selWard.value) { notifyReset(); return; }
            notifyIfComplete();
        });

        return {
            // hint: { prov?, district? }; message (tuỳ chọn): dòng hướng dẫn phía trên 3 ô
            show: async function (hint, message) {
                hint = hint || {};
                var token = ++seq;
                note.textContent = message || 'Chọn lại vùng giao hàng J&T (thường chỉ cần chọn xã):';
                wrap.style.display = '';
                emptyDist(); emptyWard();
                var provinces = await getList('/api/address/provinces');
                if (token !== seq) return;
                fillOptions(selProv, 'Tỉnh / Thành phố', provinces, hint.prov || '');
                if (!selProv.value) return;               // không nhận được tỉnh -> khách chọn từ đầu
                await loadDistricts(selProv.value, hint.district || '', token);
                if (token !== seq || !selDist.value) return;   // không nhận được huyện -> khách chọn huyện
                await loadWards(selProv.value, selDist.value, token);
            },
            hide: function () {
                seq++;
                wrap.style.display = 'none';
                selProv.innerHTML = ''; emptyDist(); emptyWard();
            },
            isVisible: function () { return wrap.style.display !== 'none'; },
            getSelection: current
        };
    }

    global.JtAddressPicker = { create: create };
})(window);
