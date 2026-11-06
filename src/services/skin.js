const DEFAULT_SKIN = '#b78238';
function normalizeSkin(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
        ? value.toLowerCase() : null;
}
module.exports = { DEFAULT_SKIN, normalizeSkin };
