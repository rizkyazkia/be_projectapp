import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("argon2", () => ({
  default: {
    hash: vi.fn(async (password) => `hashed:${password}`),
    verify: vi.fn(),
  },
}));

import pool from "../../../src/config/db.js";
import { seedRoles } from "../RoleSeeder.js";
import { seedUser } from "../UserSeeder.js";
import { seedCategories } from "../CategorySeeder.js";
import { seedCity } from "../CitySeeder.js";
import { seedProvince } from "../ProvinceSeeder.js";
import { seedInstitutionTypes } from "../InstitutionTypeSeeder.js";
import { seedQuesioners } from "../QuesionerSeeder.js";
import { seedQuestions } from "../QuestionSeeder.js";
import { seedOptions } from "../OptionSeeder.js";
import { seedJobTypes } from "../JobTypeSeeder.js";
import { seedNutritionStatus } from "../NutritionStatusSeeder.js";
import { seedIMT } from "../IMTSeeder.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RoleSeeder", () => {
  it("inserts roles when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 6 }, []]);

    await seedRoles();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM roles WHERE name IN"),
      [["admin", "parent", "school", "teacher", "healthcare", "staff"]],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO roles (name) VALUES ?"),
      [
        [
          ["admin"],
          ["parent"],
          ["school"],
          ["teacher"],
          ["healthcare"],
          ["staff"],
        ],
      ],
    );
  });

  it("skips insert when roles already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedRoles();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("UserSeeder", () => {
  it("inserts admin user when none exists", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await seedUser();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM users WHERE username = ?"),
      ["admin"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "INSERT INTO users (id, username, email, password, role_id, created_at, updated_at)",
      ),
      [
        expect.any(String),
        "admin",
        "admin@example.com",
        "hashed:admin",
        1,
      ],
    );
  });

  it("skips insert when admin user already exists", async () => {
    pool.query.mockResolvedValueOnce([[{ id: "existing-id" }], []]);

    await seedUser();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("CategorySeeder", () => {
  it("inserts categories when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 3 }, []]);

    await seedCategories();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM categories WHERE name IN"),
      [
        [
          "Tingkat Pengetahuan Gizi Seimbang",
          "Kebiasaan Sehari-hari Anak",
          "Pelayanan Kesehatan Sekolah",
        ],
      ],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO categories (name, path) VALUES ?"),
      [
        [
          ["Tingkat Pengetahuan Gizi Seimbang", "/tingkat-pengetahuan-gizi-seimbang"],
          ["Kebiasaan Sehari-hari Anak", "/kebiasaan-sehari-hari-anak"],
          ["Pelayanan Kesehatan Sekolah", "/pelayanan-kesehatan-sekolah"],
        ],
      ],
    );
  });

  it("skips insert when categories already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedCategories();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("CitySeeder", () => {
  it("inserts cities when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 6 }, []]);

    await seedCity();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM cities WHERE name IN"),
      [
        [
          "Kepulauan Seribu",
          "Jakarta Barat",
          "Jakarta Pusat",
          "Jakarta Selatan",
          "Jakarta Timur",
          "Jakarta Utara",
        ],
      ],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO cities (name, province_id) VALUES ?"),
      [
        [
          ["Kepulauan Seribu", 1],
          ["Jakarta Barat", 1],
          ["Jakarta Pusat", 1],
          ["Jakarta Selatan", 1],
          ["Jakarta Timur", 1],
          ["Jakarta Utara", 1],
        ],
      ],
    );
  });

  it("skips insert when cities already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedCity();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("ProvinceSeeder", () => {
  it("inserts province when none exists", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await seedProvince();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM provinces WHERE name = ?"),
      ["DKI Jakarta"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO provinces (name) VALUES (?)"),
      ["DKI Jakarta"],
    );
  });

  it("skips insert when province already exists", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedProvince();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("InstitutionTypeSeeder", () => {
  it("inserts institution types when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []]);

    await seedInstitutionTypes();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM institution_types WHERE name IN"),
      [["School", "HealthCare"]],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO institution_types (name) VALUES ?"),
      [[["School"], ["HealthCare"]]],
    );
  });

  it("skips insert when institution types already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedInstitutionTypes();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("QuesionerSeeder", () => {
  it("inserts quesioners when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 3 }, []]);

    await seedQuesioners();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM quesioners WHERE title IN"),
      [
        [
          "Tingkat Pengetahuan Gizi Seimbang",
          "Kebiasaan Sehari-hari Anak",
          "Pelayanan Kesehatan Sekolah",
        ],
      ],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "INSERT INTO quesioners (title, description) VALUES ?",
      ),
      [
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
      ],
    );
  });

  it("skips insert when quesioners already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedQuesioners();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("QuestionSeeder", () => {
  it("inserts questions when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 43 }, []]);

    await seedQuestions();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM questions WHERE type IN"),
      [["BOOLEAN", "SCALE"]],
    );

    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain(
      "INSERT INTO questions (quesioner_id, title, type, is_negative) VALUES ?",
    );
    const rows = params[0];
    // spot-check length only, not every value — data is seed content, not logic.
    expect(rows).toHaveLength(43);
    expect(rows[0]).toEqual([
      1,
      "Anak Sekolah yang sehat adalah yang memiliki badan gemuk",
      "BOOLEAN",
      false,
    ]);
  });

  it("skips insert when questions already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedQuestions();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("OptionSeeder", () => {
  it("inserts options built from existing questions when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []]) // existence check
      .mockResolvedValueOnce([
        [
          { id: 1, is_negative: 0 },
          { id: 16, is_negative: 1 },
          { id: 36, is_negative: 0 },
        ],
        [],
      ]) // questions lookup
      .mockResolvedValueOnce([{ affectedRows: 10 }, []]); // insert

    await seedOptions();

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM options WHERE title IN"),
      [["Benar", "Salah", "1", "2", "3", "4", "0"]],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "SELECT id, is_negative FROM questions ORDER BY id ASC",
      ),
    );

    const [sql, params] = pool.query.mock.calls[2];
    expect(sql).toContain(
      "INSERT INTO options (question_id, title, score) VALUES ?",
    );
    const optionRows = params[0];
    // q.id=1 (<=15, boolean, not negative): Benar -> 1-0=1, Salah -> 1-1=0
    expect(optionRows).toEqual(
      expect.arrayContaining([
        [1, "Benar", 1],
        [1, "Salah", 0],
      ]),
    );
  });

  it("skips insert and question lookup when options already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedOptions();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  describe("getScore bucketing logic (mirrors OptionSeeder.js internals)", () => {
    const getScore = (qid, isNegative, idx) => {
      if (qid <= 15) return isNegative ? idx : 1 - idx;
      if (qid <= 35) return isNegative ? 4 - idx : idx + 1;
      return isNegative ? 3 - idx : idx;
    };

    it("computes boolean-range (<=15) scores for both is_negative cases", () => {
      expect(getScore(15, false, 0)).toBe(1);
      expect(getScore(15, false, 1)).toBe(0);
      expect(getScore(15, true, 0)).toBe(0);
      expect(getScore(15, true, 1)).toBe(1);
    });

    it("computes parent-scale-range (<=35) scores for both is_negative cases", () => {
      expect(getScore(35, false, 0)).toBe(1);
      expect(getScore(35, false, 3)).toBe(4);
      expect(getScore(35, true, 0)).toBe(4);
      expect(getScore(35, true, 3)).toBe(1);
    });

    it("computes school-scale-range (>35) scores for both is_negative cases", () => {
      expect(getScore(36, false, 0)).toBe(0);
      expect(getScore(36, false, 3)).toBe(3);
      expect(getScore(36, true, 0)).toBe(3);
      expect(getScore(36, true, 3)).toBe(0);
    });

    it("coerces a TINYINT 1/0 is_negative value via !!q.is_negative like OptionSeeder.js does", () => {
      const rowNegativeTinyint = { id: 20, is_negative: 1 };
      const rowPositiveTinyint = { id: 20, is_negative: 0 };

      expect(!!rowNegativeTinyint.is_negative).toBe(true);
      expect(!!rowPositiveTinyint.is_negative).toBe(false);
      expect(getScore(rowNegativeTinyint.id, !!rowNegativeTinyint.is_negative, 0)).toBe(4);
      expect(getScore(rowPositiveTinyint.id, !!rowPositiveTinyint.is_negative, 0)).toBe(1);
    });
  });
});

