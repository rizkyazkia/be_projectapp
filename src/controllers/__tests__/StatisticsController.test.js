import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getAdminDashboardSummary,
  getParentDashboardSummary,
} from "../StatisticsController.js";

function mockReq(overrides = {}) {
  return { user: { id: "user-1" }, ...overrides };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Queues the 16 sequential pool.query calls getAdminDashboardSummary issues,
// in call order, with sane defaults. Pass `overrides[N]` (1-indexed, matching
// the numbered list in the implementation step) to replace one call's result.
function queueAdminDashboardMocks(overrides = {}) {
  const defaults = {
    1: [[{ id: 1, name: "admin" }], []], // adminRole
    2: [[{ count: 10 }], []], // totalUsers
    3: [
      [
        { role_id: 1, count: 1 },
        { role_id: 2, count: 5 },
        { role_id: 3, count: 4 },
      ],
      [],
    ], // usersByRole
    4: [
      [
        { id: 1, name: "admin" },
        { id: 2, name: "parent" },
        { id: 3, name: "school" },
      ],
      [],
    ], // roles
    5: [[{ count: 3 }], []], // totalInstitutions
    6: [
      [
        { type: 1, count: 2 },
        { type: 2, count: 1 },
      ],
      [],
    ], // instByType
    7: [
      [
        { id: 1, name: "School" },
        { id: 2, name: "Healthcare" },
      ],
      [],
    ], // instTypes
    8: [[], []], // nutrition rows (family_members LEFT JOIN nutritions LEFT JOIN nutrition_status)
    9: [[{ count: 2 }], []], // totalTeachers
    10: [[{ count: 4 }], []], // totalClasses
    11: [[{ count: 0 }], []], // totalRecommendations
    12: [[], []], // recByStatus
    13: [[{ id: 9, title: "Pelayanan Kesehatan Sekolah" }], []], // schoolQuesioner
    14: [[], []], // schools
    15: [[], []], // schoolResponses
    16: [[], []], // recentRecs
  };
  for (let i = 1; i <= 16; i++) {
    pool.query.mockResolvedValueOnce(overrides[i] ?? defaults[i]);
  }
}

describe("getAdminDashboardSummary", () => {
  it("returns a full admin dashboard summary on the happy path", async () => {
    queueAdminDashboardMocks();
    const req = mockReq();
    const res = mockRes();

    await getAdminDashboardSummary(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM roles WHERE name = ?"),
      ["admin"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.data).toEqual(
      expect.objectContaining({
        totalUsers: 10,
        totalInstitutions: 3,
        totalTeachers: 2,
        totalClasses: 4,
        totalRecommendations: 0,
      }),
    );
  });

  it("defaults adminRoleId to -1 when the admin role is missing", async () => {
    queueAdminDashboardMocks({ 1: [[], []] });
    const req = mockReq();
    const res = mockRes();

    await getAdminDashboardSummary(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("role_id != ?"),
      [-1],
    );
  });

  it("usersByRole: filters out the admin's own row and does NOT zero-fill roles with no users", async () => {
    // roles table has admin(1), parent(2), school(3), healthcare(4) — but the
    // groupBy only returned rows for admin and parent. healthcare(4) and
    // school(3) must simply be absent from userByRole, not zeroed.
    queueAdminDashboardMocks({
      3: [
        [
          { role_id: 1, count: "7" }, // string count — must be Number()-coerced
          { role_id: 2, count: 5 },
        ],
        [],
      ],
      4: [
        [
          { id: 1, name: "admin" },
          { id: 2, name: "parent" },
          { id: 3, name: "school" },
          { id: 4, name: "healthcare" },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.userByRole).toEqual([{ role: "parent", total: 5 }]);
  });

  it("institutionByType: does NOT zero-fill institution types with no institutions", async () => {
    queueAdminDashboardMocks({
      6: [[{ type: 2, count: "3" }], []],
      7: [
        [
          { id: 1, name: "School" },
          { id: 2, name: "Healthcare" },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.institutionByType).toEqual([
      { type: "Healthcare", total: 3 },
    ]);
  });

  it("nutritionDistribution: buckets the true-latest nutrition status per family member, with a Tidak Terdata catch-all", async () => {
    queueAdminDashboardMocks({
      8: [
        [
          { id: "fm-1", displayName: "Gizi Baik" },
          { id: "fm-2", displayName: null },
          { id: "fm-3", displayName: "Gizi Baik" },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      8,
      expect.stringContaining("MAX(n2.updatedAt)"),
      [],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.nutritionDistribution).toEqual(
      expect.arrayContaining([
        { displayName: "Gizi Baik", total: 2 },
        { displayName: "Tidak Terdata", total: 1 },
      ]),
    );
    expect(body.data.nutritionDistribution).toHaveLength(2);
  });

  it("recommendationsByStatus: groupBy does NOT zero-fill missing statuses (contrast with the healthcare dashboard's fixed 3-status backfill)", async () => {
    queueAdminDashboardMocks({
      12: [
        [
          { status: "PENDING", count: "2" },
          { status: "COMPLETED", count: 1 },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.recommendationsByStatus).toEqual([
      { status: "pending", total: 2 },
      { status: "selesai", total: 1 },
    ]);
  });

  it("schoolResponses: adds the quisionerId filter ONLY when schoolQuesioner exists, and JS-side zero-fills schools with no responses", async () => {
    queueAdminDashboardMocks({
      13: [[{ id: 9, title: "Pelayanan Kesehatan Sekolah" }], []],
      14: [
        [
          { id: 100, name: "School A" },
          { id: 101, name: "School B" },
        ],
        [],
      ],
      15: [[{ institutionId: 100, count: "4" }], []],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      15,
      expect.stringContaining("AND quisionerId = ?"),
      [9],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.questionnaireProgress.institutionDetails).toEqual([
      { id: 100, name: "School A", completedQuests: 4, totalQuests: 1 },
      { id: 101, name: "School B", completedQuests: 0, totalQuests: 1 },
    ]);
  });

  it("schoolResponses: drops the quisionerId filter entirely when schoolQuesioner is missing (does not bind NULL into '= ?')", async () => {
    queueAdminDashboardMocks({
      13: [[], []], // schoolQuesioner not found
      14: [[{ id: 100, name: "School A" }], []],
      15: [[{ institutionId: 100, count: 2 }], []],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    const [sql, params] = pool.query.mock.calls[14]; // 15th call, 0-indexed
    expect(sql).not.toContain("quisionerId");
    expect(params).toEqual([]);
    const body = res.json.mock.calls[0][0];
    expect(body.data.questionnaireProgress.institutionDetails[0]).toEqual({
      id: 100,
      name: "School A",
      completedQuests: 2,
      totalQuests: 0,
    });
  });

  it("recentRecommendations: INNER JOINs student/familyMember/institution and maps to the flattened shape", async () => {
    queueAdminDashboardMocks({
      16: [
        [
          {
            id: "rec-1",
            createdAt: new Date("2026-07-01T00:00:00Z"),
            status: "PROCESSED",
            studentName: "Budi",
            institutionName: "School A",
          },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      16,
      expect.stringContaining("INNER JOIN students"),
      [],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.recentRecommendations).toEqual([
      {
        id: "rec-1",
        studentName: "Budi",
        institutionName: "School A",
        status: "proses",
        createdAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);
  });

  it("returns the errorResponse shape when pool.query rejects", async () => {
    pool.query.mockRejectedValueOnce(new Error("connection refused"));
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to get admin dashboard summary",
      }),
    );
  });
});

describe("getParentDashboardSummary", () => {
  it("returns the errorResponse default (500) shape when the family is not found, and issues no further queries", async () => {
    pool.query.mockResolvedValueOnce([[], []]); // families lookup — empty
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family not found",
      error: null,
    });
  });

  it("guards the empty-members case: skips nutrition/students/socioEconomic queries entirely when the family has no members", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([[], []]); // family_members — empty
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    const body = res.json.mock.calls[0][0];
    expect(body.data.totalFamilyMembers).toBe(0);
    expect(body.data.totalChildren).toBe(0);
    expect(body.data.questionnaireProgress).toBe(0);
    expect(body.data.schoolHealthService).toBeNull();
  });

  it("guards on parent existence separately from the empty-members guard: skips totalQuestionnaires/parentResponses when there is no IBU/AYAH member, but still runs nutrition/students/socioEconomic for the ANAK member", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [
          {
            id: "child-1",
            fullName: "Anak Satu",
            relation: "ANAK",
            socioEconomicId: 1,
            education: null,
          },
        ],
        [],
      ]) // family_members — only a child, no parent
      .mockResolvedValueOnce([[], []]) // nutrition rows
      .mockResolvedValueOnce([[], []]) // students rows
      .mockResolvedValueOnce([[], []]); // socio_economic rows
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(5);
    const body = res.json.mock.calls[0][0];
    expect(body.data.totalQuestionnaires).toBe(0);
    expect(body.data.questionnaireResults).toEqual([]);
  });

  it("composes the true-latest nutrition per member from a separately-fetched, correlated-subquery-ordered query (same true-latest pattern as the admin dashboard)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [
          {
            id: "child-1",
            fullName: "Anak Satu",
            relation: "ANAK",
            socioEconomicId: 1,
            education: null,
          },
        ],
        [],
      ]) // family_members
      .mockResolvedValueOnce([
        [
          {
            familyMemberId: "child-1",
            id: 5,
            height: 90,
            weight: 12,
            bmi: 14.8,
            updatedAt: new Date("2026-07-10T00:00:00Z"),
            displayName: "Gizi Baik",
          },
        ],
        [],
      ]) // nutrition rows
      .mockResolvedValueOnce([[], []]) // students rows
      .mockResolvedValueOnce([[{ id: 1, residenceStatus: null }], []]); // socio_economic rows
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("MAX(n2.updatedAt)"),
      [["child-1"]],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.latestNutritionStatus).toBe("Gizi Baik");
    expect(body.data.nutritionDistribution).toEqual([
      { displayName: "Gizi Baik", total: 1 },
    ]);
  });

  it("parentResponses: INNER JOINs quesioners (required relation) and reads the flat r.quisionerId column directly, not a nested quesioner.id (preserving original non-typo behavior)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [
          {
            id: "parent-1",
            fullName: "Ibu Satu",
            relation: "IBU",
            socioEconomicId: 1,
            education: "SMA",
          },
        ],
        [],
      ]) // family_members
      .mockResolvedValueOnce([[], []]) // nutrition rows
      .mockResolvedValueOnce([[], []]) // students rows
      .mockResolvedValueOnce([[{ id: 1, residenceStatus: null }], []]) // socio_economic rows
      .mockResolvedValueOnce([[{ count: 2 }], []]) // totalQuestionnaires
      .mockResolvedValueOnce([
        [
          {
            id: "resp-1",
            quisionerId: 42,
            totalScore: 40,
            quesionerTitle: "Kebiasaan Sehari-hari Anak",
          },
        ],
        [],
      ]); // parentResponses
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("title IN (?)"),
      [["Tingkat Pengetahuan Gizi Seimbang", "Kebiasaan Sehari-hari Anak"]],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("INNER JOIN quesioners"),
      ["parent-1"],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.questionnaireResults).toEqual([
      {
        quesionerId: 42, // from the flat r.quisionerId column
        title: "Kebiasaan Sehari-hari Anak",
        totalScore: 40,
        interpretation: "Baik",
      },
    ]);
  });

  it("schoolHealthService: stays null when no child has a schoolId (queries 8/9 are skipped)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "child-1",
            fullName: "Anak Satu",
            relation: "ANAK",
            socioEconomicId: 1,
            education: null,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]) // students rows — no student record at all
      .mockResolvedValueOnce([[{ id: 1, residenceStatus: null }], []]);
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(5);
    const body = res.json.mock.calls[0][0];
    expect(body.data.schoolHealthService).toBeNull();
  });

  it("schoolHealthService: fetches schoolQuesioner + latest response when a child has a schoolId, applies the 17-point Tinggi/Rendah threshold", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "child-1",
            fullName: "Anak Satu",
            relation: "ANAK",
            socioEconomicId: 1,
            education: null,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [{ id: "stu-1", familyMemberId: "child-1", schoolId: 200 }],
        [],
      ]) // students rows
      .mockResolvedValueOnce([[{ id: 1, residenceStatus: null }], []])
      .mockResolvedValueOnce([
        [{ id: 9, title: "Pelayanan Kesehatan Sekolah" }],
        [],
      ]) // schoolQuesioner
      .mockResolvedValueOnce([[{ id: "resp-2", totalScore: 20 }], []]); // schoolResponse
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("ORDER BY created_at DESC"),
      [200, 9],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.schoolHealthService).toEqual({
      title: "Pelayanan Kesehatan Sekolah",
      totalScore: 20,
      interpretation: "Tinggi",
    });
  });

  it("socioEconomic: computes totalScore from the composed SocioEconomic row and applies the 8-point Menengah-Tinggi/Rendah threshold", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "parent-1",
            fullName: "Ibu Satu",
            relation: "IBU",
            socioEconomicId: 5,
            education: "SD",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [
          {
            id: 5,
            residenceStatus: "MILIK_SENDIRI", // 3
            childrenCount: "SATU", // 3
            underFiveCount: "TIDAK_ADA", // 4
            familyIncomeLevel: "KURANG_DARI_LIMA_JUTA", // 1
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ count: 2 }], []])
      .mockResolvedValueOnce([[], []]);
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.socioEconomic).toEqual(
      expect.objectContaining({ totalScore: 11, interpretation: "Menengah-Tinggi" }),
    );
    expect(body.data.parentEducation.ibu).toEqual({
      education: "SD",
      category: "Dasar",
    });
  });

  it("returns the errorResponse shape when a pool.query call genuinely rejects (not the family-not-found early return)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families — found, so we pass the early-return guard
      .mockRejectedValueOnce(new Error("connection refused")); // members query — actually throws
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to get dashboard summary",
      }),
    );
  });
});
