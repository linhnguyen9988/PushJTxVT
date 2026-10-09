// test-jt.js
require('dotenv').config({ quiet: true });
const axios = require('axios');
const crypto = require('crypto');
const md5ToBase64 = s => crypto.createHash('md5').update(s).digest('base64');

(async () => {
  const billCode = "802830809469";
  const oderjson = JSON.stringify({"billCodes":billCode,"txlogisticId":"","customerCode":process.env.JT_CUSTOMER_CODE,"password":process.env.JT_PASSWORD});
  const digest = md5ToBase64(oderjson + process.env.JT_PKEY);
  const params = new URLSearchParams(); params.append('bizContent', oderjson);
  const res = await axios.post('https://ylopenapi.jtexpress.vn/webopenplatformapi/api/logistics/trace', params, {
    headers: {'Content-Type':'application/x-www-form-urlencoded','apiAccount':process.env.JT_API_ACCOUNT,'digest':digest,'timestamp':Date.now().toString()}
  });
  console.log(JSON.stringify(res.data, null, 2));
})();