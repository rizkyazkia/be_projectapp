import pool from "../config/db.js";
import { randomUUID } from "node:crypto";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";
import { createNotification } from "./NotificationController.js";

export const getRecomendations = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const offset = limit * page;

  try {
    let institution = null;
    if (req.user?.role === "healthcare" || req.user?.role === "school") {
      const [instRows] = await pool.query(
        "SELECT id FROM institutions WHERE user_id = ? LIMIT 1",
        [req.user.id],
      );
      institution = instRows[0] || null;
    }

    const joinSql = `
      LEFT JOIN users su ON su.id = r.submittedById
      LEFT JOIN institutions si ON si.user_id = su.id
      LEFT JOIN cities sic ON sic.id = si.city_id
      LEFT JOIN provinces sip ON sip.id = si.province_id
      LEFT JOIN students st ON st.id = r.studentId
      LEFT JOIN institutions sti ON sti.id = st.schoolId
      LEFT JOIN cities stic ON stic.id = sti.city_id
      LEFT JOIN provinces stip ON stip.id = sti.province_id
      LEFT JOIN classes cl ON cl.id = st.classId
      LEFT JOIN family_members fm ON fm.id = st.familyMemberId
      LEFT JOIN socio_economic se ON se.id = fm.socioEconomicId
    `;

    let filterSql = "";
    let filterParams = [];
    if (req.user?.role === "healthcare" && institution) {
      filterSql = "WHERE r.healthcareInstitutionId = ?";
      filterParams = [institution.id];
    } else if (req.user?.role === "school" && institution) {
      filterSql = "WHERE si.id = ?";
      filterParams = [institution.id];
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS count FROM recommendations r ${joinSql} ${filterSql}`,
      filterParams,
    );
    const totalRows = countRows[0].count;

    const [rows] = await pool.query(
      `SELECT
        r.id, r.status, r.createdAt,
        su.id AS submittedBy_id,
        si.id AS si_id, si.name AS si_name, si.address AS si_address, si.phone AS si_phone, si.email AS si_email,
        sic.id AS sic_id, sic.name AS sic_name,
        sip.id AS sip_id, sip.name AS sip_name,
        st.id AS student_id, st.nis AS student_nis, st.schoolYear AS student_schoolYear, st.semester AS student_semester,
        sti.id AS sti_id, sti.name AS sti_name, sti.address AS sti_address, sti.phone AS sti_phone, sti.email AS sti_email,
        stic.id AS stic_id, stic.name AS stic_name,
        stip.id AS stip_id, stip.name AS stip_name,
        cl.id AS class_id, cl.name AS class_name,
        fm.id AS fm_id, fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate, fm.gender AS fm_gender, fm.familyId AS fm_familyId,
        se.id AS se_id, se.address AS se_address
      FROM recommendations r
      ${joinSql}
      ${filterSql}
      ORDER BY r.createdAt ASC
      LIMIT ? OFFSET ?`,
      [...filterParams, limit, offset],
    );

    const familyMemberIds = [...new Set(rows.filter((row) => row.fm_id).map((row) => row.fm_id))];
    let nutritionRows = [];
    if (familyMemberIds.length > 0) {
      const [nRows] = await pool.query(
        `SELECT n.id, n.familyMemberId, ns.id AS ns_id, ns.information AS ns_information
         FROM nutritions n
         LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
         WHERE n.familyMemberId IN (?)`,
        [familyMemberIds],
      );
      nutritionRows = nRows;
    }
    const nutritionByFamilyMember = new Map();
    for (const n of nutritionRows) {
      const list = nutritionByFamilyMember.get(n.familyMemberId) || [];
      list.push({
        id: n.id,
        nutritionStatus: n.ns_id ? { id: n.ns_id, information: n.ns_information } : null,
      });
      nutritionByFamilyMember.set(n.familyMemberId, list);
    }

    const recomend = rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      submittedBy: row.submittedBy_id
        ? {
            id: row.submittedBy_id,
            institution: row.si_id
              ? {
                  id: row.si_id,
                  name: row.si_name,
                  address: row.si_address,
                  phone: row.si_phone,
                  email: row.si_email,
                  city: row.sic_id ? { id: row.sic_id, name: row.sic_name } : null,
                  province: row.sip_id ? { id: row.sip_id, name: row.sip_name } : null,
                }
              : null,
          }
        : null,
      student: row.student_id
        ? {
            id: row.student_id,
            nis: row.student_nis,
            schoolYear: row.student_schoolYear,
            semester: row.student_semester,
            institution: row.sti_id
              ? {
                  id: row.sti_id,
                  name: row.sti_name,
                  address: row.sti_address,
                  phone: row.sti_phone,
                  email: row.sti_email,
                  city: row.stic_id ? { id: row.stic_id, name: row.stic_name } : null,
                  province: row.stip_id ? { id: row.stip_id, name: row.stip_name } : null,
                }
              : null,
            class: row.class_id ? { id: row.class_id, name: row.class_name } : null,
            familyMember: row.fm_id
              ? {
                  id: row.fm_id,
                  fullName: row.fm_fullName,
                  birthDate: row.fm_birthDate,
                  gender: row.fm_gender,
                  familyId: row.fm_familyId,
                  SocioEconomic: row.se_id ? { address: row.se_address } : null,
                  nutrition: nutritionByFamilyMember.get(row.fm_id) || [],
                }
              : null,
          }
        : null,
    }));

    const totalPage = Math.ceil(totalRows / limit);

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, recomend },
      "List of recommendations retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const createRecommendation = async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "school") {
      return errorResponse(
        res,
        403,
        "User is not associated with an institution",
      );
    }

    const { familyMemberId, studentId, healthCareId } = req.body;
    if (!familyMemberId) {
      return errorResponse(res, 400, "familyMemberId is required");
    }

    let studentSql = `
      SELECT s.id, s.familyMemberId, fm.fullName AS fm_fullName
      FROM students s
      LEFT JOIN family_members fm ON fm.id = s.familyMemberId
      WHERE s.familyMemberId = ?
    `;
    const studentParams = [familyMemberId];
    if (studentId !== undefined) {
      studentSql += " AND s.id = ?";
      studentParams.push(studentId);
    }
    studentSql += " LIMIT 1";

    const [studentRows] = await pool.query(studentSql, studentParams);
    const student = studentRows[0];

    if (!student) {
      return errorResponse(res, 404, "Student (anak) not found");
    }

    const [existingRows] = await pool.query(
      "SELECT id FROM recommendations WHERE studentId = ? AND status IN (?)",
      [student.id, ["PENDING", "PROCESSED"]],
    );

    if (existingRows[0]) {
      return errorResponse(
        res,
        400,
        "Murid ini sudah direkomendasikan sebelumnya",
      );
    }

    const id = randomUUID();
    const now = new Date();
    const healthcareInstitutionId = healthCareId ? Number(healthCareId) : null;

    await pool.query(
      `INSERT INTO recommendations
        (id, studentId, submittedById, healthcareInstitutionId, status, pdfUrl, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, student.id, user.id, healthcareInstitutionId, "PENDING", null, now, now],
    );

    const recommendation = {
      id,
      studentId: student.id,
      submittedById: user.id,
      healthcareInstitutionId,
      status: "PENDING",
      pdfUrl: null,
      createdAt: now,
      updatedAt: now,
    };

    // Notifikasi ke puskesmas
    let healthcareInstitution = null;
    if (healthCareId) {
      const [hcRows] = await pool.query(
        `SELECT i.id, i.name, u.id AS user_id
         FROM institutions i
         LEFT JOIN users u ON u.id = i.user_id
         WHERE i.id = ? LIMIT 1`,
        [Number(healthCareId)],
      );
      healthcareInstitution = hcRows[0] || null;
    }

    if (healthcareInstitution?.user_id) {
      const [schoolInstRows] = await pool.query(
        "SELECT id, name FROM institutions WHERE user_id = ? LIMIT 1",
        [user.id],
      );
      const schoolInstitution = schoolInstRows[0] || null;

      await createNotification(
        healthcareInstitution.user_id,
        "Rekomendasi Baru",
        `Siswa ${student.fm_fullName || "tersebut"} dari ${
          schoolInstitution?.name || "sekolah"
        } telah direkomendasikan untuk penanganan gizi. Silakan ditindaklanjuti.`,
        "recommendation_received",
        recommendation.id,
      );
    }

    // Notifikasi ke parent siswa
    const [familyMemberRows] = await pool.query(
      `SELECT fm.id, fm.fullName, f.id AS family_id, u.id AS user_id
       FROM family_members fm
       LEFT JOIN families f ON f.id = fm.familyId
       LEFT JOIN users u ON u.id = f.userId
       WHERE fm.id = ? LIMIT 1`,
      [student.familyMemberId],
    );
    const familyMember = familyMemberRows[0];

    if (familyMember?.user_id) {
      await createNotification(
        familyMember.user_id,
        "Rekomendasi Dikirim",
        `Ananda ${familyMember.fullName} telah direkomendasikan ke Puskesmas ${
          healthcareInstitution?.name || "puskesmas"
        } untuk pemeriksaan lanjutan. Silakan pantau perkembangannya.`,
        "recommendation_sent",
        recommendation.id,
      );
    }

    return successResponse(
      res,
      recommendation,
      "Recommendation created successfully",
    );
  } catch (error) {
    console.error(error);
    return errorResponse(res, error, "Failed to create recommendation");
  }
};

