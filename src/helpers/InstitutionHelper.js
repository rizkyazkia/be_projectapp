import pool from "../config/db.js";

export const getInstitutionByUser = async (userId, role) => {
  if (role === "teacher") {
    const [rows] = await pool.query(
      `SELECT i.* FROM teachers t
       JOIN institutions i ON i.id = t.school_id
       WHERE t.user_id = ? LIMIT 1`,
      [userId],
    );
    return rows[0] || null;
  }
  if (role === "staff") {
    const [rows] = await pool.query(
      `SELECT i.* FROM staffs s
       JOIN institutions i ON i.id = s.healthcare_id
       WHERE s.user_id = ? LIMIT 1`,
      [userId],
    );
    return rows[0] || null;
  }
  const [rows] = await pool.query(
    "SELECT * FROM institutions WHERE user_id = ? LIMIT 1",
    [userId],
  );
  return rows[0] || null;
};
