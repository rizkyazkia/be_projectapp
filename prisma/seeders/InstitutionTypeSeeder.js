import pool from "../../src/config/db.js";

export const seedInstitutionTypes = async () => {
  try {
    const names = ["School", "HealthCare"];
    const [existingInstitutionTypes] = await pool.query(
      "SELECT id FROM institution_types WHERE name IN (?)",
      [names],
    );

    if (existingInstitutionTypes.length > 0) {
      console.log("Institution types already exist");
      return;
    }

    await pool.query("INSERT INTO institution_types (name) VALUES ?", [
      names.map((name) => [name]),
    ]);
    console.log("Institution types seeded successfully");
  } catch (error) {
    console.error(error);
  }
};
