import pool from "../../src/config/db.js";

export const seedOptions = async () => {
  try {
    const existingTitles = [
      "Benar",
      "Salah",
      "Tidak pernah dilakukan anak",
      "Tidak pernah",
      "0",
    ];
    const [existingOptions] = await pool.query(
      "SELECT id FROM options WHERE title IN (?)",
      [existingTitles],
    );

    if (existingOptions.length > 0) {
      console.log("Options already exist");
      return;
    }

    const [questions] = await pool.query(
      "SELECT id, is_negative FROM questions ORDER BY id ASC",
    );

    const booleanTitles = ["Benar", "Salah"];
    const parentTitles = [
      "0. Tidak pernah dilakukan anak",
      "1. Dilakukan 1-2 kali dalam seminggu",
      "2. Dilakukan 3-4 kali dalam seminggu",
      "3. Dilakukan setiap hari",
    ];
    const schoolTitles = [
      "0. Tidak pernah",
      "1. Jarang (1-2x dalam tahun ajaran yang berlangsung)",
      "2. Sering (3-4x dalam tahun ajaran yang berlangsung)",
      "3. Selalu (> 4x dalam tahun ajaran yang berlangsung)",
    ];

    const getScore = (qid, isNegative, idx) => {
      if (qid <= 15) return isNegative ? idx : 1 - idx;
      if (qid <= 35) return isNegative ? 3 - idx : idx;
      return isNegative ? 3 - idx : idx;
    };

    const optionData = [];
    for (const q of questions) {
      let titles;
      if (q.id <= 15) titles = booleanTitles;
      else if (q.id <= 35) titles = parentTitles;
      else titles = schoolTitles;

      titles.forEach((title, i) => {
        optionData.push([q.id, title, getScore(q.id, !!q.is_negative, i)]);
      });
    }

    await pool.query("INSERT INTO options (question_id, title, score) VALUES ?", [
      optionData,
    ]);
    console.log("Options seeded successfully");
  } catch (error) {
    console.log(error);
  }
};
