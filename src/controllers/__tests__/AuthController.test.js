import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("argon2", () => ({
  default: {
    hash: vi.fn(async (password) => `hashed:${password}`),
    verify: vi.fn(),
  },
}));

import pool from "../../config/db.js";
import argon2 from "argon2";
import {
  registerParent,
  registerInstitution,
  login,
  logout,
} from "../AuthController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

function mockConnection() {
  return {
    beginTransaction: vi.fn(),
    query: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ACCESS_TOKEN_SECRET = "test-access-secret";
  process.env.APP_REFRESH_TOKEN_SECRET = "test-refresh-secret";
});

describe("registerParent", () => {
  it("creates a user and family record inside a transaction and returns the full user (incl. hashed password)", async () => {
    const req = {
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
        role_id: 2,
      },
    };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no existing user/email

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO users
      .mockResolvedValueOnce([{ insertId: 0 }]); // INSERT INTO families

    await registerParent(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "SELECT id FROM users WHERE username = ? OR email = ?"
      ),
      ["alice", "alice@example.com"]
    );
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO users"),
      [
        expect.any(String),
        "alice",
        "alice@example.com",
        "hashed:secret123",
        2,
        null,
        expect.any(Date),
        expect.any(Date),
      ]
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO families"),
      [expect.any(String), expect.any(String), expect.any(Date), expect.any(Date)]
    );
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat akun",
      data: expect.objectContaining({
        id: expect.any(String),
        username: "alice",
        email: "alice@example.com",
        password: "hashed:secret123",
        role_id: 2,
        refresh_token: null,
        created_at: expect.any(Date),
        updated_at: expect.any(Date),
      }),
    });
  });

  it("refuses when username or email already exists, without opening a connection", async () => {
    const req = {
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
        role_id: 2,
      },
    };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[{ id: "existing" }], []]);

    await registerParent(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Username atau email sudah digunakan",
      error: null,
    });
  });

  it("rolls back and releases the connection when an insert inside the transaction fails", async () => {
    const req = {
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
        role_id: 2,
      },
    };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    const insertError = new Error("duplicate entry");
    connection.query.mockRejectedValueOnce(insertError);

    await registerParent(req, res);

    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat membuat akun",
      error: "duplicate entry",
    });
  });
});

describe("registerInstitution", () => {
  const baseBody = {
    username: "school1",
    email: "school1@example.com",
    password: "secret123",
    role_id: 3,
    institutionName: "SD Merdeka",
    institutionEmail: "sd@merdeka.sch.id",
    institutionPhone: "0811",
    institutionAddress: "Jl. Merdeka 1",
    institutionProvince: "1",
    institutionCity: "2",
    institutionType: 1,
  };

  it("creates a user + institution inside a transaction and returns the nested role/institution/province/city shape", async () => {
    const req = { body: { ...baseBody } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[], []]) // no existing user/email
      .mockResolvedValueOnce([[], []]) // no existing institution
      .mockResolvedValueOnce([
        [
          {
            id: "u9",
            username: "school1",
            email: "school1@example.com",
            role_name: "institution",
            institution_id: 5,
            institution_name: "SD Merdeka",
            institution_email: "sd@merdeka.sch.id",
            institution_phone: "0811",
            institution_address: "Jl. Merdeka 1",
            province_id: 1,
            province_name: "Jawa Barat",
            city_id: 2,
            city_name: "Bandung",
          },
        ],
        [],
      ]); // re-select after commit

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO users
      .mockResolvedValueOnce([{ insertId: 5 }]); // INSERT INTO institutions

    await registerInstitution(req, res);

    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO institutions"),
      [
        "SD Merdeka",
        "sd@merdeka.sch.id",
        "0811",
        "Jl. Merdeka 1",
        1,
        2,
        1,
        expect.any(String),
        expect.any(Date),
        expect.any(Date),
      ]
    );
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat akun",
      data: {
        id: "u9",
        username: "school1",
        email: "school1@example.com",
        role: { name: "institution" },
        institution: {
          id: 5,
          name: "SD Merdeka",
          email: "sd@merdeka.sch.id",
          phone: "0811",
          address: "Jl. Merdeka 1",
          province: { id: 1, name: "Jawa Barat" },
          city: { id: 2, name: "Bandung" },
        },
      },
    });
  });

  it("coerces a non-numeric province/city to null instead of letting an invalid type reach the query", async () => {
    const req = {
      body: {
        ...baseBody,
        institutionProvince: "",
        institutionCity: undefined,
      },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [
          {
            id: "u10",
            username: "school1",
            email: "school1@example.com",
            role_name: "institution",
            institution_id: 6,
            institution_name: "SD Merdeka",
            institution_email: "sd@merdeka.sch.id",
            institution_phone: "0811",
            institution_address: "Jl. Merdeka 1",
            province_id: null,
            province_name: null,
            city_id: null,
            city_name: null,
          },
        ],
        [],
      ]);

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([{ insertId: 6 }]);

    await registerInstitution(req, res);

    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO institutions"),
      [
        "SD Merdeka",
        "sd@merdeka.sch.id",
        "0811",
        "Jl. Merdeka 1",
        null,
        null,
        1,
        expect.any(String),
        expect.any(Date),
        expect.any(Date),
      ]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          institution: expect.objectContaining({ province: null, city: null }),
        }),
      })
    );
  });

  it("refuses when username or email already exists, without opening a connection", async () => {
    const req = { body: { ...baseBody } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[{ id: "existing" }], []]);

    await registerInstitution(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Username atau email sudah digunakan",
      error: null,
    });
  });

  it("refuses when the institution name/email/phone already exists, without opening a connection", async () => {
    const req = { body: { ...baseBody } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[], []]) // no existing user
      .mockResolvedValueOnce([[{ id: 1 }], []]); // existing institution

    await registerInstitution(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Institusi ini sudah digunakan oleh akun lain",
      error: null,
    });
  });

  it("rolls back and releases the connection when an insert inside the transaction fails", async () => {
    const req = { body: { ...baseBody } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[], []]) // no existing user
      .mockResolvedValueOnce([[], []]); // no existing institution

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    const insertError = new Error("institution insert failed");
    connection.query.mockRejectedValueOnce(insertError);

    await registerInstitution(req, res);

    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat membuat akun",
      error: "institution insert failed",
    });
  });
});

