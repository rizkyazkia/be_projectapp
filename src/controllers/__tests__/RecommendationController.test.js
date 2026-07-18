import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("node:crypto", () => ({ randomUUID: vi.fn() }));
vi.mock("../NotificationController.js", () => ({
  createNotification: vi.fn(),
}));

import pool from "../../config/db.js";
import { randomUUID } from "node:crypto";
import { createNotification } from "../NotificationController.js";
import {
  getRecomendations,
  createRecommendation,
  changeStatusToProcessed,
  getResponseParent,
  getResponseInstitution,
  createIntervention,
  getSingleRecommendation,
  getInterventionsBelongToInstitution,
  getInterventionsBelongToFamily,
} from "../RecommendationController.js";

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

  it("scopes to the school institution via the submittedById join and returns nested paginated data", async () => {
    const req = {
      user: { id: "u-school-1", role: "school" },
      query: { page: "0", limit: "10" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 9 }], []]) // institution lookup
      .mockResolvedValueOnce([[{ count: 1 }], []]) // count query
      .mockResolvedValueOnce([
        [
          {
            id: "rec-1",
            status: "PENDING",
            createdAt: new Date("2026-01-01"),
            submittedBy_id: "u-school-1",
            si_id: 9,
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
            sti_id: 9,
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
      ["u-school-1"],
    );

    const countSql = pool.query.mock.calls[1][0];
    expect(countSql).toContain("SELECT COUNT(*) AS count FROM recommendations r");
    expect(countSql).toContain("LEFT JOIN users su ON su.id = r.submittedById");
    expect(countSql).toContain("LEFT JOIN institutions si ON si.user_id = su.id");
    expect(countSql).toContain("WHERE si.id = ?");
    expect(pool.query.mock.calls[1][1]).toEqual([9]);

    const listSql = pool.query.mock.calls[2][0];
    expect(listSql).toContain("LEFT JOIN users su ON su.id = r.submittedById");
    expect(listSql).toContain("LEFT JOIN institutions si ON si.user_id = su.id");
    expect(listSql).toContain("WHERE si.id = ?");
    expect(pool.query.mock.calls[2][1]).toEqual([9, 10, 0]);

    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("FROM nutritions n"),
      [["fm-1"]],
    );

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("success");
    expect(data.data.totalRows).toBe(1);
    expect(data.data.recomend[0].submittedBy.institution).toEqual({
      id: 9,
      name: "SD Negeri 1",
      address: "Jl. A",
      phone: "0800",
      email: "sd@x.com",
      city: { id: 1, name: "Bandung" },
      province: { id: 1, name: "Jawa Barat" },
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

describe("createRecommendation", () => {
  const baseReq = () => ({
    user: { id: "user-school-1", role: "school" },
    body: { familyMemberId: "fm-1", healthCareId: "5" },
  });

  it("creates a recommendation when studentId is omitted from the body (undefined-key guard)", async () => {
    const req = baseReq(); // no studentId in body
    const res = mockRes();

    randomUUID.mockReturnValueOnce("rec-uuid-1");

    pool.query
      .mockResolvedValueOnce([[{ id: "st-1", familyMemberId: "fm-1", fm_fullName: "Budi" }], []]) // student lookup
      .mockResolvedValueOnce([[], []]) // existing PENDING/PROCESSED check -> none
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // insert
      .mockResolvedValueOnce([[{ id: 5, name: "Puskesmas A", user_id: "user-health-1" }], []]) // healthcare institution + user
      .mockResolvedValueOnce([[{ id: 9, name: "SD Negeri 1" }], []]) // submitting school's own institution
      .mockResolvedValueOnce([[{ id: "fm-1", fullName: "Budi", family_id: "fam-1", user_id: "user-parent-1" }], []]); // family member -> family -> user chain

    await createRecommendation(req, res);

    const [studentSql, studentParams] = pool.query.mock.calls[0];
    expect(studentSql).toContain("FROM students s");
    expect(studentSql).not.toContain("AND s.id = ?");
    expect(studentParams).toEqual(["fm-1"]);

    expect(pool.query.mock.calls[1][0]).toContain("status IN (?)");
    expect(pool.query.mock.calls[1][1]).toEqual(["st-1", ["PENDING", "PROCESSED"]]);

    expect(pool.query.mock.calls[2][0]).toContain("INSERT INTO recommendations");
    expect(pool.query.mock.calls[2][1]).toEqual([
      "rec-uuid-1",
      "st-1",
      "user-school-1",
      5,
      "PENDING",
      null,
      expect.any(Date),
      expect.any(Date),
    ]);

    expect(pool.query).toHaveBeenCalledTimes(6);

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenNthCalledWith(
      1,
      "user-health-1",
      "Rekomendasi Baru",
      expect.stringContaining("Budi"),
      "recommendation_received",
      "rec-uuid-1",
    );
    expect(createNotification).toHaveBeenNthCalledWith(
      2,
      "user-parent-1",
      "Rekomendasi Dikirim",
      expect.stringContaining("Puskesmas A"),
      "recommendation_sent",
      "rec-uuid-1",
    );

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.data.id).toBe("rec-uuid-1");
    expect(data.data.status).toBe("PENDING");
  });

  it("includes s.id = ? when studentId IS present in the body", async () => {
    const req = baseReq();
    req.body.studentId = "st-2";
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "st-2", familyMemberId: "fm-1", fm_fullName: "Budi" }], []]) // student lookup
      .mockResolvedValueOnce([[], []]) // existing check -> none
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // insert
      .mockResolvedValueOnce([[], []]) // healthcare institution lookup -> no match, so notification block and school-institution lookup are both skipped
      .mockResolvedValueOnce([[], []]); // family member -> family -> user chain -> no match, parent notification skipped

    await createRecommendation(req, res);

    const [studentSql, studentParams] = pool.query.mock.calls[0];
    expect(studentSql).toContain("AND s.id = ?");
    expect(studentParams).toEqual(["fm-1", "st-2"]);

    expect(pool.query).toHaveBeenCalledTimes(5);
    expect(createNotification).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it("returns the guard-clause response (actual HTTP 500, per ResponseHelper's real arg order) when the user is not a school", async () => {
    const req = { user: { id: "u1", role: "healthcare" }, body: {} };
    const res = mockRes();

    await createRecommendation(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.error).toBe(403);
    expect(data.message).toBe("User is not associated with an institution");
  });

  it("returns the guard-clause response when a PENDING/PROCESSED recommendation already exists for the student", async () => {
    const req = baseReq();
    req.body.studentId = "st-1";
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "st-1", familyMemberId: "fm-1", fm_fullName: "Budi" }], []])
      .mockResolvedValueOnce([[{ id: "existing-rec" }], []]); // existing found

    await createRecommendation(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.error).toBe(400);
    expect(data.message).toBe("Murid ini sudah direkomendasikan sebelumnya");
  });

  it("returns a 500 error response when a query rejects", async () => {
    const req = baseReq();
    const res = mockRes();

    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await createRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.message).toBe("Failed to create recommendation");
    expect(data.error).toBe("connection lost");
  });
});

