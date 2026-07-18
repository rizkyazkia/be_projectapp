import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("argon2", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed-password") },
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(),
}));

import pool from "../../config/db.js";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import {
  addStaff,
  deleteStaff,
  updateStafff,
  getStaffs,
} from "../StaffController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
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
});

describe("addStaff", () => {
  it("creates a user + staff row in a transaction and returns 201 with capital-S status", async () => {
    randomUUID.mockReturnValueOnce("user-id-1").mockReturnValueOnce("staff-id-1");
    const req = {
      user: { id: "admin-id" },
      body: {
        fullName: "Jane Nurse",
        address: "Jl. Sehat 1",
        phone: "08123",
        email: "jane@example.com",
        password: "plainpass",
        username: "janenurse",
      },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[], []]); // existing user check -> none
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([[{ id: 6 }], []]) // role 6 exists
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO users
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO staffs
      .mockResolvedValueOnce([[{ id: "user-id-1", username: "janenurse", email: "jane@example.com", password: "hashed-password", role_id: 6 }], []]) // reselect user
      .mockResolvedValueOnce([[{ id: "staff-id-1", fullName: "Jane Nurse", healthcare_id: 5, user_id: "user-id-1" }], []]); // reselect staff

    await addStaff(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("LEFT JOIN institutions"),
      ["admin-id"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT * FROM users WHERE username = ? AND email = ?"),
      ["janenurse", "jane@example.com"]
    );
    expect(connection.beginTransaction).toHaveBeenCalled();
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM roles WHERE id = ?"),
      [6]
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO users"),
      ["user-id-1", "janenurse", "jane@example.com", "hashed-password", 6]
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO staffs"),
      ["staff-id-1", "Jane Nurse", "Jl. Sehat 1", "08123", 5, "staff", "user-id-1"]
    );
    expect(connection.commit).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      status: "Success",
      message: "User berhasil dibuat",
      data: {
        id: "user-id-1",
        username: "janenurse",
        email: "jane@example.com",
        password: "hashed-password",
        role_id: 6,
        staff: { id: "staff-id-1", fullName: "Jane Nurse", healthcare_id: 5, user_id: "user-id-1" },
      },
    });
  });

  it("creates a new 'staff' role when role id 6 does not exist yet", async () => {
    randomUUID.mockReturnValueOnce("user-id-2").mockReturnValueOnce("staff-id-2");
    const req = {
      user: { id: "admin-id" },
      body: { fullName: "A", address: "B", phone: "C", email: "a@b.com", password: "p", username: "u" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]);
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([[], []]) // role 6 not found
      .mockResolvedValueOnce([{ insertId: 42 }]) // INSERT INTO roles
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([[{ id: "user-id-2" }], []])
      .mockResolvedValueOnce([[{ id: "staff-id-2" }], []]);

    await addStaff(req, res);

    expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("INSERT INTO roles"), ["staff"]);
    expect(connection.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO users"),
      ["user-id-2", "u", "a@b.com", "hashed-password", 42]
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("throws 'User sudah ada' when username+email already exist (guard clause)", async () => {
    const req = { user: { id: "admin-id" }, body: { username: "dup", email: "dup@x.com", password: "p" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "existing" }], []]);

    await addStaff(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal menambahkan staff",
      error: "User sudah ada",
    });
  });

  it("reproduces the pre-existing TypeError when the caller's user has no institution", async () => {
    const req = { user: { id: "admin-id" }, body: { username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ institution_id: null }], []]);

    await addStaff(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal menambahkan staff",
      error: expect.stringContaining("null"),
    });
  });

  it("rolls back the transaction and releases the connection when the staffs INSERT fails", async () => {
    randomUUID.mockReturnValueOnce("user-id-3").mockReturnValueOnce("staff-id-3");
    const req = {
      user: { id: "admin-id" },
      body: { fullName: "A", address: "B", phone: "C", email: "a@b.com", password: "p", username: "u" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]);
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([[{ id: 6 }], []]) // role 6 exists
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO users succeeds
      .mockRejectedValueOnce(new Error("duplicate key")); // INSERT INTO staffs fails

    await addStaff(req, res);

    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal menambahkan staff",
      error: "duplicate key",
    });
  });

  it("does not leak the raw password field beyond the argon2 hash in the response (password IS included, pre-existing behavior)", async () => {
    randomUUID.mockReturnValueOnce("user-id-4").mockReturnValueOnce("staff-id-4");
    const req = {
      user: { id: "admin-id" },
      body: { fullName: "A", address: "B", phone: "C", email: "a@b.com", password: "plainSecret", username: "u" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]);
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([[{ id: 6 }], []]) // role 6 exists
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([[{ id: "user-id-4", username: "u", email: "a@b.com", password: "hashed-password", role_id: 6 }], []])
      .mockResolvedValueOnce([[{ id: "staff-id-4" }], []]);

    await addStaff(req, res);

    expect(argon2.hash).toHaveBeenCalledWith("plainSecret");
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.data).toHaveProperty("password", "hashed-password");
  });
});

