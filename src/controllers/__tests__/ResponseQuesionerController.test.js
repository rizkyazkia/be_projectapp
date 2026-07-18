import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("node:crypto", () => ({
  randomUUID: () => "11111111-1111-1111-1111-111111111111",
}));

import pool from "../../config/db.js";
import {
  getResponseQuesioner,
  createResponseQuesioner,
} from "../ResponseQuesionerController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getResponseQuesioner", () => {
  it("returns paginated questions with options and boolean-coerced answers", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ]) // family_members
      .mockResolvedValueOnce([
        [{ id: "resp-1", familyMemberId: "member-1", quisionerId: 5 }],
        [],
      ]) // responses
      .mockResolvedValueOnce([[{ count: 1 }], []]) // totalRows count
      .mockResolvedValueOnce([
        [{ id: 10, quesioner_id: 5, title: "Q1", type: "BOOLEAN" }],
        [],
      ]) // questions (paginated)
      .mockResolvedValueOnce([
        [{ id: 100, question_id: 10, title: "Yes", score: 1 }],
        [],
      ]) // options
      .mockResolvedValueOnce([
        [
          {
            id: 1000,
            questionId: 10,
            responseId: "resp-1",
            option_id: 100,
            score: 1,
            boolean_value: 1,
            scaleValue: null,
          },
          {
            id: 1001,
            questionId: 10,
            responseId: "resp-1",
            option_id: null,
            score: 0,
            boolean_value: null,
            scaleValue: null,
          },
        ],
        [],
      ]); // answers

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM families WHERE userId"),
      ["user-1"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("FROM responses WHERE familyMemberId"),
      ["member-1", 5]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("LIMIT ? OFFSET ?"),
      [5, "%%", 10, 0]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("FROM options WHERE question_id IN"),
      [[10]]
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.questions).toEqual([
      {
        id: 10,
        quesioner_id: 5,
        title: "Q1",
        type: "BOOLEAN",
        options: [{ id: 100, title: "Yes", score: 1 }],
      },
    ]);
    expect(payload.data.answers[0].boolean_value).toBe(true);
    expect(payload.data.answers[1].boolean_value).toBeNull();
  });

  it("returns 500 (errorResponse code-as-error bug) when family not found", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // families empty

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error: 404,
        message: "Family not found",
      })
    );
  });

  it("returns the hardcoded empty shape (limit:10 preserved bug) when no response exists", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      query: { limit: "3" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "AYAH" }],
        [],
      ])
      .mockResolvedValueOnce([[], []]); // no response

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(res.json).toHaveBeenCalledWith({
      totalRows: 0,
      totalPage: 0,
      page: 0,
      limit: 10,
      questions: [],
      answers: [],
    });
  });

  it("skips the options and answers queries when no questions match (empty IN guard)", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([
        [{ id: "resp-1", familyMemberId: "member-1", quisionerId: 5 }],
        [],
      ])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[], []]); // no questions

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(5); // no options query, no answers query
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.questions).toEqual([]);
    expect(payload.data.answers).toEqual([]);
  });

  it("returns 500 via the catch block when pool.query rejects unexpectedly", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query.mockRejectedValueOnce(new Error("Connection lost"));

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Failed to get response",
      error: "Connection lost",
    });
  });
});

describe("createResponseQuesioner", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  it("inserts the response, bulk-inserts answers, and updates totalScore", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: {
        answers: [
          { questionId: 10, option_id: 100, score: 3, boolean_value: true, scaleValue: 2 },
          { questionId: 11, option_id: 101, score: 1 },
        ],
      },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ]) // family_members
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }]) // INSERT responses
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // bulk INSERT answers
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE responses totalScore

    await createResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO responses"),
      [UUID, 5, 0, "member-1", null]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO answers"),
      [
        [
          [10, UUID, 100, 3, true, 2],
          [11, UUID, 101, 1, null, null],
        ],
      ]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("UPDATE responses SET totalScore"),
      [4, UUID]
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        data: { count: 2 },
      })
    );
  });

  it("returns 500 (401-as-error bug) when there is no user on the request", async () => {
    const req = { user: null, params: { id: "5" }, body: { answers: [] } };
    const res = mockRes();

    await createResponseQuesioner(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 401, message: "Unauthorized" })
    );
  });

  it("returns 400 (as-error bug) when 'answers' is not an array", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: { answers: "not-an-array" },
    };
    const res = mockRes();

    await createResponseQuesioner(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 400,
        message: "Data must be an array in 'answers'",
      })
    );
  });

  it("skips the bulk insert and reports count:0 when answers is an empty array", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: { answers: [] },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }]) // INSERT responses
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE responses totalScore (no bulk insert call)

    await createResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(4); // no INSERT INTO answers call
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { count: 0 } })
    );
  });
});
