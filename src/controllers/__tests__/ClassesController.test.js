import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getClasses,
  createClasses,
  updateClasses,
  deleteClasses,
  getClassesByInstitution,
} from "../ClassesController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getClasses", () => {
  it("returns paginated classes with a teacher object shaped {id, fullName}, scoped to the caller's school", async () => {
    const req = { query: {}, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [{ id: 1, name: "1A", school_id: 5, teacher_id: "t1", teacher_fullName: "Mrs. Ana" }],
        [],
      ]);

    await getClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE name LIKE ? AND school_id = ?"),
      ["%%", 5]
    );
    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("LEFT JOIN teachers"), ["%%", 5, 10, 0]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Classes retrieved successfully",
      data: {
        totalRows: 1,
        totalPage: 1,
        page: 0,
        limit: 10,
        classes: [{ id: 1, name: "1A", school_id: 5, teacher: { id: "t1", fullName: "Mrs. Ana" } }],
      },
    });
  });

  it("reshapes teacher as null when the class has no teacher_id", async () => {
    const req = { query: { search: "1A" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[{ id: 2, name: "1B", school_id: 5, teacher_id: null, teacher_fullName: null }], []]);

    await getClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE name LIKE ? AND school_id = ?"),
      ["%1A%", 5]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ classes: [{ id: 2, name: "1B", school_id: 5, teacher: null }] }),
      })
    );
  });

  it("only returns classes belonging to the caller's own school", async () => {
    const req = { query: {}, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 7 }], []]) // getUserInstitution -> school 7
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[{ id: 3, name: "3A", school_id: 7, teacher_id: null, teacher_fullName: null }], []]);

    await getClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("AND school_id = ?"),
      ["%%", 7]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("AND c.school_id = ?"),
      ["%%", 7, 10, 0]
    );
  });

  it("returns 500 via errorResponse when getUserInstitution throws (no institution)", async () => {
    const req = { query: {}, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ institution_id: null }], []]);

    await getClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Failed to retrieve classes",
      error: "User tidak terdaftar di institusi manapun",
    });
  });

  it("returns 500 via errorResponse when the count query rejects", async () => {
    const req = { query: {}, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockRejectedValueOnce(new Error("connection lost"));

    await getClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Failed to retrieve classes",
      error: "connection lost",
    });
  });
});

describe("createClasses", () => {
  it("creates every class in the array that doesn't already exist under this school", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: [{ name: "1A" }, { name: "1B" }] } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[], []]) // 1A does not exist
      .mockResolvedValueOnce([{ insertId: 10 }]) // INSERT 1A
      .mockResolvedValueOnce([[{ id: 10, name: "1A", school_id: 5 }], []]) // reselect 1A
      .mockResolvedValueOnce([[{ id: 99, name: "1B", school_id: 5 }], []]); // 1B already exists -> skipped

    await createClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE name = ? AND school_id = ?"),
      ["1A", 5]
    );
    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("INSERT INTO classes"), ["1A", 5]);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat kelas",
      data: [{ id: 10, name: "1A", school_id: 5 }],
    });
  });

  it("edge: does not roll back an earlier successful insert when a later class in the array throws", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: [{ name: "1A" }, { name: "1A" }] } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]) // first "1A" (school 5) not found -> inserted
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([[{ id: 10, name: "1A", school_id: 5 }], []])
      .mockResolvedValueOnce([[], []]) // second "1A" under a different school_id also passes the scoped check
      .mockRejectedValueOnce(new Error("Duplicate entry '1A' for key 'classes.name'")); // raw global-unique INSERT fails

    await createClasses(req, res);

    // The first class's INSERT already ran and is not undone (no transaction, no catch inside the loop).
    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("INSERT INTO classes"), ["1A", 5]);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Internal server error",
      error: "Duplicate entry '1A' for key 'classes.name'",
    });
  });

  it("creates a single class object when it doesn't exist yet", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: { name: "2A" } } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 20 }])
      .mockResolvedValueOnce([[{ id: 20, name: "2A", school_id: 5 }], []]);

    await createClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat kelas",
      data: { id: 20, name: "2A", school_id: 5 },
    });
  });

  it("bug: single-object duplicate passes 'already exists' string as the error arg, not the message", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: { name: "2A" } } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 20, name: "2A", school_id: 5 }], []]);

    await createClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Tidak dapat membuat kelas yang sudah ada",
      error: "Kelas sudah tersedia",
    });
  });

  it("returns 500 via errorResponse when getUserInstitution throws (no institution)", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: { name: "2A" } } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ institution_id: null }], []]);

    await createClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Internal server error",
      error: "User tidak terdaftar di institusi manapun",
    });
  });

  it("allows the same class name to be created in a different school than one where it already exists", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: { name: "1A" } } };
    const res = mockRes();

    // caller belongs to school 7; "1A" already exists in school 5, but not in school 7
    pool.query
      .mockResolvedValueOnce([[{ institution_id: 7 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[], []]) // no existing "1A" scoped to school 7
      .mockResolvedValueOnce([{ insertId: 30 }])
      .mockResolvedValueOnce([[{ id: 30, name: "1A", school_id: 7 }], []]);

    await createClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE name = ? AND school_id = ?"),
      ["1A", 7]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat kelas",
      data: { id: 30, name: "1A", school_id: 7 },
    });
  });

  it("rejects a duplicate class name within the same school", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: { name: "1A" } } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[{ id: 10, name: "1A", school_id: 5 }], []]); // already exists in school 5

    await createClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE name = ? AND school_id = ?"),
      ["1A", 5]
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Tidak dapat membuat kelas yang sudah ada",
      error: "Kelas sudah tersedia",
    });
  });
});

