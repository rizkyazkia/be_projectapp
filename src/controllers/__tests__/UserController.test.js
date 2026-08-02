import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getUsers, getUserById, deleteUser } from "../UserController.js";

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

describe("getUsers", () => {
  it("returns paginated users shaped with role/institution/teacher", async () => {
    const req = { query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ total: 2 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "u1",
            username: "alice",
            email: "alice@example.com",
            role_name: "admin",
            institution_id: 5,
            institution_name: "School A",
            institution_phone: "0800",
            teacher_id: null,
            teacher_institution_id: null,
            teacher_institution_name: null,
            teacher_institution_phone: null,
          },
          {
            id: "u2",
            username: "bob",
            email: "bob@example.com",
            role_name: "teacher",
            institution_id: null,
            institution_name: null,
            institution_phone: null,
            teacher_id: "t1",
            teacher_institution_id: 7,
            teacher_institution_name: "School B",
            teacher_institution_phone: "0900",
          },
        ],
        [],
      ]);

    await getUsers(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS total FROM users"),
      ["%%", "%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM users u"),
      ["%%", "%%", 10, 0]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Users retrieved successfully",
      data: {
        totalRows: 2,
        totalPage: 1,
        page: 0,
        limit: 10,
        users: [
          {
            id: "u1",
            username: "alice",
            email: "alice@example.com",
            role: { name: "admin" },
            institution: { id: 5, name: "School A", phone: "0800" },
            teacher: null,
          },
          {
            id: "u2",
            username: "bob",
            email: "bob@example.com",
            role: { name: "teacher" },
            institution: null,
            teacher: {
              institution: { id: 7, name: "School B", phone: "0900" },
            },
          },
        ],
      },
    });
  });

  it("escapes % and _ special characters in the search term before building the LIKE pattern", async () => {
    const req = { query: { search: "50%_off" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []]);

    await getUsers(req, res);

    const expectedPattern = "%50\\%\\_off%";
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS total FROM users"),
      [expectedPattern, expectedPattern]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM users u"),
      [expectedPattern, expectedPattern, 10, 0]
    );
  });
});

describe("getUserById", () => {
  it("returns a user with role and institution", async () => {
    const req = { params: { id: "u1" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([
      [
        {
          id: "u1",
          username: "alice",
          email: "alice@example.com",
          role_name: "admin",
          institution_name: "School A",
          institution_address: "Jl. Mawar",
          institution_email: "school@a.com",
          institution_phone: "0800",
          institution_city_name: "Jakarta",
        },
      ],
      [],
    ]);

    await getUserById(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE u.id = ?"),
      ["u1"]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "User with ID: u1 retrieved successfully",
      data: {
        id: "u1",
        username: "alice",
        email: "alice@example.com",
        role: { name: "admin" },
        institution: {
          name: "School A",
          address: "Jl. Mawar",
          email: "school@a.com",
          phone: "0800",
          city: { name: "Jakarta" },
        },
      },
    });
  });

  it("returns 500 'User Not Found' when no row matches", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await getUserById(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User Not Found",
      error: null,
    });
  });

  it("logs the error via console.error and returns 'Error retrieving user' when the query throws", async () => {
    const req = { params: { id: "u1" } };
    const res = mockRes();
    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await getUserById(req, res);

    expect(consoleSpy).toHaveBeenCalledWith(dbError);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error retrieving user",
      error: "connection lost",
    });

    consoleSpy.mockRestore();
  });
});

describe("deleteUser", () => {
  it("deletes a non-admin user and returns the pre-existing 200/data:200 response shape", async () => {
    const req = { params: { id: "u2" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "u2", role_id: 3 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await deleteUser(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id, role_id FROM users WHERE id = ?"),
      ["u2"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("DELETE FROM users WHERE id = ?"),
      ["u2"]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menghapus user",
      data: 200,
    });
  });

  it("returns 500 'User Not Found' when the user does not exist", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await deleteUser(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User Not Found",
      error: null,
    });
  });

  it("refuses to delete a role_id 1 (admin) user without issuing a DELETE", async () => {
    const req = { params: { id: "admin1" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[{ id: "admin1", role_id: 1 }], []]);

    await deleteUser(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Cannot delete admin user",
      error: null,
    });
  });

  it("returns 500 'Gagal menghapus user' when the query throws", async () => {
    const req = { params: { id: "u2" } };
    const res = mockRes();
    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await deleteUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal menghapus user",
      error: "connection lost",
    });
  });
});
