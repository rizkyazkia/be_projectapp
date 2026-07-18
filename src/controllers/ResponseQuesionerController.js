import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();

export const getResponseQuesioner = async (req, res) => {
  try {
    const user = req.user;
    const id = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [families] = await pool.query(
      "SELECT * FROM families WHERE userId = ? LIMIT 1",
      [user.id]
    );
    const family = families[0];

    if (!family) {
      return errorResponse(res, 404, "Family not found");
    }

    const [familyMembers] = await pool.query(
      "SELECT * FROM family_members WHERE familyId = ? AND (relation = ? OR relation = ?) LIMIT 1",
      [family.id, "IBU", "AYAH"]
    );
    const familyMember = familyMembers[0];

    if (!familyMember) {
      return errorResponse(res, 404, "Family member not found");
    }

    const [responses] = await pool.query(
      "SELECT * FROM responses WHERE familyMemberId = ? AND quisionerId = ? LIMIT 1",
      [familyMember.id, id]
    );
    const response = responses[0];

    if (!response) {
      return res.json({
        totalRows: 0,
        totalPage: 0,
        page: 0,
        limit: 10,
        questions: [],
        answers: [],
      });
    }

    const [totalRowsResult] = await pool.query(
      "SELECT COUNT(*) AS count FROM questions WHERE quesioner_id = ? AND title LIKE ?",
      [id, `%${search}%`]
    );
    const totalRows = totalRowsResult[0].count;

    const totalPage = Math.ceil(totalRows / limit);

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ? LIMIT ? OFFSET ?",
      [id, `%${search}%`, limit, offset]
    );

    const questionIds = questionRows.map((q) => q.id);

    let optionRows = [];
    if (questionIds.length > 0) {
      const [rows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds]
      );
      optionRows = rows;
    }

    const questions = questionRows.map((q) => ({
      ...q,
      options: optionRows
        .filter((o) => o.question_id === q.id)
        .map((o) => ({ id: o.id, title: o.title, score: o.score })),
    }));

    let answerRows = [];
    if (questionIds.length > 0) {
      const [rows] = await pool.query(
        "SELECT * FROM answers WHERE responseId = ? AND questionId IN (?) ORDER BY id ASC",
        [response.id, questionIds]
      );
      answerRows = rows;
    }

    const answers = answerRows.map((a) => ({
      ...a,
      boolean_value: a.boolean_value === null ? null : !!a.boolean_value,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions, answers },
      "Berhasil mendapatkan data"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};

export const createResponseQuesioner = async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return errorResponse(res, 401, "Unauthorized");
    }

    const { id } = req.params;

    const answers = req.body.answers;
    if (!Array.isArray(answers)) {
      return errorResponse(res, 400, "Data must be an array in 'answers'");
    }

    const [families] = await pool.query(
      "SELECT * FROM families WHERE userId = ? LIMIT 1",
      [user.id]
    );
    const family = families[0];

    if (!family) {
      return errorResponse(res, 404, "Family not found");
    }

    const [familyMembers] = await pool.query(
      "SELECT * FROM family_members WHERE familyId = ? AND (relation = ? OR relation = ?) LIMIT 1",
      [family.id, "IBU", "AYAH"]
    );
    const familyMember = familyMembers[0];

    if (!familyMember) {
      return errorResponse(res, 404, "Family member not found");
    }

    const responseId = randomUUID();

    await pool.query(
      "INSERT INTO responses (id, quisionerId, created_at, totalScore, familyMemberId, institutionId) VALUES (?, ?, NOW(3), ?, ?, ?)",
      [responseId, Number(id), 0, familyMember.id, null]
    );

    const sanitizedData = answers.map((item) => ({
      questionId: Number(item.questionId),
      responseId,
      option_id: Number(item.option_id),
      score: Number(item.score),
      boolean_value: item.boolean_value ? Boolean(item.boolean_value) : null,
      scaleValue: item.scaleValue ? Number(item.scaleValue) : null,
    }));

    for (const item of sanitizedData) {
      if (
        typeof item.questionId !== "number" ||
        typeof item.responseId !== "string" ||
        typeof item.score !== "number"
      ) {
        return errorResponse(res, 400, "Invalid data format");
      }
      // Field optional: hanya validasi jika ada
      if (
        item.boolean_value !== undefined &&
        item.boolean_value !== null &&
        typeof item.boolean_value !== "boolean"
      ) {
        return errorResponse(res, 400, "Invalid boolean value format");
      }
      if (
        item.scaleValue !== undefined &&
        item.scaleValue !== null &&
        typeof item.scaleValue !== "number"
      ) {
        return errorResponse(res, 400, "Invalid scale value format");
      }
    }

    let insertResult = { affectedRows: 0 };
    if (sanitizedData.length > 0) {
      const values = sanitizedData.map((item) => [
        item.questionId,
        item.responseId,
        item.option_id,
        item.score,
        item.boolean_value,
        item.scaleValue,
      ]);
      const [result] = await pool.query(
        "INSERT INTO answers (questionId, responseId, option_id, score, boolean_value, scaleValue) VALUES ?",
        [values]
      );
      insertResult = result;
    }

    const HitungScore = sanitizedData.reduce(
      (sum, item) => sum + (item.score || 0),
      0
    );

    await pool.query("UPDATE responses SET totalScore = ? WHERE id = ?", [
      HitungScore,
      responseId,
    ]);

    return successResponse(
      res,
      { count: insertResult.affectedRows },
      "Berhasil menjawab kuisioner"
    );
  } catch (error) {
    return errorResponse(
      res,
      error,
      "Gagal menjawab kuisioner, silahkan diulang"
    );
  }
};

