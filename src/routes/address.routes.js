const express = require('express');
const { addressData, normalizeAddr, resolveAddress } = require('../services/address');
const { isAuth } = require('../middleware/auth');
const { db } = require('../lib/db');

const router = express.Router();

router.get('/api/address-suggest', (req, res) => {
    const q = normalizeAddr((req.query.q || '').trim());
    if (!q || q.length < 2) return res.json([]);

    const rawKeywords = q.split(/[\s,;.\-\/\\]+/).filter(k => k.length > 1);
    const keywords = [...new Set(rawKeywords)];

    if (keywords.length === 0) return res.json([]);

    const scored = addressData
        .map(item => {
            const text = item.norm;
            const wardNorm = normalizeAddr(item.ward);

            const matches = keywords.filter(k => text.includes(k)).length;
            if (matches === 0) return null;

            const wardMatches = keywords.filter(k => wardNorm.includes(k)).length;
            const wardBonus = wardMatches * 2;

            const allMatch = matches === keywords.length ? 1 : 0;

            return { item, score: matches + wardBonus + allMatch };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(r => r.item);

    res.json(scored);
});

router.post('/api/validate-address', isAuth, async (req, res) => {
    const { address, name, phone } = req.body;
    return res.json(await resolveAddress(address, name, phone, req.app_user));
});

router.get('/api/address/provinces', async (req, res) => {
    try {
        const [rows] = await db.promise().query("SELECT DISTINCT prov FROM jtaddress ORDER BY prov");
        res.json(rows.map(r => r.prov));
    } catch (err) { res.status(500).json([]); }
});

router.get('/api/address/districts', async (req, res) => {
    const { prov } = req.query;
    try {
        const [rows] = await db.promise().query("SELECT DISTINCT district FROM jtaddress WHERE prov = ? ORDER BY district", [prov]);
        res.json(rows.map(r => r.district));
    } catch (err) { res.status(500).json([]); }
});

router.get('/api/address/wards', async (req, res) => {
    const { prov, district } = req.query;
    try {
        const [rows] = await db.promise().query("SELECT DISTINCT ward FROM jtaddress WHERE prov = ? AND district = ? ORDER BY ward", [prov, district]);
        res.json(rows.map(r => r.ward));
    } catch (err) { res.status(500).json([]); }
});

module.exports = router;
