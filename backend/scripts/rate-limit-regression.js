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
  const campus = { headers: { 'x-real-ip': '203.0.113.10' }, ip: '127.0.0.1' };
  assert.notStrictEqual(rateLimitConfig.keyGenerator({ ...campus, body: { student_id: 'STUDENT-A' } }), rateLimitConfig.keyGenerator({ ...campus, body: { student_id: 'STUDENT-B' } }), 'different students sharing a campus exit must not share the personal query limit');
  assert.strictEqual(rateLimitConfig.hook, 'preHandler', 'student identity must be available after body validation');

  console.log(JSON.stringify({ ok: true, spoofed, direct }, null, 2));
}

main();
