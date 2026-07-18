import pool from "../../src/config/db.js";

export const seedCategories = async () => {
  try {
    const names = [
      "Tingkat Pengetahuan Gizi Seimbang",
      "Kebiasaan Sehari-hari Anak",
      "Pelayanan Kesehatan Sekolah",
    ];
    const [existingCategories] = await pool.query(
      "SELECT id FROM categories WHERE name IN (?)",
      [names],
    );

    if (existingCategories.length > 0) {
      console.log("Categories already exist");
      return;
    }

    await pool.query("INSERT INTO categories (name, path) VALUES ?", [
      [
        ["Tingkat Pengetahuan Gizi Seimbang", "/tingkat-pengetahuan-gizi-seimbang"],
        ["Kebiasaan Sehari-hari Anak", "/kebiasaan-sehari-hari-anak"],
        ["Pelayanan Kesehatan Sekolah", "/pelayanan-kesehatan-sekolah"],
      ],
    ]);
    console.log("Categories seeded successfully");
  } catch (error) {
    console.error(error);
  }
};
