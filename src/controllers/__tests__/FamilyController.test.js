import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getFamily,
  getFamilyMemberByUser,
  getFamilyMember,
  getParentsByFamilyMemberId,
} from "../FamilyController.js";

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

describe("getFamily", () => {
  it("returns families joined with user and role", async () => {
    pool.query.mockResolvedValueOnce([
      [
        {
          family_id: "family-1",
          user_id: "user-1",
          user_username: "budi",
          user_email: "budi@example.com",
          role_id: 2,
          role_name: "parent",
        },
      ],
      [],
    ]);

    const req = {};
    const res = mockRes();

    await getFamily(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("JOIN users u ON u.id = f.userId"),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Family retrieved successfully",
      data: [
        {
          id: "family-1",
          user: {
            id: "user-1",
            username: "budi",
            email: "budi@example.com",
            role: { id: 2, name: "parent" },
          },
        },
      ],
    });
  });

  it("returns an error response when the query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const req = {};
    const res = mockRes();

    await getFamily(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("error");
    expect(body.message).toBe("Failed to retrieve family");
  });
});

describe("getFamilyMemberByUser", () => {
  it("returns paginated family members with joined job/socioEconomic/nutrition/student data", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[{ count: 1 }], []]) // COUNT(*)
      .mockResolvedValueOnce([
        [
          {
            fm_id: "fm-1",
            fm_fullName: "Anak Satu",
            fm_birthDate: "2020-01-01",
            fm_age: null,
            fm_education: "SD",
            fm_gender: "L",
            fm_relation: "ANAK",
            fm_phone: "0800",
            fm_isCompleted: 1,
            job_id: null,
            jobType_id: null,
            jobType_name: null,
            se_id: 5,
            se_residenceStatus: "MILIK_SENDIRI",
            se_address: "Jl. Mawar",
            se_childrenCount: "SATU",
            se_underFiveCount: "TIDAK_ADA",
            se_familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
            nu_id: 9,
            nu_height: 90,
            nu_weight: 12,
            nu_bmi: 14.8,
            ns_id: 1,
            ns_information: "info",
            ns_displayName: "Gizi Baik",
            st_id: "student-1",
            st_nis: "12345",
            st_schoolYear: "2025/2026",
            st_semester: "1",
            class_id: 3,
            class_name: "Kelas 1A",
            inst_id: 7,
            inst_name: "SD Negeri 1",
            inst_email: "sdn1@example.com",
            inst_address: "Jl. Sekolah",
            inst_phone: "0811",
            itp_id: 1,
            itp_name: "Sekolah",
            prov_id: 32,
            prov_name: "Jawa Barat",
            city_id: 320,
            city_name: "Bandung",
          },
        ],
        [],
      ]); // main JOIN query

    const req = {
      query: { page: "0", limit: "10", search: "" },
      user: { id: "user-1" },
    };
    const res = mockRes();

    await getFamilyMemberByUser(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM families WHERE userId = ?"),
      ["user-1"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("family_members WHERE familyId IN (?)"),
      [["family-1"], "%%"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("JOIN socio_economic se ON se.id = fm.socioEconomicId"),
      [["family-1"], "%%"],
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.totalRows).toBe(1);
    expect(body.data.familyMembers[0]).toEqual({
      id: "fm-1",
      fullName: "Anak Satu",
      birthDate: "2020-01-01",
      age: null,
      education: "SD",
      gender: "L",
      relation: "ANAK",
      phone: "0800",
      job: null,
      SocioEconomic: {
        id: 5,
        residenceStatus: "MILIK_SENDIRI",
        address: "Jl. Mawar",
        childrenCount: "SATU",
        underFiveCount: "TIDAK_ADA",
        familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
      },
      nutrition: [
        {
          id: 9,
          height: 90,
          weight: 12,
          bmi: 14.8,
          nutritionStatus: { id: 1, information: "info", displayName: "Gizi Baik" },
        },
      ],
      student: {
        id: "student-1",
        nis: "12345",
        schoolYear: "2025/2026",
        semester: "1",
        class: { id: 3, name: "Kelas 1A" },
        institution: {
          id: 7,
          name: "SD Negeri 1",
          email: "sdn1@example.com",
          address: "Jl. Sekolah",
          institution_type: { id: 1, name: "Sekolah" },
          phone: "0811",
          province: { id: 32, name: "Jawa Barat" },
          city: { id: 320, name: "Bandung" },
        },
      },
      isCompleted: true,
    });
  });

  it("returns an empty result without querying family_members when the user has no families (and never hits the dead !family guard)", async () => {
    pool.query.mockResolvedValueOnce([[], []]); // families lookup returns zero rows

    const req = {
      query: {},
      user: { id: "user-with-no-family" },
    };
    const res = mockRes();

    await getFamilyMemberByUser(req, res);

    // Only the families lookup ran — the empty-familyIds guard short-circuits
    // before any IN (?) query (an empty IN() is a MySQL syntax error), and it
    // returns success (not the dead "Family not found" errorResponse, since
    // `family` is an array — always truthy — even when empty).
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Family Member retrieved successfully",
      data: { totalRows: 0, totalPage: 0, page: 0, limit: 10, familyMembers: [] },
    });
  });

  it("returns an error response when a query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const req = {
      query: {},
      user: { id: "user-1" },
    };
    const res = mockRes();

    await getFamilyMemberByUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("error");
    expect(body.message).toBe("Failed to retrieve family member");
  });
});

