import { PrismaClient } from "@prisma/client";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();

export const getFamily = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT f.id AS family_id,
              u.id AS user_id, u.username AS user_username, u.email AS user_email,
              r.id AS role_id, r.name AS role_name
       FROM families f
       JOIN users u ON u.id = f.userId
       JOIN roles r ON r.id = u.role_id`,
    );

    const family = rows.map((row) => ({
      id: row.family_id,
      user: {
        id: row.user_id,
        username: row.user_username,
        email: row.user_email,
        role: {
          id: row.role_id,
          name: row.role_name,
        },
      },
    }));

    return successResponse(res, family, "Family retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve family");
  }
};

export const getFamilyMemberByUser = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const user = req.user;

    const [familyRows] = await pool.query(
      "SELECT * FROM families WHERE userId = ?",
      [user.id],
    );
    const family = familyRows;

    // `family` is always an array (possibly empty) — even a zero-row raw
    // SELECT returns `[]`, which is truthy — so this guard never fires. This
    // mirrors the original Prisma `findMany()` behavior exactly and is
    // preserved as intentional dead code rather than "fixed" to `.length === 0`.
    if (!family) {
      return errorResponse(res, null, "Family not found");
    }

    const familyIds = family.map((f) => f.id);

    if (familyIds.length === 0) {
      // An empty `IN ()` is a MySQL syntax error, and there is nothing to
      // find anyway if the user has no families, so short-circuit here.
      return successResponse(
        res,
        { totalRows: 0, totalPage: 0, page, limit, familyMembers: [] },
        "Family Member retrieved successfully",
      );
    }

    const [countRows] = await pool.query(
      "SELECT COUNT(*) AS count FROM family_members WHERE familyId IN (?) AND fullName LIKE ?",
      [familyIds, `%${search}%`],
    );
    const totalRows = countRows[0].count;
    const totalPage = Math.ceil(totalRows / limit);

    // NOTE: the original Prisma code computes `offset`/`limit` above but never
    // passes them to `findMany` — no pagination is actually applied to this
    // query. Preserved exactly: no LIMIT/OFFSET below.
    const [rows] = await pool.query(
      `SELECT
         fm.id AS fm_id, fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate,
         fm.age AS fm_age, fm.education AS fm_education, fm.gender AS fm_gender,
         fm.relation AS fm_relation, fm.phone AS fm_phone, fm.isCompleted AS fm_isCompleted,
         job.id AS job_id,
         jobType.id AS jobType_id, jobType.name AS jobType_name,
         se.id AS se_id, se.residenceStatus AS se_residenceStatus, se.address AS se_address,
         se.childrenCount AS se_childrenCount, se.underFiveCount AS se_underFiveCount,
         se.familyIncomeLevel AS se_familyIncomeLevel,
         nu.id AS nu_id, nu.height AS nu_height, nu.weight AS nu_weight, nu.bmi AS nu_bmi,
         ns.id AS ns_id, ns.information AS ns_information, ns.displayName AS ns_displayName,
         st.id AS st_id, st.nis AS st_nis, st.schoolYear AS st_schoolYear, st.semester AS st_semester,
         class.id AS class_id, class.name AS class_name,
         inst.id AS inst_id, inst.name AS inst_name, inst.email AS inst_email,
         inst.address AS inst_address, inst.phone AS inst_phone,
         itp.id AS itp_id, itp.name AS itp_name,
         prov.id AS prov_id, prov.name AS prov_name,
         city.id AS city_id, city.name AS city_name
       FROM family_members fm
       LEFT JOIN jobs job ON job.id = fm.jobId
       LEFT JOIN job_types jobType ON jobType.id = job.jobTypeId
       JOIN socio_economic se ON se.id = fm.socioEconomicId
       LEFT JOIN nutritions nu ON nu.familyMemberId = fm.id
       LEFT JOIN nutrition_status ns ON ns.id = nu.nutritionStatusId
       LEFT JOIN students st ON st.familyMemberId = fm.id
       LEFT JOIN classes class ON class.id = st.classId
       LEFT JOIN institutions inst ON inst.id = st.schoolId
       LEFT JOIN institution_types itp ON itp.id = inst.type
       LEFT JOIN provinces prov ON prov.id = inst.province_id
       LEFT JOIN cities city ON city.id = inst.city_id
       WHERE fm.familyId IN (?) AND fm.fullName LIKE ?`,
      [familyIds, `%${search}%`],
    );

    const familyMembers = rows.map((row) => ({
      id: row.fm_id,
      fullName: row.fm_fullName,
      birthDate: row.fm_birthDate,
      age: row.fm_age,
      education: row.fm_education,
      gender: row.fm_gender,
      relation: row.fm_relation,
      phone: row.fm_phone,
      job: row.job_id
        ? {
            id: row.job_id,
            jobType: row.jobType_id
              ? { id: row.jobType_id, name: row.jobType_name }
              : null,
          }
        : null,
      SocioEconomic: {
        id: row.se_id,
        residenceStatus: row.se_residenceStatus,
        address: row.se_address,
        childrenCount: row.se_childrenCount,
        underFiveCount: row.se_underFiveCount,
        familyIncomeLevel: row.se_familyIncomeLevel,
      },
      nutrition: row.nu_id
        ? [
            {
              id: row.nu_id,
              height: row.nu_height,
              weight: row.nu_weight,
              bmi: row.nu_bmi,
              nutritionStatus: row.ns_id
                ? {
                    id: row.ns_id,
                    information: row.ns_information,
                    displayName: row.ns_displayName,
                  }
                : null,
            },
          ]
        : [],
      student: row.st_id
        ? {
            id: row.st_id,
            nis: row.st_nis,
            schoolYear: row.st_schoolYear,
            semester: row.st_semester,
            class: row.class_id
              ? { id: row.class_id, name: row.class_name }
              : null,
            institution: row.inst_id
              ? {
                  id: row.inst_id,
                  name: row.inst_name,
                  email: row.inst_email,
                  address: row.inst_address,
                  institution_type: row.itp_id
                    ? { id: row.itp_id, name: row.itp_name }
                    : null,
                  phone: row.inst_phone,
                  province: row.prov_id
                    ? { id: row.prov_id, name: row.prov_name }
                    : null,
                  city: row.city_id
                    ? { id: row.city_id, name: row.city_name }
                    : null,
                }
              : null,
          }
        : null,
      isCompleted: !!row.fm_isCompleted,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, familyMembers },
      "Family Member retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve family member");
  }
};

export const getFamilyMember = async (req, res) => {
  const page = Number.parseInt(req.query.page) || 0;
  const limit = Number.parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const [countRows] = await pool.query(
      "SELECT COUNT(*) AS count FROM family_members WHERE fullName LIKE ?",
      [`%${search}%`],
    );
    const totalRows = countRows[0].count;
    const totalPage = Math.ceil(totalRows / limit);

    const [rows] = await pool.query(
      "SELECT * FROM family_members WHERE fullName LIKE ? ORDER BY id ASC LIMIT ? OFFSET ?",
      [`%${search}%`, limit, offset],
    );

    const familyMembers = rows.map((row) => ({
      ...row,
      isCompleted: !!row.isCompleted,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, familyMembers },
      "Family Member retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve family member");
  }
};

export const getParentsByFamilyMemberId = async (req, res) => {
  try {
    const { id } = req.params;

    const [familyMemberRows] = await pool.query(
      "SELECT familyId FROM family_members WHERE id = ?",
      [id],
    );
    const familyMember = familyMemberRows[0];

    if (!familyMember)
      return errorResponse(res, null, "Family member not found");

    const [rows] = await pool.query(
      `SELECT
         fm.id AS fm_id, fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate,
         fm.age AS fm_age, fm.education AS fm_education, fm.phone AS fm_phone,
         job.id AS job_id,
         jobType.id AS jobType_id, jobType.name AS jobType_name,
         se.id AS se_id, se.residenceStatus AS se_residenceStatus, se.address AS se_address,
         se.childrenCount AS se_childrenCount, se.underFiveCount AS se_underFiveCount,
         se.familyIncomeLevel AS se_familyIncomeLevel
       FROM family_members fm
       LEFT JOIN jobs job ON job.id = fm.jobId
       LEFT JOIN job_types jobType ON jobType.id = job.jobTypeId
       JOIN socio_economic se ON se.id = fm.socioEconomicId
       WHERE fm.familyId = ? AND (fm.relation = 'AYAH' OR fm.relation = 'IBU')`,
      [familyMember.familyId],
    );

    const parents = rows.map((row) => ({
      id: row.fm_id,
      fullName: row.fm_fullName,
      birthDate: row.fm_birthDate,
      age: row.fm_age,
      education: row.fm_education,
      phone: row.fm_phone,
      job: row.job_id
        ? {
            id: row.job_id,
            jobType: row.jobType_id
              ? { id: row.jobType_id, name: row.jobType_name }
              : null,
          }
        : null,
      SocioEconomic: {
        id: row.se_id,
        residenceStatus: row.se_residenceStatus,
        address: row.se_address,
        childrenCount: row.se_childrenCount,
        underFiveCount: row.se_underFiveCount,
        familyIncomeLevel: row.se_familyIncomeLevel,
      },
    }));

    return successResponse(res, parents, "Parents retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve parents");
  }
};

export const createFamilyMember = async (req, res) => {
  try {
    const user = req.user;
    let members = req.body;

    if (!Array.isArray(members)) {
      members = [members];
    }

    const familyByUser = await prisma.family.findUnique({
      where: {
        userId: user.id,
      },
    });

    if (!familyByUser) {
      return errorResponse(res, null, "Family not found");
    }

    const results = [];

    for (const member of members) {
      const {
        type,
        fullName,
        age,
        birthDate,
        education,
        jobTypeId,
        height,
        weight,
        gender,
        relation,
        phone,
        residenceStatus,
        address,
        childrenCount,
        underFiveCount,
        familyIncomeLevel,
        nis,
        schoolYear,
        semester,
        schoolId,
        classId,
        sameSocioEconomic,
      } = member;

      let job, socioEconomic, familyMember, nutrition, student, parent;

      const existingFamilyMember = await prisma.familyMember.findFirst({
        where: {
          familyId: familyByUser.id,
          relation,
        },
        include: {
          job: true,
        },
      });

      if (type === "ibu") {
        socioEconomic = await prisma.socioEconomic.create({
          data: {
            residenceStatus,
            address,
            childrenCount,
            underFiveCount,
            familyIncomeLevel,
          },
        });

        if (existingFamilyMember && existingFamilyMember.job) {
          job = await prisma.job.update({
            where: { id: existingFamilyMember.job.id },
            data: { jobTypeId },
          });
        } else {
          job = await prisma.job.create({
            data: { jobTypeId },
          });
        }

        if (!job || !job.id) {
          results.push({ error: "Job gagal dibuat", member });
          continue;
        }

        if (existingFamilyMember) {
          familyMember = await prisma.familyMember.update({
            where: { id: existingFamilyMember.id },
            data: {
              fullName,
              age: age ? Number.parseInt(age) : null,
              education,
              relation,
              familyId: familyByUser.id,
              phone,
              jobId: job.id,
              socioEconomicId: socioEconomic.id,
              isCompleted: true,
            },
          });
        } else {
          familyMember = await prisma.familyMember.create({
            data: {
              fullName,
              age: age ? Number.parseInt(age) : null,
              education,
              relation,
              familyId: familyByUser.id,
              phone,
              jobId: job.id,
              socioEconomicId: socioEconomic.id,
              isCompleted: true,
            },
          });
        }
      } else if (type === "ayah") {
        let socioEconomicId;

        if (sameSocioEconomic) {
          const ibu = await prisma.familyMember.findFirst({
            where: {
              familyId: familyByUser.id,
              relation: "IBU",
            },
            select: { socioEconomicId: true },
          });

          if (!ibu || !ibu.socioEconomicId) {
            results.push({
              error: "Data ibu tidak ditemukan, isi data ibu terlebih dahulu",
              member,
            });
            continue;
          }

          socioEconomicId = ibu.socioEconomicId;
        } else {
          socioEconomic = await prisma.socioEconomic.create({
            data: {
              residenceStatus,
              address,
              childrenCount,
              underFiveCount,
              familyIncomeLevel,
            },
          });
          socioEconomicId = socioEconomic.id;
        }

        if (existingFamilyMember && existingFamilyMember.job) {
          job = await prisma.job.update({
            where: { id: existingFamilyMember.job.id },
            data: { jobTypeId },
          });
        } else {
          job = await prisma.job.create({
            data: { jobTypeId },
          });
        }

        if (!job || !job.id) {
          results.push({ error: "Job gagal dibuat", member });
          continue;
        }

        if (existingFamilyMember) {
          familyMember = await prisma.familyMember.update({
            where: { id: existingFamilyMember.id },
            data: {
              fullName,
              age: age ? Number.parseInt(age) : null,
              education,
              relation,
              familyId: familyByUser.id,
              phone,
              jobId: job.id,
              socioEconomicId,
              isCompleted: true,
            },
          });
        } else {
          familyMember = await prisma.familyMember.create({
            data: {
              fullName,
              age: age ? Number.parseInt(age) : null,
              education,
              relation,
              familyId: familyByUser.id,
              phone,
              jobId: job.id,
              socioEconomicId,
              isCompleted: true,
            },
          });
        }
      } else if (type === "anak") {
        const childBirthDate = new Date(birthDate);
        const today = new Date();
        let ageMonths =
          (today.getFullYear() - childBirthDate.getFullYear()) * 12 +
          (today.getMonth() - childBirthDate.getMonth());
        if (today.getDate() < childBirthDate.getDate()) {
          ageMonths--;
        }
        const ageYear = Math.floor(ageMonths / 12);
        const ageMonthRemainder = ageMonths % 12;

        const heightInMeters = Number(height) / 100;
        const calculateBMI = Number(weight) / (heightInMeters * heightInMeters);

        const bmiRef = await prisma.bmiReference.findFirst({
          where: {
            gender: gender,
            ageYear: ageYear,
            ageMonthFrom: { lte: ageMonthRemainder },
            ageMonthTo: { gte: ageMonthRemainder },
          },
        });

        if (!bmiRef) {
          results.push({
            error: "Referensi BMI tidak ditemukan untuk usia anak ini",
            member,
          });
          continue;
        }

        let nutritionStatusEnum;
        if (calculateBMI < bmiRef.sdMinus2Min) {
          nutritionStatusEnum = "GIZI_BURUK_KURANG";
        } else if (calculateBMI > bmiRef.sdPlus1Max) {
          nutritionStatusEnum = "OVERWEIGHT_OBESITAS";
        } else {
          nutritionStatusEnum = "GIZI_BAIK";
        }

        const nutritionStatusRecord = await prisma.nutritionStatus.findFirst({
          where: { status: nutritionStatusEnum },
        });

        if (!nutritionStatusRecord) {
          results.push({
            error: "Nutrition status not found",
            member,
          });
          continue;
        }

        parent = await prisma.familyMember.findFirst({
          where: {
            familyId: familyByUser.id,
            OR: [{ relation: "IBU" }, { relation: "AYAH" }],
          },
          select: {
            socioEconomicId: true,
          },
        });

        if (!parent || !parent.socioEconomicId) {
          results.push({
            error: "Data orang tua tidak ditemukan",
            member,
          });
          continue;
        }

        if (existingFamilyMember) {
          familyMember = await prisma.familyMember.update({
            where: { id: existingFamilyMember.id },
            data: {
              fullName,
              birthDate: childBirthDate,
              education,
              gender,
              relation,
              familyId: familyByUser.id,
              phone,
              socioEconomicId: parent.socioEconomicId,
              isCompleted: true,
            },
          });
        } else {
          familyMember = await prisma.familyMember.create({
            data: {
              fullName,
              birthDate: childBirthDate,
              education,
              gender,
              relation,
              familyId: familyByUser.id,
              phone,
              socioEconomicId: parent.socioEconomicId,
              isCompleted: true,
            },
          });
        }

        const existingStudent = await prisma.student.findUnique({
          where: { nis },
        });

        if (existingStudent) {
          student = await prisma.student.update({
            where: { nis },
            data: {
              schoolYear,
              semester,
              schoolId,
              classId,
              familyMemberId: familyMember.id,
            },
          });
        } else {
          student = await prisma.student.create({
            data: {
              nis,
              schoolYear,
              semester,
              schoolId,
              classId,
              familyMemberId: familyMember.id,
            },
          });
        }

        const existingNutrition = await prisma.nutrition.findFirst({
          where: { familyMemberId: familyMember.id },
        });

        if (existingNutrition) {
          nutrition = await prisma.nutrition.update({
            where: { id: existingNutrition.id },
            data: {
              height: Number(height),
              weight: Number(weight),
              bmi: calculateBMI,
              nutritionStatusId: nutritionStatusRecord.id,
            },
          });
        } else {
          nutrition = await prisma.nutrition.create({
            data: {
              height: Number(height),
              weight: Number(weight),
              bmi: calculateBMI,
              nutritionStatusId: nutritionStatusRecord.id,
              familyMemberId: familyMember.id,
              createdBy: user.id,
            },
          });
        }
      } else {
        results.push({ error: "Invalid type", member });
        continue;
      }

      results.push({ job, socioEconomic, familyMember, nutrition, student });
    }

    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      return errorResponse(
        res,
        { results, errors },
        errors[0].error,
      );
    }

    return successResponse(
      res,
      results,
      "Berhasil menambahkan anggota keluarga",
    );
  } catch (error) {
    return errorResponse(res, error, "Gagal menambahkan anggota keluarga");
  }
};

export const updateFamilyMember = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      type,
      height,
      weight,
      nis,
      schoolYear,
      semester,
      schoolId,
      classId,
      ...fields
    } = req.body;

    const familyMember = await prisma.familyMember.findUnique({
      where: { id },
      include: {
        nutrition: true,
        student: true,
      },
    });

    if (!familyMember) {
      return errorResponse(res, null, "Family member not found");
    }

    if (Object.keys(fields).length > 0) {
      if (fields.birthDate) fields.birthDate = new Date(fields.birthDate);
      await prisma.familyMember.update({
        where: { id },
        data: fields,
      });
    }

    if (
      (height !== undefined || weight !== undefined) &&
      familyMember.nutrition.length > 0
    ) {
      let bmi, nutritionStatusId;
      if (height !== undefined && weight !== undefined) {
        const heightInMeters = Number(height) / 100;
        bmi = Number(weight) / (heightInMeters * heightInMeters);

        const childBirthDate = familyMember.birthDate;
        if (childBirthDate) {
          const today = new Date();
          let ageMonths =
            (today.getFullYear() - childBirthDate.getFullYear()) * 12 +
            (today.getMonth() - childBirthDate.getMonth());
          if (today.getDate() < childBirthDate.getDate()) {
            ageMonths--;
          }
          const ageYear = Math.floor(ageMonths / 12);
          const ageMonthRemainder = ageMonths % 12;

          const bmiRef = await prisma.bmiReference.findFirst({
            where: {
              gender: familyMember.gender,
              ageYear: ageYear,
              ageMonthFrom: { lte: ageMonthRemainder },
              ageMonthTo: { gte: ageMonthRemainder },
            },
          });

          if (bmiRef) {
            let nutritionStatusEnum;
            if (bmi < bmiRef.sdMinus2Min) {
              nutritionStatusEnum = "GIZI_BURUK_KURANG";
            } else if (bmi > bmiRef.sdPlus1Max) {
              nutritionStatusEnum = "OVERWEIGHT_OBESITAS";
            } else {
              nutritionStatusEnum = "GIZI_BAIK";
            }

            const nutritionStatusRecord =
              await prisma.nutritionStatus.findFirst({
                where: { status: nutritionStatusEnum },
              });
            nutritionStatusId = nutritionStatusRecord?.id;
          }
        }
      }

      const nutritionUpdateData = {
        ...(height !== undefined && { height: Number(height) }),
        ...(weight !== undefined && { weight: Number(weight) }),
        ...(bmi !== undefined && { bmi }),
        ...(nutritionStatusId && { nutritionStatusId }),
      };

      await prisma.nutrition.update({
        where: { id: familyMember.nutrition[0].id },
        data: nutritionUpdateData,
      });
    }

    if (type === "anak") {
      const studentUpdateData = {
        ...(nis !== undefined && { nis }),
        ...(schoolYear !== undefined && { schoolYear }),
        ...(semester !== undefined && { semester }),
        ...(schoolId !== undefined && { schoolId }),
        ...(classId !== undefined && { classId }),
      };

      if (Object.keys(studentUpdateData).length > 0 && familyMember.student) {
        await prisma.student.update({
          where: { id: familyMember.student.id },
          data: studentUpdateData,
        });
      } else if (
        Object.keys(studentUpdateData).length > 0 &&
        !familyMember.student
      ) {
        await prisma.student.create({
          data: {
            ...studentUpdateData,
            familyMemberId: familyMember.id,
          },
        });
      }
    }

    await prisma.familyMember.update({
      where: { id },
      data: { isCompleted: true },
    });

    return successResponse(res, null, "Berhasil mengupdate anggota keluarga");
  } catch (error) {
    return errorResponse(res, error, "Gagal mengupdate anggota keluarga");
  }
};

export const deleteFamilyMember = async (req, res) => {
  try {
    const { id } = req.params;

    const familyMember = await prisma.familyMember.findUnique({
      where: { id },
    });

    if (!familyMember) {
      return errorResponse(res, null, "Family member not found");
    }

    if (familyMember.jobId) {
      await prisma.job.delete({
        where: { id: familyMember.jobId },
      });
    }

    await prisma.familyMember.delete({
      where: { id },
    });

    return successResponse(res, null, "Berhasil menghapus anggota keluarga");
  } catch (error) {
    return errorResponse(res, error, "Gagal menghapus anggota keluarga");
  }
};
