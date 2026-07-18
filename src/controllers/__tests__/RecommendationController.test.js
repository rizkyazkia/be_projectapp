import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getRecomendations } from "../RecommendationController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRecomendations", () => {
  it("scopes to the healthcare institution and returns nested paginated data", async () => {
    const req = {
      user: { id: "u-health-1", role: "healthcare" },
      query: { page: "0", limit: "10" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []]) // institution lookup
      .mockResolvedValueOnce([[{ count: 1 }], []]) // count query
      .mockResolvedValueOnce([
        [
          {
            id: "rec-1",
            status: "PENDING",
            createdAt: new Date("2026-01-01"),
            submittedBy_id: "u-school-1",
            si_id: 3,
            si_name: "SD Negeri 1",
            si_address: "Jl. A",
            si_phone: "0800",
            si_email: "sd@x.com",
            sic_id: 1,
            sic_name: "Bandung",
            sip_id: 1,
            sip_name: "Jawa Barat",
            student_id: "st-1",
            student_nis: "12345",
            student_schoolYear: "2025/2026",
            student_semester: "1",
            sti_id: 3,
            sti_name: "SD Negeri 1",
            sti_address: "Jl. A",
            sti_phone: "0800",
            sti_email: "sd@x.com",
            stic_id: 1,
            stic_name: "Bandung",
            stip_id: 1,
            stip_name: "Jawa Barat",
            class_id: 9,
            class_name: "5A",
            fm_id: "fm-1",
            fm_fullName: "Budi",
            fm_birthDate: new Date("2015-01-01"),
            fm_gender: "L",
            fm_familyId: "fam-1",
            se_id: 4,
            se_address: "Jl. Rumah",
          },
        ],
        [],
      ]) // main list query
      .mockResolvedValueOnce([
        [{ id: 20, familyMemberId: "fm-1", ns_id: 2, ns_information: "Gizi Baik" }],
        [],
      ]); // nutrition follow-up query

    await getRecomendations(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM institutions WHERE user_id = ?"),
      ["u-health-1"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT COUNT(*) AS count FROM recommendations r"),
      [7],
    );
    expect(pool.query.mock.calls[2][0]).toContain("r.healthcareInstitutionId = ?");
    expect(pool.query.mock.calls[2][1]).toEqual([7, 10, 0]);
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("FROM nutritions n"),
      [["fm-1"]],
    );

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("success");
    expect(data.data.totalRows).toBe(1);
    expect(data.data.recomend[0].student.familyMember.nutrition).toEqual([
      { id: 20, nutritionStatus: { id: 2, information: "Gizi Baik" } },
    ]);
    expect(data.data.recomend[0].student.familyMember.SocioEconomic).toEqual({
      address: "Jl. Rumah",
    });
  });

  it("applies no institution filter and skips the nutrition query when no family members are returned", async () => {
    const req = {
      user: { id: "u-admin", role: "admin" },
      query: {},
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ count: 0 }], []]) // count query (no institution lookup for this role)
      .mockResolvedValueOnce([[], []]); // main list query, empty

    await getRecomendations(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).not.toContain("WHERE");
    const [data] = res.json.mock.calls[0];
    expect(data.data.recomend).toEqual([]);
    expect(data.data.totalRows).toBe(0);
  });

  it("returns a 500 error response when a query rejects", async () => {
    const req = {
      user: { id: "u-health-1", role: "healthcare" },
      query: { page: "0", limit: "10" },
    };
    const res = mockRes();

    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await getRecomendations(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.message).toBe("Internal server error");
    expect(data.error).toBe("connection lost");
  });
});
