import pool from "../../src/config/db.js";

export const seedOptions = async () => {
  try {
    const existingTitles = ["Benar", "Salah", "1", "2", "3", "4", "0"];
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
    const parentTitles = ["1", "2", "3", "4"];
    const schoolTitles = ["0", "1", "2", "3"];

    const getScore = (qid, isNegative, idx) => {
      if (qid <= 15) return isNegative ? idx : 1 - idx;
      if (qid <= 35) return isNegative ? 4 - idx : idx + 1;
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
