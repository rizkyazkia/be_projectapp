import pool from "../config/db.js";
import { successResponse, errorResponse } from "../helpers/ResponseHelper.js";

export const calculateIMT = async (req, res) => {
  try {
    const { gender, ageMonths, weightKg, heightCm } = req.body;

    if (!gender || ageMonths === undefined || !weightKg || !heightCm) {
      return errorResponse(res, null, "Semua field wajib diisi", 400);
    }

    const ageYear = Math.floor(Number(ageMonths) / 12);
    const ageMonthRemainder = Number(ageMonths) % 12;

    const [rows] = await pool.query(
      `SELECT id, ageYear, ageMonthFrom, ageMonthTo, gender,
              sdMinus3Min, sdMinus3Max, sdMinus2Min, sdMinus2Max,
              sdMinus1Min, sdMinus1Max, medianMin, medianMax,
              sdPlus1Min, sdPlus1Max, sdPlus2Min, sdPlus2Max,
              sdPlus3Min, sdPlus3Max, createdAt
       FROM bmi_references
       WHERE gender = ? AND ageYear = ? AND ageMonthFrom <= ? AND ageMonthTo >= ?
       ORDER BY id ASC
       LIMIT 1`,
      [
        gender === "L" ? "L" : "P",
        ageYear,
        ageMonthRemainder,
        ageMonthRemainder,
      ]
    );
    const bmiRef = rows[0];

    if (!bmiRef) {
      return errorResponse(
        res,
        null,
        "Referensi BMI tidak ditemukan untuk usia ini",
        404
      );
    }

    const heightM = Number(heightCm) / 100;
    const bmi = Number(weightKg) / (heightM * heightM);
    const roundedBMI = Math.round(bmi * 10) / 10;

    let bmiStatus, bmiStatusDesc, bmiColor, recommendations;

    if (roundedBMI < bmiRef.sdMinus2Min) {
      bmiStatus = "Gizi Kurang (Wasted)";
      bmiStatusDesc =
        "Anak kurus. Tingkatkan porsi protein hewani dan karbohidrat.";
      bmiColor = "text-orange-600 bg-orange-50";
      recommendations = [
        "Berikan makanan padat nutrisi tinggi kalori (alpukat, telur rebus, keju, daging merah).",
        "Berikan susu pertumbuhan 2 kali sehari setelah makan utama.",
        "Terapkan jadwal makan teratur: 3 kali makan utama dan 2 kali selingan sehat.",
        "Konsultasikan ke Puskesmas terdekat untuk penanganan lebih lanjut.",
      ];
    } else if (roundedBMI > bmiRef.sdPlus1Max) {
      bmiStatus = "Gizi Lebih / Obesitas";
      bmiStatusDesc =
        "Berat anak berlebih. Kurangi gula dan perbanyak aktivitas fisik.";
      bmiColor = "text-red-600 bg-red-50";
      recommendations = [
        "Kurangi minuman manis, jus kemasan, dan camilan tinggi tepung.",
        "Perbanyak serat dari buah potong segar dan sayuran.",
        "Ajak anak aktif bergerak minimal 60 menit sehari.",
        "Jangan kurangi porsi secara ekstrem, perbaiki kualitas menu.",
      ];
    } else {
      bmiStatus = "Gizi Baik (Normal)";
      bmiStatusDesc =
        "Proporsi berat terhadap tinggi anak seimbang dan sehat.";
      bmiColor = "text-emerald-600 bg-emerald-50";
      recommendations = [
        "Berikan protein hewani (telur, ayam, ikan) setiap hari.",
        "Perbanyak sayuran hijau sebagai sumber zat besi.",
        "Pastikan minum air putih minimal 1.2 liter per hari.",
        "Batasi screen time, dorong aktivitas luar ruangan.",
      ];
    }

    return successResponse(res, {
      bmi: roundedBMI.toFixed(1),
      bmiStatus,
      bmiStatusDesc,
      bmiColor,
      recommendations,
      bmiCategory:
        roundedBMI < bmiRef.sdMinus2Min
          ? "kurang"
          : roundedBMI > bmiRef.sdPlus1Max
            ? "lebih"
            : "baik",
      sdMinus2: bmiRef.sdMinus2Min,
      sdPlus1: bmiRef.sdPlus1Max,
    });
  } catch (err) {
    return errorResponse(res, err, "Gagal menghitung IMT");
  }
};
