import pool from "../../src/config/db.js";

export const seedQuestions = async () => {
  try {
    const [existingQuestions] = await pool.query(
      "SELECT id FROM questions WHERE type IN (?)",
      [["BOOLEAN", "SCALE"]],
    );

    if (existingQuestions.length > 0) {
      console.log("Questions already exist");
      return;
    }

    const QUESTIONS_DATA = [
      {
        quesioner_id: 1,
        title: "Anak Sekolah yang sehat adalah yang memiliki badan gemuk",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Kegemukan terjadi karena jumlah makanan yang dimakan melebihi kebutuhan tubuh",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Untuk memenuhi kebutuhan gizi, anak SD harus makan 3x sehari, yaitu: pagi, siang dan malam",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Sarapan pagi sangat baik untuk prestasi belajar anak SD di sekolah",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Sarapan dapat meningkatkan konsentrasi belajar, energi pada otak sehingga dapat berprestasi",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Makanan yang dianjurkan untuk anak SD mengacu pada ”Isi piringku”, yaitu: 1/3 untuk makanan pokok, 1/3 sayuran dan 1/3 lauk pauk dan buah-buahan",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title: "Kebiasaan jajan yang tidak sehat akan menyebabkan kegemukan",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Makanan yang sehat untuk anak SD adalah terhindar dari pengawet, pemanis buatan dan pewarna",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Anak yang kurang melakukan aktivitas fisik seperti: bermain, berolahraga, bersepeda, jalan kaki dapat berisiko kegemukan",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Menu seimbang untuk anak SD adalah yang terdiri dari nasi, ikan/daging, sayur dan buah-buahan",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Kebiasaan makan tidak tepat waktu akan berdampak buruk terhadap kesehatan",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Anak SD tidak berisiko mengalami masalah kesehatan, jika gemar minum minuman kemasan",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Anak SD usia 10-12 tahun membutuhkan air putih kurang lebih 7-8 gelas",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Minuman yang tinggi pemanis buatan dapat meningkatkan risiko kegemukan bagi anak",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 1,
        title:
          "Kegemukan dapat menyebabkan penyakit jantung, diabetes milititus/kencing manis, tekanan darah tinggi",
        type: "BOOLEAN",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya sarapan pagi atau makan siang sebelum berangkat sekolah",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title:
          "Apabila tidak sempat sarapan atau makan siang, maka anak saya membawa bekal",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title: "Anak saya makan nasi dan lauk pauk 2-3 kali sehari",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title:
          "Menurut saya, anak saya menghabiskan makanan dengan porsi yang sesuai umurnya",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya makan fast food, seperti burger, fried chiken atau pizza 2-3 kali dalam seminggu",
        type: "SCALE",
        is_negative: true,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya mengkonsumsi minuman bersoda di rumah, seperti: coca cola, sprite, fanta, dll 2-3 kali seminggu",
        type: "SCALE",
        is_negative: true,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya membawa cukup uang untuk beli cemilan dan makan nasi di sekolah ",
        type: "SCALE",
        is_negative: true,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya tidak gemar makan cemilan yang gurih, tinggi penyedap di rumah",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title: "Anak saya tidak gemar membeli gorengan sebagai jajanan",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title: "Anak saya tidak gemar minum minuman dingin dengan aneka rasa buah",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya lebih suka jalan kaki atau naik sepeda ke sekolah daripada naik motor/mobil",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya berjalan kaki, berenang atau senam minimal 30 menit sehari",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya gemar menonton televisi, bermain games atau tidur apabila sedang berada di rumah",
        type: "SCALE",
        is_negative: true,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya menonton televisi, bermain game menggunakan komputer/laptop/hp lebih dari 3 jam/hari",
        type: "SCALE",
        is_negative: true,
      },
      {
        quesioner_id: 2,
        title:
          "Anak saya lebih suka bermain dengan teman sebaya di luar rumah daripada diam di dalam rumah",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title: "Di hari sekolah, anak saya tidur di bawah jam 21.00 wib",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title: "Di hari libur, anak saya tidur di bawah jam 21.00 wib",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 2,
        title: "Anak saya menonton televisi hingga melebihi jam 21.00 wib",
        type: "SCALE",
        is_negative: true,
      },
      {
        quesioner_id: 2,
        title:
          "Di luar jam sekolah, anak saya lebih memilih tidur, nonton televisi, main game pada komputer/hp daripada beraktivitas di luar rumah",
        type: "SCALE",
        is_negative: true,
      },
      {
        quesioner_id: 2,
        title: "Anak saya memiliki waktu tidur yang cukup dan berkualitas",
        type: "SCALE",
        is_negative: false
      },
      {
        quesioner_id: 3,
        title:
          "Sekolah memfasilitasi puskesmas melaksanakan penjaringan kesehatan dan pemeriksaan status gizi anak secara berkala",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 3,
        title:
          "Sekolah membantu pelaksanaan imunisasi anak sekolah",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 3,
        title:
          "Sekolah memeriksa kebersihan diri anak sekolah",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 3,
        title:
          "Sekolah melaksanakan layanan konseling terkait masalah gizi anak",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 3,
        title:
          "Sekolah berkolaborasi dengan pihak puskesmas dalam mengatasi anak sekolah dengan kelebihan berat badan",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 3,
        title:
          "Sekolah melibatkan orang tua melalui komite dalam program pelayanan kesehatan di sekolah",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 3,
        title:
          "Sekolah berperan dalam mengatasi bulliying pada anak sekolah karena kelebihan berat badan",
        type: "SCALE",
        is_negative: false,
      },
      {
        quesioner_id: 3,
        title:
          "Sekolah tidak memfasilitasi puskesmas dalam monitoring status gizi anak",
        type: "SCALE",
        is_negative: true,
      },
    ];

    await pool.query(
      "INSERT INTO questions (quesioner_id, title, type, is_negative) VALUES ?",
      [
        QUESTIONS_DATA.map((q) => [q.quesioner_id, q.title, q.type, q.is_negative]),
      ],
    );
    console.log("Questions seeded successfully");
  } catch (error) {
    console.log(error);
  }
};
