const http = require('http');

const port = Number(process.env.PORT || 4000);
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 4000);

const req = http.request({
  hostname: '127.0.0.1',
  port,
  path: '/healthz',
  method: 'GET',
  timeout: timeoutMs
}, (res) => {
  if (res.statusCode >= 200 && res.statusCode < 300) {
    res.resume();
    res.on('end', () => process.exit(0));
  } else {
    res.resume();
    res.on('end', () => process.exit(1));
  }
});

req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});

req.on('error', () => {
  process.exit(1);
});

req.end();