export const checkAnsweredQuesioner = async (req, res) => {
  try {
    const user = req.user;
    const id = Number(req.params.id);

    const [families] = await pool.query(
      "SELECT * FROM families WHERE userId = ? LIMIT 1",
      [user.id]
    );
    const family = families[0];

    if (!family) return errorResponse(res, 404, "Family not found");

    const [familyMembers] = await pool.query(
      "SELECT * FROM family_members WHERE familyId = ? AND (relation = ? OR relation = ?) LIMIT 1",
      [family.id, "IBU", "AYAH"]
    );
    const familyMember = familyMembers[0];

    if (!familyMember)
      return errorResponse(res, 404, "Family member not found");

    const [responses] = await pool.query(
      "SELECT * FROM responses WHERE familyMemberId = ? AND quisionerId = ? LIMIT 1",
      [familyMember.id, id]
    );
    const response = responses[0];

    if (!response) {
      return res.json({
        answers: [],
        questions: [],
        page: 0,
        totalPage: 0,
        totalRows: 0,
      });
    }

    const [totalQuestionsResult] = await pool.query(
      "SELECT COUNT(*) AS count FROM questions WHERE quesioner_id = ?",
      [id]
    );
    const totalQuestions = totalQuestionsResult[0].count;

    const [totalAnswersResult] = await pool.query(
      "SELECT COUNT(*) AS count FROM answers WHERE responseId = ?",
      [response.id]
    );
    const totalAnswers = totalAnswersResult[0].count;

    return res.json({ answered: totalAnswers === totalQuestions });
  } catch (error) {
    return errorResponse(res, error, "Failed to check answered status");
  }
};

export const updateResponseQuesioner = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { option_id, boolean_value, scaleValue, score } =
      req.body;

    const updateResponse = await prisma.answer.update({
      where: {
        id,
      },
      data: {
        option_id: Number(option_id),
        boolean_value:
          boolean_value === undefined || boolean_value === null
            ? null
            : Boolean(boolean_value),
        scaleValue: Number(scaleValue),
        score: Number(score),
      },
    });

    const answer = await prisma.answer.findFirst({
      where: { id },
    });

    const totalScore = await prisma.answer.aggregate({
      where: {
        responseId: answer.responseId,
      },
      _sum: { score: true },
    });

    await prisma.response.update({
      where: { id: answer.responseId },
      data: { totalScore: totalScore._sum.score || 0 },
    });

    return successResponse(res, updateResponse, "Berhasil mengupdate jawaban");
  } catch (error) {
    return errorResponse(res, error, "Failed to update response");
  }
};

