import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getInstitutions = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const searchParam = `%${search}%`;

    const [countRows] = await pool.query(
      `SELECT COUNT(DISTINCT i.id) AS count
       FROM institutions i
       LEFT JOIN provinces p ON i.province_id = p.id
       LEFT JOIN cities c ON i.city_id = c.id
       WHERE i.name LIKE ? OR i.address LIKE ? OR p.name LIKE ? OR c.name LIKE ?`,
      [searchParam, searchParam, searchParam, searchParam]
    );
    const totalRows = countRows[0].count;

    const totalPage = Math.ceil(totalRows / limit);
    const [rows] = await pool.query(
      `SELECT i.id, i.name, i.email, i.phone, i.address,
              p.name AS province_name, c.name AS city_name, it.name AS institution_type_name
       FROM institutions i
       LEFT JOIN provinces p ON i.province_id = p.id
       LEFT JOIN cities c ON i.city_id = c.id
       LEFT JOIN institution_types it ON i.type = it.id
       WHERE i.name LIKE ? OR i.address LIKE ? OR p.name LIKE ? OR c.name LIKE ?
       ORDER BY i.id DESC
       LIMIT ? OFFSET ?`,
      [searchParam, searchParam, searchParam, searchParam, limit, offset]
    );

    const institutions = rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      province: row.province_name ? { name: row.province_name } : null,
      city: row.city_name ? { name: row.city_name } : null,
      institution_type: row.institution_type_name
        ? { name: row.institution_type_name }
        : null,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, institutions },
      "Institutions retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const getInstitutionByUser = async (req, res) => {
  try {
    const user = req.user;
    const [rows] = await pool.query(
      "SELECT * FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = rows[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    return successResponse(
      res,
      institution,
      "Institution retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const getInstitutionType = async (req, res) => {
  try {
    const [institutionTypes] = await pool.query(
      "SELECT id, name FROM institution_types"
    );
    if (institutionTypes.length === 0) {
      return errorResponse(res, 404, "No institution types found");
    }
    return successResponse(
      res,
      institutionTypes,
      "Institution types retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const getHealthCares = async (req, res) => {
  try {
    const search = req.query.search || "";

    let sql = `SELECT i.id, i.name, i.address, i.phone, i.email,
                      c.id AS city_id, c.name AS city_name,
                      p.id AS province_id, p.name AS province_name
               FROM institutions i
               INNER JOIN institution_types it ON i.type = it.id AND it.name = 'HealthCare'
               LEFT JOIN cities c ON i.city_id = c.id
               LEFT JOIN provinces p ON i.province_id = p.id`;
    const params = [];

    if (search) {
      sql += ` WHERE (i.name LIKE ? OR i.address LIKE ? OR i.phone LIKE ?)`;
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam);
    }

    sql += ` ORDER BY i.name ASC`;

    const [rows] = await pool.query(sql, params);

    const healthcares = rows.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      phone: row.phone,
      email: row.email,
      city: row.city_id ? { id: row.city_id, name: row.city_name } : null,
      province: row.province_id
        ? { id: row.province_id, name: row.province_name }
        : null,
    }));

    return successResponse(
      res,
      healthcares,
      "Healthcares retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};
