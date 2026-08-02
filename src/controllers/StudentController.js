import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";
import { getInstitutionByUser } from "../helpers/InstitutionHelper.js";

// ---- constants for conclusion computation (getStudentByUser only) ----

const SOCIO_ECONOMIC_POINTS = {
  residence: { MILIK_SENDIRI: 3, MENYEWA: 2, BERSAMA_ORANG_TUA: 1 },
  children: { SATU: 3, DUA_SAMPAI_TIGA: 2, EMPAT_ATAU_LEBIH: 1 },
  underFive: { TIDAK_ADA: 4, SATU: 3, DUA_SAMPAI_TIGA: 2, EMPAT_ATAU_LEBIH: 1 },
  income: {
    KURANG_DARI_LIMA_JUTA: 1,
    LIMA_JUTA_SAMPAI_SEPULUH_JUTA: 2,
    LEBIH_DARI_SEPULUH_JUTA: 3,
  },
};

const SOCIO_ECONOMIC_THRESHOLD = 8;
const QUESTIONNAIRE_PARENT_THRESHOLDS = {
  "Kebiasaan Sehari-hari Anak": 34,
  "Tingkat Pengetahuan Gizi Seimbang": 13,
};

const SCHOOL_HEALTH_THRESHOLD = 17;

const categorizeEducation = (edu) => {
  if (!edu) return "Dasar";
  return ["TIDAK_SEKOLAH", "SD", "SMP"].includes(edu) ? "Dasar" : "Menengah-Tinggi";
};

const computeSocioEconomicInterpretation = (se) => {
  if (!se) return null;
  const totalScore =
    (SOCIO_ECONOMIC_POINTS.residence[se.residenceStatus] ?? 0) +
    (SOCIO_ECONOMIC_POINTS.children[se.childrenCount] ?? 0) +
    (SOCIO_ECONOMIC_POINTS.underFive[se.underFiveCount] ?? 0) +
    (SOCIO_ECONOMIC_POINTS.income[se.familyIncomeLevel] ?? 0);
  return totalScore >= SOCIO_ECONOMIC_THRESHOLD ? "Menengah-Tinggi" : "Dasar";
};

const computeConclusion = (
  nutritionStatus,
  parentData,
  schoolHealthInterpretation
) => {
  if (!nutritionStatus) return null;

  if (nutritionStatus === "OVERWEIGHT-OBESITAS") return "Gizi Lebih";
  if (nutritionStatus === "GIZI BURUK-KURANG")
    return "Tidak Berisiko Gizi Lebih";

  if (nutritionStatus === "GIZI BAIK") {
    const kebiasaanBaik =
      (parentData?.kebiasaanScore ?? 0) >=
      QUESTIONNAIRE_PARENT_THRESHOLDS["Kebiasaan Sehari-hari Anak"];
    const pengetahuanBaik =
      (parentData?.pengetahuanScore ?? 0) >=
      QUESTIONNAIRE_PARENT_THRESHOLDS["Tingkat Pengetahuan Gizi Seimbang"];
    const sosialEkonomiBaik =
      parentData?.socioEconomicInterpretation === "Menengah-Tinggi";
    const pendidikanBaik = parentData?.parentEducation === "Menengah-Tinggi";
    const pelkesBaik = schoolHealthInterpretation === "Tinggi";

    const all5Good =
      kebiasaanBaik &&
      pengetahuanBaik &&
      sosialEkonomiBaik &&
      pendidikanBaik &&
      pelkesBaik;

    if (all5Good) return "Tidak Berisiko Gizi Lebih";

    const triggerBad = !kebiasaanBaik || !pengetahuanBaik || !sosialEkonomiBaik;
    if (triggerBad) return "Berisiko Gizi Lebih";

    return "Tidak Berisiko Gizi Lebih";
  }

  return null;
};