export const getResponseQuesionerInstitution = async (req, res) => {
  try {
    const user = req.user;
    const quesionerId = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const institution = await prisma.institution.findFirst({
      where: {
        user_id: user.id,
      },
    });

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    const response = await prisma.response.findFirst({
      where: {
        institutionId: institution.id,
        quisionerId: quesionerId,
      },
    });

    if (!response) {
      return res.json({
        totalRows: 0,
        totalPage: 0,
        page: 0,
        limit: 10,
        questions: [],
        answers: [],
      });
    }

    const questions = await prisma.question.findMany({
      where: {
        quesioner_id: quesionerId,
        title: {
          contains: search,
        },
      },
      select: {
        id: true,
        quesioner_id: true,
        title: true,
        type: true,
        options: {
          select: {
            id: true,
            title: true,
            score: true,
          },
        },
      },
    });

    const questionIds = questions.map((q) => q.id);

    const totalRows = await prisma.answer.count({
      where: {
        responseId: response.id,
        questionId: {
          in: questionIds,
        },
      },
    });

    const totalPage = Math.ceil(totalRows / limit);

    const answers = await prisma.answer.findMany({
      where: {
        responseId: response.id,
        questionId: {
          in: questionIds,
        },
      },
      skip: offset,
      take: limit,
      orderBy: {
        id: "asc",
      },
    });

    return successResponse(
      res,
      {
        totalRows,
        totalPage,
        page,
        limit,
        questions,
        answers,
      },
      "Berhasil mendapatkan data"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};

export const createResponseQuesionerInstitution = async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return errorResponse(res, 401, "Unauthorized");
    }

    const { id } = req.params;
    const answers = req.body.answers;
    if (!Array.isArray(answers)) {
      return errorResponse(res, 400, "Data must be an array in 'answers'");
    }

    // Cari institution milik user
    const institution = await prisma.institution.findFirst({
      where: { user_id: user.id },
    });

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    // Buat response baru untuk institution
    const responseRecord = await prisma.response.create({
      data: {
        quisionerId: Number(id),
        totalScore: 0,
        familyMemberId: null,
        institutionId: institution.id,
      },
    });

    const sanitizedData = answers.map((item) => ({
      questionId: Number(item.questionId),
      responseId: responseRecord.id,
      option_id: item.option_id !== undefined ? Number(item.option_id) : null,
      score: Number(item.score),
      boolean_value:
        item.boolean_value !== undefined ? Boolean(item.boolean_value) : null,
      scaleValue:
        item.scaleValue !== undefined ? Number(item.scaleValue) : null,
    }));

    for (const item of sanitizedData) {
      if (
        typeof item.questionId !== "number" ||
        typeof item.responseId !== "string" ||
        typeof item.score !== "number"
      ) {
        return errorResponse(res, 400, "Invalid data format");
      }
      if (
        item.boolean_value !== undefined &&
        item.boolean_value !== null &&
        typeof item.boolean_value !== "boolean"
      ) {
        return errorResponse(res, 400, "Invalid boolean value format");
      }
      if (
        item.scaleValue !== undefined &&
        item.scaleValue !== null &&
        typeof item.scaleValue !== "number"
      ) {
        return errorResponse(res, 400, "Invalid scale value format");
      }
    }

    const response = await prisma.answer.createMany({
      data: sanitizedData,
    });

    const HitungScore = sanitizedData.reduce(
      (sum, item) => sum + (item.score || 0),
      0
    );

    await prisma.response.update({
      where: {
        id: responseRecord.id,
      },
      data: {
        totalScore: HitungScore,
      },
    });

    return successResponse(res, response, "Berhasil menjawab kuisioner");
  } catch (error) {
    return errorResponse(
      res,
      error,
      "Gagal menjawab kuisioner, silahkan diulang"
    );
  }
};

