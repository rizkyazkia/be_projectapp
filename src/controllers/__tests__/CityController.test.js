import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getCities,
  getCitiesByProvince,
  createCity,
} from "../CityController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCities", () => {
  it("returns all cities", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[{ id: 1, name: "Bandung" }], []]);

    await getCities(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM cities")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Cities retrieved successfully",
      data: [{ id: 1, name: "Bandung" }],
    });
  });
});

describe("getCitiesByProvince", () => {
  it("returns cities filtered by province_id", async () => {
    const req = { params: { id: "3" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [{ id: 1, name: "Bandung", province_id: 3 }],
      [],
    ]);

    await getCitiesByProvince(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM cities WHERE province_id = ?"),
      [3]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil mendapatkan data kota berdasarkan provinsi",
      data: [{ id: 1, name: "Bandung", province_id: 3 }],
    });
  });
});

describe("createCity", () => {
  it("inserts a city under a province then returns the re-selected row", async () => {
    const req = { params: { id: "3" }, body: { name: "Bandung" } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([{ insertId: 7, affectedRows: 1 }, []])
      .mockResolvedValueOnce([
        [{ id: 7, name: "Bandung", province_id: 3 }],
        [],
      ]);

    await createCity(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO cities"),
      ["Bandung", 3]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT id, name, province_id FROM cities WHERE id = ?"),
      [7]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menambahkan kota baru",
      data: { id: 7, name: "Bandung", province_id: 3 },
    });
  });
});
