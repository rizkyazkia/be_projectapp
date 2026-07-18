import pool from "../../src/config/db.js";

export const seedNutritionStatus = async () => {
  try {
    const displayNames = ["GIZI BURUK-KURANG", "GIZI BAIK", "OVERWEIGHT-OBESITAS"];
    const [existingNutritionStatus] = await pool.query(
      "SELECT id FROM nutrition_status WHERE displayName IN (?)",
      [displayNames],
    );

    if (existingNutritionStatus.length > 0) {
      console.log("Nutrition status already exist");
      return;
    }

    await pool.query(
      "INSERT INTO nutrition_status (displayName, status, information) VALUES ?",
      [
        [
          ["GIZI BURUK-KURANG", "GIZI_BURUK_KURANG", "Kekurangan bb tingkat ringan sampai berat"],
          ["GIZI BAIK", "GIZI_BAIK", "Gizi normal"],
          ["OVERWEIGHT-OBESITAS", "OVERWEIGHT_OBESITAS", "Kelebihan bb tingkat ringan sampai berat"],
        ],
      ],
    );
    console.log("Nutrition status seeded successfully");
  } catch (error) {
    console.error(error);
  }
};
