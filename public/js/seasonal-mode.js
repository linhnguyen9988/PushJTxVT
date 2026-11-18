(function () {
    'use strict';
    if (location.pathname.startsWith('/admin')) return;
    const root = document.documentElement;
    let enabled = root.classList.contains('christmas');
    let busy = false;
    let previousTheme = root.getAttribute('data-bs-theme');
    function savedTheme() {
        try { return localStorage.getItem('tvship-theme') === 'dark' ? 'dark' : 'light'; }
        catch (_) { return previousTheme === 'dark' ? 'dark' : 'light'; }
    }
    function syncControls() {
        const dark = root.getAttribute('data-bs-theme') === 'dark';
        ['uiThemeSwitch', 'toggleDarkMode'].forEach(id => {
            const control = document.getElementById(id);
            if (!control) return;
            control.disabled = enabled;
            control.title = enabled ? 'Skin Noel đang dùng chế độ tối theo cài đặt admin' : 'Đổi giao diện sáng/tối';
            if (id === 'toggleDarkMode') control.checked = dark;
            else control.innerHTML = '<i class="fas fa-' + (enabled ? 'lock' : dark ? 'sun' : 'moon') + '" aria-hidden="true"></i>';
        });
    }
    function apply(next) {
        if (next && !enabled) previousTheme = root.getAttribute('data-bs-theme');
        enabled = next;
        root.classList.toggle('christmas', enabled);
        if (enabled || savedTheme() === 'dark') root.setAttribute('data-bs-theme', 'dark');
        else root.removeAttribute('data-bs-theme');
        if (enabled && !document.querySelector('.christmas-stickers')) {
            const stickers = document.createElement('div');
            stickers.className = 'christmas-stickers';
            stickers.setAttribute('aria-hidden', 'true');
            stickers.innerHTML = '<span>🎁</span><span>🎄</span><span>⛄</span>';
            document.body.append(stickers);
        }
        if (!enabled) {
            document.querySelectorAll('.christmas-stickers,.noel-garland,.noel-snow-cap').forEach(el => el.remove());
            document.querySelectorAll('.noel-main,.noel-secondary,.noel-snow-button').forEach(el => el.classList.remove('noel-main', 'noel-secondary', 'noel-snow-button'));
        }
        syncControls();
        document.dispatchEvent(new Event('tvship:seasonal-change'));
    }
    // Preserve the user's preference; the seasonal override never writes storage.
    new MutationObserver(() => {
        if (enabled && root.getAttribute('data-bs-theme') !== 'dark') root.setAttribute('data-bs-theme', 'dark');
        syncControls();
    }).observe(root, { attributes: true, attributeFilter: ['data-bs-theme'] });
    async function refresh() {
        if (busy || document.hidden) return;
        busy = true;
        try {
            const response = await fetch('/seasonal-theme-status', { cache: 'no-store', credentials: 'same-origin' });
            if (!response.ok) return;
            const data = await response.json();
            if (typeof data.christmasEnabled === 'boolean' && data.christmasEnabled !== enabled) apply(data.christmasEnabled);
        } catch (_) { /* Keep the last known setting when offline. */ }
        finally { busy = false; }
    }
    apply(enabled);
    refresh();
    setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
})();
