import pool from "../../src/config/db.js";

export const seedCity = async () => {
  try {
    const names = [
      "Kepulauan Seribu",
      "Jakarta Barat",
      "Jakarta Pusat",
      "Jakarta Selatan",
      "Jakarta Timur",
      "Jakarta Utara",
    ];
    const [existingCity] = await pool.query(
      "SELECT id FROM cities WHERE name IN (?)",
      [names],
    );

    if (existingCity.length > 0) {
      console.log("City already exists");
      return;
    }

    await pool.query("INSERT INTO cities (name, province_id) VALUES ?", [
      names.map((name) => [name, 1]),
    ]);
    console.log("City seeded successfully");
  } catch (error) {
    console.error(error);
  }
};
