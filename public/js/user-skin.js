(function () {
    'use strict';
    const root = document.documentElement;
    const defaultColor = '#b78238';
    const valid = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const hex = channels => '#' + channels.map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
    const mix = (a, b, weight) => hex(rgb(a).map((v, i) => v * (1 - weight) + rgb(b)[i] * weight));
    const luminance = color => rgb(color).map(v => {
        v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const readable = (color, dark) => {
        let result = color;
        for (let i = 0; i < 30; i++) {
            const l = luminance(result), bg = luminance(dark ? '#22211e' : '#fffefa');
            if ((Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05) >= 4.5) break;
            result = mix(result, dark ? '#ffffff' : '#000000', 0.12);
        }
        return result;
    };
    const properties = ['--brand-50','--brand-100','--brand-200','--brand-500','--brand-600','--brand-700',
        '--bs-primary-rgb','--skin-on','--skin-on-hover','--skin-deep','--skin-pale'];
    let current = document.querySelector('meta[name="tvship-skin"]').content.toLowerCase();
    function apply(color) {
        if (!valid(color)) return false;
        current = color.toLowerCase();
        if (current === defaultColor) {
            root.removeAttribute('data-custom-skin');
            properties.forEach(key => root.style.removeProperty(key));
            return true;
        }
        root.setAttribute('data-custom-skin', 'true');
        const dark = root.getAttribute('data-bs-theme') === 'dark';
        const base = readable(current, dark), hover = readable(mix(base, dark ? '#ffffff' : '#000000', 0.15), dark);
        const on = c => luminance(c) > 0.179 ? '#000000' : '#ffffff';
        const values = [mix(current, dark ? '#171715' : '#ffffff', 0.92),
            mix(current, dark ? '#171715' : '#ffffff', 0.83), mix(current, dark ? '#171715' : '#ffffff', 0.6),
            base, hover, readable(mix(base, dark ? '#ffffff' : '#000000', 0.3), dark),
            rgb(base).join(', '), on(base), on(hover), mix(current, '#000000', 0.8), mix(current, '#ffffff', 0.8)];
        properties.forEach((key, i) => root.style.setProperty(key, values[i]));
        return true;
    }
    window.TVShipSkin = { apply, get: () => current };
    apply(valid(current) ? current : defaultColor);
    new MutationObserver(() => apply(current)).observe(root, { attributes: true, attributeFilter: ['data-bs-theme'] });
})();
