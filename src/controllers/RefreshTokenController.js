import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const refreshToken = async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken)
      return errorResponse(res, null, "Refresh token tidak ditemukan");
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.email, u.password, u.role_id, u.refresh_token,
              u.created_at, u.updated_at, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE u.refresh_token = ?
       LIMIT 1`,
      [refreshToken]
    );
    const userRow = rows[0];
    if (!userRow) return errorResponse(res, null, "Refresh token tidak valid");
    const user = { ...userRow, role: { name: userRow.role_name } };
    jwt.verify(
      refreshToken,
      process.env.APP_REFRESH_TOKEN_SECRET,
      (err, decoded) => {
        if (err) return errorResponse(res, err, "Refresh token tidak valid");
        const { id, username, email, role } = user;
        const roleName = role.name;
        const accessToken = jwt.sign(
          { id, username, email, role: roleName },
          process.env.APP_ACCESS_TOKEN_SECRET,
          {
            expiresIn: "15m",
          }
        );
        return successResponse(
          res,
          { accessToken },
          "Access token berhasil diperbarui"
        );
      }
    );
  } catch (error) {
    return errorResponse(res, error, "Error refreshing token");
  }
};
