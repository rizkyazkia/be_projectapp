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
import { randomUUID } from "node:crypto";
import { getTeachers, createTeacher, updateTeacher, deleteTeacher } from "../TeacherController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getTeachers", () => {
  it("joins to-one relations in one query and groups to-many classes from a follow-up query", async () => {
    const req = { user: { id: "admin-id" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "t1",
            fullName: "Mrs. Ana",
            role: "Wali Kelas",
            address: "Jl. A",
            phone: "081",
            user_id: "u1",
            user_username: "ana",
            user_email: "ana@x.com",
            institution_id: 5,
            institution_name: "SDN 1",
            institution_address: "Jl. B",
            institution_phone: "082",
            province_id: 1,
            province_name: "Jawa Barat",
            city_id: 2,
            city_name: "Bandung",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ id: 10, name: "1A", teacher_id: "t1" }], []]);

    await getTeachers(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE school_id = ? AND (fullName LIKE ? OR role LIKE ?)"),
      [5, "%%", "%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("SELECT id, name, teacher_id FROM classes WHERE teacher_id IN (?)"),
      [["t1"]]
    );
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Teachers retrieved successfully",
      data: {
        totalRows: 1,
        totalPage: 1,
        page: 0,
        limit: 10,
        teachers: [
          {
            id: "t1",
            fullName: "Mrs. Ana",
            role: "Wali Kelas",
            address: "Jl. A",
            phone: "081",
            user: { id: "u1", username: "ana", email: "ana@x.com" },
            institution: {
              id: 5,
              name: "SDN 1",
              address: "Jl. B",
              phone: "082",
              province: { id: 1, name: "Jawa Barat" },
              city: { id: 2, name: "Bandung" },
            },
            classes: [{ id: 10, name: "1A" }],
          },
        ],
      },
    });
  });

  it("edge: skips the classes follow-up query entirely when the teacher page is empty", async () => {
    const req = { user: { id: "admin-id" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []]);

    await getTeachers(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it("guard: 404 when the caller has no institution", async () => {
    const req = { user: { id: "admin-id" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no institution row

    await getTeachers(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Institusi tidak ditemukan", error: 404 });
  });

  it("returns 500 via errorResponse when a query rejects", async () => {
    const req = { user: { id: "admin-id" }, query: {} };
    const res = mockRes();

    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await getTeachers(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Failed to retrieve teachers",
      error: "connection lost",
    });
  });
});

describe("createTeacher", () => {
  it("guard: 404 when the caller has no institution", async () => {
    const req = { user: { id: "admin-id" }, body: { classId: 1, username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no institution row

    await createTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Institusi tidak ditemukan", error: 404 });
  });

  it("guard: requires classId to be present", async () => {
    const req = { user: { id: "admin-id" }, body: { username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ id: 5 }], []]);

    await createTeacher(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "ID kelas harus disertakan", error: null });
  });

  it("guard: class already has a teacher_id", async () => {
    const req = { user: { id: "admin-id" }, body: { classId: 1, username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, teacher_id: "existing-teacher" }], []]);

    await createTeacher(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Kelas sudah memiliki wali kelas", error: null });
  });

  it("links a NEW teacher record to an existing userless-teacher user and returns the updated user with nested teacher", async () => {
    randomUUID.mockReturnValueOnce("teacher-id-1");
    const req = {
      user: { id: "admin-id" },
      body: { classId: 1, username: "existing", email: "existing@x.com", fullName: "Mr. Budi", role: "Wali 1A", address: "Jl. C", phone: "083", password: "p" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: 1, teacher_id: null }], []]) // class exists, no teacher yet
      .mockResolvedValueOnce([[{ id: "existing-user-id", username: "existing", email: "existing@x.com" }], []]) // existing user
      .mockResolvedValueOnce([[], []]) // that user has no teacher row yet
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT INTO teachers
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE classes teacher_id
      .mockResolvedValueOnce([
        [{ id: "existing-user-id", username: "existing", email: "existing@x.com", role_id: 4 }],
        [],
      ]) // reselect user
      .mockResolvedValueOnce([[{ id: "teacher-id-1", fullName: "Mr. Budi", role: "Wali 1A" }], []]); // reselect teacher

    await createTeacher(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO teachers"),
      ["teacher-id-1", "Mr. Budi", "Wali 1A", "Jl. C", "083", 5, "existing-user-id"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(6, expect.stringContaining("UPDATE classes SET teacher_id = ?"), ["teacher-id-1", 1]);
    expect(pool.query).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("SELECT id, username, email, role_id FROM users WHERE id = ?"),
      ["existing-user-id"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(8, expect.stringContaining("SELECT * FROM teachers WHERE id = ?"), ["teacher-id-1"]);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menambahkan wali kelas",
      data: {
        id: "existing-user-id",
        username: "existing",
        email: "existing@x.com",
        role_id: 4,
        teacher: { id: "teacher-id-1", fullName: "Mr. Budi", role: "Wali 1A" },
      },
    });
  });

  it("guard: existing user that already has a teacher record", async () => {
    const req = {
      user: { id: "admin-id" },
      body: { classId: 1, username: "existing", email: "existing@x.com", password: "p" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, teacher_id: null }], []])
      .mockResolvedValueOnce([[{ id: "existing-user-id" }], []])
      .mockResolvedValueOnce([[{ id: "already-a-teacher" }], []]);

    await createTeacher(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Username atau email sudah digunakan", error: null });
  });

  it("creates a brand new user + teacher and links the class when no existing user matches", async () => {
    randomUUID.mockReturnValueOnce("user-id-1").mockReturnValueOnce("teacher-id-1");
    const req = {
      user: { id: "admin-id" },
      body: {
        classId: 1,
        username: "newteacher",
        email: "new@x.com",
        password: "plain",
        role_id: 4,
        fullName: "Ms. Citra",
        role: "Wali 2A",
        address: "Jl. D",
        phone: "084",
      },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, teacher_id: null }], []])
      .mockResolvedValueOnce([[], []]) // no existing user
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT INTO users
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT INTO teachers
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE classes
      .mockResolvedValueOnce([[{ id: "user-id-1", username: "newteacher", email: "new@x.com", role_id: 4 }], []]) // reselect user
      .mockResolvedValueOnce([[{ id: "teacher-id-1", fullName: "Ms. Citra" }], []]); // reselect teacher

    await createTeacher(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO users"),
      ["user-id-1", "newteacher", "new@x.com", "hashed-password", 4]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO teachers"),
      ["teacher-id-1", "Ms. Citra", "Wali 2A", "Jl. D", "084", 5, "user-id-1"]
    );
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menambahkan wali kelas",
      data: { id: "user-id-1", username: "newteacher", email: "new@x.com", role_id: 4, teacher: { id: "teacher-id-1", fullName: "Ms. Citra" } },
    });
  });

  it("returns 500 via errorResponse when a query rejects", async () => {
    const req = { user: { id: "admin-id" }, body: { classId: 1, username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await createTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat menambahkan wali kelas",
      error: "connection lost",
    });
  });
});

