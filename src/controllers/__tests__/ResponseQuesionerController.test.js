import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getResponseQuesioner } from "../ResponseQuesionerController.js";

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
});