describe("login", () => {
  const userRow = {
    id: "u1",
    username: "alice",
    email: "alice@example.com",
    password: "hashed-pw",
    role_id: 2,
    refresh_token: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    role_name: "parent",
  };

  it("logs in with a valid identifier/password, updates refresh_token, and sets the refresh cookie", async () => {
    const req = { body: { identifier: "alice", password: "secret123" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[userRow], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    argon2.verify.mockResolvedValueOnce(true);

    await login(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM users u"),
      ["alice", "alice"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE users SET refresh_token = ?"),
      [expect.any(String), "u1"]
    );
    expect(res.cookie).toHaveBeenCalledWith("refreshToken", expect.any(String), {
      httpOnly: true,
      maxAge: 86400000,
      secure: true,
      sameSite: "none",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Login berhasil",
      data: { accessToken: expect.any(String) },
    });
  });

  it("returns 500 'User tidak ditemukan' when no user matches the identifier", async () => {
    const req = { body: { identifier: "ghost", password: "secret123" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User tidak ditemukan",
      error: null,
    });
  });

  it("returns 500 'Password salah' when argon2.verify does not match", async () => {
    const req = { body: { identifier: "alice", password: "wrongpass" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[userRow], []]);
    argon2.verify.mockResolvedValueOnce(false);

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Password salah",
      error: null,
    });
  });

  it("returns 500 with the underlying error message when the DB lookup throws", async () => {
    const req = { body: { identifier: "alice", password: "secret123" } };
    const res = mockRes();
    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Terjadi kesalahan saat login",
      error: "connection lost",
    });
  });
});

describe("logout", () => {
  it("clears the refresh token in the DB and the cookie for a valid refresh token", async () => {
    const req = { cookies: { refreshToken: "valid-refresh-token" } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[{ id: "u1" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await logout(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM users WHERE refresh_token = ?"),
      ["valid-refresh-token"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE users SET refresh_token = NULL WHERE id = ?"),
      ["u1"]
    );
    expect(res.clearCookie).toHaveBeenCalledWith("refreshToken", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Logout berhasil",
      data: null,
    });
  });

  it("returns 500 'Refresh token tidak ditemukan' when no cookie is present, without querying the DB", async () => {
    const req = { cookies: {} };
    const res = mockRes();

    await logout(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak ditemukan",
      error: null,
    });
  });

  it("returns 500 'Refresh token tidak valid' when the token doesn't match any user", async () => {
    const req = { cookies: { refreshToken: "stale-token" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await logout(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak valid",
      error: null,
    });
  });
});
