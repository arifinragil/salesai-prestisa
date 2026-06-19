require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mysql = require('mysql2/promise');

// Source DB server is on -04:00; logistic dates (oi.date_time, etc.) are stored
// as WIB DATETIME with no tz. Force every connection to +07:00 so NOW()/CURDATE()
// and DATETIME parsing align with how the data is meant to be read.
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT) || 3306,
  database: process.env.MYSQL_DATABASE,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 15000,
  timezone: '+07:00',
});

// The 'connection' event hands back the raw (callback-style) connection,
// not the promise wrapper — use the callback form here.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+07:00'", () => {});
});

module.exports = pool;
