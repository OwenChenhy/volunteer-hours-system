const { buildApp } = require('../src/app');

async function main() {
  const app = buildApp();

  try {
    await app.ready();

    const health = await app.inject({
      method: 'GET',
      url: '/health'
    });

    const invalidQuery = await app.inject({
      method: 'POST',
      url: '/api/v1/query',
      payload: {}
    });

    const result = {
      health: health.statusCode,
      query_validation: invalidQuery.statusCode,
      query_validation_message: invalidQuery.json().message
    };

    if (health.statusCode !== 200 || invalidQuery.statusCode !== 400) {
      console.error(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
