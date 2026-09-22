/*!
 * OtpInput – ô nhập mã 2FA dùng chung (6 ô, mỗi ô 1 số)
 *
 *   var otp = OtpInput.mount(document.getElementById('host'), {
 *       recovery: true,        // cho phép chuyển sang nhập mã khôi phục (XXXX-XXXX)
 *       size: 'sm',            // 'sm' = ô nhỏ hơn (dùng trong modal)
 *       autofocus: true,
 *       onChange:     function (otp) {},
 *       onModeChange: function (mode, otp) {},           // 'code' | 'recovery'
 *       onSubmit:     function (value, info) {}          // info.auto = true khi tự gửi lúc đủ 6 số
 *   });
 *
 *   otp.getValue()  otp.isComplete()  otp.reset({keepMode, error, noFocus})
 *   otp.focus()  otp.setError(bool)  otp.setDisabled(bool)  otp.getMode()
 */
(function (global) {
    'use strict';

    var LEN = 6;
    var AUTO_DELAY = 150;                 // ms chờ sau số cuối rồi mới tự gửi
    var STALE_MS = 90 * 1000;             // không gợi ý lại mã vừa gửi trong 90s
    var LAST_KEY = 'otp:last-submitted';

    var instances = [];
    var perm = 'unknown';                 // granted | prompt | denied | unsupported
    var armed = false;

    /* ───────── Clipboard (dùng chung cho mọi instance) ───────── */
    function canRead() { return !!(navigator.clipboard && navigator.clipboard.readText); }
    function hasActivation() { return !!(navigator.userActivation && navigator.userActivation.isActive); }

    function extractCode(text) {
        var t = String(text || '').trim().replace(/[\s-]/g, '');
        return /^\d{6}$/.test(t) ? t : null;
    }

    function recentlySubmitted(code) {
        try {
            var o = JSON.parse(sessionStorage.getItem(LAST_KEY) || 'null');
            return !!(o && o.code === code && Date.now() - o.t < STALE_MS);
        } catch (e) { return false; }
    }
    function rememberSubmitted(code) {
        try { sessionStorage.setItem(LAST_KEY, JSON.stringify({ code: code, t: Date.now() })); } catch (e) {}
    }

    function refreshAll() {
        instances = instances.filter(function (i) { return i.host.isConnected; });
        instances.forEach(function (i) { i._clip(); });
    }

    // Chrome hỏi quyền đọc clipboard cần 1 thao tác của người dùng -> chờ cú chạm đầu tiên
    function armGesture() {
        if (armed) return;
        armed = true;
        var evs = ['pointerdown', 'pointerup', 'click', 'keydown'];
        var h = function () {
            armed = false;
            evs.forEach(function (n) { document.removeEventListener(n, h, true); });
            refreshAll();
        };
        evs.forEach(function (n) { document.addEventListener(n, h, true); });
    }

    function initPermission() {
        if (!canRead() || !navigator.permissions || !navigator.permissions.query) { perm = 'unsupported'; return; }
        navigator.permissions.query({ name: 'clipboard-read' }).then(function (st) {
            perm = st.state;
            st.onchange = function () { perm = st.state; refreshAll(); };
            refreshAll();
        }).catch(function () { perm = 'unsupported'; }); // Firefox/Safari: không cho web tự đọc clipboard
    }
    window.addEventListener('focus', refreshAll);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshAll(); });

    /* ───────── Mount ───────── */
    function mount(host, opts) {
        opts = opts || {};
        if (host._otp) return host._otp;

        var mode = 'code';
        var disabled = false;
        var lastFired = '';
        var clipCode = null;
        var timer = null;
        var ready = false;               // chưa emit onChange trong lúc mount

        host.classList.add('otp');
        if (opts.size === 'sm') host.classList.add('otp--sm');

        var boxesHtml = '';
        for (var i = 0; i < LEN; i++) {
            boxesHtml += '<input type="text" class="otp-box" inputmode="numeric" pattern="[0-9]*"' +
                ' autocomplete="' + (i === 0 ? 'one-time-code' : 'off') + '"' +
                ' autocapitalize="off" autocorrect="off" spellcheck="false"' +
                ' aria-label="Chữ số thứ ' + (i + 1) + '">';
        }
        host.innerHTML =
            '<div class="otp-pane-code">' +
                '<div class="otp-group" role="group" aria-label="Mã xác thực 6 số">' + boxesHtml + '</div>' +
                '<div class="otp-paste-slot text-center">' +
                    '<button type="button" class="otp-paste btn btn-sm btn-outline-primary rounded-pill px-3 d-none">' +
                        '<i class="fas fa-paste me-1"></i>Dán mã <strong class="otp-paste-code ms-1"></strong>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="otp-pane-recovery d-none">' +
                '<input type="text" class="form-control text-center otp-recovery" placeholder="XXXX-XXXX" maxlength="9"' +
                ' autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Mã khôi phục">' +
            '</div>' +
            (opts.recovery
                ? '<div class="otp-toggle-wrap text-center"><button type="button" class="otp-toggle btn btn-link btn-sm text-decoration-none p-0">Mất thiết bị? Dùng mã khôi phục</button></div>'
                : '');

        var group = host.querySelector('.otp-group');
        var boxes = Array.prototype.slice.call(group.querySelectorAll('.otp-box'));
        var paneCode = host.querySelector('.otp-pane-code');
        var paneRec = host.querySelector('.otp-pane-recovery');
        var recInput = host.querySelector('.otp-recovery');
        var toggleBtn = host.querySelector('.otp-toggle');
        var pasteBtn = host.querySelector('.otp-paste');
        var pasteLabel = host.querySelector('.otp-paste-code');

        /* ── helpers ── */
        function getCode() { return boxes.map(function (b) { return b.value; }).join(''); }
        function isComplete() { return mode === 'recovery' ? recInput.value.length === 9 : getCode().length === LEN; }
        function getValue() { return mode === 'recovery' ? recInput.value : getCode(); }
        function visible() { return host.getClientRects().length > 0; }

        function setError(on) {
            boxes.forEach(function (b) { b.classList.toggle('error', !!on); });
            recInput.classList.toggle('is-invalid', !!on);
            group.classList.remove('shake');
            if (on) { void group.offsetWidth; group.classList.add('shake'); }
        }

        function pop(box) { box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop'); }

        function emitChange() { if (ready && opts.onChange) opts.onChange(api); }

        function fire(auto) {
            var v = getValue();
            rememberSubmitted(v);
            if (opts.onSubmit) opts.onSubmit(v, { auto: !!auto });
        }

        // fromUser = true khi do người dùng gõ/dán -> mới được phép tự gửi
        function sync(fromUser) {
            var code = getCode();
            boxes.forEach(function (b) { b.dataset.prev = b.value; b.classList.toggle('filled', !!b.value); });

            if (code.length === LEN) {
                hidePaste();
                if (fromUser && mode === 'code' && !disabled && code !== lastFired) {
                    lastFired = code;
                    clearTimeout(timer);
                    timer = setTimeout(function () {
                        if (mode === 'code' && !disabled && getCode() === code) fire(true);
                    }, AUTO_DELAY);
                }
            } else {
                lastFired = '';
                clearTimeout(timer);
            }
            emitChange();
        }

        // Điền digits từ ô `start`; đủ 6 số thì luôn điền từ ô đầu
        function fill(digits, start, fromUser) {
            digits = String(digits || '').replace(/\D/g, '');
            if (!digits) return;
            if (digits.length >= LEN) { digits = digits.slice(0, LEN); start = 0; }
            var i = start;
            for (var k = 0; k < digits.length && i < LEN; k++, i++) {
                boxes[i].value = digits[k];
                pop(boxes[i]);
            }
            setError(false);
            sync(fromUser !== false);
            boxes[Math.min(i, LEN - 1)].focus();
        }

        /* ── paste button ── */
        function showPaste(code) {
            clipCode = code;
            pasteLabel.textContent = code.slice(0, 3) + ' ' + code.slice(3);
            pasteBtn.classList.remove('d-none');
        }
        function hidePaste() { clipCode = null; pasteBtn.classList.add('d-none'); }

        function readClipboard() {
            navigator.clipboard.readText().then(function (text) {
                var c = extractCode(text);
                if (c && !recentlySubmitted(c) && mode === 'code' && !disabled && getCode().length < LEN && visible()) showPaste(c);
                else hidePaste();
            }).catch(function () { /* không có quyền / tab chưa focus */ });
        }

        function checkClip() {
            if (mode !== 'code' || disabled || getCode().length === LEN || !visible() || !canRead()) { hidePaste(); return; }
            if (perm === 'granted' || (perm === 'prompt' && hasActivation())) readClipboard();
            else if (perm === 'prompt') armGesture();
        }

        pasteBtn.addEventListener('click', function () {
            var c = clipCode;
            hidePaste();
            if (c) fill(c, 0, true);
        });

        /* ── 6 ô ── */
        boxes.forEach(function (box, idx) {
            box.addEventListener('focus', function () { box.select(); });
            box.addEventListener('mouseup', function (e) { e.preventDefault(); }); // giữ vùng chọn (Safari)

            box.addEventListener('keydown', function (e) {
                if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl/Cmd+V, +A...
                switch (e.key) {
                    case 'Enter':
                        e.preventDefault();
                        if (isComplete() && !disabled) { lastFired = getCode(); fire(false); }
                        break;
                    case 'Backspace':
                        e.preventDefault();
                        if (box.value) box.value = '';
                        else if (idx > 0) { boxes[idx - 1].value = ''; boxes[idx - 1].focus(); }
                        setError(false); sync(false);
                        break;
                    case 'Delete':
                        e.preventDefault(); box.value = ''; setError(false); sync(false);
                        break;
                    case 'ArrowLeft':  e.preventDefault(); if (idx > 0) boxes[idx - 1].focus(); break;
                    case 'ArrowRight': e.preventDefault(); if (idx < LEN - 1) boxes[idx + 1].focus(); break;
                    case 'Home':       e.preventDefault(); boxes[0].focus(); break;
                    case 'End':        e.preventDefault(); boxes[LEN - 1].focus(); break;
                }
            });

            // Gõ số / autofill SMS / bàn phím ảo Android
            box.addEventListener('input', function (e) {
                var prev = box.dataset.prev || '';
                var raw = box.value;
                var digits = raw.replace(/\D/g, '');

                if (!digits) {
                    box.value = (e.inputType || '').indexOf('delete') === 0 ? '' : prev; // gõ chữ -> bỏ qua
                } else if (digits.length === 1) {
                    box.value = digits; pop(box);
                    if (idx < LEN - 1) boxes[idx + 1].focus();
                } else if (digits.length === 2 && prev && digits.indexOf(prev) !== -1) {
                    box.value = digits.replace(prev, ''); pop(box);   // gõ đè lên ô đã có số
                    if (idx < LEN - 1) boxes[idx + 1].focus();
                } else {
                    fill(digits, idx, true);                          // autofill / dán kiểu input
                    return;
                }
                setError(false);
                sync(true);
            });

            // Dán vào BẤT KỲ ô nào -> điền hết
            box.addEventListener('paste', function (e) {
                e.preventDefault();
                var text = (e.clipboardData || window.clipboardData).getData('text');
                fill(text, idx, true);
            });
        });

        /* ── mã khôi phục XXXX-XXXX ── */
        recInput.addEventListener('input', function () {
            var v = recInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
            if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4);
            recInput.value = v;
            recInput.classList.remove('is-invalid');
            emitChange();
        });
        recInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (isComplete() && !disabled) fire(false);
            }
        });

        function setMode(m) {
            if (m === 'recovery' && !opts.recovery) return;
            mode = m;
            paneCode.classList.toggle('d-none', m === 'recovery');
            paneRec.classList.toggle('d-none', m !== 'recovery');
            if (toggleBtn) toggleBtn.textContent = m === 'recovery' ? 'Dùng mã từ app Authenticator' : 'Mất thiết bị? Dùng mã khôi phục';
            if (m === 'recovery') { hidePaste(); recInput.focus(); }
            else { boxes[Math.min(getCode().length, LEN - 1)].focus(); checkClip(); }
            if (opts.onModeChange) opts.onModeChange(m, api);
            emitChange();
        }
        if (toggleBtn) toggleBtn.addEventListener('click', function () { setMode(mode === 'code' ? 'recovery' : 'code'); });

        /* ── API ── */
        function focus() {
            if (mode === 'recovery') recInput.focus();
            else boxes[Math.min(getCode().length, LEN - 1)].focus();
        }

        function setDisabled(d) {
            disabled = !!d;
            boxes.forEach(function (b) { b.disabled = disabled; });
            recInput.disabled = disabled;
            if (toggleBtn) toggleBtn.disabled = disabled;
            if (disabled) hidePaste();
        }

        function reset(o) {
            o = o || {};
            clearTimeout(timer);
            setDisabled(false);
            boxes.forEach(function (b) { b.value = ''; });
            recInput.value = '';
            lastFired = '';
            setError(false);
            if (!o.keepMode && mode !== 'code') {
                mode = 'code';
                paneCode.classList.remove('d-none'); paneRec.classList.add('d-none');
                if (toggleBtn) toggleBtn.textContent = 'Mất thiết bị? Dùng mã khôi phục';
                if (opts.onModeChange) opts.onModeChange('code', api);
            }
            sync(false);
            if (o.error) setError(true);
            if (!o.noFocus) focus();
            checkClip();
        }

        var api = {
            host: host,
            getValue: getValue,
            isComplete: isComplete,
            getMode: function () { return mode; },
            setMode: setMode,
            focus: focus,
            reset: reset,
            setError: setError,
            setDisabled: setDisabled,
            _clip: checkClip
        };

        host._otp = api;
        instances.push(api);
        sync(false);
        ready = true;
        if (opts.autofocus) setTimeout(function () { focus(); checkClip(); }, 0);
        return api;
    }

    initPermission();
    global.OtpInput = { mount: mount, get: function (host) { return host && host._otp; } };
})(window);