describe("changeStatusToProcessed", () => {
  it("updates status and re-selects the row", async () => {
    const req = { params: { id: "rec-1" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
      .mockResolvedValueOnce([[{ id: "rec-1", status: "PROCESSED" }], []]); // re-select

    await changeStatusToProcessed(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE recommendations SET status = ? WHERE id = ?"),
      ["PROCESSED", "rec-1"],
    );
    expect(pool.query.mock.calls[0][0]).not.toContain("updatedAt");
    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.data).toEqual({ id: "rec-1", status: "PROCESSED" });
    expect(data.message).toBe("Berhasil dimasukan ke dalam antrian proses");
  });

  it("errors when the recommendation id does not exist (affectedRows === 0)", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

    await changeStatusToProcessed(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1); // no re-select attempted
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.message).toBe("Gagal memasukan ke dalam antrian proses");
  });

  it("returns a 500 error response when the UPDATE query rejects", async () => {
    const req = { params: { id: "rec-1" } };
    const res = mockRes();

    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await changeStatusToProcessed(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.message).toBe("Gagal memasukan ke dalam antrian proses");
    expect(data.error).toBe("connection lost");
  });
});

describe("getResponseParent", () => {
  it("scopes answers to the response matching the requested quesioner (full bug fix)", async () => {
    const req = {
      body: { userId: 42 },
      query: { page: "0", limit: "10", search: "" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1" }], []]) // family lookup
      .mockResolvedValueOnce([[{ id: "fm-1" }], []]) // familyMember (IBU/AYAH) lookup
      .mockResolvedValueOnce([
        [
          { id: "resp-other", quisionerId: 99 },
          { id: "resp-match", quisionerId: 42 },
        ],
        [],
      ]) // responses for this family member (array, unscoped fetch preserved)
      .mockResolvedValueOnce([[{ id: 1, quesioner_id: 42, title: "Q1", type: "SCALE" }], []]) // questions
      .mockResolvedValueOnce([[{ id: 10, question_id: 1, title: "Opt A", score: 1 }], []]) // options
      .mockResolvedValueOnce([[{ count: 1 }], []]) // answers count, scoped
      .mockResolvedValueOnce([[{ id: 100, responseId: "resp-match", questionId: 1 }], []]); // answers, scoped

    await getResponseParent(req, res);

    expect(pool.query.mock.calls[0][1]).toEqual([42]);
    expect(pool.query.mock.calls[3][0]).toContain("quesioner_id = ?");
    expect(pool.query.mock.calls[3][1]).toEqual([42, "%%"]);

    const countCall = pool.query.mock.calls[5];
    expect(countCall[0]).toContain("responseId = ?");
    expect(countCall[0]).toContain("questionId IN (?)");
    expect(countCall[1]).toEqual(["resp-match", [1]]);

    const answersCall = pool.query.mock.calls[6];
    expect(answersCall[1]).toEqual(["resp-match", [1], 10, 0]);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.data.questions[0].options).toEqual([{ id: 10, title: "Opt A", score: 1 }]);
    expect(data.data.answers).toEqual([{ id: 100, responseId: "resp-match", questionId: 1 }]);
  });

  it("returns empty answers/totalRows=0 without querying when no response matches the quesioner", async () => {
    const req = { body: { userId: 7 }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1" }], []])
      .mockResolvedValueOnce([[{ id: "fm-1" }], []])
      .mockResolvedValueOnce([[{ id: "resp-other", quisionerId: 99 }], []]) // no match for quesionerId 7
      .mockResolvedValueOnce([[{ id: 1, quesioner_id: 7, title: "Q1", type: "SCALE" }], []])
      .mockResolvedValueOnce([[], []]); // options (empty, guarded)

    await getResponseParent(req, res);

    expect(pool.query).toHaveBeenCalledTimes(5); // no count/answers queries executed
    const [data] = res.json.mock.calls[0];
    expect(data.data.totalRows).toBe(0);
    expect(data.data.answers).toEqual([]);
  });

  it("returns the guard-clause response (actual HTTP 500) when no family is found", async () => {
    const req = { body: { userId: 1 }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no family

    await getResponseParent(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.error).toBe(404);
    expect(data.message).toBe("Family not found");
  });

  it("returns a 500 error response when the family lookup query rejects (genuine catch-block path)", async () => {
    const req = { body: { userId: 1 }, query: {} };
    const res = mockRes();

    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await getResponseParent(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.message).toBe("Failed to get response");
    expect(data.error).toBe("connection lost");
  });
});

describe("getResponseInstitution", () => {
  it("returns paginated answers scoped by responseId and questionId", async () => {
    const req = {
      body: { userId: "user-inst-1" },
      params: { id: "3" },
      query: { page: "0", limit: "10", search: "" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 8 }], []]) // institution lookup
      .mockResolvedValueOnce([[{ id: "resp-1" }], []]) // response lookup
      .mockResolvedValueOnce([[{ id: 1, quesioner_id: 3, title: "Q1", type: "BOOLEAN" }], []]) // questions
      .mockResolvedValueOnce([[{ id: 11, question_id: 1, title: "Ya", score: 1 }], []]) // options
      .mockResolvedValueOnce([[{ count: 2 }], []]) // answers count
      .mockResolvedValueOnce([[{ id: 200, responseId: "resp-1", questionId: 1 }], []]); // answers

    await getResponseInstitution(req, res);

    expect(pool.query.mock.calls[2][1]).toEqual([3, "%%"]);
    expect(pool.query.mock.calls[4][1]).toEqual(["resp-1", [1]]);
    expect(pool.query.mock.calls[5][1]).toEqual(["resp-1", [1], 10, 0]);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.data.totalRows).toBe(2);
    expect(data.data.answers).toEqual([{ id: 200, responseId: "resp-1", questionId: 1 }]);
  });

  it("skips the answers query when no questions match (empty questionIds guard)", async () => {
    const req = { body: { userId: "user-inst-1" }, params: { id: "3" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 8 }], []])
      .mockResolvedValueOnce([[{ id: "resp-1" }], []])
      .mockResolvedValueOnce([[], []]); // no questions

    await getResponseInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const [data] = res.json.mock.calls[0];
    expect(data.data.totalRows).toBe(0);
    expect(data.data.answers).toEqual([]);
  });

  it("returns the guard-clause response (actual HTTP 500) when the institution is not found", async () => {
    const req = { body: { userId: "no-such-user" }, params: { id: "3" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await getResponseInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.error).toBe(404);
    expect(data.message).toBe("Institution not found");
  });

  it("returns a 500 error response when a query rejects", async () => {
    const req = { body: { userId: "user-inst-1" }, params: { id: "3" }, query: {} };
    const res = mockRes();

    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await getResponseInstitution(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.message).toBe("Failed to get response");
    expect(data.error).toBe("connection lost");
  });
});