export const checkAnsweredQuesionerInstitution = async (req, res) => {
  try {
    const user = req.user;
    const quesionerId = Number(req.params.id);

    // Cari institution milik user
    const institution = await prisma.institution.findFirst({
      where: { user_id: user.id },
    });

    if (!institution) return errorResponse(res, 404, "Institution not found");

    // Cari response untuk institution & quesioner
    const response = await prisma.response.findFirst({
      where: {
        institutionId: institution.id,
        quisionerId: quesionerId,
      },
    });

    // Jika belum pernah menjawab, return answered: false
    if (!response) return res.json({ answered: false });

    // Hitung total pertanyaan pada quesioner
    const totalQuestions = await prisma.question.count({
      where: { quesioner_id: quesionerId },
    });

    // Hitung total jawaban pada response
    const totalAnswers = await prisma.answer.count({
      where: { responseId: response.id },
    });

    return res.json({ answered: totalAnswers === totalQuestions });
  } catch (error) {
    return errorResponse(res, error, "Failed to check answered status");
  }
};

export const showResponseForParent = async (req, res) => {
  try {
    const userId = req.params.userId;
    const id = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const familyMember = await prisma.familyMember.findFirst({
      where: {
        familyId: userId,
        OR: [
          {
            relation: "IBU",
          },
          {
            relation: "AYAH",
          },
        ],
      },
    });

    if (!familyMember) {
      return errorResponse(res, 404, "Family member not found");
    }

    const response = await prisma.response.findFirst({
      where: {
        familyMemberId: familyMember.id,
        quisionerId: id,
      },
      include: {
        answers: true,
      },
    });

    if (!response) {
      return res.json({
        totalRows: 0,
        totalPage: 0,
        page: 0,
        limit: 10,
        questions: [],
        answers: [],
      });
    }

    const questions = await prisma.question.findMany({
      where: {
        quesioner_id: id,
        title: {
          contains: search,
        },
      },
      select: {
        id: true,
        quesioner_id: true,
        title: true,
        type: true,
        options: {
          select: {
            id: true,
            title: true,
            score: true,
          },
        },
      },
    });

    const questionIds = questions.map((q) => q.id);

    const totalRows = await prisma.answer.count({
      where: {
        responseId: response.id,
        questionId: {
          in: questionIds,
        },
      },
    });

    const totalPage = Math.ceil(totalRows / limit);
    const answers = await prisma.answer.findMany({
      where: {
        responseId: response.id,
        questionId: {
          in: questionIds,
        },
      },
      skip: offset,
      take: limit,
      orderBy: {
        id: "asc",
      },
    });

    return successResponse(
      res,
      {
        totalRows,
        totalPage,
        page,
        limit,
        questions,
        answers,
      },
      "Berhasil mendapatkan data"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};

export const showResponseForInstitution = async (req, res) => {
  try {
    const user_id = Number(req.params.user_id);
    const quesionerId = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const institution = await prisma.institution.findFirst({
      where: {
        id: user_id,
      },
    });

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    const response = await prisma.response.findFirst({
      where: {
        institutionId: institution.id,
        quisionerId: quesionerId,
      },
    });

    if (!response) {
      return res.json({
        totalRows: 0,
        totalPage: 0,
        page: 0,
        limit: 10,
        questions: [],
        answers: [],
      });
    }

    const questions = await prisma.question.findMany({
      where: {
        quesioner_id: quesionerId,
        title: {
          contains: search,
        },
      },
      select: {
        id: true,
        quesioner_id: true,
        title: true,
        type: true,
        options: {
          select: {
            id: true,
            title: true,
            score: true,
          },
        },
      },
    });

    const questionIds = questions.map((q) => q.id);

    const totalRows = await prisma.answer.count({
      where: {
        responseId: response.id,
        questionId: {
          in: questionIds,
        },
      },
    });

    const totalPage = Math.ceil(totalRows / limit);

    const answers = await prisma.answer.findMany({
      where: {
        responseId: response.id,
        questionId: {
          in: questionIds,
        },
      },
      skip: offset,
      take: limit,
      orderBy: {
        id: "asc",
      },
    });

    return successResponse(
      res,
      {
        totalRows,
        totalPage,
        page,
        limit,
        questions,
        answers,
      },
      "Berhasil mendapatkan data"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};
