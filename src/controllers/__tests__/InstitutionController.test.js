import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getInstitutions,
  getInstitutionByUser,
  getInstitutionType,
  getHealthCares,
} from "../InstitutionController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getInstitutions", () => {
  it("returns paginated institutions with nested province/city/institution_type, mapping null FKs to null", async () => {
    const req = { query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ count: 2 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: 1,
            name: "RS A",
            email: "a@rs.com",
            phone: "0800",
            address: "Jl. A",
            province_name: "Jawa Barat",
            city_name: "Bandung",
            institution_type_name: "HealthCare",
          },
          {
            id: 2,
            name: "RS B",
            email: "b@rs.com",
            phone: "0801",
            address: "Jl. B",
            province_name: null,
            city_name: null,
            institution_type_name: null,
          },
        ],
        [],
      ]);

    await getInstitutions(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(DISTINCT i.id) AS count"),
      ["%%", "%%", "%%", "%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "LEFT JOIN institution_types it ON i.type = it.id"
      ),
      ["%%", "%%", "%%", "%%", 10, 0]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Institutions retrieved successfully",
      data: {
        totalRows: 2,
        totalPage: 1,
        page: 0,
        limit: 10,
        institutions: [
          {
            id: 1,
            name: "RS A",
            email: "a@rs.com",
            phone: "0800",
            address: "Jl. A",
            province: { name: "Jawa Barat" },
            city: { name: "Bandung" },
            institution_type: { name: "HealthCare" },
          },
          {
            id: 2,
            name: "RS B",
            email: "b@rs.com",
            phone: "0801",
            address: "Jl. B",
            province: null,
            city: null,
            institution_type: null,
          },
        ],
      },
    });
  });

  it("accepts custom page, limit, and search parameters", async () => {
    const req = { query: { page: "2", limit: "5", search: "Bandung" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ count: 12 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: 8,
            name: "RS Bandung",
            email: "rs@bandung.com",
            phone: "0802",
            address: "Jl. Bandung",
            province_name: "Jawa Barat",
            city_name: "Bandung",
            institution_type_name: "HealthCare",
          },
        ],
        [],
      ]);

    await getInstitutions(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(DISTINCT i.id) AS count"),
      ["%Bandung%", "%Bandung%", "%Bandung%", "%Bandung%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "LEFT JOIN institution_types it ON i.type = it.id"
      ),
      ["%Bandung%", "%Bandung%", "%Bandung%", "%Bandung%", 5, 10]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Institutions retrieved successfully",
      data: {
        totalRows: 12,
        totalPage: 3,
        page: 2,
        limit: 5,
        institutions: [
          {
            id: 8,
            name: "RS Bandung",
            email: "rs@bandung.com",
            phone: "0802",
            address: "Jl. Bandung",
            province: { name: "Jawa Barat" },
            city: { name: "Bandung" },
            institution_type: { name: "HealthCare" },
          },
        ],
      },
    });
  });

  it("returns a 500 error when the count query fails", async () => {
    const req = { query: {} };
    const res = mockRes();
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await getInstitutions(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Internal server error",
      error: "connection lost",
    });
  });
});

describe("getInstitutionByUser", () => {
  it("returns the institution owned by req.user.id", async () => {
    const req = { user: { id: "user-1" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [{ id: 1, name: "RS A", user_id: "user-1" }],
      [],
    ]);

    await getInstitutionByUser(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM institutions WHERE user_id = ?"),
      ["user-1"]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Institution retrieved successfully",
      data: { id: 1, name: "RS A", user_id: "user-1" },
    });
  });

  it("preserves the existing 404-is-actually-500 bug when no institution is found", async () => {
    const req = { user: { id: "user-404" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await getInstitutionByUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Institution not found",
      error: 404,
    });
  });

  it("returns a 500 error when the query fails", async () => {
    const req = { user: { id: "user-1" } };
    const res = mockRes();
    pool.query.mockRejectedValueOnce(new Error("database error"));

    await getInstitutionByUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Internal server error",
      error: "database error",
    });
  });
});

describe("getInstitutionType", () => {
  it("returns institution types", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        { id: 1, name: "School" },
        { id: 2, name: "HealthCare" },
      ],
      [],
    ]);

    await getInstitutionType(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM institution_types")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Institution types retrieved successfully",
      data: [
        { id: 1, name: "School" },
        { id: 2, name: "HealthCare" },
      ],
    });
  });

  it("preserves the existing 404-is-actually-500 bug on an empty result", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await getInstitutionType(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "No institution types found",
      error: 404,
    });
  });

  it("returns a 500 error when the query fails", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockRejectedValueOnce(new Error("connection timeout"));

    await getInstitutionType(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Internal server error",
      error: "connection timeout",
    });
  });
});

describe("getHealthCares", () => {
  it("returns healthcare institutions without a search filter", async () => {
    const req = { query: {} };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        {
          id: 1,
          name: "RS A",
          address: "Jl. A",
          phone: "0800",
          email: "a@rs.com",
          city_id: 5,
          city_name: "Bandung",
          province_id: 9,
          province_name: "Jawa Barat",
        },
      ],
      [],
    ]);

    await getHealthCares(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "INNER JOIN institution_types it ON i.type = it.id AND it.name = 'HealthCare'"
      ),
      []
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Healthcares retrieved successfully",
      data: [
        {
          id: 1,
          name: "RS A",
          address: "Jl. A",
          phone: "0800",
          email: "a@rs.com",
          city: { id: 5, name: "Bandung" },
          province: { id: 9, name: "Jawa Barat" },
        },
      ],
    });
  });

  it("appends the optional search WHERE clause only when search is non-empty", async () => {
    const req = { query: { search: "bandung" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await getHealthCares(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "WHERE (i.name LIKE ? OR i.address LIKE ? OR i.phone LIKE ?)"
      ),
      ["%bandung%", "%bandung%", "%bandung%"]
    );
  });

  it("returns a 500 error when the query fails", async () => {
    const req = { query: {} };
    const res = mockRes();
    pool.query.mockRejectedValueOnce(new Error("query syntax error"));

    await getHealthCares(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Internal server error",
      error: "query syntax error",
    });
  });
});
