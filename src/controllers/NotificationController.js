import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const createNotification = async (
  userId,
  title,
  message,
  type,
  referenceId = null
) => {
  const id = randomUUID();

  await pool.query(
    "INSERT INTO notifications (id, userId, title, message, type, referenceId) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, title, message, type, referenceId]
  );

  const [[notification]] = await pool.query(
    "SELECT id, userId, title, message, isRead, type, referenceId, createdAt FROM notifications WHERE id = ?",
    [id]
  );

  return { ...notification, isRead: !!notification.isRead };
};

export const getNotifications = async (req, res) => {
  try {
    const user = req.user;
    const page = Number.parseInt(req.query.page) || 0;
    const limit = Number.parseInt(req.query.limit) || 20;
    const skip = limit * page;

    const [[notificationRows], [countRows]] = await Promise.all([
      pool.query(
        "SELECT id, userId, title, message, isRead, type, referenceId, createdAt FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?",
        [user.id, limit, skip]
      ),
      pool.query("SELECT COUNT(*) AS total FROM notifications WHERE userId = ?", [
        user.id,
      ]),
    ]);

    const notifications = notificationRows.map((n) => ({
      ...n,
      isRead: !!n.isRead,
    }));
    const totalRows = countRows[0].total;
    const totalPages = Math.ceil(totalRows / limit);

    return successResponse(
      res,
      { notifications, page, limit, totalPages, totalRows },
      "Notifications fetched"
    );
  } catch (err) {
    return errorResponse(res, err, "Failed to get notifications");
  }
};

export const getUnreadCount = async (req, res) => {
  try {
    const user = req.user;
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM notifications WHERE userId = ? AND isRead = 0",
      [user.id]
    );

    return successResponse(res, { count: total }, "Unread count fetched");
  } catch (err) {
    return errorResponse(res, err, "Failed to get unread count");
  }
};

export const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    await pool.query(
      "UPDATE notifications SET isRead = 1 WHERE id = ? AND userId = ?",
      [id, user.id]
    );

    return successResponse(res, null, "Notification marked as read");
  } catch (err) {
    return errorResponse(res, err, "Failed to mark notification as read");
  }
};

export const markAllAsRead = async (req, res) => {
  try {
    const user = req.user;

    await pool.query(
      "UPDATE notifications SET isRead = 1 WHERE userId = ? AND isRead = 0",
      [user.id]
    );

    return successResponse(res, null, "All notifications marked as read");
  } catch (err) {
    return errorResponse(res, err, "Failed to mark all as read");
  }
};
