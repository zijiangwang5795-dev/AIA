'use strict';
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/ai_assistant',
  max: 10,
  idleTimeoutMillis: 30000,
});

// 查询助手
const query = (text, params) => db.query(text, params);

module.exports = { db, query };
