import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { roleBased } from "../roleBased.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("roleBased", () => {
  it("calls next() when the user's role is in the allowed list", async () => {
    const req = { user: { id: "u1" } };
    const res = mockRes();
    const next = vi.fn();
    pool.query.mockResolvedValueOnce([[{ role_name: "admin" }], []]);

    await roleBased(["admin", "teacher"])(req, res, next);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM users u JOIN roles r"),
      ["u1"]
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts a single role string and normalizes it to an array before checking membership", async () => {
    const req = { user: { id: "u1" } };
    const res = mockRes();
    const next = vi.fn();
    pool.query.mockResolvedValueOnce([[{ role_name: "admin" }], []]);

    await roleBased("admin")(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 500 'User tidak ditemukan' when req.user is missing, without querying the DB", async () => {
    const req = {};
    const res = mockRes();
    const next = vi.fn();

    await roleBased(["admin"])(req, res, next);

    expect(pool.query).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User tidak ditemukan",
      error: null,
    });
  });

  it("returns 500 'User tidak ditemukan' when no row matches req.user.id", async () => {
    const req = { user: { id: "missing" } };
    const res = mockRes();
    const next = vi.fn();
    pool.query.mockResolvedValueOnce([[], []]);

    await roleBased(["admin"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User tidak ditemukan",
      error: null,
    });
  });

  it("returns 500 'Akses ditolak' when the user's role is not in the allowed list", async () => {
    const req = { user: { id: "u1" } };
    const res = mockRes();
    const next = vi.fn();
    pool.query.mockResolvedValueOnce([[{ role_name: "parent" }], []]);

    await roleBased(["admin", "teacher"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Akses ditolak",
      error: null,
    });
  });

  it("catches a query error and returns 500 'Error checking user role'", async () => {
    const req = { user: { id: "u1" } };
    const res = mockRes();
    const next = vi.fn();
    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await roleBased(["admin"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error checking user role",
      error: "connection lost",
    });
  });
});
