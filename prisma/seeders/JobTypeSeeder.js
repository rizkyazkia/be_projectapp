import pool from "../../src/config/db.js";

export const seedJobTypes = async () => {
  try {
    const names = [
      "Tidak Bekerja",
      "Buruh",
      "Karyawan Swasta",
      "ASN / BUMN",
      "Wiraswasta",
    ];
    const [existingJobTypes] = await pool.query(
      "SELECT id FROM job_types WHERE name IN (?)",
      [names],
    );

    if (existingJobTypes.length > 0) {
      console.log("Job types already exist");
      return;
    }

    await pool.query("INSERT INTO job_types (name, type) VALUES ?", [
      [
        ["Tidak Bekerja", "TIDAK_BEKERJA"],
        ["Buruh", "BURUH"],
        ["Karyawan Swasta", "KARYAWAN_SWASTA"],
        ["ASN / BUMN", "ASN_BUMN"],
        ["Wiraswasta", "WIRASWASTA"],
      ],
    ]);
    console.log("Job types seeded successfully");
  } catch (error) {
    console.error(error);
  }
};