// ---- shared row-reshaping helper ----

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
          // measurementDate/monitoringPeriod columns are only selected by
          // getStudentByUser (not getStudents), so only attach them when present.
          ...(row.n_measurementDate !== undefined
            ? { measurementDate: row.n_measurementDate }
            : {}),
          ...(row.mp_label !== undefined
            ? { monitoringPeriod: row.mp_id ? { label: row.mp_label } : null }
            : {}),
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
    // familyId is only selected by getStudentByUser (needed for the
    // conclusion computation, stripped again before the response is sent).
    ...(row.fm_familyId !== undefined ? { familyId: row.fm_familyId } : {}),
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
    if (!user || !["school", "teacher"].includes(user.role)) {
      return errorResponse(
        res,
        404,
        "User not found or not associated with an institution"
      );
    }

    const institution = await getInstitutionByUser(user.id, user.role);

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

    // nutritions no longer has a unique(familyMemberId) constraint (historical
    // tracking allows multiple measurements per student), so the join below
    // pins down the single latest measurement (by measurementDate, tie-broken
    // by id) via a correlated subquery, keeping one row per student for
    // pagination. monitoring_periods is joined in for the period label.
    const [rows] = await pool.query(
      `SELECT ${STUDENT_JOIN_SELECT},
         fm.familyId AS fm_familyId,
         n.measurementDate AS n_measurementDate,
         mp.id AS mp_id, mp.label AS mp_label
       FROM family_members fm
       INNER JOIN students s ON s.familyMemberId = fm.id
       LEFT JOIN nutritions n ON n.id = (
         SELECT n2.id FROM nutritions n2
         WHERE n2.familyMemberId = fm.id
         ORDER BY n2.measurementDate DESC, n2.id DESC
         LIMIT 1
       )
       LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
       LEFT JOIN monitoring_periods mp ON mp.id = n.monitoringPeriodId
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
    let completedRecMap = {};
    if (studentIds.length > 0) {
      const [recRows] = await pool.query(
        "SELECT id, studentId, status FROM recommendations WHERE studentId IN (?)",
        [studentIds]
      );
      activeRecStudentIds = new Set(
        recRows
          .filter((r) => r.status === "PENDING" || r.status === "PROCESSED")
          .map((r) => r.studentId)
      );
      for (const r of recRows) {
        if (r.status === "COMPLETED") {
          completedRecMap[r.studentId] = { id: r.id, status: r.status };
        }
      }
    }

    const studentsWithFlag = students.map((s) => ({
      ...s,
      isRecommending: s.student ? activeRecStudentIds.has(s.student.id) : false,
      completedRecommendation: s.student
        ? completedRecMap[s.student.id] || null
        : null,
    }));

    // ---- compute conclusion per student ----

    const familyIds = [
      ...new Set(studentsWithFlag.map((s) => s.familyId).filter(Boolean)),
    ];

    const familyConclusionMap = {};
    if (familyIds.length > 0) {
      const [parentRows] = await pool.query(
        `SELECT fm2.id, fm2.familyId, fm2.relation, fm2.education,
                se.residenceStatus, se.childrenCount, se.underFiveCount, se.familyIncomeLevel
         FROM family_members fm2
         LEFT JOIN socio_economic se ON se.id = fm2.socioEconomicId
         WHERE fm2.familyId IN (?) AND fm2.relation IN ('AYAH', 'IBU')`,
        [familyIds]
      );

      // Prefer IBU over AYAH per family when both exist - same convention as
      // StatisticsController.getParentDashboardSummary.
      const parentByFamily = {};
      for (const p of parentRows) {
        const existing = parentByFamily[p.familyId];
        if (!existing || (existing.relation !== "IBU" && p.relation === "IBU")) {
          parentByFamily[p.familyId] = p;
        }
      }

      const parentIds = Object.values(parentByFamily).map((p) => p.id);
      const responsesByParent = {};
      if (parentIds.length > 0) {
        const [responseRows] = await pool.query(
          `SELECT r.familyMemberId, q.title, r.totalScore
           FROM responses r
           INNER JOIN quesioners q ON q.id = r.quisionerId
           WHERE r.familyMemberId IN (?)
           ORDER BY r.created_at ASC, r.id ASC`,
          [parentIds]
        );
        for (const r of responseRows) {
          if (!responsesByParent[r.familyMemberId]) {
            responsesByParent[r.familyMemberId] = {};
          }
          responsesByParent[r.familyMemberId][r.title] = r.totalScore;
        }
      }

      for (const familyId of familyIds) {
        const parent = parentByFamily[familyId];
        if (!parent) {
          familyConclusionMap[familyId] = null;
          continue;
        }

        const qMap = responsesByParent[parent.id] || {};
        familyConclusionMap[familyId] = {
          socioEconomicInterpretation: computeSocioEconomicInterpretation(
            parent.residenceStatus != null
              ? {
                  residenceStatus: parent.residenceStatus,
                  childrenCount: parent.childrenCount,
                  underFiveCount: parent.underFiveCount,
                  familyIncomeLevel: parent.familyIncomeLevel,
                }
              : null
          ),
          parentEducation: categorizeEducation(parent.education),
          kebiasaanScore: qMap["Kebiasaan Sehari-hari Anak"],
          pengetahuanScore: qMap["Tingkat Pengetahuan Gizi Seimbang"],
        };
      }
    }

    // School health service (same for all students in this school)
    let schoolHealthInterpretation = "Rendah";
    const [healthQuesionerRows] = await pool.query(
      "SELECT id FROM quesioners WHERE title = ? LIMIT 1",
      ["Pelayanan Kesehatan Sekolah"]
    );
    const healthQuesioner = healthQuesionerRows[0];
    if (healthQuesioner) {
      const [healthResponseRows] = await pool.query(
        `SELECT totalScore FROM responses
         WHERE institutionId = ? AND quisionerId = ?
         ORDER BY created_at DESC LIMIT 1`,
        [institution.id, healthQuesioner.id]
      );
      const healthResponse = healthResponseRows[0];
      if (
        healthResponse &&
        (healthResponse.totalScore ?? 0) >= SCHOOL_HEALTH_THRESHOLD
      ) {
        schoolHealthInterpretation = "Tinggi";
      }
    }

    const studentsWithConclusion = studentsWithFlag.map((s) => {
      const nutritionStatus = s.nutrition?.[0]?.nutritionStatus?.displayName;
      const conclusion = computeConclusion(
        nutritionStatus,
        familyConclusionMap[s.familyId],
        schoolHealthInterpretation
      );
      const { familyId, ...rest } = s;
      return { ...rest, conclusion };
    });

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, students: studentsWithConclusion },
      "Students retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve students");
  }
};
