import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getQuesioners,
  getQuestion,
  getQuestionByQuesionerId,
  getAllQuestionByQuesionerId,
  updateQuestion,
} from "../QuesionerController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getQuesioners", () => {
  it("returns all quesioners", async () => {
    pool.query.mockResolvedValueOnce([
      [{ id: 1, title: "Quiz 1", description: "desc" }],
      [],
    ]);
    const req = {};
    const res = mockRes();

    await getQuesioners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id, title, description FROM quesioners")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        data: [{ id: 1, title: "Quiz 1", description: "desc" }],
      })
    );
  });

  it("returns an error response when the query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db exploded"));
    const req = {};
    const res = mockRes();

    await getQuesioners(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to retrieve quesioners",
      })
    );
  });
});

describe("getQuestion", () => {
  it("returns paginated questions with grouped options", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [{ id: 1, quesioner_id: 1, title: "Q1", type: "SCALE", is_required: 1 }],
        [],
      ])
      .mockResolvedValueOnce([
        [
          { id: 10, question_id: 1, title: "Opt A", score: 1 },
          { id: 11, question_id: 1, title: "Opt B", score: 0 },
        ],
        [],
      ]);
    const req = { query: {} };
    const res = mockRes();

    await getQuestion(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS total FROM questions WHERE title LIKE ?"),
      ["%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM questions WHERE title LIKE ?"),
      ["%%", 10, 0]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("FROM options WHERE question_id IN (?)"),
      [[1]]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        data: expect.objectContaining({
          totalRows: 1,
          totalPage: 1,
          page: 0,
          limit: 10,
          questions: [
            {
              id: 1,
              quesioner_id: 1,
              title: "Q1",
              type: "SCALE",
              is_required: true,
              options: [
                { id: 10, question_id: 1, title: "Opt A", score: 1 },
                { id: 11, question_id: 1, title: "Opt B", score: 0 },
              ],
            },
          ],
        }),
      })
    );
  });

  it("skips the options query when no questions match", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []]);
    const req = { query: { search: "nomatch" } };
    const res = mockRes();

    await getQuestion(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ questions: [] }),
      })
    );
  });

  it("returns an error response when the count query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db exploded"));
    const req = { query: {} };
    const res = mockRes();

    await getQuestion(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to retrieve question",
      })
    );
  });
});

describe("getQuestionByQuesionerId", () => {
  it("filters by quesioner id and uses the raw param in the success message", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [{ id: 2, quesioner_id: 5, title: "Q2", type: "BOOLEAN", is_required: 0 }],
        [],
      ])
      .mockResolvedValueOnce([[{ id: 20, question_id: 2, title: "Yes", score: 1 }], []]);
    const req = { params: { id: "5" }, query: {} };
    const res = mockRes();

    await getQuestionByQuesionerId(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE quesioner_id = ? AND title LIKE ?"),
      [5, "%%"]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Question 5 retrieved successfully" })
    );
  });

  it("returns an error response when the query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db exploded"));
    const req = { params: { id: "5" }, query: {} };
    const res = mockRes();

    await getQuestionByQuesionerId(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to retrieve question",
      })
    );
  });
});

describe("getAllQuestionByQuesionerId", () => {
  it("returns a bare array without a pagination wrapper", async () => {
    pool.query
      .mockResolvedValueOnce([
        [{ id: 3, quesioner_id: 7, title: "Q3", type: "SCALE", is_required: 1 }],
        [],
      ])
      .mockResolvedValueOnce([[{ id: 30, question_id: 3, title: "Opt", score: 2 }], []]);
    const req = { params: { id: "7" } };
    const res = mockRes();

    await getAllQuestionByQuesionerId(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE quesioner_id = ? ORDER BY id ASC"),
      [7]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Question 7 retrieved successfully",
        data: [
          {
            id: 3,
            quesioner_id: 7,
            title: "Q3",
            type: "SCALE",
            is_required: true,
            options: [{ id: 30, question_id: 3, title: "Opt", score: 2 }],
          },
        ],
      })
    );
  });

  it("returns an error response when the query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db exploded"));
    const req = { params: { id: "7" } };
    const res = mockRes();

    await getAllQuestionByQuesionerId(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to retrieve question",
      })
    );
  });
});

describe("updateQuestion", () => {
  function mockConnection() {
    return {
      beginTransaction: vi.fn(),
      query: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
  }

  it("updates the question, replaces its options in a transaction, and re-selects", async () => {
    const conn = mockConnection();
    pool.getConnection.mockResolvedValueOnce(conn);
    conn.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE questions
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // DELETE options
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT options (bulk)
      .mockResolvedValueOnce([
        [{ id: 4, quesioner_id: 1, title: "New title", type: "SCALE", is_required: 1 }],
      ]) // SELECT question
      .mockResolvedValueOnce([[{ id: 40, question_id: 4, title: "A", score: 1 }]]); // SELECT options

    const req = {
      params: { id: "4" },
      body: { title: "New title", type: "SCALE", options: [{ title: "A", score: 1 }] },
    };
    const res = mockRes();

    await updateQuestion(req, res);

    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE questions SET title = ?, type = ? WHERE id = ?"),
      ["New title", "SCALE", 4]
    );
    expect(conn.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("DELETE FROM options WHERE question_id = ?"),
      [4]
    );
    expect(conn.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO options (question_id, title, score) VALUES ?"),
      [[[4, "A", 1]]]
    );
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Question updated successfully",
        data: expect.objectContaining({
          id: 4,
          is_required: true,
          options: [{ id: 40, question_id: 4, title: "A", score: 1 }],
        }),
      })
    );
  });

  it("skips the bulk insert when the options array is empty", async () => {
    const conn = mockConnection();
    pool.getConnection.mockResolvedValueOnce(conn);
    conn.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // DELETE
      .mockResolvedValueOnce([[{ id: 4, quesioner_id: 1, title: "T", type: "SCALE", is_required: 1 }]]) // SELECT question
      .mockResolvedValueOnce([[]]); // SELECT options

    const req = { params: { id: "4" }, body: { title: "T", type: "SCALE", options: [] } };
    const res = mockRes();

    await updateQuestion(req, res);

    expect(conn.query).toHaveBeenCalledTimes(4);
    expect(
      conn.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO options"))
    ).toBe(false);
  });

  it("rolls back and releases the connection when a query in the transaction fails", async () => {
    const conn = mockConnection();
    pool.getConnection.mockResolvedValueOnce(conn);
    conn.query.mockRejectedValueOnce(new Error("db exploded"));

    const req = { params: { id: "4" }, body: { title: "T", type: "SCALE", options: [] } };
    const res = mockRes();

    await updateQuestion(req, res);

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Failed to update question" })
    );
  });
});
