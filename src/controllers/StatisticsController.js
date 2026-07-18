import { PrismaClient } from "@prisma/client";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();

// NOTE: mysql2 can return COUNT(*)/COUNT(id) results as a JS number or as a
// string representation of a BIGINT, depending on driver/row configuration.
// Every count in this file is wrapped in Number(...) before arithmetic or
// comparison to avoid string-concatenation bugs ("12" + 1 !== 13).

const POINTS_RESIDENCE = {
  MILIK_SENDIRI: 3,
  MENYEWA: 2,
  BERSAMA_ORANG_TUA: 1,
};

const POINTS_CHILDREN = {
  SATU: 3,
  DUA_SAMPAI_TIGA: 2,
  EMPAT_ATAU_LEBIH: 1,
};

const POINTS_UNDER_FIVE = {
  TIDAK_ADA: 4,
  SATU: 3,
  DUA_SAMPAI_TIGA: 2,
  EMPAT_ATAU_LEBIH: 1,
};

const POINTS_INCOME = {
  KURANG_DARI_LIMA_JUTA: 1,
  LIMA_JUTA_SAMPAI_SEPULUH_JUTA: 2,
  LEBIH_DARI_SEPULUH_JUTA: 3,
};

const categorizeEducation = (edu) => {
  if (!edu) return null;
  const dasar = ["TIDAK_SEKOLAH", "SD", "SMP"];
  return dasar.includes(edu) ? "Dasar" : "Menengah-Tinggi";
};

const SOCIO_ECONOMIC_THRESHOLD = 8;

const QUESTIONNAIRE_THRESHOLDS = {
  "Kebiasaan Sehari-hari Anak": { min: 34, good: "Baik", bad: "Kurang Baik" },
  "Tingkat Pengetahuan Gizi Seimbang": { min: 13, good: "Baik", bad: "Kurang" },
};

