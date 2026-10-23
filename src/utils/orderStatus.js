const { STATUS_MAP } = require('../config/constants');

function getBadge(status) {
    const s = status ? status.toLowerCase() : '';
    return STATUS_MAP[s] || { text: status || 'N/A', class: 'bg-light text-dark border' };
}

module.exports = { getBadge };