describe("deleteStaff", () => {
  it("deletes the staff row and returns the pre-delete row as data", async () => {
    const req = { params: { id: "staff-1" }, user: { id: "admin-id" } };
    const res = mockRes();
    const staffRow = { id: "staff-1", healthcare_id: 5, fullName: "Jane" };

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[staffRow], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await deleteStaff(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("DELETE FROM staffs WHERE id = ?"), ["staff-1"]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "Success",
      message: "Berhasil menghapus staff",
      data: staffRow,
    });
  });

  it("guard: throws when id param is missing", async () => {
    const req = { params: {}, user: { id: "admin-id" } };
    const res = mockRes();

    await deleteStaff(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Terjadi kesalahan saat menghapus staff",
      error: "Id dibutuhkan untuk menghapus staff",
    });
  });

  it("guard: throws when staff belongs to a different institution", async () => {
    const req = { params: { id: "staff-1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", healthcare_id: 99 }], []]);

    await deleteStaff(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Terjadi kesalahan saat menghapus staff",
      error: "Tidak bisa menghapus akun institusi lain",
    });
  });
});

describe("updateStafff", () => {
  it("updates staffs and conditionally-built users fields, then re-selects both", async () => {
    randomUUID; // no ids generated by this handler
    const req = {
      params: { id: "staff-1" },
      user: { id: "admin-id" },
      body: { fullName: "New Name", address: "Addr", phone: "Ph", username: "newuser", email: "", password: "" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", user_id: "user-1" }], []]);
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE staffs
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE users (username only, email/password empty)
      .mockResolvedValueOnce([[{ id: "user-1", username: "newuser" }], []]) // reselect user
      .mockResolvedValueOnce([[{ id: "staff-1", fullName: "New Name" }], []]); // reselect staff

    await updateStafff(req, res);

    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE staffs SET"),
      ["New Name", "Addr", "Ph", 5, "staff", "staff-1"]
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE users SET username = ?"),
      ["newuser", "user-1"]
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      status: "Success",
      message: "User berhasil diupdate",
      data: { id: "user-1", username: "newuser", staff: { id: "staff-1", fullName: "New Name" } },
    });
  });

  it("skips the users UPDATE entirely when username/email/password are all falsy, but still re-selects", async () => {
    const req = {
      params: { id: "staff-1" },
      user: { id: "admin-id" },
      body: { fullName: "New Name", address: "Addr", phone: "Ph" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", user_id: "user-1" }], []]);
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE staffs
      .mockResolvedValueOnce([[{ id: "user-1" }], []]) // reselect user
      .mockResolvedValueOnce([[{ id: "staff-1" }], []]); // reselect staff

    await updateStafff(req, res);

    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.query.mock.calls[1][0]).toEqual(expect.stringContaining("SELECT * FROM users"));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("guard: throws 'User tidak ditemukan' when staff has no linked user_id", async () => {
    const req = { params: { id: "staff-1" }, user: { id: "admin-id" }, body: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", user_id: null }], []]);

    await updateStafff(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal Mengubah staff",
      error: "User tidak ditemukan",
    });
  });

  it("edge: reproduces the pre-existing TypeError when the staff row itself does not exist", async () => {
    const req = { params: { id: "missing" }, user: { id: "admin-id" }, body: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]); // no staff row

    await updateStafff(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal Mengubah staff",
      error: expect.stringContaining("user_id"),
    });
  });

  it("rolls back the transaction and releases the connection when the users UPDATE fails", async () => {
    const req = {
      params: { id: "staff-1" },
      user: { id: "admin-id" },
      body: { fullName: "New Name", address: "Addr", phone: "Ph", username: "newuser" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", user_id: "user-1" }], []]);
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE staffs succeeds
      .mockRejectedValueOnce(new Error("connection lost")); // UPDATE users fails

    await updateStafff(req, res);

    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal Mengubah staff",
      error: "connection lost",
    });
  });
});

describe("getStaffs", () => {
  it("filters by healthcare_id only when no keyword is given", async () => {
    const req = { user: { id: "admin-id" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // inline institution lookup
      .mockResolvedValueOnce([[{ total: 2 }], []])
      .mockResolvedValueOnce([[{ id: "s1" }, { id: "s2" }], []]);

    await getStaffs(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE healthcare_id = ?"),
      [5]
    );
    expect(pool.query.mock.calls[2][0]).not.toContain("fullName LIKE");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "Success",
      message: "Berhasil mendapatkan data",
      data: { staffs: [{ id: "s1" }, { id: "s2" }], page: 0, limit: 10, totalPages: 1, totalRows: 2 },
    });
  });

  it("edge: drops the healthcare_id filter (not NULL-matching) when institution_id is null, safely via ??", async () => {
    const req = { user: { id: "admin-id" }, query: { keyword: "bud" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: null }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[{ id: "s1" }], []]);

    await getStaffs(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE fullName LIKE ?"),
      ["%bud%"]
    );
    expect(pool.query.mock.calls[1][0]).not.toContain("healthcare_id");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("guard: throws when the caller has no user row at all", async () => {
    const req = { user: { id: "ghost" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await getStaffs(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal mendapatkan staff",
      error: "User tidak di institusi manapun",
    });
  });
});
