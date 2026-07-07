'use strict';
/* Minimal dependency-free HTTPS JSON POST — for optional exact provider APIs. */

const https = require('https');

function postJson(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers },
    }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        const t = Buffer.concat(ch).toString('utf8');
        let j; try { j = JSON.parse(t); } catch { j = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(new Error(`HTTP ${res.statusCode}: ${t.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { postJson };
