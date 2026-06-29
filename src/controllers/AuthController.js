import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();

export const registerParent = async (req, res) => {
  const { username, email, password, role_id } = req.body;

  const hashPassword = await argon2.hash(password);

  try {
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ username }, { email }],
      },
    });

    if (existingUser) {
      return errorResponse(res, null, "Username atau email sudah digunakan");
    }

    const [newParent] = await prisma.$transaction([
      prisma.user.create({
        data: {
          username,
          email,
          password: hashPassword,
          role_id: role_id,
        },
      }),
      prisma.family.create({
        data: {
          user: {
            connect: {
              username: username,
            },
          },
        },
      }),
    ]);

    return successResponse(res, newParent, "Berhasil membuat akun");
  } catch (error) {
    return errorResponse(res, error, "Error saat membuat akun");
  }
};

export const registerInstitution = async (req, res) => {
  const {
    username,
    email,
    password,
    role_id,
    institutionName,
    institutionEmail,
    institutionPhone,
    institutionAddress,
    institutionProvince,
    institutionCity,
    institutionType,
  } = req.body;

  const hashPassword = await argon2.hash(password);

  try {
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ username }, { email }],
      },
    });

    if (existingUser)
      return errorResponse(res, null, "Username atau email sudah digunakan");

    const existingInstitution = await prisma.institution.findFirst({
      where: {
        OR: [
          { name: institutionName },
          { email: institutionEmail },
          { phone: institutionPhone },
          // { address: institutionAddress },
        ],
      },
    });

    if (existingInstitution)
      return errorResponse(
        res,
        null,
        "Institusi ini sudah digunakan oleh akun lain"
      );

    const newInstitution = await prisma.user.create({
      data: {
        username,
        email,
        password: hashPassword,
        role_id,
        institution: {
          create: {
            name: institutionName,
            email: institutionEmail,
            phone: institutionPhone,
            address: institutionAddress,
            province_id: institutionProvince,
            city_id: institutionCity,
            type: institutionType,
          },
        },
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: {
          select: {
            name: true,
          },
        },
        institution: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            address: true,
            province: {
              select: {
                id: true,
                name: true,
              },
            },
            city: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
    return successResponse(res, newInstitution, "Berhasil membuat akun");
  } catch (error) {
    return errorResponse(res, error, "Error saat membuat akun");
  }
};

export const login = async (req, res) => {
  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ username: req.body.identifier }, { email: req.body.identifier }],
      },
      include: {
        role: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!user) {
      return errorResponse(res, null, "User tidak ditemukan");
    }

    const match = await argon2.verify(user.password, req.body.password);
    if (!match) return errorResponse(res, null, "Password salah");
    const { id, username, email, role } = user;
    const roleName = role.name;

    const accessToken = jwt.sign(
      { id, username, email, role: roleName },
      process.env.APP_ACCESS_TOKEN_SECRET,
      {
        expiresIn: process.env?.NODE_ENV === "production" ? "20s" : 3600 * 3,
      }
    );
    const refreshToken = jwt.sign(
      { id, username, email, role: roleName },
      process.env.APP_REFRESH_TOKEN_SECRET,
      {
        expiresIn: "1d",
      }
    );
    await prisma.user.update({
      data: {
        refresh_token: refreshToken,
      },
      where: {
        id,
      },
    });
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      secure: true,
      sameSite: "none",
    });
    return successResponse(res, { accessToken }, "Login berhasil");
  } catch (error) {
    return errorResponse(res, error, "Terjadi kesalahan saat login");
  }
};

export const logout = async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken)
    return errorResponse(res, null, "Refresh token tidak ditemukan");
  const user = await prisma.user.findFirst({
    where: {
      refresh_token: refreshToken,
    },
    include: {
      role: {
        select: {
          name: true,
        },
      },
    },
  });
  if (!user) return errorResponse(res, null, "Refresh token tidak valid");
  const { id } = user;
  await prisma.user.update({
    where: {
      id,
    },
    data: {
      refresh_token: null,
    },
  });
  res.clearCookie("refreshToken", { httpOnly: true, secure: true, sameSite: "none" });
  return successResponse(res, null, "Logout berhasil");
};
