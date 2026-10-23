const express = require('express');
const { BEHIND_PROXY } = require('../config/env');

const app = express();

if (BEHIND_PROXY) app.set('trust proxy', 'loopback');

module.exports = { app };
