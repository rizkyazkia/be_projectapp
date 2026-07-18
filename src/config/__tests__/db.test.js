import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("db pool", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: "mysql://testuser:testpass@localhost:3306/testdb",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("exports a mysql2 pool with a query method", async () => {
    const { default: pool } = await import("../db.js");
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe("function");
    expect(typeof pool.getConnection).toBe("function");
  });
});
