import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const getUserInstitution = async (userId) => {
  const [rows] = await pool.query(
    `SELECT i.id AS institution_id
     FROM users u
     LEFT JOIN institutions i ON i.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  const row = rows[0];
  if (!row || row.institution_id == null) {
    throw new Error("User tidak terdaftar di institusi manapun");
  }
  return row.institution_id;
};

export const getClasses = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const school_id = await getUserInstitution(req.user.id);
    const likeParam = `%${search}%`;
    const [[countRows], [classRows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM classes WHERE name LIKE ? AND school_id = ?`, [
        likeParam,
        school_id,
      ]),
      pool.query(
        `SELECT c.id, c.name, c.school_id, t.id AS teacher_id, t.fullName AS teacher_fullName
         FROM classes c
         LEFT JOIN teachers t ON t.id = c.teacher_id
         WHERE c.name LIKE ? AND c.school_id = ?
         ORDER BY c.id ASC
         LIMIT ? OFFSET ?`,
        [likeParam, school_id, limit, offset]
      ),
    ]);

    const totalRows = countRows[0].total;
    const totalPage = Math.ceil(totalRows / limit);
    const classes = classRows.map((row) => ({
      id: row.id,
      name: row.name,
      school_id: row.school_id,
      teacher: row.teacher_id ? { id: row.teacher_id, fullName: row.teacher_fullName } : null,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, classes },
      "Classes retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve classes");
  }
};

export const createClasses = async (req, res) => {
  const { classes } = req.body;
  const isArrayInput = Array.isArray(classes);
  const classList = isArrayInput ? classes : [classes];

  try {
    const school_id = await getUserInstitution(req.user.id);

    // Check every name in the batch for a duplicate before inserting anything.
    // Previously an array submission silently skipped duplicates and still
    // returned 200 with whatever subset was actually new - a duplicate class
    // name looked like a success with no indication anything was rejected.
    const duplicateNames = [];
    for (const cls of classList) {
      const [existingRows] = await pool.query(
        `SELECT * FROM classes WHERE name = ? AND school_id = ? LIMIT 1`,
        [cls.name, school_id]
      );
      if (existingRows[0]) {
        duplicateNames.push(cls.name);
      }
    }

    if (duplicateNames.length > 0) {
      return errorResponse(
        res,
        `Kelas sudah tersedia: ${duplicateNames.join(", ")}`,
        "Tidak dapat membuat kelas yang sudah ada",
        409
      );
    }

    const createdClasses = [];
    for (const cls of classList) {
      const [insertResult] = await pool.query(`INSERT INTO classes (name, school_id) VALUES (?, ?)`, [
        cls.name,
        school_id,
      ]);
      const [newRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [insertResult.insertId]);
      createdClasses.push(newRows[0]);
    }

    return successResponse(
      res,
      isArrayInput ? createdClasses : createdClasses[0],
      "Berhasil membuat kelas"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const updateClasses = async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  try {
    const school_id = await getUserInstitution(req.user.id);

    const [existingRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [Number.parseInt(id)]);
    const existingClass = existingRows[0];

    if (!existingClass) {
      return errorResponse(res, 404, "Kelas tidak ditemukan");
    }

    if (existingClass.school_id !== school_id) {
      return errorResponse(res, 403, "Kelas bukan milik sekolah anda");
    }

    await pool.query(`UPDATE classes SET name = ? WHERE id = ?`, [name, Number.parseInt(id)]);
    const [updatedRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [Number.parseInt(id)]);
    const updatedClass = updatedRows[0];

    if (existingClass.teacher_id) {
      await pool.query(`UPDATE teachers SET role = ? WHERE id = ?`, [name, existingClass.teacher_id]);
    }

    return successResponse(res, updatedClass, "Kelas berhasil diperbarui");
  } catch (error) {
    return errorResponse(res, error, "Error saat memperbarui kelas");
  }
};

export const deleteClasses = async (req, res) => {
  const { id } = req.params;

  try {
    const school_id = await getUserInstitution(req.user.id);

    const [existingRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [Number.parseInt(id)]);
    const existingClass = existingRows[0];

    if (!existingClass) {
      return errorResponse(res, 404, "Kelas tidak ditemukan");
    }

    if (existingClass.school_id !== school_id) {
      return errorResponse(res, 403, "Kelas bukan milik sekolah anda");
    }

    if (existingClass.teacher_id) {
      await pool.query(`UPDATE teachers SET role = ? WHERE id = ?`, [null, existingClass.teacher_id]);
    }

    await pool.query(`DELETE FROM classes WHERE id = ?`, [Number.parseInt(id)]);

    return successResponse(res, null, "Kelas berhasil dihapus");
  } catch (error) {
    return errorResponse(res, error, "Error saat menghapus teacher");
  }
};

export const getClassesByInstitution = async (req, res) => {
  const { institutionId } = req.params;

  try {
    const [classes] = await pool.query(`SELECT id, name FROM classes WHERE school_id = ? ORDER BY id ASC`, [
      Number(institutionId),
    ]);
    return successResponse(res, classes, "Kelas berhasil diambil berdasarkan institusi");
  } catch (error) {
    return errorResponse(res, error, "Error saat mengambil kelas berdasarkan institusi");
  }
};
