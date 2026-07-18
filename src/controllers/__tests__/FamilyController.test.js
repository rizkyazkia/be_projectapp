import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(),
}));

import pool from "../../config/db.js";
import { randomUUID } from "node:crypto";
import {
  getFamily,
  getFamilyMemberByUser,
  getFamilyMember,
  getParentsByFamilyMemberId,
  createFamilyMember,
  updateFamilyMember,
  deleteFamilyMember,
} from "../FamilyController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

let uuidCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  randomUUID.mockImplementation(() => `uuid-${++uuidCounter}`);
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

describe("createFamilyMember", () => {
  it("returns 'Family not found' when the caller has no family yet", async () => {
    pool.query.mockResolvedValueOnce([[], []]); // families lookup, empty

    const req = {
      user: { id: "user-1" },
      body: [{ type: "ibu", relation: "IBU" }],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family not found",
      error: null,
    });
  });

  it("creates a new ibu member with a new socio_economic row and a new job row", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup (none yet)
      .mockResolvedValueOnce([{ insertId: 10 }]) // INSERT socio_economic
      .mockResolvedValueOnce([{ insertId: 20 }]) // INSERT jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT family_members

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "ibu",
          fullName: "Ibu Satu",
          age: "30",
          education: "S1",
          jobTypeId: 2,
          relation: "IBU",
          phone: "0800",
          residenceStatus: "MILIK_SENDIRI",
          address: "Jl. Mawar",
          childrenCount: "SATU",
          underFiveCount: "TIDAK_ADA",
          familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE fm.familyId = ? AND fm.relation = ?"),
      ["family-1", "IBU"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO socio_economic"),
      ["MILIK_SENDIRI", "Jl. Mawar", "SATU", "TIDAK_ADA", "LEBIH_DARI_SEPULUH_JUTA"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO jobs (jobTypeId) VALUES (?)"),
      [2],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO family_members"),
      ["uuid-1", "Ibu Satu", 30, "S1", "IBU", "family-1", "0800", 20, 10, true],
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data[0].familyMember).toEqual({
      id: "uuid-1",
      fullName: "Ibu Satu",
      age: 30,
      education: "S1",
      relation: "IBU",
      familyId: "family-1",
      phone: "0800",
      jobId: 20,
      socioEconomicId: 10,
      isCompleted: true,
    });
  });

  it("updates an existing ibu member and reuses/updates the existing job row", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([
        [{ id: "existing-fm-1", job_id: 99, job_jobTypeId: 5 }],
        [],
      ]) // existingFamilyMember lookup (found, has a job)
      .mockResolvedValueOnce([{ insertId: 11 }]) // INSERT socio_economic (still created fresh for ibu)
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE family_members

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "ibu",
          fullName: "Ibu Satu Updated",
          age: "31",
          education: "S2",
          jobTypeId: 6,
          relation: "IBU",
          phone: "0801",
          residenceStatus: "MENYEWA",
          address: "Jl. Melati",
          childrenCount: "DUA_SAMPAI_TIGA",
          underFiveCount: "SATU",
          familyIncomeLevel: "KURANG_DARI_LIMA_JUTA",
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("UPDATE jobs SET jobTypeId = ? WHERE id = ?"),
      [6, 99],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("UPDATE family_members"),
      [
        "Ibu Satu Updated",
        31,
        "S2",
        "IBU",
        "family-1",
        "0801",
        99,
        11,
        true,
        "existing-fm-1",
      ],
    );

    const body = res.json.mock.calls[0][0];
    expect(body.data[0].familyMember.id).toBe("existing-fm-1");
    expect(body.data[0].familyMember.jobId).toBe(99);
  });

  it("creates an ayah member with sameSocioEconomic reusing the IBU's socioEconomicId", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup (none)
      .mockResolvedValueOnce([[{ socioEconomicId: 10 }], []]) // IBU lookup
      .mockResolvedValueOnce([{ insertId: 21 }]) // INSERT jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT family_members

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "ayah",
          fullName: "Ayah Satu",
          age: "35",
          education: "S1",
          jobTypeId: 3,
          relation: "AYAH",
          phone: "0802",
          sameSocioEconomic: true,
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("relation = 'IBU'"),
      ["family-1"],
    );
    // No socio_economic INSERT should run when sameSocioEconomic reuses IBU's id.
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO socio_economic"),
      expect.anything(),
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO family_members"),
      ["uuid-1", "Ayah Satu", 35, "S1", "AYAH", "family-1", "0802", 21, 10, true],
    );

    const body = res.json.mock.calls[0][0];
    expect(body.data[0].familyMember.socioEconomicId).toBe(10);
  });

  it("pushes an error and continues when sameSocioEconomic is set but no IBU exists yet", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup for ayah (none)
      .mockResolvedValueOnce([[], []]) // IBU lookup — not found
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup for the 2nd member (invalid type)
      ;

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "ayah",
          relation: "AYAH",
          sameSocioEconomic: true,
        },
        {
          type: "unknown-type",
          relation: "LAINNYA",
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    // The loop must continue to the 2nd member instead of aborting.
    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe(
      "Data ibu tidak ditemukan, isi data ibu terlebih dahulu",
    );
    expect(body.error.errors).toEqual([
      {
        error: "Data ibu tidak ditemukan, isi data ibu terlebih dahulu",
        member: req.body[0],
      },
      { error: "Invalid type", member: req.body[1] },
    ]);
  });

  it("creates an anak member with bmi/nutrition/student rows derived from bmi_references", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup (none)
      .mockResolvedValueOnce([
        [{ sdMinus2Min: 14, sdPlus1Max: 20 }],
        [],
      ]) // bmi_references lookup
      .mockResolvedValueOnce([[{ id: 1, status: "GIZI_BAIK" }], []]) // nutrition_status lookup
      .mockResolvedValueOnce([[{ socioEconomicId: 10 }], []]) // parent lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT family_members
      .mockResolvedValueOnce([[], []]) // existingStudent lookup (none)
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT students
      .mockResolvedValueOnce([[], []]) // existingNutrition lookup (none)
      .mockResolvedValueOnce([{ insertId: 55 }]); // INSERT nutritions

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "anak",
          fullName: "Anak Satu",
          birthDate: "2020-01-01",
          education: "TIDAK_SEKOLAH",
          gender: "L",
          relation: "ANAK",
          phone: "0803",
          height: "90",
          weight: "13",
          nis: "12345",
          schoolYear: "2025/2026",
          semester: "1",
          schoolId: 7,
          classId: 3,
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("FROM bmi_references WHERE gender = ?"),
      expect.arrayContaining(["L"]),
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("INSERT INTO family_members"),
      expect.arrayContaining(["uuid-1", "Anak Satu", "TIDAK_SEKOLAH", "L", "ANAK", "family-1", "0803", 10, true]),
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      8,
      expect.stringContaining("INSERT INTO students"),
      ["uuid-2", "12345", "2025/2026", "1", 7, 3, "uuid-1"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      10,
      expect.stringContaining("INSERT INTO nutritions"),
      [90, 13, expect.closeTo(16.05, 1), 1, "uuid-1", "user-1"],
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data[0].student.id).toBe("uuid-2");
    expect(body.data[0].nutrition.id).toBe(55);
  });

  it("pushes an error when no bmi_references match the child's age", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([[], []]) // existingFamilyMember
      .mockResolvedValueOnce([[], []]); // bmi_references — no match

    const req = {
      user: { id: "user-1" },
      body: {
        type: "anak",
        birthDate: "2020-01-01",
        gender: "L",
        relation: "ANAK",
        height: "90",
        weight: "13",
      },
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Referensi BMI tidak ditemukan untuk usia anak ini");
  });

  it("pushes an error when neither parent has a socioEconomicId yet", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([[], []]) // existingFamilyMember
      .mockResolvedValueOnce([[{ sdMinus2Min: 14, sdPlus1Max: 20 }], []]) // bmi_references
      .mockResolvedValueOnce([[{ id: 1, status: "GIZI_BAIK" }], []]) // nutrition_status
      .mockResolvedValueOnce([[], []]); // parent lookup — none found

    const req = {
      user: { id: "user-1" },
      body: {
        type: "anak",
        birthDate: "2020-01-01",
        gender: "L",
        relation: "ANAK",
        height: "90",
        weight: "13",
      },
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Data orang tua tidak ditemukan");
  });

  it("pushes an 'Invalid type' error for unrecognized member types", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([[], []]); // existingFamilyMember lookup still runs before the type check

    const req = {
      user: { id: "user-1" },
      body: { type: "kakek", relation: "LAINNYA" },
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Invalid type");
  });
});

