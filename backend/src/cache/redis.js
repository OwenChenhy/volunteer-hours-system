const { createClient } = require('redis');

let clientPromise;

function getRedisClient() {
  if (!process.env.REDIS_URL) {
    return null;
  }

  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => {
      console.warn('Redis cache disabled after connection error:', err.message);
    });
    clientPromise = client.connect().then(() => client).catch(() => null);
  }

  return clientPromise;
}

async function getJson(key) {
  try {
    const client = await getRedisClient();
    if (!client) return null;

    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function setJson(key, value, ttlSeconds) {
  try {
    const client = await getRedisClient();
    if (!client) return;

    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch {
    // Cache failures must not block the public query path.
  }
}

async function deleteByPrefix(prefix) {
  try {
    const client = await getRedisClient();
    if (!client) return 0;

    let cursor = 0;
    let deleted = 0;
    do {
      const result = await client.scan(cursor, { MATCH: `${prefix}*`, COUNT: 200 });
      cursor = Number(result.cursor);
      const keys = result.keys || [];
      if (keys.length > 0) {
        deleted += await client.del(keys);
      }
    } while (cursor !== 0);
    return deleted;
  } catch {
    return 0;
  }
}

async function close() {
  if (!clientPromise) return;
  const client = await clientPromise;
  if (client?.isOpen) await client.quit();
  clientPromise = null;
}

module.exports = { getJson, setJson, deleteByPrefix, close };
