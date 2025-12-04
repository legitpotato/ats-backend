const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.NEON_USER,
  host: process.env.NEON_HOST,
  database: process.env.NEON_DB,
  password: process.env.NEON_PASSWORD,
  port: process.env.NEON_PORT ? Number(process.env.NEON_PORT) : 5432,
  ssl: { rejectUnauthorized: false },
});

module.exports = pool;
