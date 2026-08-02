import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const escapeLikeValue = (value) => value.replace(/([%_])/g, "\\$1");

export const getUsers = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;
  const searchPattern = `%${escapeLikeValue(search)}%`;

  const [countRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM users WHERE username LIKE ? OR email LIKE ?",
    [searchPattern, searchPattern]
  );
  const totalRows = countRows[0].total;
  const totalPage = Math.ceil(totalRows / limit);

  const [rows] = await pool.query(
    `SELECT
       u.id AS id,
       u.username AS username,
       u.email AS email,
       r.name AS role_name,
       i.id AS institution_id,
       i.name AS institution_name,
       i.phone AS institution_phone,
       t.id AS teacher_id,
       ti.id AS teacher_institution_id,
       ti.name AS teacher_institution_name,
       ti.phone AS teacher_institution_phone
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN institutions i ON i.user_id = u.id
     LEFT JOIN teachers t ON t.user_id = u.id
     LEFT JOIN institutions ti ON ti.id = t.school_id
     WHERE u.username LIKE ? OR u.email LIKE ?
     ORDER BY u.id DESC
     LIMIT ? OFFSET ?`,
    [searchPattern, searchPattern, limit, offset]
  );

  const users = rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    role: { name: row.role_name },
    institution: row.institution_id
      ? {
          id: row.institution_id,
          name: row.institution_name,
          phone: row.institution_phone,
        }
      : null,
    teacher: row.teacher_id
      ? {
          institution: row.teacher_institution_id
            ? {
                id: row.teacher_institution_id,
                name: row.teacher_institution_name,
                phone: row.teacher_institution_phone,
              }
            : null,
        }
      : null,
  }));

  return successResponse(
    res,
    {
      totalRows,
      totalPage,
      page,
      limit,
      users,
    },
    "Users retrieved successfully"
  );
};

export const getUserById = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT
         u.id AS id,
         u.username AS username,
         u.email AS email,
         r.name AS role_name,
         i.name AS institution_name,
         i.address AS institution_address,
         i.email AS institution_email,
         i.phone AS institution_phone,
         c.name AS institution_city_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN institutions i ON i.user_id = u.id
       LEFT JOIN cities c ON c.id = i.city_id
       WHERE u.id = ?
       LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return errorResponse(res, null, "User Not Found");
    }

    const row = rows[0];
    const user = {
      id: row.id,
      username: row.username,
      email: row.email,
      role: { name: row.role_name },
      institution: row.institution_name
        ? {
            name: row.institution_name,
            address: row.institution_address,
            email: row.institution_email,
            phone: row.institution_phone,
            city: row.institution_city_name
              ? { name: row.institution_city_name }
              : null,
          }
        : null,
    };

    return successResponse(
      res,
      user,
      `User with ID: ${id} retrieved successfully`
    );
  } catch (error) {
    console.error(error);
    return errorResponse(res, error, "Error retrieving user");
  }
};

export const updateUser = async (req, res) => {};

export const deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await pool.query(
      "SELECT id, role_id FROM users WHERE id = ? LIMIT 1",
      [id]
    );

    if (rows.length === 0) {
      return errorResponse(res, null, "User Not Found");
    }

    const user = rows[0];

    if (user.role_id === 1) {
      return errorResponse(res, null, "Cannot delete admin user");
    } else {
      await pool.query("DELETE FROM users WHERE id = ?", [id]);
    }
    return successResponse(res, 200, "Berhasil menghapus user");
  } catch (error) {
    return errorResponse(res, error, "Gagal menghapus user");
  }
};