export const getAdminDashboardSummary = async (req, res) => {
  try {
    // 1. admin role lookup
    const [adminRoleRows] = await pool.query(
      `SELECT id FROM roles WHERE name = ? LIMIT 1`,
      ["admin"],
    );
    const adminRoleId = adminRoleRows[0]?.id ?? -1;

    // 2. totalUsers excluding admin
    const [totalUsersRows] = await pool.query(
      `SELECT COUNT(id) AS count FROM users WHERE role_id != ?`,
      [adminRoleId],
    );
    const totalUsers = Number(totalUsersRows[0].count);

    // 3+4. usersByRole groupBy (no zero-fill) + roles list for labeling
    const [usersByRoleRows] = await pool.query(
      `SELECT role_id, COUNT(id) AS count FROM users GROUP BY role_id`,
    );
    const [roleRows] = await pool.query(`SELECT id, name FROM roles`);
    const roleMap = {};
    roleRows.forEach((r) => {
      roleMap[r.id] = r.name;
    });
    const userByRole = usersByRoleRows
      .filter((u) => u.role_id !== adminRoleId)
      .map((u) => ({ role: roleMap[u.role_id], total: Number(u.count) }));

    // 5. totalInstitutions
    const [totalInstitutionsRows] = await pool.query(
      `SELECT COUNT(id) AS count FROM institutions`,
    );
    const totalInstitutions = Number(totalInstitutionsRows[0].count);

    // 6+7. instByType groupBy (no zero-fill) + institution_types list for labeling
    const [instByTypeRows] = await pool.query(
      `SELECT type, COUNT(id) AS count FROM institutions GROUP BY type`,
    );
    const [instTypeRows] = await pool.query(
      `SELECT id, name FROM institution_types`,
    );
    const instTypeMap = {};
    instTypeRows.forEach((t) => {
      instTypeMap[t.id] = t.name;
    });
    const institutionByType = instByTypeRows.map((i) => ({
      type: instTypeMap[i.type],
      total: Number(i.count),
    }));

    // 8. true-latest nutrition status per family member (ALL members, not scoped
    // to any family). Correlated subquery is used instead of ROW_NUMBER() OVER()
    // for compatibility with MariaDB/MySQL versions that predate window function
    // support; if the target server is confirmed MySQL 8+/MariaDB 10.2+, this can
    // be swapped for a ROW_NUMBER() OVER (PARTITION BY familyMemberId ORDER BY
    // updatedAt DESC) = 1 filter with identical results.
    const [nutritionRows] = await pool.query(
      `SELECT fm.id, ns.displayName
       FROM family_members fm
       LEFT JOIN nutritions n
         ON n.familyMemberId = fm.id
         AND n.updatedAt = (
           SELECT MAX(n2.updatedAt) FROM nutritions n2 WHERE n2.familyMemberId = fm.id
         )
       LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId`,
      [],
    );
    const nutritionMap = {};
    nutritionRows.forEach((fm) => {
      const name = fm.displayName || "Tidak Terdata";
      nutritionMap[name] = (nutritionMap[name] || 0) + 1;
    });
    const nutritionDistribution = Object.entries(nutritionMap).map(
      ([displayName, total]) => ({ displayName, total }),
    );

    // 9-11. simple counts, run in parallel (independent of each other)
    const [teacherRows, classRows, recommendationRows] = await Promise.all([
      pool.query(`SELECT COUNT(id) AS count FROM teachers`),
      pool.query(`SELECT COUNT(id) AS count FROM classes`),
      pool.query(`SELECT COUNT(id) AS count FROM recommendations`),
    ]);
    const totalTeachers = Number(teacherRows[0][0].count);
    const totalClasses = Number(classRows[0][0].count);
    const totalRecommendations = Number(recommendationRows[0][0].count);

    // 12. recByStatus groupBy — NO zero-fill (contrast with healthcare dashboard,
    // which fixed-array zero-fills all 3 statuses; do not unify these)
    const [recByStatusRows] = await pool.query(
      `SELECT status, COUNT(id) AS count FROM recommendations GROUP BY status`,
    );
    const statusLabelMap = {
      PENDING: "pending",
      PROCESSED: "proses",
      COMPLETED: "selesai",
    };
    const recommendationsByStatus = recByStatusRows.map((r) => ({
      status: statusLabelMap[r.status] || r.status.toLowerCase(),
      total: Number(r.count),
    }));

    // 13. schoolQuesioner lookup
    const [schoolQuesionerRows] = await pool.query(
      `SELECT id, title FROM quesioners WHERE title = ? LIMIT 1`,
      ["Pelayanan Kesehatan Sekolah"],
    );
    const schoolQuesioner = schoolQuesionerRows[0] ?? null;

    // 14. schools list
    const [schools] = await pool.query(
      `SELECT i.id, i.name
       FROM institutions i
       INNER JOIN institution_types it ON it.id = i.type
       WHERE it.name = ?`,
      ["School"],
    );

    // 15. schoolResponses groupBy. The quisionerId filter is added conditionally
    // in JS — replicating Prisma's "undefined drops the where key" semantics.
    // Binding `schoolQuesioner?.id ?? null` into `= ?` would be WRONG: SQL
    // `= NULL` is always unknown/false, so it would silently return zero groups
    // instead of "count every response" when the questionnaire is missing.
    let schoolResponsesSql = `SELECT institutionId, COUNT(id) AS count FROM responses WHERE institutionId IS NOT NULL`;
    const schoolResponsesParams = [];
    if (schoolQuesioner) {
      schoolResponsesSql += ` AND quisionerId = ?`;
      schoolResponsesParams.push(schoolQuesioner.id);
    }
    schoolResponsesSql += ` GROUP BY institutionId`;
    const [schoolResponses] = await pool.query(
      schoolResponsesSql,
      schoolResponsesParams,
    );
    const responseMap = {};
    schoolResponses.forEach((r) => {
      if (r.institutionId) responseMap[r.institutionId] = Number(r.count);
    });

    // JS-side zero-fill: every school defaults to 0 completed quests. This is
    // the REAL backfill in this handler — it happens here, in JS, over the
    // independently-fetched `schools` list, not in SQL.
    const institutionDetails = schools.map((s) => ({
      id: s.id,
      name: s.name,
      completedQuests: responseMap[s.id] || 0,
      totalQuests: schoolQuesioner ? 1 : 0,
    }));

    const completedInstitutions = institutionDetails.filter(
      (d) => d.completedQuests >= d.totalQuests,
    ).length;
    const totalSchoolInst = schools.length;
    const percentage =
      totalSchoolInst > 0
        ? Math.round((completedInstitutions / totalSchoolInst) * 100)
        : 0;

    // 16. recentRecs — student/familyMember/institution are all required
    // (non-optional) relations in the schema, so INNER JOIN is safe here
    // (mirrors Prisma's guarantee that `include` on a required relation never
    // returns null).
    const [recentRecs] = await pool.query(
      `SELECT r.id, r.createdAt, r.status, fm.fullName AS studentName, i.name AS institutionName
       FROM recommendations r
       INNER JOIN students s ON s.id = r.studentId
       INNER JOIN family_members fm ON fm.id = s.familyMemberId
       INNER JOIN institutions i ON i.id = s.schoolId
       ORDER BY r.createdAt DESC
       LIMIT 5`,
      [],
    );
    const recentRecommendations = recentRecs.map((r) => ({
      id: r.id,
      studentName: r.studentName,
      institutionName: r.institutionName,
      status: statusLabelMap[r.status] || r.status.toLowerCase(),
      createdAt: r.createdAt,
    }));

    return successResponse(
      res,
      {
        totalUsers,
        userByRole,
        totalInstitutions,
        institutionByType,
        nutritionDistribution,
        totalTeachers,
        totalClasses,
        totalRecommendations,
        recommendationsByStatus,
        questionnaireProgress: {
          totalInstitutions: totalSchoolInst,
          completedInstitutions,
          percentage,
          institutionDetails,
        },
        recentRecommendations,
      },
      "Admin dashboard summary retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get admin dashboard summary");
  }
};

