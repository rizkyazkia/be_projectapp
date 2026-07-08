import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();

export const refreshToken = async (req, res) => {
  try {
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
    jwt.verify(
      refreshToken,
      process.env.APP_REFRESH_TOKEN_SECRET,
      (err, decoded) => {
        if (err) return errorResponse(res, err, "Refresh token tidak valid");
        const { id, username, email, role } = user;
        const roleName = role.name;
        const accessToken = jwt.sign(
          { id, username, email, role: roleName },
          process.env.APP_ACCESS_TOKEN_SECRET,
          {
            expiresIn: "15m",
          }
        );
        return successResponse(
          res,
          { accessToken },
          "Access token berhasil diperbarui"
        );
      }
    );
  } catch (error) {
    return errorResponse(res, error, "Error refreshing token");
  }
};
