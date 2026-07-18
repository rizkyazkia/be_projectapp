import { PrismaClient } from "@prisma/client";
import pool from "../config/db.js";
import { randomUUID } from "node:crypto";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";
import { createNotification } from "./NotificationController.js";

const prisma = new PrismaClient();

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
    const intervention = await prisma.$transaction(async (trx) => {
      const intervention = await trx.intervention.createMany({
        data: [
          {
            forType,
            notes,
            options: content,
            recommendationId: id,
            user_id: user.id,
          },
          {
            forType: forType === "PARENT" ? "SCHOOL" : "PARENT",
            notes,
            options: content,
            recommendationId: id,
            user_id: user.id,
          },
        ],
      });
      await trx.recommendation.update({
        where: {
          id,
        },
        data: {
          status: "COMPLETED",
        },
      });

      return intervention;
    });

    // Notifikasi ke parent
    const recWithParent = await prisma.recommendation.findUnique({
      where: { id },
      include: {
        student: {
          include: {
            familyMember: {
              include: {
                family: { include: { user: true } },
              },
            },
          },
        },
      },
    });

    const parentUser = recWithParent?.student?.familyMember?.family?.user;
    if (parentUser) {
      const puskesmasUser = await prisma.user.findUnique({
        where: { id: user.id },
        include: { institution: { select: { name: true } } },
      });
      const rawName = puskesmasUser?.institution?.name || "";
      const puskesmasName = rawName
        ? rawName.toLowerCase().includes("puskesmas")
          ? rawName
          : `Puskesmas ${rawName}`
        : "Puskesmas";

      await createNotification(
        parentUser.id,
        "Tindak Lanjut Rekomendasi",
        `${puskesmasName} telah mengirimkan surat tindak lanjut untuk ${recWithParent.student.familyMember.fullName}. Silakan periksa halaman rekomendasi.`,
        "intervention_created",
        id,
      );
    }

    res.status(201).json({
      status: "Success",
      message: "Intervention created",
      data: intervention,
    });
  } catch (err) {
    console.log(err.message);
    return errorResponse(res, err, "Failed to get response");
  }
};

export const getSingleRecommendation = async (req, res) => {
  try {
    const { id } = req.params;
    const recommendation = await prisma.recommendation.findUnique({
      where: {
        id,
      },
      include: {
        submittedBy: {
          select: {
            institution: {
              select: {
                name: true,
              },
            },
          },
        },
        Intervention: true,
        student: {
          include: {
            class: true,
            familyMember: {
              include: {
                family: {
                  include: {
                    user: {
                      include: { family: { include: { familyMember: true } } },
                    },
                  },
                },
                residence: true,
              },
            },
          },
        },
      },
    });

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
    const userInstitution = await prisma.user.findUnique({
      where: {
        id: user.id,
      },
      select: {
        institution: {
          select: {
            id: true,
          },
        },
      },
    });
    if (!userInstitution) {
      throw new Error("user not found");
    }
    const interventions = await prisma.intervention.findMany({
      where: {
        user: {
          institution: {
            id: userInstitution.institution.id,
          },
        },
        ...(keyword !== "" && {
          recommendation: {
            student: {
              familyMember: {
                fullName: {
                  contains: keyword,
                },
              },
            },
          },
        }),
      },
      distinct: ["recommendationId"],
      select: {
        recommendation: {
          select: {
            student: {
              select: {
                nis: true,
                class: {
                  select: {
                    name: true,
                  },
                },
                familyMember: {
                  select: {
                    fullName: true,
                    birthDate: true,
                    gender: true,
                    SocioEconomic: {
                      select: {
                        address: true,
                      },
                    },
                    family: {
                      select: {
                        user: {
                          select: {
                            family: {
                              select: {
                                familyMember: {
                                  select: {
                                    fullName: true,
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            id: true,
            status: true,
            createdAt: true,
            submittedBy: {
              select: {
                institution: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        id: true,
        forType: true,
        notes: true,
        options: true,
        createdAt: true,
        user: {
          select: {
            institution: {
              select: {
                name: true,
                address: true,
                phone: true,
                email: true,
              },
            },
            username: true,
          },
        },
      },
      skip,
      orderBy: {
        createdAt: "desc",
      },
    });
    const totalPages = Math.ceil(interventions.length / limit);

    res.status(200).json({
      status: "Success",
      message: "Interventions Belongs to Institution fetched",
      data: {
        totalPages,
        skip,
        page,
        limit,
        interventions: interventions.map((val) => ({
          ...val,
          options: JSON.parse(val.options),
        })),
      },
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
    const interventions = await prisma.intervention.findMany({
      where: {
        recommendation: {
          student: {
            familyMember: {
              family: {
                userId: user.id,
              },
            },
          },
        },
        ...(keyword !== "" && {
          recommendation: {
            student: {
              familyMember: {
                fullName: {
                  contains: keyword,
                },
              },
            },
          },
        }),
        forType: "PARENT",
      },
      select: {
        recommendation: {
          select: {
            student: {
              select: {
                nis: true,
                class: {
                  select: {
                    name: true,
                  },
                },
                familyMember: {
                  select: {
                    fullName: true,
                    birthDate: true,
                    gender: true,
                    SocioEconomic: {
                      select: {
                        address: true,
                      },
                    },
                    family: {
                      select: {
                        user: {
                          select: {
                            family: {
                              select: {
                                familyMember: {
                                  select: {
                                    fullName: true,
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            id: true,
            status: true,
            createdAt: true,
            submittedBy: {
              select: {
                institution: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        id: true,
        forType: true,
        notes: true,
        options: true,
        createdAt: true,
        user: {
          select: {
            institution: {
              select: {
                name: true,
                email: true,
                address: true,
                phone: true,
              },
            },
            username: true,
          },
        },
      },
      skip,
      orderBy: {
        recommendation: {
          updatedAt: "desc",
        },
      },
    });
    const totalPages = interventions.length;

    res.status(200).json({
      status: "Success",
      message: "Intervention belongs to family fetched",
      data: {
        totalPages,
        skip,
        page,
        limit,
        interventions: interventions.map((val) => ({
          ...val,
          options: JSON.parse(val.options),
        })),
      },
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
    const intervention = await prisma.intervention.findUnique({
      where: {
        id,
      },
    });
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
    const intervention = await prisma.intervention.findUnique({
      where: {
        id,
      },
    });
    if (!intervention) {
      throw new Error(`Intervention with id ${id} is not found`);
    }
    await prisma.intervention.delete({
      where: {
        id,
      },
    });
    res.status(200).json({
      status: "Success",
      message: "Intervention deleted",
      data: intervention,
    });
  } catch (err) {
    return errorResponse(res, err, "Failed to get response");
  }
};
