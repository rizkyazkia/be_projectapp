import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getProvinces = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name FROM provinces");
    return successResponse(res, rows, "Province retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve provinces");
  }
};

export const createProvince = async (req, res) => {
  try {
    const { name } = req.body;
    const [result] = await pool.query(
      "INSERT INTO provinces (name) VALUES (?)",
      [name]
    );
    const [rows] = await pool.query(
      "SELECT id, name FROM provinces WHERE id = ?",
      [result.insertId]
    );
    const response = rows[0];
    return successResponse(res, response, "Berhasil menambahkan provinsi baru");
  } catch (error) {
    return errorResponse(res, error, "Gagal menambahkan provinsi baru");
  }
};


