import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getStudents, getStudentByUser } from "../StudentController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

function fullRow(overrides = {}) {
  return {
    fm_id: "fm-1",
    fm_fullName: "Budi",
    n_id: 1,
    n_height: 120,
    n_weight: 25,
    n_bmi: 17.3,
    ns_id: 2,
    ns_information: "Normal",
    ns_displayName: "Gizi Baik",
    s_id: "st-1",
    s_nis: "12345",
    s_schoolYear: "2025/2026",
    s_semester: "1",
    i_id: 7,
    i_name: "SDN 1",
    i_address: "Jl. Mawar",
    i_phone: "0811",
    i_email: "sdn1@x.com",
    pr_id: 3,
    pr_name: "Jawa Barat",
    ci_id: 4,
    ci_name: "Bandung",
    c_id: 5,
    c_name: "6A",
    t_id: "t-1",
    t_fullName: "Bu Guru",
    t_address: "Jl. Melati",
    t_phone: "0822",
    ...overrides,
  };
}

describe("getStudents", () => {
  it("returns paginated students with all joined relations reshaped", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[fullRow()], []]);

    const req = { query: {} };
    const res = mockRes();

    await getStudents(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "WHERE fm.relation = 'ANAK' AND fm.education = 'SD' AND fm.fullName LIKE ?"
      ),
      ["%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("LEFT JOIN teachers t ON t.id = c.teacher_id"),
      ["%%", 10, 0]
    );
    // getStudents' student relation is optional (no nested where-filter), unlike
    // getStudentByUser's INNER JOIN below - this LEFT JOIN must not become an INNER JOIN.
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("LEFT JOIN students s ON s.familyMemberId = fm.id"),
      ["%%", 10, 0]
    );

    const [[body]] = res.json.mock.calls;
    const student = body.data.students[0];
    expect(student).toEqual({
      id: "fm-1",
      fullName: "Budi",
      nutrition: [
        {
          id: 1,
          height: 120,
          weight: 25,
          bmi: 17.3,
          nutritionStatus: { id: 2, information: "Normal", displayName: "Gizi Baik" },
        },
      ],
      student: {
        id: "st-1",
        nis: "12345",
        schoolYear: "2025/2026",
        semester: "1",
        institution: {
          id: 7,
          name: "SDN 1",
          address: "Jl. Mawar",
          phone: "0811",
          email: "sdn1@x.com",
          province: { id: 3, name: "Jawa Barat" },
          city: { id: 4, name: "Bandung" },
        },
        class: {
          id: 5,
          name: "6A",
          teacher: { id: "t-1", fullName: "Bu Guru", address: "Jl. Melati", phone: "0822" },
        },
      },
    });
  });

  it("nulls out nutrition and student (and its nested relations) when the joins have no match", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [
          fullRow({
            n_id: null,
            n_height: null,
            n_weight: null,
            n_bmi: null,
            ns_id: null,
            ns_information: null,
            ns_displayName: null,
            s_id: null,
            s_nis: null,
            s_schoolYear: null,
            s_semester: null,
            i_id: null,
            i_name: null,
            i_address: null,
            i_phone: null,
            i_email: null,
            pr_id: null,
            pr_name: null,
            ci_id: null,
            ci_name: null,
            c_id: null,
            c_name: null,
            t_id: null,
            t_fullName: null,
            t_address: null,
            t_phone: null,
          }),
        ],
        [],
      ]);

    const req = { query: {} };
    const res = mockRes();

    await getStudents(req, res);

    const [[body]] = res.json.mock.calls;
    const student = body.data.students[0];
    expect(student.nutrition).toEqual([]);
    expect(student.student).toBeNull();
  });

  it("returns a 500 error response when the count query rejects", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const req = { query: {} };
    const res = mockRes();

    await getStudents(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to retrieve students",
      })
    );
  });
});

