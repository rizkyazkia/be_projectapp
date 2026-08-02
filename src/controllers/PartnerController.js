import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";
import { getInstitutionByUser } from "../helpers/InstitutionHelper.js";

export const getPartners = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const user = req.user;
    const institution = await getInstitutionByUser(user.id, user.role);

    if (!institution) return errorResponse(res, null, "Institution not found");

    const searchClause = search
      ? " AND (h.name LIKE ? OR h.address LIKE ? OR h.phone LIKE ?)"
      : "";
    const searchParams = search
      ? [`%${search}%`, `%${search}%`, `%${search}%`]
      : [];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM partnerships p JOIN institutions h ON h.id = p.healthcareId WHERE p.schoolId = ?${searchClause}`,
      [institution.id, ...searchParams]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [rows] = await pool.query(
      `SELECT p.id AS p_id, p.schoolId AS p_schoolId, p.healthcareId AS p_healthcareId, p.createdAt AS p_createdAt,
              h.id AS h_id, h.name AS h_name, h.address AS h_address, h.phone AS h_phone, h.email AS h_email
       FROM partnerships p JOIN institutions h ON h.id = p.healthcareId
       WHERE p.schoolId = ?${searchClause}
       ORDER BY p.createdAt DESC
       LIMIT ? OFFSET ?`,
      [institution.id, ...searchParams, limit, offset]
    );

    const partnerships = rows.map((row) => ({
      id: row.p_id,
      schoolId: row.p_schoolId,
      healthcareId: row.p_healthcareId,
      createdAt: row.p_createdAt,
      healthcare: {
        id: row.h_id,
        name: row.h_name,
        address: row.h_address,
        phone: row.h_phone,
        email: row.h_email,
      },
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, partnerships },
      "Partners retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get partners");
  }
};

export const addPartners = async (req, res) => {
  try {
    const user = req.user;
    const { healthcareIds } = req.body;

    if (!Array.isArray(healthcareIds) || healthcareIds.length === 0) {
      return errorResponse(
        res,
        null,
        "healthcareIds must be a non-empty array"
      );
    }

    const institution = await getInstitutionByUser(user.id, user.role);

    if (!institution) return errorResponse(res, null, "Institution not found");

    const values = healthcareIds.map((healthcareId) => [
      randomUUID(),
      institution.id,
      healthcareId,
    ]);

    await pool.query(
      "INSERT IGNORE INTO partnerships (id, schoolId, healthcareId) VALUES ?",
      [values]
    );

    return successResponse(res, null, "Partners added successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to add partners");
  }
};

export const deletePartner = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      "DELETE FROM partnerships WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      throw new Error("Partnership not found");
    }

    return successResponse(res, null, "Partner removed successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to remove partner");
  }
};
