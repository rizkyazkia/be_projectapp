import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getJobs, getJobTypes } from "../JobController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getJobs", () => {
  it("returns all jobs with camelCase columns and no relation include", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        {
          id: 1,
          jobTypeId: 2,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      [],
    ]);

    await getJobs(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "SELECT id, jobTypeId, createdAt, updatedAt FROM jobs"
      )
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        message: "Jobs retrieved successfully",
      })
    );
  });
});

describe("getJobTypes", () => {
  it("returns all job types", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [{ id: 1, name: "Buruh", type: "BURUH" }],
      [],
    ]);

    await getJobTypes(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name, type FROM job_types")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Job types retrieved successfully",
      data: [{ id: 1, name: "Buruh", type: "BURUH" }],
    });
  });
});