describe("createIntervention", () => {
  it("bulk-inserts both intervention rows, marks the recommendation COMPLETED, commits, and notifies the parent", async () => {
    const req = {
      user: { id: "user-health-1", role: "healthcare" },
      params: { id: "rec-1" },
      body: { content: { note: "periksa gizi" }, forType: "PARENT", notes: "catatan" },
    };
    const res = mockRes();

    randomUUID.mockReturnValueOnce("iv-uuid-1").mockReturnValueOnce("iv-uuid-2");

    const mockConnection = {
      beginTransaction: vi.fn(),
      query: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    pool.getConnection.mockResolvedValueOnce(mockConnection);
    mockConnection.query
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // bulk INSERT
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE status

    pool.query
      .mockResolvedValueOnce([
        [{ id: "rec-1", fm_id: "fm-1", fm_fullName: "Budi", parent_user_id: "user-parent-1" }],
        [],
      ]) // recommendation -> student -> familyMember -> family -> user
      .mockResolvedValueOnce([[{ institution_name: "Kecamatan A" }], []]); // puskesmas institution name

    await createIntervention(req, res);

    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(mockConnection.beginTransaction).toHaveBeenCalledTimes(1);

    const [insertSql, insertParams] = mockConnection.query.mock.calls[0];
    expect(insertSql).toContain("INSERT INTO interventions");
    expect(insertParams).toEqual([
      "iv-uuid-1", "rec-1", "PARENT", JSON.stringify({ note: "periksa gizi" }), "catatan", expect.any(Date), "user-health-1",
      "iv-uuid-2", "rec-1", "SCHOOL", JSON.stringify({ note: "periksa gizi" }), "catatan", expect.any(Date), "user-health-1",
    ]);

    expect(mockConnection.query.mock.calls[1][0]).toContain("UPDATE recommendations SET status = ? WHERE id = ?");
    expect(mockConnection.query.mock.calls[1][1]).toEqual(["COMPLETED", "rec-1"]);

    expect(mockConnection.commit).toHaveBeenCalledTimes(1);
    expect(mockConnection.rollback).not.toHaveBeenCalled();
    expect(mockConnection.release).toHaveBeenCalledTimes(1);

    expect(res.status).toHaveBeenCalledWith(201);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("Success");
    expect(data.data).toEqual({ count: 2 });
  });

  it("returns the guard-clause response without opening a connection when the user is not healthcare", async () => {
    const req = { user: { id: "u1", role: "school" }, params: { id: "rec-1" }, body: {} };
    const res = mockRes();

    await createIntervention(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.message).toBe("Failed to get response");
  });

  it("rolls back and releases the connection when the transaction fails", async () => {
    const req = {
      user: { id: "user-health-1", role: "healthcare" },
      params: { id: "rec-1" },
      body: { content: {}, forType: "PARENT", notes: null },
    };
    const res = mockRes();

    const mockConnection = {
      beginTransaction: vi.fn(),
      query: vi.fn().mockRejectedValueOnce(new Error("insert failed")),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    pool.getConnection.mockResolvedValueOnce(mockConnection);

    await createIntervention(req, res);

    expect(mockConnection.rollback).toHaveBeenCalledTimes(1);
    expect(mockConnection.commit).not.toHaveBeenCalled();
    expect(mockConnection.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("getSingleRecommendation", () => {
  it("returns the full nested shape with no residence key", async () => {
    const req = { params: { id: "rec-1" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([
        [
          {
            id: "rec-1",
            studentId: "st-1",
            submittedById: "user-school-1",
            healthcareInstitutionId: 5,
            status: "COMPLETED",
            pdfUrl: null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-02"),
            si_name: "SD Negeri 1",
            student_id: "st-1",
            student_nis: "12345",
            student_schoolYear: "2025/2026",
            student_semester: "1",
            student_classId: 9,
            class_id: 9,
            class_name: "5A",
            fm_id: "fm-1",
            fm_fullName: "Budi",
            fm_birthDate: new Date("2015-01-01"),
            fm_gender: "L",
            fm_relation: "ANAK",
            fm_familyId: "fam-1",
            family_id: "fam-1",
            user_id: "user-parent-1",
            user_family_id: "fam-1",
          },
        ],
        [],
      ]) // main row
      .mockResolvedValueOnce([[{ id: "iv-1", forType: "PARENT" }], []]) // Intervention[]
      .mockResolvedValueOnce([
        [{ id: "fm-1", fullName: "Budi", birthDate: new Date("2015-01-01"), gender: "L", relation: "ANAK" }],
        [],
      ]); // siblings

    await getSingleRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const [data] = res.json.mock.calls[0];
    expect(data.data.submittedBy).toEqual({ institution: { name: "SD Negeri 1" } });
    expect(data.data.Intervention).toEqual([{ id: "iv-1", forType: "PARENT" }]);
    expect(data.data.student.familyMember).not.toHaveProperty("residence");
    expect(data.data.student.familyMember.family.user.family.familyMember).toEqual([
      { id: "fm-1", fullName: "Budi", birthDate: new Date("2015-01-01"), gender: "L", relation: "ANAK" },
    ]);
  });

  it("returns 200 with data: null when the recommendation id does not exist (no added 404 guard)", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no matching row -> no Intervention/siblings queries run

    await getSingleRecommendation(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    const [data] = res.json.mock.calls[0];
    expect(data.data).toBeNull();
  });

  it("returns a 500 error response when the main query rejects (genuine catch-block path)", async () => {
    const req = { params: { id: "rec-1" } };
    const res = mockRes();

    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await getSingleRecommendation(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.message).toBe("Failed to get response");
    expect(data.error).toBe("connection lost");
  });
});

describe("getInterventionsBelongToInstitution", () => {
  it("dedupes to one intervention per recommendation via ROW_NUMBER, applies OFFSET with no LIMIT, and preserves the length-based totalPages bug", async () => {
    const req = {
      user: { id: "user-health-1" },
      query: { page: "0", limit: "10", keyword: "" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // userInstitution lookup
      .mockResolvedValueOnce([
        [
          {
            iv_id: "iv-1", iv_forType: "PARENT", iv_notes: "n", iv_options: JSON.stringify({ a: 1 }), iv_createdAt: new Date("2026-01-02"),
            r_id: "rec-1", r_status: "COMPLETED", r_createdAt: new Date("2026-01-01"),
            st_nis: "12345", cl_id: 9, cl_name: "5A",
            fm_fullName: "Budi", fm_birthDate: new Date("2015-01-01"), fm_gender: "L",
            se_address: "Jl. A", of2_id: "fam-2",
            subu_i_id: 3, subu_i_name: "SD Negeri 1",
            vi_name: "Puskesmas A", vi_address: "Jl. B", vi_phone: "0800", vi_email: "p@x.com",
            vu_username: "petugas1",
          },
        ],
        [],
      ]) // main windowed query
      .mockResolvedValueOnce([[{ familyId: "fam-2", id: "sib-1", fullName: "Ani" }], []]); // siblings batch

    await getInterventionsBelongToInstitution(req, res);

    expect(pool.query.mock.calls[1][0]).toContain("ROW_NUMBER() OVER (PARTITION BY iv.recommendationId ORDER BY iv.createdAt DESC)");
    expect(pool.query.mock.calls[1][0]).toContain("LIMIT 18446744073709551615 OFFSET ?");
    expect(pool.query.mock.calls[1][1]).toEqual([5, 0]);
    expect(pool.query.mock.calls[2][1]).toEqual([["fam-2"]]);

    expect(res.status).toHaveBeenCalledWith(200);
    const [data] = res.json.mock.calls[0];
    expect(data.data.totalPages).toBe(Math.ceil(1 / 10)); // length-based, not a real count
    expect(data.data.interventions[0].options).toEqual({ a: 1 });
    expect(
      data.data.interventions[0].recommendation.student.familyMember.family.user.family.familyMember,
    ).toEqual([{ fullName: "Ani" }]);
  });

  it("appends the keyword LIKE filter only when keyword is non-empty", async () => {
    const req = { user: { id: "user-health-1" }, query: { keyword: "Budi" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]);

    await getInterventionsBelongToInstitution(req, res);

    expect(pool.query.mock.calls[1][0]).toContain("fm.fullName LIKE ?");
    expect(pool.query.mock.calls[1][1]).toEqual([5, "%Budi%", 0]);
  });

  it("throws when the requesting user does not exist", async () => {
    const req = { user: { id: "ghost" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no user row

    await getInterventionsBelongToInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("returns a 500 error response when a query rejects (genuine catch-block path)", async () => {
    const req = { user: { id: "user-health-1" }, query: {} };
    const res = mockRes();

    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await getInterventionsBelongToInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.message).toBe("Failed to get response");
    expect(data.error).toBe("connection lost");
  });
});

describe("getInterventionsBelongToFamily", () => {
  it("orders by the joined recommendation's updatedAt (not the intervention's own createdAt) and preserves the un-divided totalPages bug", async () => {
    const req = { user: { id: "user-parent-1" }, query: { page: "0", limit: "10", keyword: "" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([
      [
        {
          iv_id: "iv-1", iv_forType: "PARENT", iv_notes: null, iv_options: JSON.stringify({ b: 2 }), iv_createdAt: new Date("2026-01-01"),
          r_id: "rec-1", r_status: "COMPLETED", r_createdAt: new Date("2025-12-01"),
          st_nis: "999", cl_id: 4, cl_name: "3B",
          fm_fullName: "Sari", fm_birthDate: new Date("2016-01-01"), fm_gender: "P",
          se_address: "Jl. C", of2_id: null,
          subu_i_id: 2, subu_i_name: "SD Negeri 2",
          vi_name: "Puskesmas B", vi_address: "Jl. D", vi_phone: "0801", vi_email: "b@x.com",
          vu_username: "petugas2",
        },
      ],
      [],
    ]);

    await getInterventionsBelongToFamily(req, res);

    expect(pool.query.mock.calls[0][0]).toContain("ORDER BY r.updatedAt DESC");
    expect(pool.query.mock.calls[0][0]).toContain("iv.forType = 'PARENT'");
    expect(pool.query.mock.calls[0][0]).toContain("LIMIT 18446744073709551615 OFFSET ?");

    const [data] = res.json.mock.calls[0];
    expect(data.data.totalPages).toBe(1); // interventions.length, NOT Math.ceil(length/limit)
    expect(data.data.interventions[0].recommendation.student.familyMember.family.user.family).toBeNull();
    expect(data.data.interventions[0].options).toEqual({ b: 2 });
  });

  it("returns a 500 error response when a query rejects (genuine catch-block path)", async () => {
    const req = { user: { id: "user-parent-1" }, query: {} };
    const res = mockRes();

    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await getInterventionsBelongToFamily(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.message).toBe("Failed to get response");
    expect(data.error).toBe("connection lost");
  });
});