export const changeStatusToProcessed = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await pool.query(
      "UPDATE recommendations SET status = ? WHERE id = ?",
      ["PROCESSED", id],
    );

    if (result.affectedRows === 0) {
      throw new Error(`No 'Recommendation' record(s) found for id ${id}.`);
    }

    const [rows] = await pool.query(
      "SELECT * FROM recommendations WHERE id = ? LIMIT 1",
      [id],
    );

    return successResponse(
      res,
      rows[0],
      "Berhasil dimasukan ke dalam antrian proses",
    );
  } catch (error) {
    return errorResponse(res, error, "Gagal memasukan ke dalam antrian proses");
  }
};

export const getResponseParent = async (req, res) => {
  try {
    const { userId } = req.body;
    const quesionerId = userId;

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [familyRows] = await pool.query(
      "SELECT id FROM families WHERE userId = ? LIMIT 1",
      [userId],
    );
    const family = familyRows[0];

    if (!family) {
      return errorResponse(res, 404, "Family not found");
    }

    const [familyMemberRows] = await pool.query(
      `SELECT id FROM family_members
       WHERE familyId = ? AND (relation = 'IBU' OR relation = 'AYAH')
       LIMIT 1`,
      [family.id],
    );
    const familyMember = familyMemberRows[0];

    if (!familyMember) {
      return errorResponse(res, 404, "Family member not found");
    }

    const [responses] = await pool.query(
      "SELECT id, quisionerId FROM responses WHERE familyMemberId = ?",
      [familyMember.id],
    );

    const [questions] = await pool.query(
      `SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ?`,
      [quesionerId, `%${search}%`],
    );

    const questionIds = questions.map((q) => q.id);
    const optionsByQuestion = new Map();
    if (questionIds.length > 0) {
      const [optionRows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds],
      );
      for (const o of optionRows) {
        const list = optionsByQuestion.get(o.question_id) || [];
        list.push({ id: o.id, title: o.title, score: o.score });
        optionsByQuestion.set(o.question_id, list);
      }
    }
    const questionsWithOptions = questions.map((q) => ({
      id: q.id,
      quesioner_id: q.quesioner_id,
      title: q.title,
      type: q.type,
      options: optionsByQuestion.get(q.id) || [],
    }));

    // The response actually relevant to this quesioner (fixes the latent
    // un-scoped-answers bug that shipped alongside the `id` ReferenceError).
    const targetResponse = responses.find((r) => r.quisionerId === quesionerId);

    let totalRows = 0;
    let answers = [];
    if (targetResponse && questionIds.length > 0) {
      const [countRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM answers WHERE responseId = ? AND questionId IN (?)",
        [targetResponse.id, questionIds],
      );
      totalRows = countRows[0].count;

      const [answerRows] = await pool.query(
        `SELECT * FROM answers WHERE responseId = ? AND questionId IN (?)
         ORDER BY id ASC LIMIT ? OFFSET ?`,
        [targetResponse.id, questionIds, limit, offset],
      );
      answers = answerRows;
    }

    const totalPage = Math.ceil(totalRows / limit);

    return successResponse(
      res,
      {
        totalRows,
        totalPage,
        page,
        limit,
        questions: questionsWithOptions,
        answers,
      },
      "Berhasil mendapatkan data",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};

export const getResponseInstitution = async (req, res) => {
  try {
    const { userId } = req.body;
    const quesionerId = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [institutionRows] = await pool.query(
      "SELECT id FROM institutions WHERE user_id = ? LIMIT 1",
      [userId],
    );
    const institution = institutionRows[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    const [responseRows] = await pool.query(
      "SELECT id FROM responses WHERE institutionId = ? LIMIT 1",
      [institution.id],
    );
    const response = responseRows[0];

    if (!response) {
      return errorResponse(res, 404, "Response not found");
    }

    const [questions] = await pool.query(
      `SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ?`,
      [quesionerId, `%${search}%`],
    );

    const questionIds = questions.map((q) => q.id);
    const optionsByQuestion = new Map();
    if (questionIds.length > 0) {
      const [optionRows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds],
      );
      for (const o of optionRows) {
        const list = optionsByQuestion.get(o.question_id) || [];
        list.push({ id: o.id, title: o.title, score: o.score });
        optionsByQuestion.set(o.question_id, list);
      }
    }
    const questionsWithOptions = questions.map((q) => ({
      id: q.id,
      quesioner_id: q.quesioner_id,
      title: q.title,
      type: q.type,
      options: optionsByQuestion.get(q.id) || [],
    }));

    let totalRows = 0;
    let answers = [];
    if (questionIds.length > 0) {
      const [countRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM answers WHERE responseId = ? AND questionId IN (?)",
        [response.id, questionIds],
      );
      totalRows = countRows[0].count;

      const [answerRows] = await pool.query(
        `SELECT * FROM answers WHERE responseId = ? AND questionId IN (?)
         ORDER BY id ASC LIMIT ? OFFSET ?`,
        [response.id, questionIds, limit, offset],
      );
      answers = answerRows;
    }

    const totalPage = Math.ceil(totalRows / limit);

    return successResponse(
      res,
      {
        totalRows,
        totalPage,
        page,
        limit,
        questions: questionsWithOptions,
        answers,
      },
      "Berhasil mendapatkan data",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};

export const createIntervention = async (req, res) => {
  let connection;
  let committed = false;
  try {
    const user = req.user;
    if (user.role !== "healthcare") {
      throw new Error("User not have access to this resource");
    }
    const { id } = req.params;
    if (!id) {
      throw new Error("RecommendationId is required in params");
    }
    const { content, forType, notes } = req.body;

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const oppositeForType = forType === "PARENT" ? "SCHOOL" : "PARENT";
    const serializedOptions = JSON.stringify(content);
    const now = new Date();

    const [insertResult] = await connection.query(
      `INSERT INTO interventions
        (id, recommendationId, forType, options, notes, createdAt, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), id, forType, serializedOptions, notes, now, user.id,
        randomUUID(), id, oppositeForType, serializedOptions, notes, now, user.id,
      ],
    );

    await connection.query(
      "UPDATE recommendations SET status = ? WHERE id = ?",
      ["COMPLETED", id],
    );

    await connection.commit();
    committed = true;

    const intervention = { count: insertResult.affectedRows };

    // Notifikasi ke parent (plain, non-transactional lookups after commit).
    // The intervention itself already committed successfully at this point,
    // so a failure here must not roll back (there's nothing left to roll
    // back) or surface as an error response - it's logged and swallowed.
    try {
      const [recRows] = await pool.query(
        `SELECT r.id, fm.id AS fm_id, fm.fullName AS fm_fullName, u.id AS parent_user_id
         FROM recommendations r
         LEFT JOIN students st ON st.id = r.studentId
         LEFT JOIN family_members fm ON fm.id = st.familyMemberId
         LEFT JOIN families f ON f.id = fm.familyId
         LEFT JOIN users u ON u.id = f.userId
         WHERE r.id = ? LIMIT 1`,
        [id],
      );
      const recWithParent = recRows[0];

      if (recWithParent?.parent_user_id) {
        const [puskesmasRows] = await pool.query(
          `SELECT i.name AS institution_name
           FROM users u
           LEFT JOIN institutions i ON i.user_id = u.id
           WHERE u.id = ? LIMIT 1`,
          [user.id],
        );
        const rawName = puskesmasRows[0]?.institution_name || "";
        const puskesmasName = rawName
          ? rawName.toLowerCase().includes("puskesmas")
            ? rawName
            : `Puskesmas ${rawName}`
          : "Puskesmas";

        await createNotification(
          recWithParent.parent_user_id,
          "Tindak Lanjut Rekomendasi",
          `${puskesmasName} telah mengirimkan surat tindak lanjut untuk ${recWithParent.fm_fullName}. Silakan periksa halaman rekomendasi.`,
          "intervention_created",
          id,
        );
      }
    } catch (notifyErr) {
      console.log("Failed to send intervention notification:", notifyErr.message);
    }

    res.status(201).json({
      status: "Success",
      message: "Intervention created",
      data: intervention,
    });
  } catch (err) {
    if (connection && !committed) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.log("Rollback failed:", rollbackErr.message);
      }
    }
    console.log(err.message);
    return errorResponse(res, err, "Failed to get response");
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

export const getSingleRecommendation = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT
        r.id, r.studentId, r.submittedById, r.healthcareInstitutionId, r.status, r.pdfUrl, r.createdAt, r.updatedAt,
        si.name AS si_name,
        st.id AS student_id, st.nis AS student_nis, st.schoolYear AS student_schoolYear, st.semester AS student_semester, st.classId AS student_classId,
        cl.id AS class_id, cl.name AS class_name,
        fm.id AS fm_id, fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate, fm.gender AS fm_gender, fm.relation AS fm_relation, fm.familyId AS fm_familyId,
        f.id AS family_id,
        u.id AS user_id,
        uf.id AS user_family_id
      FROM recommendations r
      LEFT JOIN users su ON su.id = r.submittedById
      LEFT JOIN institutions si ON si.user_id = su.id
      LEFT JOIN students st ON st.id = r.studentId
      LEFT JOIN classes cl ON cl.id = st.classId
      LEFT JOIN family_members fm ON fm.id = st.familyMemberId
      LEFT JOIN families f ON f.id = fm.familyId
      LEFT JOIN users u ON u.id = f.userId
      LEFT JOIN families uf ON uf.userId = u.id
      WHERE r.id = ?
      LIMIT 1`,
      [id],
    );
    const row = rows[0];

    let recommendation = null;
    if (row) {
      const [interventionRows] = await pool.query(
        "SELECT * FROM interventions WHERE recommendationId = ?",
        [id],
      );

      let siblings = [];
      if (row.user_family_id) {
        const [siblingRows] = await pool.query(
          "SELECT id, fullName, birthDate, gender, relation FROM family_members WHERE familyId = ?",
          [row.user_family_id],
        );
        siblings = siblingRows;
      }

      recommendation = {
        id: row.id,
        studentId: row.studentId,
        submittedById: row.submittedById,
        healthcareInstitutionId: row.healthcareInstitutionId,
        status: row.status,
        pdfUrl: row.pdfUrl,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        submittedBy: { institution: row.si_name != null ? { name: row.si_name } : null },
        Intervention: interventionRows,
        student: row.student_id
          ? {
              id: row.student_id,
              nis: row.student_nis,
              schoolYear: row.student_schoolYear,
              semester: row.student_semester,
              classId: row.student_classId,
              class: row.class_id ? { id: row.class_id, name: row.class_name } : null,
              familyMember: row.fm_id
                ? {
                    id: row.fm_id,
                    fullName: row.fm_fullName,
                    birthDate: row.fm_birthDate,
                    gender: row.fm_gender,
                    relation: row.fm_relation,
                    familyId: row.fm_familyId,
                    family: row.family_id
                      ? {
                          id: row.family_id,
                          user: row.user_id
                            ? {
                                id: row.user_id,
                                family: row.user_family_id
                                  ? { id: row.user_family_id, familyMember: siblings }
                                  : null,
                              }
                            : null,
                        }
                      : null,
                  }
                : null,
            }
          : null,
      };
    }

    res.status(200).json({
      status: "Success",
      message: "Recommendation fetched",
      data: recommendation,
    });
  } catch (err) {
    console.log({ err });
    return errorResponse(res, err, "Failed to get response");
  }
};

export const getInterventionsBelongToInstitution = async (req, res) => {
  try {
    const user = req.user;
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const keyword = req.query.keyword ?? "";
    const skip = limit * page;

    const [userRows] = await pool.query(
      `SELECT u.id AS user_id, i.id AS institution_id
       FROM users u
       LEFT JOIN institutions i ON i.user_id = u.id
       WHERE u.id = ? LIMIT 1`,
      [user.id],
    );
    const userInstitution = userRows[0];
    if (!userInstitution) {
      throw new Error("user not found");
    }
    // NOTE: if the user exists but has no institution, userInstitution.institution_id
    // is null and the WHERE below naturally matches nothing (Prisma's equivalent threw
    // a TypeError here instead — a separate pre-existing bug not covered by this task).

    const keywordParams = keyword !== "" ? [`%${keyword}%`] : [];
    const keywordSql = keyword !== "" ? "AND fm.fullName LIKE ?" : "";

    const [rows] = await pool.query(
      `SELECT
        iv.id AS iv_id, iv.forType AS iv_forType, iv.notes AS iv_notes, iv.options AS iv_options, iv.createdAt AS iv_createdAt,
        r.id AS r_id, r.status AS r_status, r.createdAt AS r_createdAt,
        st.nis AS st_nis,
        cl.id AS cl_id, cl.name AS cl_name,
        fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate, fm.gender AS fm_gender,
        se.address AS se_address,
        of2.id AS of2_id,
        subu_i.id AS subu_i_id, subu_i.name AS subu_i_name,
        vi.name AS vi_name, vi.address AS vi_address, vi.phone AS vi_phone, vi.email AS vi_email,
        vu.username AS vu_username
      FROM interventions iv
      JOIN users vu ON vu.id = iv.user_id
      JOIN institutions vi ON vi.user_id = vu.id
      LEFT JOIN recommendations r ON r.id = iv.recommendationId
      LEFT JOIN students st ON st.id = r.studentId
      LEFT JOIN classes cl ON cl.id = st.classId
      LEFT JOIN family_members fm ON fm.id = st.familyMemberId
      LEFT JOIN socio_economic se ON se.id = fm.socioEconomicId
      LEFT JOIN families f ON f.id = fm.familyId
      LEFT JOIN users ofu ON ofu.id = f.userId
      LEFT JOIN families of2 ON of2.userId = ofu.id
      LEFT JOIN users subu ON subu.id = r.submittedById
      LEFT JOIN institutions subu_i ON subu_i.user_id = subu.id
      WHERE vi.id = ? ${keywordSql}
        -- createIntervention bulk-inserts both forType rows with one shared \`now\`, so createdAt ties are the norm; iv.id (UUID PK) guarantees exactly one match.
        AND iv.id = (
          SELECT iv2.id FROM interventions iv2
          WHERE iv2.recommendationId = iv.recommendationId
          ORDER BY iv2.createdAt DESC, iv2.id DESC
          LIMIT 1
        )
      ORDER BY iv.createdAt DESC
      LIMIT 18446744073709551615 OFFSET ?`,
      [userInstitution.institution_id, ...keywordParams, skip],
    );

    const familyIds = [...new Set(rows.filter((r) => r.of2_id).map((r) => r.of2_id))];
    let siblingsByFamily = new Map();
    if (familyIds.length > 0) {
      const [siblingRows] = await pool.query(
        "SELECT familyId, id, fullName FROM family_members WHERE familyId IN (?)",
        [familyIds],
      );
      for (const s of siblingRows) {
        const list = siblingsByFamily.get(s.familyId) || [];
        list.push({ fullName: s.fullName });
        siblingsByFamily.set(s.familyId, list);
      }
    }

    const totalPages = Math.ceil(rows.length / limit);

    const interventions = rows.map((row) => ({
      recommendation: {
        student: {
          nis: row.st_nis,
          class: row.cl_id ? { name: row.cl_name } : null,
          familyMember: {
            fullName: row.fm_fullName,
            birthDate: row.fm_birthDate,
            gender: row.fm_gender,
            SocioEconomic: row.se_address !== null ? { address: row.se_address } : null,
            family: {
              user: {
                family: row.of2_id
                  ? { familyMember: siblingsByFamily.get(row.of2_id) || [] }
                  : null,
              },
            },
          },
        },
        id: row.r_id,
        status: row.r_status,
        createdAt: row.r_createdAt,
        submittedBy: { institution: row.subu_i_id ? { id: row.subu_i_id, name: row.subu_i_name } : null },
      },
      id: row.iv_id,
      forType: row.iv_forType,
      notes: row.iv_notes,
      options: JSON.parse(row.iv_options),
      createdAt: row.iv_createdAt,
      user: {
        institution: { name: row.vi_name, address: row.vi_address, phone: row.vi_phone, email: row.vi_email },
        username: row.vu_username,
      },
    }));

    res.status(200).json({
      status: "Success",
      message: "Interventions Belongs to Institution fetched",
      data: { totalPages, skip, page, limit, interventions },
    });
  } catch (err) {
    console.log({ err });
    return errorResponse(res, err, "Failed to get response");
  }
};

export const getInterventionsBelongToFamily = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      throw new Error("user not found");
    }
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const keyword = req.query.keyword ?? "";
    const skip = limit * page;

    const keywordParams = keyword !== "" ? [`%${keyword}%`] : [];
    const keywordSql = keyword !== "" ? "AND fm.fullName LIKE ?" : "";

    const [rows] = await pool.query(
      `SELECT
        iv.id AS iv_id, iv.forType AS iv_forType, iv.notes AS iv_notes, iv.options AS iv_options, iv.createdAt AS iv_createdAt,
        r.id AS r_id, r.status AS r_status, r.createdAt AS r_createdAt,
        st.nis AS st_nis,
        cl.id AS cl_id, cl.name AS cl_name,
        fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate, fm.gender AS fm_gender,
        se.address AS se_address,
        of2.id AS of2_id,
        subu_i.id AS subu_i_id, subu_i.name AS subu_i_name,
        vi.name AS vi_name, vi.address AS vi_address, vi.phone AS vi_phone, vi.email AS vi_email,
        vu.username AS vu_username
      FROM interventions iv
      JOIN users vu ON vu.id = iv.user_id
      LEFT JOIN institutions vi ON vi.user_id = vu.id
      LEFT JOIN recommendations r ON r.id = iv.recommendationId
      LEFT JOIN students st ON st.id = r.studentId
      LEFT JOIN classes cl ON cl.id = st.classId
      LEFT JOIN family_members fm ON fm.id = st.familyMemberId
      LEFT JOIN socio_economic se ON se.id = fm.socioEconomicId
      LEFT JOIN families f ON f.id = fm.familyId
      LEFT JOIN users ofu ON ofu.id = f.userId
      LEFT JOIN families of2 ON of2.userId = ofu.id
      LEFT JOIN users subu ON subu.id = r.submittedById
      LEFT JOIN institutions subu_i ON subu_i.user_id = subu.id
      WHERE f.userId = ? AND iv.forType = 'PARENT' ${keywordSql}
      ORDER BY r.updatedAt DESC
      LIMIT 18446744073709551615 OFFSET ?`,
      [user.id, ...keywordParams, skip],
    );

    const familyIds = [...new Set(rows.filter((r) => r.of2_id).map((r) => r.of2_id))];
    let siblingsByFamily = new Map();
    if (familyIds.length > 0) {
      const [siblingRows] = await pool.query(
        "SELECT familyId, id, fullName FROM family_members WHERE familyId IN (?)",
        [familyIds],
      );
      for (const s of siblingRows) {
        const list = siblingsByFamily.get(s.familyId) || [];
        list.push({ fullName: s.fullName });
        siblingsByFamily.set(s.familyId, list);
      }
    }

    const totalPages = rows.length;

    const interventions = rows.map((row) => ({
      recommendation: {
        student: {
          nis: row.st_nis,
          class: row.cl_id ? { name: row.cl_name } : null,
          familyMember: {
            fullName: row.fm_fullName,
            birthDate: row.fm_birthDate,
            gender: row.fm_gender,
            SocioEconomic: row.se_address !== null ? { address: row.se_address } : null,
            family: {
              user: {
                family: row.of2_id
                  ? { familyMember: siblingsByFamily.get(row.of2_id) || [] }
                  : null,
              },
            },
          },
        },
        id: row.r_id,
        status: row.r_status,
        createdAt: row.r_createdAt,
        submittedBy: { institution: row.subu_i_id ? { id: row.subu_i_id, name: row.subu_i_name } : null },
      },
      id: row.iv_id,
      forType: row.iv_forType,
      notes: row.iv_notes,
      options: JSON.parse(row.iv_options),
      createdAt: row.iv_createdAt,
      user: {
        institution: { name: row.vi_name, email: row.vi_email, address: row.vi_address, phone: row.vi_phone },
        username: row.vu_username,
      },
    }));

    res.status(200).json({
      status: "Success",
      message: "Intervention belongs to family fetched",
      data: { totalPages, skip, page, limit, interventions },
    });
  } catch (err) {
    console.log({ err });
    return errorResponse(res, err, "Failed to get response");
  }
};

export const getInterventionById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new Error("Id is required");
    }
    const [rows] = await pool.query(
      "SELECT * FROM interventions WHERE id = ? LIMIT 1",
      [id],
    );
    const intervention = rows[0];
    if (!intervention) {
      throw new Error(`Intervention with id ${id} is not found`);
    }
    res.status(200).json({
      status: "Success",
      message: "Intervention retrieved",
      data: {
        ...intervention,
        options: JSON.parse(intervention.options),
      },
    });
  } catch (err) {
    return errorResponse(res, err, "Failed to get response");
  }
};

export const deleteIntervention = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new Error("Id is required");
    }
    const [rows] = await pool.query(
      "SELECT * FROM interventions WHERE id = ? LIMIT 1",
      [id],
    );
    const intervention = rows[0];
    if (!intervention) {
      throw new Error(`Intervention with id ${id} is not found`);
    }
    await pool.query("DELETE FROM interventions WHERE id = ?", [id]);
    res.status(200).json({
      status: "Success",
      message: "Intervention deleted",
      data: intervention,
    });
  } catch (err) {
    return errorResponse(res, err, "Failed to get response");
  }
};
