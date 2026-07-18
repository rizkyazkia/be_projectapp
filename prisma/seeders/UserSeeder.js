import pool from "../../src/config/db.js";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";

export const seedUser = async () => {
  try {
    const hashPassword = await argon2.hash("admin");

    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      ["admin"],
    );

    if (existingUsers.length > 0) {
      console.log("User already exists");
      return;
    }

    await pool.query(
      "INSERT INTO users (id, username, email, password, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3))",
      [randomUUID(), "admin", "admin@example.com", hashPassword, 1],
    );
    console.log("User seeded successfully");
  } catch (error) {
    console.error(error.message);
  }
};