export const getParentDashboardSummary = async (req, res) => {
  try {
    const user = req.user;

    // 1. family lookup
    const [familyRows] = await pool.query(
      `SELECT id, userId FROM families WHERE userId = ? LIMIT 1`,
      [user.id],
    );
    const family = familyRows[0] ?? null;

    if (!family) {
      return errorResponse(res, null, "Family not found");
    }

    // 2. members — the base list this whole handler is composed around
    const [members] = await pool.query(
      `SELECT id, fullName, birthDate, age, education, jobId, gender, relation,
              familyId, institutionId, phone, isCompleted, socioEconomicId,
              createdAt, updatedAt
       FROM family_members
       WHERE familyId = ?`,
      [family.id],
    );

    const memberIds = members.map((m) => m.id);

    // 3. true-latest nutrition per member, scoped to this family's members only
    // (same true-latest pattern as the admin dashboard's ALL-members version —
    // correlated subquery, not ROW_NUMBER(), for MariaDB/older-MySQL compat).
    // Guarded: an empty IN (?) is invalid SQL, so skip the query entirely when
    // there are no members.
    let nutritionRows = [];
    if (memberIds.length > 0) {
      [nutritionRows] = await pool.query(
        `SELECT n.familyMemberId, n.id, n.height, n.weight, n.bmi, n.updatedAt, ns.displayName
         FROM nutritions n
         LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
         WHERE n.familyMemberId IN (?)
           AND n.updatedAt = (
             SELECT MAX(n2.updatedAt) FROM nutritions n2 WHERE n2.familyMemberId = n.familyMemberId
           )`,
        [memberIds],
      );
    }
    const nutritionByMember = {};
    nutritionRows.forEach((n) => {
      nutritionByMember[n.familyMemberId] = n;
    });

    // 4. students keyed by familyMemberId
    let studentRows = [];
    if (memberIds.length > 0) {
      [studentRows] = await pool.query(
        `SELECT id, schoolId, familyMemberId, nis, schoolYear, semester, classId
         FROM students
         WHERE familyMemberId IN (?)`,
        [memberIds],
      );
    }
    const studentByMember = {};
    studentRows.forEach((s) => {
      studentByMember[s.familyMemberId] = s;
    });

    // 5. socio_economic keyed by id (distinct ids, guarded)
    const socioEconomicIds = [...new Set(members.map((m) => m.socioEconomicId))];
    let socioRows = [];
    if (socioEconomicIds.length > 0) {
      [socioRows] = await pool.query(
        `SELECT id, residenceStatus, address, childrenCount, underFiveCount,
                familyIncomeLevel, createdAt, updatedAt
         FROM socio_economic
         WHERE id IN (?)`,
        [socioEconomicIds],
      );
    }
    const socioById = {};
    socioRows.forEach((se) => {
      socioById[se.id] = se;
    });

    // Compose the in-memory shape the (unchanged) pure-JS logic below expects,
    // matching Prisma's nested include shape.
    const familyMembers = members.map((m) => {
      const n = nutritionByMember[m.id];
      return {
        ...m,
        nutrition: n
          ? [
              {
                id: n.id,
                height: n.height,
                weight: n.weight,
                bmi: n.bmi,
                updatedAt: n.updatedAt,
                nutritionStatus:
                  n.displayName != null ? { displayName: n.displayName } : null,
              },
            ]
          : [],
        SocioEconomic: socioById[m.socioEconomicId] ?? null,
        student: studentByMember[m.id] ?? null,
      };
    });

    const totalFamilyMembers = familyMembers.length;
    const children = familyMembers.filter((m) => m.relation === "ANAK");
    const totalChildren = children.length;

    const parent =
      familyMembers.find((m) => m.relation === "IBU") ||
      familyMembers.find((m) => m.relation === "AYAH");

    let totalQuestionnaires = 0;
    let answeredQuestionnaires = 0;
    let questionnaireProgress = 0;
    const questionnaireResults = [];

    const parentTitles = [
      "Tingkat Pengetahuan Gizi Seimbang",
      "Kebiasaan Sehari-hari Anak",
    ];

    if (parent) {
      // 6. totalQuestionnaires
      const [totalQuestionnairesRows] = await pool.query(
        `SELECT COUNT(id) AS count FROM quesioners WHERE title IN (?)`,
        [parentTitles],
      );
      totalQuestionnaires = Number(totalQuestionnairesRows[0].count);

      // 7. parentResponses — INNER JOIN quesioners (required relation).
      // NOTE: `r.quisionerId` (the flat column) is read directly below rather
      // than a nested quesioner.id — this is the original behavior, not a typo,
      // and must be preserved as-is.
      const [parentResponses] = await pool.query(
        `SELECT r.id, r.quisionerId, r.totalScore, r.familyMemberId, r.institutionId,
                r.created_at, q.title AS quesionerTitle
         FROM responses r
         INNER JOIN quesioners q ON q.id = r.quisionerId
         WHERE r.familyMemberId = ?`,
        [parent.id],
      );

      answeredQuestionnaires = parentResponses.length;
      questionnaireProgress =
        totalQuestionnaires > 0
          ? Math.round((answeredQuestionnaires / totalQuestionnaires) * 100)
          : 0;

      for (const r of parentResponses) {
        const threshold = QUESTIONNAIRE_THRESHOLDS[r.quesionerTitle];
        if (threshold) {
          questionnaireResults.push({
            quesionerId: r.quisionerId,
            title: r.quesionerTitle,
            totalScore: r.totalScore,
            interpretation:
              r.totalScore >= threshold.min ? threshold.good : threshold.bad,
          });
        }
      }
    }

    let socioEconomic = null;
    if (parent?.SocioEconomic) {
      const se = parent.SocioEconomic;
      const residencePoints = POINTS_RESIDENCE[se.residenceStatus] ?? 0;
      const childrenPoints = POINTS_CHILDREN[se.childrenCount] ?? 0;
      const underFivePoints = POINTS_UNDER_FIVE[se.underFiveCount] ?? 0;
      const incomePoints = POINTS_INCOME[se.familyIncomeLevel] ?? 0;
      const totalScore =
        residencePoints + childrenPoints + underFivePoints + incomePoints;

      socioEconomic = {
        residenceStatus: se.residenceStatus,
        residencePoints,
        childrenCount: se.childrenCount,
        childrenPoints,
        underFiveCount: se.underFiveCount,
        underFivePoints,
        familyIncomeLevel: se.familyIncomeLevel,
        incomePoints,
        totalScore,
        interpretation:
          totalScore >= SOCIO_ECONOMIC_THRESHOLD ? "Menengah-Tinggi" : "Rendah",
      };
    }

    const parentEducation = {};
    const ibu = familyMembers.find((m) => m.relation === "IBU");
    const ayah = familyMembers.find((m) => m.relation === "AYAH");
    if (ibu)
      parentEducation.ibu = {
        education: ibu.education,
        category: categorizeEducation(ibu.education),
      };
    if (ayah)
      parentEducation.ayah = {
        education: ayah.education,
        category: categorizeEducation(ayah.education),
      };

    const latestNutrition = children
      .flatMap((c) => c.nutrition)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];

    const nutritionDistribution = {};
    children.forEach((child) => {
      const status = child.nutrition?.[0]?.nutritionStatus?.displayName;
      if (status) {
        nutritionDistribution[status] =
          (nutritionDistribution[status] || 0) + 1;
      }
    });
    const nutritionDistArray = Object.entries(nutritionDistribution).map(
      ([displayName, total]) => ({ displayName, total }),
    );

    let schoolHealthService = null;
    const childWithSchool = children.find((c) => c.student?.schoolId);
    if (childWithSchool) {
      const schoolId = childWithSchool.student.schoolId;
      // 8. schoolQuesioner lookup
      const [schoolQuesionerRows] = await pool.query(
        `SELECT id, title FROM quesioners WHERE title = ? LIMIT 1`,
        ["Pelayanan Kesehatan Sekolah"],
      );
      const schoolQuesioner = schoolQuesionerRows[0] ?? null;
      if (schoolQuesioner) {
        // 9. latest response for that school+questionnaire
        const [schoolResponseRows] = await pool.query(
          `SELECT id, quisionerId, totalScore, familyMemberId, institutionId, created_at
           FROM responses
           WHERE institutionId = ? AND quisionerId = ?
           ORDER BY created_at DESC
           LIMIT 1`,
          [schoolId, schoolQuesioner.id],
        );
        const schoolResponse = schoolResponseRows[0] ?? null;
        if (schoolResponse) {
          const threshold = 17;
          schoolHealthService = {
            title: schoolQuesioner.title,
            totalScore: schoolResponse.totalScore,
            interpretation:
              schoolResponse.totalScore >= threshold ? "Tinggi" : "Rendah",
          };
        }
      }
    }

    return successResponse(
      res,
      {
        totalFamilyMembers,
        totalChildren,
        totalQuestionnaires,
        answeredQuestionnaires,
        questionnaireProgress,
        questionnaireResults,
        socioEconomic,
        parentEducation,
        latestNutritionStatus:
          latestNutrition?.nutritionStatus?.displayName ?? null,
        nutritionDistribution: nutritionDistArray,
        schoolHealthService,
      },
      "Dashboard summary retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get dashboard summary");
  }
};

