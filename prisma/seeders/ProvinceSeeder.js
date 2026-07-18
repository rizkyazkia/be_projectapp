import pool from "../../src/config/db.js";

export const seedProvince = async () => {
  try {
    const [existingProvince] = await pool.query(
      "SELECT id FROM provinces WHERE name = ? LIMIT 1",
      ["DKI Jakarta"],
    );

    if (existingProvince.length > 0) {
      console.log("Province already exists");
      return;
    }

    await pool.query("INSERT INTO provinces (name) VALUES (?)", ["DKI Jakarta"]);
    console.log("Province seeded successfully");
  } catch (error) {
    console.error(error.message);
  }
};
