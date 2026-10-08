const { Pool, types } = require('pg');
// PostgreSQL DATE is a calendar date, not a timestamp. Preserve YYYY-MM-DD in every route.
types.setTypeParser(1082, (value) => value);
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};