describe("getStudentByUser", () => {
  it("returns a 500 (arg-order bug preserved) when the user role is not 'school'", async () => {
    const req = { user: { id: "user-1", role: "parent" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "User not found or not associated with an institution",
      })
    );
  });

  it("returns a 500 (arg-order bug preserved) when no institution is found for the user", async () => {
    pool.query.mockResolvedValueOnce([[], []]);
    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Institution not found for this user" })
    );
  });

  it("filters by class name (exact match) when a class query param is given, and flags isRecommending", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []]) // institution lookup
      .mockResolvedValueOnce([[{ total: 1 }], []]) // count
      .mockResolvedValueOnce([[fullRow()], []]) // page
      .mockResolvedValueOnce([
        [{ id: "rec-1", studentId: "st-1", status: "PENDING" }],
        [],
      ]) // recommendations
      .mockResolvedValueOnce([[], []]); // health quesioner lookup (not found)

    const req = {
      user: { id: "user-1", role: "school" },
      query: { class: "6A" },
    };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("AND c.name = ?"),
      ["%%", 7, "6A"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(
        "INNER JOIN students s ON s.familyMemberId = fm.id"
      ),
      ["%%", 7, "6A", 10, 0]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining(
        "SELECT id, studentId, status FROM recommendations WHERE studentId IN (?)"
      ),
      [["st-1"]]
    );

    const [[body]] = res.json.mock.calls;
    expect(body.data.students[0].isRecommending).toBe(true);
    expect(body.data.students[0].completedRecommendation).toBeNull();
  });

  it("flags completedRecommendation when a COMPLETED recommendation exists for the student", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[fullRow()], []])
      .mockResolvedValueOnce([
        [{ id: "rec-9", studentId: "st-1", status: "COMPLETED" }],
        [],
      ])
      .mockResolvedValueOnce([[], []]); // health quesioner lookup (not found)

    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    const [[body]] = res.json.mock.calls;
    expect(body.data.students[0].isRecommending).toBe(false);
    expect(body.data.students[0].completedRecommendation).toEqual({
      id: "rec-9",
      status: "COMPLETED",
    });
  });

  it("skips the recommendations query when the page has no students, but still runs the school-health lookup", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]); // health quesioner lookup (not found)

    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining(
        "SELECT id FROM quesioners WHERE title = ? LIMIT 1"
      ),
      ["Pelayanan Kesehatan Sekolah"]
    );
    const [[body]] = res.json.mock.calls;
    expect(body.data.students).toEqual([]);
  });

  it("uses a LEFT JOIN for the class relation (optional) unlike the INNER JOIN on students", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[fullRow()], []])
      .mockResolvedValueOnce([[], []]) // recommendations
      .mockResolvedValueOnce([[], []]); // health quesioner lookup (not found)

    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("LEFT JOIN classes c ON c.id = s.classId"),
      ["%%", 7, 10, 0]
    );
    // The required relation itself (unlike getStudents' optional LEFT JOIN above)
    // must be an INNER JOIN, since the original Prisma nested where-filter required it to exist.
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INNER JOIN students s ON s.familyMemberId = fm.id"),
      ["%%", 7, 10, 0]
    );
  });

  it("allows role 'teacher' (not just 'school') and resolves the institution via the teacher's school", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []]) // getInstitutionByUser (teacher branch)
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]); // health quesioner lookup (not found)

    const req = { user: { id: "user-1", role: "teacher" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("JOIN institutions i ON i.id = t.school_id"),
      ["user-1"]
    );
    const [[body]] = res.json.mock.calls;
    expect(body.status).toBe("success");
  });

  it("computes a conclusion using family socio-economic/education/questionnaire data and the school health score", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []]) // institution lookup
      .mockResolvedValueOnce([[{ total: 1 }], []]) // count
      .mockResolvedValueOnce([
        [
          fullRow({
            fm_familyId: "fam-1",
            ns_displayName: "GIZI BAIK",
          }),
        ],
        [],
      ]) // page
      .mockResolvedValueOnce([[], []]) // recommendations (no students matched -> actually st-1 present, so empty means no active/completed)
      .mockResolvedValueOnce([
        [
          {
            id: "parent-1",
            familyId: "fam-1",
            relation: "IBU",
            education: "S1",
            residenceStatus: "MILIK_SENDIRI",
            childrenCount: "SATU",
            underFiveCount: "TIDAK_ADA",
            familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
          },
        ],
        [],
      ]) // family parent lookup
      .mockResolvedValueOnce([
        [
          {
            familyMemberId: "parent-1",
            title: "Kebiasaan Sehari-hari Anak",
            totalScore: 40,
          },
          {
            familyMemberId: "parent-1",
            title: "Tingkat Pengetahuan Gizi Seimbang",
            totalScore: 20,
          },
        ],
        [],
      ]) // parent questionnaire responses
      .mockResolvedValueOnce([[{ id: 99 }], []]) // health quesioner found
      .mockResolvedValueOnce([[{ totalScore: 20 }], []]); // health response >= threshold

    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    const [[body]] = res.json.mock.calls;
    const student = body.data.students[0];
    // all 5 factors good -> "Tidak Berisiko Gizi Lebih"
    expect(student.conclusion).toBe("Tidak Berisiko Gizi Lebih");
    // familyId must not leak into the response
    expect(student.familyId).toBeUndefined();
  });

  it("concludes 'Gizi Lebih' for OVERWEIGHT-OBESITAS regardless of family/school data", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [fullRow({ fm_familyId: null, ns_displayName: "OVERWEIGHT-OBESITAS" })],
        [],
      ])
      .mockResolvedValueOnce([[], []]) // recommendations
      .mockResolvedValueOnce([[], []]); // health quesioner lookup (not found)

    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    const [[body]] = res.json.mock.calls;
    expect(body.data.students[0].conclusion).toBe("Gizi Lebih");
  });

  it("concludes 'Berisiko Gizi Lebih' for GIZI BAIK when a parent factor is below threshold", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [fullRow({ fm_familyId: "fam-2", ns_displayName: "GIZI BAIK" })],
        [],
      ])
      .mockResolvedValueOnce([[], []]) // recommendations
      .mockResolvedValueOnce([
        [
          {
            id: "parent-2",
            familyId: "fam-2",
            relation: "AYAH",
            education: "SD",
            residenceStatus: "MENYEWA",
            childrenCount: "EMPAT_ATAU_LEBIH",
            underFiveCount: "EMPAT_ATAU_LEBIH",
            familyIncomeLevel: "KURANG_DARI_LIMA_JUTA",
          },
        ],
        [],
      ]) // family parent lookup (low socio-economic score -> "Dasar")
      .mockResolvedValueOnce([[], []]) // no questionnaire responses at all
      .mockResolvedValueOnce([[], []]); // health quesioner lookup (not found)

    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    const [[body]] = res.json.mock.calls;
    expect(body.data.students[0].conclusion).toBe("Berisiko Gizi Lebih");
  });

  it("returns a 500 error response when the page query rejects", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockRejectedValueOnce(new Error("db down"));

    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to retrieve students",
      })
    );
  });
});
