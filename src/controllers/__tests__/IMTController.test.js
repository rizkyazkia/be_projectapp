import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { calculateIMT } from "../IMTController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("calculateIMT", () => {
  it("returns 400 when a required field is missing (guard clause, no DB call)", async () => {
    const req = {
      body: { gender: "L", ageMonths: 24, weightKg: "", heightCm: 90 },
    };
    const res = mockRes();

    await calculateIMT(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Semua field wajib diisi",
      error: null,
    });
  });

  it("returns 404 when no bmi reference row matches the age/gender", async () => {
    const req = {
      body: { gender: "L", ageMonths: 24, weightKg: 12, heightCm: 90 },
    };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await calculateIMT(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM bmi_references"),
      ["L", 2, 0, 0]
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Referensi BMI tidak ditemukan untuk usia ini",
      error: null,
    });
  });

  it("computes BMI and returns the normal-status shape on the success path", async () => {
    const req = {
      body: { gender: "L", ageMonths: 24, weightKg: 12, heightCm: 90 },
    };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        {
          id: 1,
          ageYear: 2,
          ageMonthFrom: 0,
          ageMonthTo: 11,
          gender: "L",
          sdMinus2Min: 14.0,
          sdPlus1Max: 18.0,
        },
      ],
      [],
    ]);

    await calculateIMT(req, res);

    // heightM = 0.9, bmi = 12 / (0.9*0.9) = 14.814..., rounded to 14.8,
    // which is between sdMinus2Min (14.0) and sdPlus1Max (18.0) => "baik".
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        data: expect.objectContaining({
          bmi: "14.8",
          bmiStatus: "Gizi Baik (Normal)",
          bmiCategory: "baik",
          sdMinus2: 14.0,
          sdPlus1: 18.0,
        }),
      })
    );
  });
});