describe("getFamilyMember", () => {
  it("returns paginated family members ordered by id with LIMIT/OFFSET applied", async () => {
    pool.query
      .mockResolvedValueOnce([[{ count: 1 }], []])
      .mockResolvedValueOnce([
        [{ id: "fm-1", fullName: "Budi", isCompleted: 0 }],
        [],
      ]);

    const req = { query: { page: "1", limit: "5", search: "Bud" } };
    const res = mockRes();

    await getFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS count FROM family_members WHERE fullName LIKE ?"),
      ["%Bud%"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ORDER BY id ASC LIMIT ? OFFSET ?"),
      ["%Bud%", 5, 5],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.familyMembers).toEqual([
      { id: "fm-1", fullName: "Budi", isCompleted: false },
    ]);
  });

  it("returns an error response when the query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const req = { query: {} };
    const res = mockRes();

    await getFamilyMember(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("error");
    expect(body.message).toBe("Failed to retrieve family member");
  });
});

describe("getParentsByFamilyMemberId", () => {
  it("returns IBU/AYAH parents for the family member's family", async () => {
    pool.query
      .mockResolvedValueOnce([[{ familyId: "family-1" }], []])
      .mockResolvedValueOnce([
        [
          {
            fm_id: "parent-1",
            fm_fullName: "Ibu Satu",
            fm_birthDate: "1990-01-01",
            fm_age: 34,
            fm_education: "S1",
            fm_phone: "0800",
            job_id: 2,
            jobType_id: 3,
            jobType_name: "ASN",
            se_id: 5,
            se_residenceStatus: "MILIK_SENDIRI",
            se_address: "Jl. Mawar",
            se_childrenCount: "SATU",
            se_underFiveCount: "TIDAK_ADA",
            se_familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
          },
        ],
        [],
      ]);

    const req = { params: { id: "child-1" } };
    const res = mockRes();

    await getParentsByFamilyMemberId(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT familyId FROM family_members WHERE id = ?"),
      ["child-1"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("fm.relation = 'AYAH' OR fm.relation = 'IBU'"),
      ["family-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data[0]).toEqual({
      id: "parent-1",
      fullName: "Ibu Satu",
      birthDate: "1990-01-01",
      age: 34,
      education: "S1",
      phone: "0800",
      job: { id: 2, jobType: { id: 3, name: "ASN" } },
      SocioEconomic: {
        id: 5,
        residenceStatus: "MILIK_SENDIRI",
        address: "Jl. Mawar",
        childrenCount: "SATU",
        underFiveCount: "TIDAK_ADA",
        familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
      },
    });
  });

  it("returns 'Family member not found' when the member does not exist", async () => {
    pool.query.mockResolvedValueOnce([[], []]);

    const req = { params: { id: "missing-id" } };
    const res = mockRes();

    await getParentsByFamilyMemberId(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family member not found",
      error: null,
    });
  });

  it("returns an error response when the query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const req = { params: { id: "child-1" } };
    const res = mockRes();

    await getParentsByFamilyMemberId(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("error");
    expect(body.message).toBe("Failed to retrieve parents");
  });
});
