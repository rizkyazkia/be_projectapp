import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getTeachers = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const likeParam = `%${search}%`;
    const [[countRows], [teacherRows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM teachers WHERE fullName LIKE ? OR role LIKE ?`, [likeParam, likeParam]),
      pool.query(
        `SELECT
           t.id, t.fullName, t.role, t.address, t.phone,
           u.id AS user_id, u.username AS user_username, u.email AS user_email,
           i.id AS institution_id, i.name AS institution_name, i.address AS institution_address, i.phone AS institution_phone,
           p.id AS province_id, p.name AS province_name,
           c.id AS city_id, c.name AS city_name
         FROM teachers t
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN institutions i ON i.id = t.school_id
         LEFT JOIN provinces p ON p.id = i.province_id
         LEFT JOIN cities c ON c.id = i.city_id
         WHERE t.fullName LIKE ? OR t.role LIKE ?
         ORDER BY t.id DESC
         LIMIT ? OFFSET ?`,
        [likeParam, likeParam, limit, offset]
      ),
    ]);

    const totalRows = countRows[0].total;
    const totalPage = Math.ceil(totalRows / limit);

    const teacherIds = teacherRows.map((row) => row.id);
    let classesByTeacher = {};
    if (teacherIds.length > 0) {
      const [classRows] = await pool.query(`SELECT id, name, teacher_id FROM classes WHERE teacher_id IN (?)`, [teacherIds]);
      classesByTeacher = classRows.reduce((acc, cls) => {
        if (!acc[cls.teacher_id]) acc[cls.teacher_id] = [];
        acc[cls.teacher_id].push({ id: cls.id, name: cls.name });
        return acc;
      }, {});
    }

    const teachers = teacherRows.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      role: row.role,
      address: row.address,
      phone: row.phone,
      user: row.user_id ? { id: row.user_id, username: row.user_username, email: row.user_email } : null,
      institution: row.institution_id
        ? {
            id: row.institution_id,
            name: row.institution_name,
            address: row.institution_address,
            phone: row.institution_phone,
            province: row.province_id ? { id: row.province_id, name: row.province_name } : null,
            city: row.city_id ? { id: row.city_id, name: row.city_name } : null,
          }
        : null,
      classes: classesByTeacher[row.id] || [],
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, teachers },
      "Teachers retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve teachers");
  }
};

export const createTeacher = async (req, res) => {
  const { username, email, password, role_id, fullName, role, classId, address, phone } = req.body;

  const hashPassword = await argon2.hash(password);

  try {
    const user = req.user;
    const [institutionRows] = await pool.query(`SELECT * FROM institutions WHERE user_id = ? LIMIT 1`, [user.id]);
    const institution = institutionRows[0];

    if (!institution) {
      return errorResponse(res, 404, "Institusi tidak ditemukan");
    }

    if (classId) {
      const [classRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [classId]);
      const existingClass = classRows[0];

      if (!existingClass) {
        return errorResponse(res, null, "Kelas tidak ditemukan");
      }

      if (existingClass.teacher_id) {
        return errorResponse(res, null, "Kelas sudah memiliki wali kelas");
      }
    } else {
      return errorResponse(res, null, "ID kelas harus disertakan");
    }

    const [existingUserRows] = await pool.query(`SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1`, [
      username,
      email,
    ]);
    const existingUser = existingUserRows[0];

    if (existingUser) {
      const [existingTeacherRows] = await pool.query(`SELECT id FROM teachers WHERE user_id = ? LIMIT 1`, [existingUser.id]);
      if (existingTeacherRows[0]) {
        return errorResponse(res, null, "Username atau email sudah digunakan");
      }

      const teacherId = randomUUID();
      await pool.query(
        `INSERT INTO teachers (id, fullName, role, address, phone, school_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [teacherId, fullName, role, address, phone, institution.id, existingUser.id]
      );

      await pool.query(`UPDATE classes SET teacher_id = ? WHERE id = ?`, [teacherId, classId]);

      // Preserved bug: the original passed the exported `updateTeacher` function
      // itself here (hoisted reference, not the local result), which
      // JSON.stringify()s to undefined — so `data` is omitted from the response.
      return successResponse(res, undefined, "Berhasil menambahkan wali kelas");
    } else {
      const userId = randomUUID();
      await pool.query(`INSERT INTO users (id, username, email, password, role_id) VALUES (?, ?, ?, ?, ?)`, [
        userId,
        username,
        email,
        hashPassword,
        role_id,
      ]);

      const teacherId = randomUUID();
      await pool.query(
        `INSERT INTO teachers (id, fullName, role, address, phone, school_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [teacherId, fullName, role, address, phone, institution.id, userId]
      );

      await pool.query(`UPDATE classes SET teacher_id = ? WHERE id = ?`, [teacherId, classId]);

      const [newUserRows] = await pool.query(`SELECT id, username, email, role_id FROM users WHERE id = ? LIMIT 1`, [userId]);
      const [newTeacherRows] = await pool.query(`SELECT * FROM teachers WHERE id = ? LIMIT 1`, [teacherId]);
      const newTeacher = { ...newUserRows[0], teacher: newTeacherRows[0] };

      return successResponse(res, newTeacher, "Berhasil menambahkan wali kelas");
    }
  } catch (error) {
    return errorResponse(res, error, "Error saat menambahkan wali kelas");
  }
};

export const updateTeacher = async (req, res) => {
  const { id } = req.params;
  const { role, address, phone } = req.body;

  try {
    const [teacherRows] = await pool.query(`SELECT * FROM teachers WHERE id = ? LIMIT 1`, [id]);
    const existingTeacher = teacherRows[0];

    if (!existingTeacher) {
      return errorResponse(res, 404, "Guru tidak ditemukan");
    }

    const [oldClassRows] = await pool.query(`SELECT * FROM classes WHERE teacher_id = ? LIMIT 1`, [id]);
    const oldClass = oldClassRows[0];

    if (oldClass) {
      await pool.query(`UPDATE classes SET teacher_id = ? WHERE id = ?`, [null, oldClass.id]);
    }

    // NOTE: `role` here doubles as the target class NAME, confusingly — preserved from the original.
    const [newClassRows] = await pool.query(`SELECT * FROM classes WHERE name = ? LIMIT 1`, [role]);
    const newClass = newClassRows[0];

    if (!newClass) {
      return errorResponse(res, 404, "Kelas baru tidak ditemukan");
    }

    await pool.query(`UPDATE classes SET teacher_id = ? WHERE id = ?`, [id, newClass.id]);

    await pool.query(`UPDATE teachers SET role = ?, address = ?, phone = ? WHERE id = ?`, [role, address, phone, id]);
    const [updatedRows] = await pool.query(`SELECT * FROM teachers WHERE id = ? LIMIT 1`, [id]);
    const updatedTeacher = updatedRows[0];

    return successResponse(res, updatedTeacher, "Guru berhasil diperbarui");
  } catch (error) {
    return errorResponse(res, error, "Error saat memperbarui guru");
  }
};

export const deleteTeacher = async (req, res) => {
  const { id } = req.params;

  try {
    const [teacherRows] = await pool.query(`SELECT * FROM teachers WHERE id = ? LIMIT 1`, [id]);
    const existingTeacher = teacherRows[0];

    if (!existingTeacher) {
      return errorResponse(res, 404, "Guru tidak ditemukan");
    }

    if (existingTeacher.user_id) {
      await pool.query(`DELETE FROM users WHERE id = ?`, [existingTeacher.user_id]);
    }

    return successResponse(res, null, "Guru berhasil dihapus");
  } catch (error) {
    return errorResponse(res, error, "Error saat menghapus teacher");
  }
};
