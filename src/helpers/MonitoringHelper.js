import pool from "../config/db.js";
import { randomUUID } from "node:crypto";

const MONTH_NAMES = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

export const getOrCreateCurrentPeriod = async (familyId) => {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const label = `${MONTH_NAMES[month]} ${year}`;

  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 0);

  const [existing] = await pool.query(
    "SELECT * FROM monitoring_periods WHERE familyId = ? AND label = ? LIMIT 1",
    [familyId, label],
  );
  if (existing[0]) return existing[0];

  const id = randomUUID();
  try {
    await pool.query(
      "INSERT INTO monitoring_periods (id, familyId, label, startDate, endDate) VALUES (?, ?, ?, ?, ?)",
      [id, familyId, label, startDate, endDate],
    );
  } catch (error) {
    if (error.code !== "ER_DUP_ENTRY") throw error;
  }

  const [rows] = await pool.query(
    "SELECT * FROM monitoring_periods WHERE familyId = ? AND label = ? LIMIT 1",
    [familyId, label],
  );
  return rows[0];
};

export const getPeriodLabelFromDate = (date) => {
  const d = new Date(date);
  const m = d.getMonth();
  const y = d.getFullYear();
  return `${MONTH_NAMES[m]} ${y}`;
};

export const getPeriodLabelShort = (date) => {
  const d = new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}`;
};
