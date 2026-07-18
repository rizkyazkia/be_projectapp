import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("node:crypto", () => ({ randomUUID: vi.fn() }));

import pool from "../../config/db.js";
import { randomUUID } from "node:crypto";
import { getPartners, addPartners, deletePartner } from "../PartnerController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPartners", () => {
  it("returns a 500 'Institution not found' response when the user has no institution (preserved bug)", async () => {
    pool.query.mockResolvedValueOnce([[], []]);
    const req = { user: { id: "user-1" }, query: {} };
    const res = mockRes();

    await getPartners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM institutions WHERE user_id = ? LIMIT 1"),
      ["user-1"]
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Institution not found" })
    );
  });

  it("returns joined, reshaped partnerships without a search filter", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [
          {
            p_id: "pt-1",
            p_schoolId: 1,
            p_healthcareId: 9,
            p_createdAt: new Date("2026-01-01"),
            h_id: 9,
            h_name: "Puskesmas A",
            h_address: "Jl. A",
            h_phone: "0800",
            h_email: "a@x.com",
          },
        ],
        [],
      ]);

    const req = { user: { id: "user-1" }, query: {} };
    const res = mockRes();

    await getPartners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "FROM partnerships p JOIN institutions h ON h.id = p.healthcareId"
      ),
      [1]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("ORDER BY p.createdAt DESC"),
      [1, 10, 0]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalRows: 1,
          partnerships: [
            {
              id: "pt-1",
              schoolId: 1,
              healthcareId: 9,
              createdAt: new Date("2026-01-01"),
              healthcare: {
                id: 9,
                name: "Puskesmas A",
                address: "Jl. A",
                phone: "0800",
                email: "a@x.com",
              },
            },
          ],
        }),
      })
    );
  });

  it("applies the search filter across name/address/phone but not email", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }], []])
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []]);

    const req = { user: { id: "user-1" }, query: { search: "puskesmas" } };
    const res = mockRes();

    await getPartners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "h.name LIKE ? OR h.address LIKE ? OR h.phone LIKE ?"
      ),
      [1, "%puskesmas%", "%puskesmas%", "%puskesmas%"]
    );
  });

  it("returns a 500 'Failed to get partners' response when a query rejects", async () => {
    pool.query.mockRejectedValueOnce(new Error("connection lost"));
    const req = { user: { id: "user-1" }, query: {} };
    const res = mockRes();

    await getPartners(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Failed to get partners" })
    );
  });
});

describe("addPartners", () => {
  it("rejects when healthcareIds is missing or empty", async () => {
    const req = { user: { id: "user-1" }, body: { healthcareIds: [] } };
    const res = mockRes();

    await addPartners(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "healthcareIds must be a non-empty array" })
    );
  });

  it("bulk inserts with INSERT IGNORE to replicate skipDuplicates", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }], []])
      .mockResolvedValueOnce([{ affectedRows: 2 }]);
    randomUUID.mockReturnValueOnce("uuid-1").mockReturnValueOnce("uuid-2");

    const req = { user: { id: "user-1" }, body: { healthcareIds: [9, 10] } };
    const res = mockRes();

    await addPartners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "INSERT IGNORE INTO partnerships (id, schoolId, healthcareId) VALUES ?"
      ),
      [
        [
          ["uuid-1", 1, 9],
          ["uuid-2", 1, 10],
        ],
      ]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Partners added successfully" })
    );
  });

  it("returns 'Institution not found' when the user has no institution", async () => {
    pool.query.mockResolvedValueOnce([[], []]);
    const req = { user: { id: "user-1" }, body: { healthcareIds: [9] } };
    const res = mockRes();

    await addPartners(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Institution not found" })
    );
  });

  it("returns a 500 'Failed to add partners' response when a query rejects", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }], []])
      .mockRejectedValueOnce(new Error("connection lost"));
    randomUUID.mockReturnValueOnce("uuid-1");

    const req = { user: { id: "user-1" }, body: { healthcareIds: [9] } };
    const res = mockRes();

    await addPartners(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Failed to add partners" })
    );
  });
});

describe("deletePartner", () => {
  it("removes a partnership", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const req = { params: { id: "pt-1" } };
    const res = mockRes();

    await deletePartner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("DELETE FROM partnerships WHERE id = ?"),
      ["pt-1"]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Partner removed successfully" })
    );
  });

  it("throws to replicate Prisma's P2025 when no row is deleted", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const req = { params: { id: "missing" } };
    const res = mockRes();

    await deletePartner(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Failed to remove partner" })
    );
  });

  it("returns a 500 'Failed to remove partner' response when the query itself rejects (distinct from the not-found case)", async () => {
    pool.query.mockRejectedValueOnce(new Error("connection lost"));
    const req = { params: { id: "pt-1" } };
    const res = mockRes();

    await deletePartner(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Failed to remove partner" })
    );
  });
});