describe("updateClasses", () => {
  it("updates the class name and cascades to the teacher's role when teacher_id is set", async () => {
    const req = { params: { id: "1" }, body: { name: "1A Renamed" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[{ id: 1, name: "1A", school_id: 5, teacher_id: "t1" }], []]) // existing
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE classes
      .mockResolvedValueOnce([[{ id: 1, name: "1A Renamed", school_id: 5, teacher_id: "t1" }], []]) // reselect
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE teachers

    await updateClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("UPDATE classes SET name = ?"), ["1A Renamed", 1]);
    expect(pool.query).toHaveBeenNthCalledWith(5, expect.stringContaining("UPDATE teachers SET role = ?"), ["1A Renamed", "t1"]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Kelas berhasil diperbarui",
      data: { id: 1, name: "1A Renamed", school_id: 5, teacher_id: "t1" },
    });
  });

  it("skips the teacher cascade when the class has no teacher_id", async () => {
    const req = { params: { id: "2" }, body: { name: "2A" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 2, name: "2A-old", school_id: 5, teacher_id: null }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: 2, name: "2A", school_id: 5, teacher_id: null }], []]);

    await updateClasses(req, res);

    expect(pool.query).toHaveBeenCalledTimes(4);
  });

  it("bug: not-found guard passes literal 404 as the error arg, resolving to HTTP 500", async () => {
    const req = { params: { id: "999" }, body: { name: "X" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]);

    await updateClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Kelas tidak ditemukan",
      error: 404,
    });
  });

  it("returns 403 when the class belongs to a different school than the caller's", async () => {
    const req = { params: { id: "1" }, body: { name: "1A Renamed" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // caller's school is 5
      .mockResolvedValueOnce([[{ id: 1, name: "1A", school_id: 99, teacher_id: "t1" }], []]); // class belongs to school 99

    await updateClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Kelas bukan milik sekolah anda",
      error: 403,
    });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("returns 500 via errorResponse when getUserInstitution throws (no institution)", async () => {
    const req = { params: { id: "1" }, body: { name: "1A Renamed" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ institution_id: null }], []]);

    await updateClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat memperbarui kelas",
      error: "User tidak terdaftar di institusi manapun",
    });
  });

  it("returns 500 via errorResponse when the UPDATE query rejects", async () => {
    const req = { params: { id: "1" }, body: { name: "1A Renamed" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, name: "1A", school_id: 5, teacher_id: "t1" }], []])
      .mockRejectedValueOnce(new Error("connection lost"));

    await updateClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat memperbarui kelas",
      error: "connection lost",
    });
  });
});

describe("deleteClasses", () => {
  it("nulls the teacher's role before deleting the class", async () => {
    const req = { params: { id: "1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[{ id: 1, school_id: 5, teacher_id: "t1" }], []]) // existing class
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE teachers role=null
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE class

    await deleteClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("UPDATE teachers SET role = ?"), [null, "t1"]);
    expect(pool.query).toHaveBeenNthCalledWith(4, expect.stringContaining("DELETE FROM classes WHERE id = ?"), [1]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "success", message: "Kelas berhasil dihapus", data: null });
  });

  it("bug: wrong-school guard passes literal 403 as the error arg, resolving to HTTP 500", async () => {
    const req = { params: { id: "1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, school_id: 99, teacher_id: null }], []]);

    await deleteClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Kelas bukan milik sekolah anda", error: 403 });
  });

  it("guard: throws via the safe getUserInstitution helper when the caller has no institution", async () => {
    const req = { params: { id: "1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ institution_id: null }], []]);

    await deleteClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat menghapus teacher",
      error: "User tidak terdaftar di institusi manapun",
    });
  });

  it("bug: not-found guard passes literal 404 as the error arg, resolving to HTTP 500", async () => {
    const req = { params: { id: "999" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]);

    await deleteClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Kelas tidak ditemukan",
      error: 404,
    });
  });

  it("returns 500 via errorResponse when the DELETE query rejects", async () => {
    const req = { params: { id: "1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, school_id: 5, teacher_id: null }], []])
      .mockRejectedValueOnce(new Error("connection lost"));

    await deleteClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat menghapus teacher",
      error: "connection lost",
    });
  });
});

describe("getClassesByInstitution", () => {
  it("returns id+name classes for a school ordered by id", async () => {
    const req = { params: { institutionId: "5" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ id: 1, name: "1A" }, { id: 2, name: "1B" }], []]);

    await getClassesByInstitution(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM classes WHERE school_id = ? ORDER BY id ASC"),
      [5]
    );
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Kelas berhasil diambil berdasarkan institusi",
      data: [{ id: 1, name: "1A" }, { id: 2, name: "1B" }],
    });
  });

  it("returns 500 via errorResponse when the query rejects", async () => {
    const req = { params: { institutionId: "5" } };
    const res = mockRes();

    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await getClassesByInstitution(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat mengambil kelas berdasarkan institusi",
      error: "connection lost",
    });
  });
});