describe("JobTypeSeeder", () => {
  it("inserts job types when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 5 }, []]);

    await seedJobTypes();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM job_types WHERE name IN"),
      [
        [
          "Tidak Bekerja",
          "Buruh",
          "Karyawan Swasta",
          "ASN / BUMN",
          "Wiraswasta",
        ],
      ],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO job_types (name, type) VALUES ?"),
      [
        [
          ["Tidak Bekerja", "TIDAK_BEKERJA"],
          ["Buruh", "BURUH"],
          ["Karyawan Swasta", "KARYAWAN_SWASTA"],
          ["ASN / BUMN", "ASN_BUMN"],
          ["Wiraswasta", "WIRASWASTA"],
        ],
      ],
    );
  });

  it("skips insert when job types already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedJobTypes();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("NutritionStatusSeeder", () => {
  it("inserts nutrition status rows when none exist", async () => {
    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 3 }, []]);

    await seedNutritionStatus();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "SELECT id FROM nutrition_status WHERE displayName IN",
      ),
      [["GIZI BURUK-KURANG", "GIZI BAIK", "OVERWEIGHT-OBESITAS"]],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "INSERT INTO nutrition_status (displayName, status, information) VALUES ?",
      ),
      [
        [
          ["GIZI BURUK-KURANG", "GIZI_BURUK_KURANG", "Kekurangan bb tingkat ringan sampai berat"],
          ["GIZI BAIK", "GIZI_BAIK", "Gizi normal"],
          ["OVERWEIGHT-OBESITAS", "OVERWEIGHT_OBESITAS", "Kelebihan bb tingkat ringan sampai berat"],
        ],
      ],
    );
  });

  it("skips insert when nutrition status rows already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);

    await seedNutritionStatus();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("IMTSeeder", () => {
  it("inserts bmi references when table is empty", async () => {
    pool.query
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([{ affectedRows: 16 }, []]);

    await seedIMT();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS count FROM bmi_references"),
    );

    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain("INSERT INTO bmi_references");
    expect(sql).toContain("VALUES ?");
    const rows = params[0];
    expect(rows).toHaveLength(16);
    // first column set is ageYear, ageMonthFrom, ageMonthTo, gender ...
    expect(rows[0][0]).toBe(7);
    expect(rows[0][3]).toBe("P");
  });

  it("skips insert when bmi references already exist", async () => {
    pool.query.mockResolvedValueOnce([[{ count: 16 }], []]);

    await seedIMT();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
