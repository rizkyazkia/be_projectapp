import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

function reshapeStudentRow(row) {
  const nutrition = row.n_id
    ? [
        {
          id: row.n_id,
          height: row.n_height,
          weight: row.n_weight,
          bmi: row.n_bmi,
          nutritionStatus: row.ns_id
            ? {
                id: row.ns_id,
                information: row.ns_information,
                displayName: row.ns_displayName,
              }
            : null,
        },
      ]
    : [];

  const institution = row.i_id
    ? {
        id: row.i_id,
        name: row.i_name,
        address: row.i_address,
        phone: row.i_phone,
        email: row.i_email,
        province: row.pr_id ? { id: row.pr_id, name: row.pr_name } : null,
        city: row.ci_id ? { id: row.ci_id, name: row.ci_name } : null,
      }
    : null;

  const teacher = row.t_id
    ? {
        id: row.t_id,
        fullName: row.t_fullName,
        address: row.t_address,
        phone: row.t_phone,
      }
    : null;

  const classObj = row.c_id ? { id: row.c_id, name: row.c_name, teacher } : null;

  const student = row.s_id
    ? {
        id: row.s_id,
        nis: row.s_nis,
        schoolYear: row.s_schoolYear,
        semester: row.s_semester,
        institution,
        class: classObj,
      }
    : null;

  return {
    id: row.fm_id,
    fullName: row.fm_fullName,
    nutrition,
    student,
  };
}

const STUDENT_JOIN_SELECT = `
  fm.id AS fm_id, fm.fullName AS fm_fullName,
  n.id AS n_id, n.height AS n_height, n.weight AS n_weight, n.bmi AS n_bmi,
  ns.id AS ns_id, ns.information AS ns_information, ns.displayName AS ns_displayName,
  s.id AS s_id, s.nis AS s_nis, s.schoolYear AS s_schoolYear, s.semester AS s_semester,
  i.id AS i_id, i.name AS i_name, i.address AS i_address, i.phone AS i_phone, i.email AS i_email,
  pr.id AS pr_id, pr.name AS pr_name,
  ci.id AS ci_id, ci.name AS ci_name,
  c.id AS c_id, c.name AS c_name,
  t.id AS t_id, t.fullName AS t_fullName, t.address AS t_address, t.phone AS t_phone
`;

export const getStudents = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM family_members fm WHERE fm.relation = 'ANAK' AND fm.education = 'SD' AND fm.fullName LIKE ?",
      [`%${search}%`]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [rows] = await pool.query(
      `SELECT ${STUDENT_JOIN_SELECT}
       FROM family_members fm
       LEFT JOIN nutritions n ON n.familyMemberId = fm.id
       LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
       LEFT JOIN students s ON s.familyMemberId = fm.id
       LEFT JOIN institutions i ON i.id = s.schoolId
       LEFT JOIN provinces pr ON pr.id = i.province_id
       LEFT JOIN cities ci ON ci.id = i.city_id
       LEFT JOIN classes c ON c.id = s.classId
       LEFT JOIN teachers t ON t.id = c.teacher_id
       WHERE fm.relation = 'ANAK' AND fm.education = 'SD' AND fm.fullName LIKE ?
       ORDER BY fm.id ASC
       LIMIT ? OFFSET ?`,
      [`%${search}%`, limit, offset]
    );

    const students = rows.map(reshapeStudentRow);

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, students },
      "Students retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve students");
  }
};

export const getStudentByUser = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;
  const filteredClass = req.query.class || "";

  try {
    const user = req.user;
    if (!user || user.role !== "school") {
      return errorResponse(
        res,
        404,
        "User not found or not associated with an institution"
      );
    }

    const [institutionRows] = await pool.query(
      "SELECT id FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = institutionRows[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found for this user");
    }

    const classClause = filteredClass ? " AND c.name = ?" : "";
    const classParams = filteredClass ? [filteredClass] : [];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM family_members fm
       INNER JOIN students s ON s.familyMemberId = fm.id
       LEFT JOIN classes c ON c.id = s.classId
       WHERE fm.fullName LIKE ? AND s.schoolId = ?${classClause}`,
      [`%${search}%`, institution.id, ...classParams]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [rows] = await pool.query(
      `SELECT ${STUDENT_JOIN_SELECT}
       FROM family_members fm
       INNER JOIN students s ON s.familyMemberId = fm.id
       LEFT JOIN nutritions n ON n.familyMemberId = fm.id
       LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
       LEFT JOIN institutions i ON i.id = s.schoolId
       LEFT JOIN provinces pr ON pr.id = i.province_id
       LEFT JOIN cities ci ON ci.id = i.city_id
       LEFT JOIN classes c ON c.id = s.classId
       LEFT JOIN teachers t ON t.id = c.teacher_id
       WHERE fm.fullName LIKE ? AND s.schoolId = ?${classClause}
       ORDER BY fm.id ASC
       LIMIT ? OFFSET ?`,
      [`%${search}%`, institution.id, ...classParams, limit, offset]
    );

    const students = rows.map(reshapeStudentRow);

    const studentIds = students.map((s) => s.student?.id).filter(Boolean);

    let activeRecStudentIds = new Set();
    if (studentIds.length > 0) {
      const [recRows] = await pool.query(
        "SELECT studentId FROM recommendations WHERE studentId IN (?) AND status IN ('PENDING', 'PROCESSED')",
        [studentIds]
      );
      activeRecStudentIds = new Set(recRows.map((r) => r.studentId));
    }

    const studentsWithFlag = students.map((s) => ({
      ...s,
      isRecommending: s.student ? activeRecStudentIds.has(s.student.id) : false,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, students: studentsWithFlag },
      "Students retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve students");
  }
};