export const getSchoolDashboardSummary = async (req, res) => {
  try {
    const user = req.user;

    const institution = await prisma.institution.findUnique({
      where: { user_id: user.id },
    });

    if (!institution) return errorResponse(res, null, "Institution not found");

    const institutionId = institution.id;

    const totalStudents = await prisma.student.count({
      where: { schoolId: institutionId },
    });
    const totalClasses = await prisma.class.count({
      where: { school_id: institutionId },
    });
    const totalTeachers = await prisma.teacher.count({
      where: { school_id: institutionId },
    });
    const totalPartners = await prisma.partnership.count({
      where: { schoolId: institutionId },
    });

    const students = await prisma.familyMember.findMany({
      where: { student: { schoolId: institutionId } },
      select: {
        nutrition: {
          select: { nutritionStatus: { select: { displayName: true } } },
        },
      },
    });

    const nutritionMap = {};
    students.forEach((fm) => {
      const name =
        fm.nutrition?.[0]?.nutritionStatus?.displayName || "Tidak Terdata";
      nutritionMap[name] = (nutritionMap[name] || 0) + 1;
    });
    const nutritionDistribution = Object.entries(nutritionMap).map(
      ([displayName, total]) => ({ displayName, total }),
    );

    const classGroups = await prisma.student.groupBy({
      by: ["classId"],
      where: { schoolId: institutionId },
      _count: { id: true },
    });
    const classIds = classGroups.map((g) => g.classId);
    const classes = await prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    });
    const classMap = {};
    classes.forEach((c) => {
      classMap[c.id] = c.name;
    });
    const studentsPerClass = classGroups.map((g) => ({
      className: classMap[g.classId] || "Unknown",
      total: g._count.id,
    }));

    const QUESTIONNAIRE_THRESHOLDS = {
      "Pelayanan Kesehatan Sekolah": { min: 17, good: "Tinggi", bad: "Rendah" },
    };

    const quesioner = await prisma.quesioner.findFirst({
      where: { title: "Pelayanan Kesehatan Sekolah" },
    });

    let questionnaireResult = null;
    let questionnaireProgress = 0;
    let totalQuestionnaires = 0;
    let answeredQuestionnaires = 0;

    if (quesioner) {
      totalQuestionnaires = 1;
      const response = await prisma.response.findFirst({
        where: {
          institutionId,
          quisionerId: quesioner.id,
        },
        orderBy: { created_at: "desc" },
      });

      if (response) {
        answeredQuestionnaires = 1;
        const threshold = QUESTIONNAIRE_THRESHOLDS[quesioner.title]?.min ?? 17;
        const totalScore = response.totalScore || 0;
        questionnaireResult = {
          quesionerId: quesioner.id,
          title: quesioner.title,
          totalScore,
          interpretation:
            totalScore >= threshold
              ? (QUESTIONNAIRE_THRESHOLDS[quesioner.title]?.good ?? "Tinggi")
              : (QUESTIONNAIRE_THRESHOLDS[quesioner.title]?.bad ?? "Rendah"),
        };
      }
    }

    questionnaireProgress =
      totalQuestionnaires > 0
        ? Math.round((answeredQuestionnaires / totalQuestionnaires) * 100)
        : 0;

    const schoolConclusion = questionnaireResult
      ? questionnaireResult.interpretation === "Tinggi"
        ? {
            kategori: "Pelayanan Kesehatan Sekolah Baik",
            icon: "🏆",
            color: "from-emerald-500 to-teal-600",
            saran: ["Budayakan perilaku hidup sehat dalam lingkungan sekolah"],
          }
        : {
            kategori: "Pelayanan Kesehatan Sekolah Perlu Ditingkatkan",
            icon: "⚠️",
            color: "from-amber-500 to-orange-600",
            saran: [
              "Rekomendasi tindaklanjut Puskesmas",
              "Budayakan perilaku hidup sehat dalam lingkungan sekolah",
            ],
          }
      : null;

    return successResponse(
      res,
      {
        totalStudents,
        totalClasses,
        totalTeachers,
        totalPartners,
        questionnaireProgress,
        questionnaireResult,
        nutritionDistribution,
        studentsPerClass,
        schoolConclusion,
      },
      "School dashboard summary retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get school dashboard summary");
  }
};

