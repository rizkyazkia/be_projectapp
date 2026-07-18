import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  createNotification,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} from "../NotificationController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createNotification", () => {
  it("inserts a notification and returns the re-selected row with isRead coerced to boolean", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([
        [
          {
            id: "generated-id",
            userId: "user-1",
            title: "Title",
            message: "Msg",
            isRead: 0,
            type: "REC",
            referenceId: "ref-1",
            createdAt: new Date("2026-01-01"),
          },
        ],
      ]);

    const result = await createNotification(
      "user-1",
      "Title",
      "Msg",
      "REC",
      "ref-1"
    );

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "INSERT INTO notifications (id, userId, title, message, type, referenceId) VALUES (?, ?, ?, ?, ?, ?)"
      ),
      [expect.any(String), "user-1", "Title", "Msg", "REC", "ref-1"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM notifications WHERE id = ?"),
      [expect.any(String)]
    );
    expect(result).toEqual(
      expect.objectContaining({ id: "generated-id", isRead: false })
    );
  });

  it("defaults referenceId to null when not provided", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([
        [
          {
            id: "generated-id-2",
            userId: "user-2",
            title: "T",
            message: "M",
            isRead: 0,
            type: "GEN",
            referenceId: null,
            createdAt: new Date("2026-01-01"),
          },
        ],
      ]);

    await createNotification("user-2", "T", "M", "GEN");

    expect(pool.query).toHaveBeenNthCalledWith(1, expect.any(String), [
      expect.any(String),
      "user-2",
      "T",
      "M",
      "GEN",
      null,
    ]);
  });
});

describe("getNotifications", () => {
  it("returns a paginated list with isRead coerced per row", async () => {
    pool.query
      .mockResolvedValueOnce([
        [
          {
            id: "n1",
            userId: "user-1",
            title: "A",
            message: "a",
            isRead: 1,
            type: "GEN",
            referenceId: null,
            createdAt: new Date(),
          },
          {
            id: "n2",
            userId: "user-1",
            title: "B",
            message: "b",
            isRead: 0,
            type: "GEN",
            referenceId: null,
            createdAt: new Date(),
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ total: 2 }], []]);

    const req = { user: { id: "user-1" }, query: {} };
    const res = mockRes();

    await getNotifications(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("ORDER BY createdAt DESC LIMIT ? OFFSET ?"),
      ["user-1", 20, 0]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "SELECT COUNT(*) AS total FROM notifications WHERE userId = ?"
      ),
      ["user-1"]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalRows: 2,
          totalPages: 1,
          page: 0,
          limit: 20,
          notifications: [
            expect.objectContaining({ id: "n1", isRead: true }),
            expect.objectContaining({ id: "n2", isRead: false }),
          ],
        }),
      })
    );
  });

  it("returns an error response when the query rejects", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));
    const req = { user: { id: "user-1" }, query: {} };
    const res = mockRes();

    await getNotifications(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to get notifications",
      })
    );
  });
});

describe("getUnreadCount", () => {
  it("returns the unread count for the user", async () => {
    pool.query.mockResolvedValueOnce([[{ total: 3 }], []]);
    const req = { user: { id: "user-1" } };
    const res = mockRes();

    await getUnreadCount(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE userId = ? AND isRead = 0"),
      ["user-1"]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { count: 3 } })
    );
  });

  it("returns an error response when the query rejects", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));
    const req = { user: { id: "user-1" } };
    const res = mockRes();

    await getUnreadCount(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to get unread count",
      })
    );
  });
});

describe("markAsRead", () => {
  it("marks a single notification as read for the owning user", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const req = { params: { id: "n1" }, user: { id: "user-1" } };
    const res = mockRes();

    await markAsRead(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "UPDATE notifications SET isRead = 1 WHERE id = ? AND userId = ?"
      ),
      ["n1", "user-1"]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Notification marked as read" })
    );
  });

  it("does not error when zero rows are affected (mirrors Prisma's updateMany no-throw semantics)", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const req = { params: { id: "missing" }, user: { id: "user-1" } };
    const res = mockRes();

    await markAsRead(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("returns an error response when the query rejects", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));
    const req = { params: { id: "n1" }, user: { id: "user-1" } };
    const res = mockRes();

    await markAsRead(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to mark notification as read",
      })
    );
  });
});

describe("markAllAsRead", () => {
  it("marks all unread notifications as read for the user", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 5 }]);
    const req = { user: { id: "user-1" } };
    const res = mockRes();

    await markAllAsRead(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "UPDATE notifications SET isRead = 1 WHERE userId = ? AND isRead = 0"
      ),
      ["user-1"]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "All notifications marked as read" })
    );
  });

  it("returns an error response when the query rejects", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));
    const req = { user: { id: "user-1" } };
    const res = mockRes();

    await markAllAsRead(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to mark all as read",
      })
    );
  });
});
