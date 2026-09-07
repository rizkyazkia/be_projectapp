import mysql from "mysql2/promise";

const pool = mysql.createPool(process.env.DATABASE_URL);

export async function checkDbConnection(timeoutMs = 5000) {
  const timeout = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`connection attempt timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  const conn = await Promise.race([pool.getConnection(), timeout]);
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

export default pool;
