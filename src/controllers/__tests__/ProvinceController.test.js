import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getProvinces, createProvince } from "../ProvinceController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getProvinces", () => {
  it("returns all provinces", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        { id: 1, name: "Jawa Barat" },
        { id: 2, name: "Jawa Tengah" },
      ],
      [],
    ]);

    await getProvinces(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM provinces")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Province retrieved successfully",
      data: [
        { id: 1, name: "Jawa Barat" },
        { id: 2, name: "Jawa Tengah" },
      ],
    });
  });

  it("returns a 500 error when the query fails", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await getProvinces(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Failed to retrieve provinces",
      error: "connection lost",
    });
  });
});

describe("createProvince", () => {
  it("inserts a province then returns the re-selected row", async () => {
    const req = { body: { name: "Jawa Barat" } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([{ insertId: 5, affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ id: 5, name: "Jawa Barat" }], []]);

    await createProvince(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO provinces"),
      ["Jawa Barat"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT id, name FROM provinces WHERE id = ?"),
      [5]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menambahkan provinsi baru",
      data: { id: 5, name: "Jawa Barat" },
    });
  });
});
