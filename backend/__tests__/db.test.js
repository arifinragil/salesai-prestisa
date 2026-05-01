const pg = require('../db/postgres');
const mysql = require('../db/mysql');

afterAll(async () => {
  await pg.end();
  await mysql.end();
});

test('postgres pool can run SELECT 1', async () => {
  const { rows } = await pg.query('SELECT 1 AS v');
  expect(rows[0].v).toBe(1);
});

test('mysql pool can run SELECT 1', async () => {
  const [rows] = await mysql.query('SELECT 1 AS v');
  expect(rows[0].v).toBe(1);
});