describe("updateFamilyMember", () => {
  it("returns 'Family member not found' when the member does not exist", async () => {
    pool.query.mockResolvedValueOnce([[], []]);

    const req = { params: { id: "missing-id" }, body: { fullName: "New Name" } };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family member not found",
      error: null,
    });
  });

  it("updates only allow-listed fields, ignores an unrecognized column-name key (SQL injection guard), and always sets isCompleted = true", async () => {
    pool.query
      .mockResolvedValueOnce([
        [{ id: "fm-1", fullName: "Old Name", gender: "L", birthDate: null }],
        [],
      ]) // fetch familyMember + nutrition + student (both empty via LEFT JOIN => no nu_id/st_id keys)
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE family_members (allow-listed fields only)
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // final UPDATE isCompleted

    const req = {
      params: { id: "fm-1" },
      body: {
        fullName: "New Name",
        phone: "0899",
        // Attempted injection: not in ALLOWED_FAMILY_MEMBER_FIELDS, must be silently dropped.
        "id = (SELECT 1); --": "malicious",
      },
    };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const [setSql, setParams] = pool.query.mock.calls[1];
    expect(setSql).toContain("UPDATE family_members SET");
    expect(setSql).not.toContain("id = (SELECT 1); --");
    expect(setSql).toContain("fullName = ?");
    expect(setSql).toContain("phone = ?");
    expect(setParams).toEqual(["New Name", "0899", "fm-1"]);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE family_members SET isCompleted = ? WHERE id = ?"),
      [true, "fm-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("silently ignores the request when every body key is unrecognized (no family_members SET query at all)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", fullName: "Old Name" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // only the final isCompleted UPDATE

    const req = {
      params: { id: "fm-1" },
      body: { "DROP TABLE family_members; --": "x" },
    };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET isCompleted = ?"),
      [true, "fm-1"],
    );
  });

  it("updates nutrition height/weight/bmi/nutritionStatusId when type is anak and a nutrition row exists", async () => {
    pool.query
      .mockResolvedValueOnce([
        [
          {
            id: "fm-1",
            gender: "L",
            birthDate: new Date("2020-01-01"),
            nu_id: 9,
            nu_height: 80,
            nu_weight: 10,
            nu_bmi: 15.6,
            nu_nutritionStatusId: 1,
          },
        ],
        [],
      ]) // fetch with nutrition present
      .mockResolvedValueOnce([[{ sdMinus2Min: 14, sdPlus1Max: 20 }], []]) // bmi_references
      .mockResolvedValueOnce([[{ id: 2, status: "GIZI_BAIK" }], []]) // nutrition_status
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE nutritions
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // final isCompleted UPDATE

    const req = {
      params: { id: "fm-1" },
      body: { type: "anak", height: "92", weight: "14" },
    };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM bmi_references WHERE gender = ?"),
      expect.arrayContaining(["L"]),
    );
    const [nutritionSql, nutritionParams] = pool.query.mock.calls[3];
    expect(nutritionSql).toContain("UPDATE nutritions SET");
    expect(nutritionParams[nutritionParams.length - 1]).toBe(9);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("creates a students row when type is anak, student fields are present, and no student exists yet", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", gender: "L", birthDate: null }], []]) // fetch, no nutrition/student
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT students
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // final isCompleted UPDATE

    const req = {
      params: { id: "fm-1" },
      body: {
        type: "anak",
        nis: "999",
        schoolYear: "2025/2026",
        semester: "2",
        schoolId: 4,
        classId: 1,
      },
    };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO students"),
      ["uuid-1", "999", "2025/2026", "2", 4, 1, "fm-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns an error response when the initial fetch query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const req = { params: { id: "fm-1" }, body: { fullName: "New Name" } };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("error");
    expect(body.message).toBe("Gagal mengupdate anggota keluarga");
  });

  it("returns an error response when the UPDATE family_members query fails", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", fullName: "Old Name" }], []])
      .mockRejectedValueOnce(new Error("update failed"));

    const req = { params: { id: "fm-1" }, body: { fullName: "New Name" } };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("error");
    expect(body.message).toBe("Gagal mengupdate anggota keluarga");
  });
});

