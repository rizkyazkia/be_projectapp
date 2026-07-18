import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("jsonwebtoken", () => ({
  default: {
    verify: vi.fn(),
    sign: vi.fn(),
  },
}));

import pool from "../../config/db.js";
import jwt from "jsonwebtoken";
import { refreshToken } from "../RefreshTokenController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_REFRESH_TOKEN_SECRET = "refresh-secret";
  process.env.APP_ACCESS_TOKEN_SECRET = "access-secret";
});

describe("refreshToken", () => {
  it("returns a new access token when the cookie matches a stored refresh token", async () => {
    const req = { cookies: { refreshToken: "valid-refresh-token" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([
      [
        {
          id: "user-1",
          username: "budi",
          email: "budi@example.com",
          password: "hashed",
          role_id: 2,
          refresh_token: "valid-refresh-token",
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
          role_name: "admin",
        },
      ],
      [],
    ]);
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(null, { id: "user-1" })
    );
    jwt.sign.mockReturnValue("new-access-token");

    await refreshToken(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("LEFT JOIN roles r ON u.role_id = r.id"),
      ["valid-refresh-token"]
    );
    expect(jwt.sign).toHaveBeenCalledWith(
      {
        id: "user-1",
        username: "budi",
        email: "budi@example.com",
        role: "admin",
      },
      "access-secret",
      { expiresIn: "15m" }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Access token berhasil diperbarui",
      data: { accessToken: "new-access-token" },
    });
  });

  it("returns an error when no refresh token cookie is present (guard clause, no DB call)", async () => {
    const req = { cookies: {} };
    const res = mockRes();

    await refreshToken(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak ditemukan",
      error: null,
    });
  });

  it("returns an error when the refresh token is not found in the database", async () => {
    const req = { cookies: { refreshToken: "unknown-token" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await refreshToken(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak valid",
      error: null,
    });
  });

  it("returns an error when jwt.verify rejects the token", async () => {
    const req = { cookies: { refreshToken: "expired-token" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        {
          id: "user-1",
          username: "budi",
          email: "budi@example.com",
          password: "hashed",
          role_id: 2,
          refresh_token: "expired-token",
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
          role_name: "admin",
        },
      ],
      [],
    ]);
    const verifyError = new Error("jwt expired");
    jwt.verify.mockImplementation((token, secret, cb) => cb(verifyError, null));

    await refreshToken(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak valid",
      error: "jwt expired",
    });
  });
});