describe("updateTeacher", () => {
  it("nulls the old class then assigns the class named by `role` to this teacher", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" }, body: { role: "2A", address: "Jl. E", phone: "085" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: "t1", school_id: 5 }], []]) // existing teacher
      .mockResolvedValueOnce([[{ id: 1 }], []]) // old class
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // null out old class
      .mockResolvedValueOnce([[{ id: 2, name: "2A" }], []]) // new class found by name
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // assign new class
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE teachers
      .mockResolvedValueOnce([[{ id: "t1", role: "2A", address: "Jl. E", phone: "085" }], []]); // reselect

    await updateTeacher(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(4, expect.stringContaining("UPDATE classes SET teacher_id = ?"), [null, 1]);
    expect(pool.query).toHaveBeenNthCalledWith(5, expect.stringContaining("SELECT * FROM classes WHERE name = ?"), ["2A"]);
    expect(pool.query).toHaveBeenNthCalledWith(6, expect.stringContaining("UPDATE classes SET teacher_id = ?"), ["t1", 2]);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Guru berhasil diperbarui",
      data: { id: "t1", role: "2A", address: "Jl. E", phone: "085" },
    });
  });

  it("edge: skips nulling out when the teacher has no old class", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" }, body: { role: "2A", address: "Jl. E", phone: "085" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: "t1", school_id: 5 }], []])
      .mockResolvedValueOnce([[], []]) // no old class
      .mockResolvedValueOnce([[{ id: 2, name: "2A" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: "t1" }], []]);

    await updateTeacher(req, res);

    expect(pool.query).toHaveBeenCalledTimes(7);
  });

  it("guard: 404 when the caller has no institution", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" }, body: { role: "2A" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no institution row

    await updateTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Institusi tidak ditemukan", error: 404 });
  });

  it("guard: teacher not found (404-as-500 preserved)", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "missing" }, body: { role: "2A" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[], []]);

    await updateTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Guru tidak ditemukan", error: 404 });
  });

  it("guard: 403 when the teacher does not belong to the caller's institution", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" }, body: { role: "2A" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: "t1", school_id: 99 }], []]); // teacher belongs to a different school

    await updateTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Guru bukan milik sekolah anda", error: 403 });
  });

  it("guard: target class named by `role` does not exist", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" }, body: { role: "Nonexistent" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: "t1", school_id: 5 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]); // class named "Nonexistent" not found

    await updateTeacher(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Kelas baru tidak ditemukan", error: 404 });
  });

  it("returns 500 via errorResponse when a query rejects", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" }, body: { role: "2A" } };
    const res = mockRes();

    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await updateTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat memperbarui guru",
      error: "connection lost",
    });
  });
});

describe("deleteTeacher", () => {
  it("deletes the linked users row, which cascades to remove the teacher", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: "t1", user_id: "u1", school_id: 5 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await deleteTeacher(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("DELETE FROM users WHERE id = ?"), ["u1"]);
    expect(res.json).toHaveBeenCalledWith({ status: "success", message: "Guru berhasil dihapus", data: null });
  });

  it("bug: reports success without deleting anything when the teacher has no linked user_id", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: "t1", user_id: null, school_id: 5 }], []]);

    await deleteTeacher(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith({ status: "success", message: "Guru berhasil dihapus", data: null });
  });

  it("guard: 404 when the caller has no institution", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no institution row

    await deleteTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Institusi tidak ditemukan", error: 404 });
  });

  it("guard: teacher not found (404-as-500 preserved)", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "missing" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[], []]);

    await deleteTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Guru tidak ditemukan", error: 404 });
  });

  it("guard: 403 when the teacher does not belong to the caller's institution", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: "t1", user_id: "u1", school_id: 99 }], []]); // different school

    await deleteTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Guru bukan milik sekolah anda", error: 403 });
  });

  it("returns 500 via errorResponse when a query rejects", async () => {
    const req = { user: { id: "admin-id" }, params: { id: "t1" } };
    const res = mockRes();

    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await deleteTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat menghapus teacher",
      error: "connection lost",
    });
  });
});