describe("deleteFamilyMember", () => {
  it("deletes the job row then the family member when jobId is set", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", jobId: 42 }], []]) // fetch
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // DELETE jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE family_members

    const req = { params: { id: "fm-1" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("DELETE FROM jobs WHERE id = ?"),
      [42],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("DELETE FROM family_members WHERE id = ?"),
      ["fm-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("skips job deletion when jobId is null", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", jobId: null }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE family_members only

    const req = { params: { id: "fm-1" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 'Family member not found' when the member does not exist", async () => {
    pool.query.mockResolvedValueOnce([[], []]);

    const req = { params: { id: "missing-id" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family member not found",
      error: null,
    });
  });

  it("throws (replicating Prisma's P2025) when the job delete affects zero rows", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", jobId: 42 }], []])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // DELETE jobs affected nothing

    const req = { params: { id: "fm-1" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Gagal menghapus anggota keluarga");
  });

  it("throws (replicating Prisma's P2025) when the family_members delete affects zero rows", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", jobId: null }], []])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // DELETE family_members affected nothing

    const req = { params: { id: "fm-1" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Gagal menghapus anggota keluarga");
  });

  it("returns an error response when the initial fetch query fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const req = { params: { id: "fm-1" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("error");
    expect(body.message).toBe("Gagal menghapus anggota keluarga");
  });
});
