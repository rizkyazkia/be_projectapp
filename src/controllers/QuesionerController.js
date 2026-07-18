import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

async function attachOptions(questions) {
  if (questions.length === 0) return questions;

  const questionIds = questions.map((q) => q.id);
  const [optionRows] = await pool.query(
    "SELECT id, question_id, title, score FROM options WHERE question_id IN (?) ORDER BY id ASC",
    [questionIds]
  );

  const optionsByQuestionId = new Map();
  for (const opt of optionRows) {
    if (!optionsByQuestionId.has(opt.question_id)) {
      optionsByQuestionId.set(opt.question_id, []);
    }
    optionsByQuestionId.get(opt.question_id).push(opt);
  }

  return questions.map((q) => ({
    ...q,
    options: optionsByQuestionId.get(q.id) || [],
  }));
}

export const getQuesioners = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, title, description FROM quesioners"
    );
    return successResponse(res, rows, "Quesioner retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve quesioners");
  }
};

export const getQuestion = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM questions WHERE title LIKE ?",
      [`%${search}%`]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type, is_required FROM questions WHERE title LIKE ? ORDER BY id ASC LIMIT ? OFFSET ?",
      [`%${search}%`, limit, offset]
    );

    const withBooleans = questionRows.map((q) => ({
      ...q,
      is_required: !!q.is_required,
    }));
    const questions = await attachOptions(withBooleans);

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions },
      "Question retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve question");
  }
};

export const getQuestionByQuesionerId = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;
  const quesionerId = Number.parseInt(req.params.id);

  try {
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM questions WHERE quesioner_id = ? AND title LIKE ?",
      [quesionerId, `%${search}%`]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type, is_required FROM questions WHERE quesioner_id = ? AND title LIKE ? ORDER BY id ASC LIMIT ? OFFSET ?",
      [quesionerId, `%${search}%`, limit, offset]
    );

    const withBooleans = questionRows.map((q) => ({
      ...q,
      is_required: !!q.is_required,
    }));
    const questions = await attachOptions(withBooleans);

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions },
      `Question ${req.params.id} retrieved successfully`
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve question");
  }
};

export const getAllQuestionByQuesionerId = async (req, res) => {
  const quesionerId = Number.parseInt(req.params.id);

  try {
    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type, is_required FROM questions WHERE quesioner_id = ? ORDER BY id ASC",
      [quesionerId]
    );

    const withBooleans = questionRows.map((q) => ({
      ...q,
      is_required: !!q.is_required,
    }));
    const questions = await attachOptions(withBooleans);

    return successResponse(
      res,
      questions,
      `Question ${req.params.id} retrieved successfully`
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve question");
  }
};

export const updateQuestion = async (req, res) => {
  const { id } = req.params;
  const { title, type, options } = req.body;
  const questionId = Number.parseInt(id);

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.query(
      "UPDATE questions SET title = ?, type = ? WHERE id = ?",
      [title, type, questionId]
    );

    await connection.query("DELETE FROM options WHERE question_id = ?", [
      questionId,
    ]);

    if (Array.isArray(options) && options.length > 0) {
      const values = options.map((o) => [questionId, o.title, o.score ?? 0]);
      await connection.query(
        "INSERT INTO options (question_id, title, score) VALUES ?",
        [values]
      );
    }

    const [[questionRow]] = await connection.query(
      "SELECT id, quesioner_id, title, type, is_required FROM questions WHERE id = ?",
      [questionId]
    );
    const [optionRows] = await connection.query(
      "SELECT id, question_id, title, score FROM options WHERE question_id = ? ORDER BY id ASC",
      [questionId]
    );

    await connection.commit();

    const question = {
      ...questionRow,
      is_required: !!questionRow.is_required,
      options: optionRows,
    };

    return successResponse(res, question, "Question updated successfully");
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    return errorResponse(res, error, "Failed to update question");
  } finally {
    if (connection) {
      connection.release();
    }
  }
};
