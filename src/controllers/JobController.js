import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getJobs = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, jobTypeId, createdAt, updatedAt FROM jobs"
    );
    return successResponse(res, rows, "Jobs retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve jobs");
  }
};

export const getJobTypes = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name, type FROM job_types");
    return successResponse(res, rows, "Job types retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve job types");
  }
};