export const getHealthcareDashboardSummary = async (req, res) => {
  try {
    const user = req.user;

    const institution = await prisma.institution.findFirst({
      where: { user_id: user.id },
    });

    if (!institution) return errorResponse(res, null, "Institution not found");

    const institutionId = institution.id;

    const [pending, processed, completed] = await Promise.all([
      prisma.recommendation.count({
        where: { healthcareInstitutionId: institutionId, status: "PENDING" },
      }),
      prisma.recommendation.count({
        where: { healthcareInstitutionId: institutionId, status: "PROCESSED" },
      }),
      prisma.recommendation.count({
        where: { healthcareInstitutionId: institutionId, status: "COMPLETED" },
      }),
    ]);

    const totalPartnerSchools = await prisma.partnership.count({
      where: { healthcareId: institutionId },
    });

    const recentRecs = await prisma.recommendation.findMany({
      where: { healthcareInstitutionId: institutionId, status: "PENDING" },
      select: {
        id: true,
        createdAt: true,
        student: {
          select: {
            nis: true,
            familyMember: {
              select: { fullName: true },
            },
            institution: {
              select: { name: true },
            },
            class: {
              select: { name: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    const recByStatus = [
      { status: "PENDING", total: pending },
      { status: "PROCESSED", total: processed },
      { status: "COMPLETED", total: completed },
    ];

    return successResponse(
      res,
      {
        totalPending: pending,
        totalProcessed: processed,
        totalCompleted: completed,
        totalPartnerSchools,
        recentRecommendations: recentRecs,
        recommendationsByStatus: recByStatus,
      },
      "Healthcare dashboard summary retrieved successfully",
    );
  } catch (error) {
    return errorResponse(
      res,
      error,
      "Failed to get healthcare dashboard summary",
    );
  }
};
