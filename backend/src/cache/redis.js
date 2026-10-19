const { createClient } = require('redis');

let clientPromise, retryAt = 0;
const pending = new Map();

async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Redis cache timeout')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function getRedisClient() {
  if (!process.env.REDIS_URL || Date.now() < retryAt) {
    return null;
  }

  if (!clientPromise) {
    const client = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 1000, reconnectStrategy: false },
      disableOfflineQueue: true
    });
    client.on('error', () => console.warn('Redis cache unavailable; falling back to the query service.'));
    // Bound the whole handshake as well as TCP connection establishment.
    clientPromise = bounded(client.connect().then(() => client), 1000).catch(() => {
      disable(client);
      return null;
    });
  }

  return clientPromise;
}

function disable(client) {
  if (client?.isOpen) client.destroy();
  clientPromise = null;
  retryAt = Date.now() + 5000;
}

async function execute(command) {
  let client;
  try {
    client = await getRedisClient();
    if (!client) return null;
    return await bounded(command(client), 500);
  } catch {
    disable(client);
    return null;
  }
}

async function getJson(key) {
  try {
    const value = await execute(client => client.get(key));
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function setJson(key, value, ttlSeconds) {
  await execute(client => client.set(key, JSON.stringify(value), { EX: ttlSeconds }));
}

async function remember(key, load, ttlSeconds = 300) {
  const cached = await getJson(key);
  if (cached !== null) return cached;
  if (!pending.has(key)) {
    pending.set(key, Promise.resolve().then(load).then(async value => {
      if (value !== null) await setJson(key, value, ttlSeconds);
      return value;
    }).finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

async function deleteByPrefix(prefix) {
  return (await execute(async client => {
    let cursor = '0';
    let deleted = 0;
    do {
      const result = await client.scan(cursor, { MATCH: `${prefix}*`, COUNT: 200 });
      cursor = String(result.cursor);
      const keys = result.keys || [];
      if (keys.length > 0) {
        deleted += await client.del(keys);
      }
    } while (cursor !== '0');
    return deleted;
  })) || 0;
}

async function close() {
  const client = await clientPromise;
  if (client?.isOpen) client.destroy();
  clientPromise = null;
  retryAt = 0;
}

module.exports = { getJson, setJson, remember, deleteByPrefix, close };
