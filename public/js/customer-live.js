(function () {
    'use strict';
    let stream, refreshTimer, toastTimer, busy = false, pending = false, stopped = false;
    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = 'display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1000010;max-width:calc(100vw - 32px);padding:16px 24px;border-radius:16px;background:var(--surface-card);color:var(--ink-900);border:1px solid var(--surface-border);box-shadow:0 12px 40px #0004;text-align:center;pointer-events:none;font-weight:600;';
    document.body.append(toast);
    function showToast(message) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.style.display = 'block';
        toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 2500);
    }
    async function flush() {
        if (busy || stopped) return;
        pending = false;
        busy = true;
        let ok = false;
        try { ok = await refreshCustomerLists(); }
        finally {
            busy = false;
            if (!ok && !stopped) {
                showToast('Chưa tải được danh sách mới. Đang thử lại…');
                pending = true;
            }
            if (pending && !stopped) refresh(ok ? 80 : 5000);
        }
    }
    function refresh(delay = 80) {
        pending = true;
        clearTimeout(refreshTimer);
        if (!busy && !stopped) refreshTimer = setTimeout(flush, delay);
    }
    function connect() {
        if (stream || stopped || !window.EventSource) return;
        stream = new EventSource('/api/customers/events');
        // A fresh snapshot also recovers changes missed during disconnection.
        stream.addEventListener('ready', () => refresh());
        stream.addEventListener('customers-changed', () => refresh());
    }
    window.CustomerLive = { refresh, toast: showToast };
    window.addEventListener('pagehide', () => {
        stopped = true;
        stream?.close(); stream = null;
        clearTimeout(refreshTimer); clearTimeout(toastTimer);
        toast.style.display = 'none';
    });
    window.addEventListener('pageshow', () => { stopped = false; connect(); refresh(); });
    window.addEventListener('online', () => { connect(); refresh(); });
    connect();
})();
