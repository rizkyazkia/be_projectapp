import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse } from "../helpers/ResponseHelper.js";

const getUserInstitution = async (userId) => {
  const [rows] = await pool.query(
    `SELECT i.id AS institution_id
     FROM users u
     LEFT JOIN institutions i ON i.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  const user = rows[0];
  if (!user) {
    throw new Error("user tidak ditemukan");
  }
  // Preserved bug: when the user has no institution, `institution` is null
  // and `.id` throws a TypeError, exactly like the original
  // `user.institution.id` on a Prisma `institution: null` result.
  const institution = user.institution_id != null ? { id: user.institution_id } : null;
  return institution.id;
};

export const addStaff = async (req, res) => {
  try {
    const user = req.user;
    const institutionId = await getUserInstitution(user.id);
    const { fullName, address, phone, email, password, username } = req.body;
    const hashedPassword = await argon2.hash(password);

    const [existingRows] = await pool.query(
      `SELECT * FROM users WHERE username = ? AND email = ? LIMIT 1`,
      [username, email]
    );
    const isUserExist = existingRows[0];
    console.log({ isUserExist });
    if (!!isUserExist) {
      throw new Error("User sudah ada");
    }

    const [roleRows] = await pool.query(`SELECT id FROM roles WHERE id = ?`, [6]);
    let roleId;
    if (roleRows[0]) {
      roleId = 6;
    } else {
      const [roleInsert] = await pool.query(`INSERT INTO roles (name) VALUES (?)`, ["staff"]);
      roleId = roleInsert.insertId;
    }

    const connection = await pool.getConnection();
    let newUser;
    try {
      await connection.beginTransaction();
      const userId = randomUUID();
      await connection.query(
        `INSERT INTO users (id, username, email, password, role_id) VALUES (?, ?, ?, ?, ?)`,
        [userId, username, email, hashedPassword, roleId]
      );
      const staffId = randomUUID();
      await connection.query(
        `INSERT INTO staffs (id, fullName, address, phone, healthcare_id, role, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [staffId, fullName, address, phone, institutionId, "staff", userId]
      );
      const [userRows] = await connection.query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [userId]);
      const [staffRows] = await connection.query(`SELECT * FROM staffs WHERE id = ? LIMIT 1`, [staffId]);
      await connection.commit();
      newUser = { ...userRows[0], staff: staffRows[0] };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    res.status(201).json({
      status: "Success",
      message: "User berhasil dibuat",
      data: newUser,
    });
  } catch (err) {
    return errorResponse(res, err, "Gagal menambahkan staff");
  }
};

export const deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new Error("Id dibutuhkan untuk menghapus staff");
    }
    const user = req.user;
    const institutionId = await getUserInstitution(user.id);

    const [staffRows] = await pool.query(`SELECT * FROM staffs WHERE id = ? LIMIT 1`, [id]);
    const existingStaff = staffRows[0];
    if (!existingStaff) {
      throw new Error("Staff tidak ditemukan");
    }
    if (existingStaff.healthcare_id !== institutionId) {
      throw new Error("Tidak bisa menghapus akun institusi lain");
    }

    await pool.query(`DELETE FROM staffs WHERE id = ?`, [id]);

    res.status(200).json({
      status: "Success",
      message: "Berhasil menghapus staff",
      data: existingStaff,
    });
  } catch (err) {
    return errorResponse(res, err, "Terjadi kesalahan saat menghapus staff");
  }
};

export const updateStafff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new Error("Id dibutuhkan");
    }
    const user = req.user;
    const institutionId = await getUserInstitution(user.id);
    const { fullName, address, phone, username, email, password } = req.body;

    const [rows] = await pool.query(
      `SELECT s.*, u.username AS user_username, u.email AS user_email
       FROM staffs s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?
       LIMIT 1`,
      [id]
    );
    const isUserExist = rows[0];
    if (!isUserExist.user_id) {
      throw new Error("User tidak ditemukan");
    }

    const connection = await pool.getConnection();
    let updatedUser;
    try {
      await connection.beginTransaction();
      await connection.query(
        `UPDATE staffs SET fullName = ?, address = ?, phone = ?, healthcare_id = ?, role = ? WHERE id = ?`,
        [fullName, address, phone, institutionId, "staff", id]
      );

      const fields = [];
      const values = [];
      if (username) {
        fields.push("username = ?");
        values.push(username);
      }
      if (email) {
        fields.push("email = ?");
        values.push(email);
      }
      if (password) {
        const hashedPassword = await argon2.hash(password);
        fields.push("password = ?");
        values.push(hashedPassword);
      }

      if (fields.length > 0) {
        values.push(isUserExist.user_id);
        await connection.query(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, values);
      }

      const [userRows] = await connection.query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [isUserExist.user_id]);
      const [staffRows] = await connection.query(`SELECT * FROM staffs WHERE id = ? LIMIT 1`, [id]);
      await connection.commit();
      updatedUser = { ...userRows[0], staff: staffRows[0] };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    res.status(201).json({
      status: "Success",
      message: "User berhasil diupdate",
      data: updatedUser,
    });
  } catch (err) {
    return errorResponse(res, err, "Gagal Mengubah staff");
  }
};

export const getStaffs = async (req, res) => {
  try {
    const user = req.user;
    const page = Number.parseInt(req.query.page) || 0;
    const limit = Number.parseInt(req.query.limit) || 10;
    const keyword = req.query.keyword ?? "";
    const skip = limit * page;

    const [instRows] = await pool.query(
      `SELECT i.id AS institution_id
       FROM users u
       LEFT JOIN institutions i ON i.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
      [user.id]
    );
    const userInstitution = instRows[0];
    if (!userInstitution) {
      throw new Error("User tidak di institusi manapun");
    }
    const healthcareId = userInstitution.institution_id ?? undefined;

    const conditions = [];
    const params = [];
    if (healthcareId !== undefined) {
      conditions.push("healthcare_id = ?");
      params.push(healthcareId);
    }
    if (keyword !== "") {
      conditions.push("fullName LIKE ?");
      params.push(`%${keyword}%`);
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[countRows], [staffs]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM staffs ${whereSql}`, params),
      pool.query(`SELECT * FROM staffs ${whereSql} LIMIT ? OFFSET ?`, [...params, limit, skip]),
    ]);

    const totalRows = countRows[0].total;
    const totalPages = Math.ceil(totalRows / limit);

    res.status(200).json({
      status: "Success",
      message: "Berhasil mendapatkan data",
      data: {
        staffs,
        page,
        limit,
        totalPages,
        totalRows,
      },
    });
  } catch (err) {
    return errorResponse(res, err, "Gagal mendapatkan staff");
  }
};
