const assert = require('assert');
const rateLimitConfig = require('../src/middlewares/rateLimit');

function main() {
  const spoofed = rateLimitConfig.keyGenerator({
    headers: {
      'x-real-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.77'
    },
    ip: '127.0.0.1'
  });

  const direct = rateLimitConfig.keyGenerator({
    headers: {
      'x-forwarded-for': '198.51.100.88'
    },
    ip: '127.0.0.1'
  });

  assert.strictEqual(spoofed, '203.0.113.10', 'X-Real-IP from trusted proxy should be used');
  assert.strictEqual(direct, '127.0.0.1', 'client supplied X-Forwarded-For must be ignored');

  console.log(JSON.stringify({ ok: true, spoofed, direct }, null, 2));
}

main();
