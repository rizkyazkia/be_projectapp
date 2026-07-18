import pool from "../../src/config/db.js";

export const seedQuesioners = async () => {
  try {
    const titles = [
      "Tingkat Pengetahuan Gizi Seimbang",
      "Kebiasaan Sehari-hari Anak",
      "Pelayanan Kesehatan Sekolah",
    ];
    const [existingQuesioners] = await pool.query(
      "SELECT id FROM quesioners WHERE title IN (?)",
      [titles],
    );

    if (existingQuesioners.length > 0) {
      console.log("Quesioners already exist");
      return;
    }

    await pool.query("INSERT INTO quesioners (title, description) VALUES ?", [
      [
        [
          "Tingkat Pengetahuan Gizi Seimbang",
          "Quisioner tentang pengetahuan gizi seimbang orang tua",
        ],
        [
          "Kebiasaan Sehari-hari Anak",
          "Quisioner untuk mengetahui kebiasaaan sehari-hari anak",
        ],
        [
          "Pelayanan Kesehatan Sekolah",
          "Quisioner Pelayanan kesehatan di sekolah",
        ],
      ],
    ]);
    console.log("Quesioner seeded successfully");
  } catch (error) {
    console.error(error);
  }
};
