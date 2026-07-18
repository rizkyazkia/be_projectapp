import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getCategory } from "../CategoryController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCategory", () => {
  it("returns the first page with default pagination when no query params are given", async () => {
    const req = { query: {} };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[{ count: 2 }], []])
      .mockResolvedValueOnce([
        [
          { id: 1, name: "Stunting", path: "/stunting" },
          { id: 2, name: "Gizi", path: "/gizi" },
        ],
        [],
      ]);

    await getCategory(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "SELECT COUNT(*) AS count FROM categories WHERE name LIKE ?"
      ),
      ["%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ORDER BY id ASC LIMIT ? OFFSET ?"),
      ["%%", 10, 0]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Categories retrieved successfully",
      data: {
        totalRows: 2,
        totalPage: 1,
        page: 0,
        limit: 10,
        categories: [
          { id: 1, name: "Stunting", path: "/stunting" },
          { id: 2, name: "Gizi", path: "/gizi" },
        ],
      },
    });
  });

  it("applies search and pagination params to both queries (offset = limit * page)", async () => {
    const req = { query: { page: "2", limit: "5", search: "gizi" } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[{ count: 12 }], []])
      .mockResolvedValueOnce([
        [{ id: 11, name: "Gizi Buruk", path: "/gizi-buruk" }],
        [],
      ]);

    await getCategory(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM categories WHERE name LIKE ?"),
      ["%gizi%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("LIMIT ? OFFSET ?"),
      ["%gizi%", 5, 10]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalRows: 12,
          totalPage: 3,
          page: 2,
          limit: 5,
        }),
      })
    );
  });
});
