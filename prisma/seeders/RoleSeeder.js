import pool from "../../src/config/db.js";

export const seedRoles = async () => {
  try {
    const names = ["admin", "parent", "school", "teacher", "healthcare", "staff"];
    const [existingRoles] = await pool.query(
      "SELECT id FROM roles WHERE name IN (?)",
      [names],
    );

    if (existingRoles.length > 0) {
      console.log("Roles already exist");
      return;
    }

    await pool.query("INSERT INTO roles (name) VALUES ?", [
      names.map((name) => [name]),
    ]);
    console.log("Roles seeded successfully");
  } catch (error) {
    console.error(error);
  }
};
