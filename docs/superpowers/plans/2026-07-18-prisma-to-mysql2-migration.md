# Prisma to mysql2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Prisma ORM call in `be_projectapp`'s backend with raw parameterized `mysql2` queries, with test coverage added alongside, because the previous constrained production host could not run Prisma's query engine reliably — confirmed with a `PANIC: timer has gone away` engine crash under process suspension, on top of repeated resource-limit exhaustion from Prisma's engine-binary downloading and connection handling.

**Architecture:** A single shared `mysql2/promise` connection pool (`src/config/db.js`, default export `pool`) replaces the 20 independent `new PrismaClient()` instantiations across the codebase. Each controller/middleware file is converted one at a time: every `prisma.<model>.<method>(...)` call becomes an equivalent `pool.query(sql, params)` call (or, for the 6 places using `prisma.$transaction`, an explicit `pool.getConnection()` + `beginTransaction`/`commit`/`rollback`/`release` sequence). Relations that Prisma resolved via `include`/`select` are reconstructed either via SQL `JOIN`s (for to-one relations, which can't multiply rows) or via a second batched query grouped in JS (for to-many relations, to avoid row multiplication against pagination). Every conversion is designed to preserve the exact current HTTP response shape and status code — including several pre-existing bugs identified during analysis — with two explicit, approved exceptions (Tasks 28 and 31) that fix two endpoints which currently always return HTTP 500 due to unrelated pre-existing defects. Tests (vitest, mocking the pool module) are added alongside each conversion since the backend currently has zero test coverage.

**Tech Stack:** Node.js (ESM), Express 5, `mysql2` (already a dependency, `^3.14.0`), `vitest` (added in Task 0), `argon2`, `jsonwebtoken` — none of these last three change.

## Global Constraints

- The shared pool module is `src/config/db.js`, exporting `pool` as the **default export**. Every converted file imports it as `import pool from "../config/db.js"` (or `"../../config/db.js"` from a `__tests__` subdirectory).
- Every `pool.query()` call uses `?` positional placeholders with a params array — never string concatenation/interpolation of untrusted values into SQL text (Task 15's allow-list fix in `updateFamilyMember` is the one place a *new* defense is added beyond straightforward translation, because the current Prisma code's safety there came from Prisma's own schema validation, which a naive raw-SQL port would lose).
- MySQL `TINYINT(1)` boolean columns are coerced explicitly at each read site with `!!row.col` (or `row.col === null ? null : !!row.col` when the column is nullable) — no global `typeCast` hook is used.
- Every `String @id @default(uuid())` Prisma model (`User`, `Family`, `FamilyMember`, `Student`, `Response`, `Recommendation`, `Intervention`, `Staff`, `Teacher`, `Notification`, `Partnership`, etc.) requires `id = randomUUID()` (from `import { randomUUID } from "node:crypto"`) generated in JS before INSERT — these are never DB-generated. `Int @id @default(autoincrement())` models (`Institution`, `Role`, `SocioEconomic`, `Job`, `Nutrition`, `Class`, etc.) use `insertResult.insertId` instead.
- No table in this schema uses `@updatedAt` — every `updatedAt`/`updated_at` column is a plain `@default(now())`. No `UPDATE` statement written during this migration may touch those columns unless the original Prisma code explicitly set them in `data` (it never does).
- Every dynamic `IN (?)` query must guard against an empty id array before running (`if (ids.length > 0) { ... }`), since MySQL's `IN ()` is a syntax error where Prisma's `{ in: [] }` safely matches zero rows.
- Wherever Prisma's `where` clause relied on a filter key being `undefined` and therefore silently dropped (as opposed to compared against `NULL`), the raw SQL equivalent must build the `WHERE` clause conditionally in JS — never bind `undefined`/`null` into a `= ?` comparison expecting it to behave like "no filter."
- Every `.update()`/`.delete()` call that Prisma would throw `P2025` on (record not found) needs an explicit `result.affectedRows === 0` check followed by `throw new Error(...)`, since raw `UPDATE`/`DELETE` do not throw natively on zero matched rows.
- Preserve every documented pre-existing bug/quirk exactly (wrong HTTP status codes from `errorResponse` argument-order mistakes, a dropped response field in `TeacherController`, a permanently-broken `deleteTeacher` no-op path, `getFamilyMemberByUser`'s always-true-array dead guard, un-applied pagination in two places, mismatched `successResponse` capitalization between files, etc.) — these are called out individually in the tasks that touch them. The **only two exceptions**, approved explicitly, are Task 28 (fix the `ReferenceError` in `getResponseParent`) and Task 31 (drop the invalid `residence` include in `getSingleRecommendation`) — both endpoints currently always return HTTP 500 and have no existing working behavior to break.
- Every converted handler gets vitest coverage for: the success path, any not-found/guard-clause path, and any explicitly-flagged edge case from the conversion analysis — not exhaustive permutation coverage of all ~252 queries.
- `prisma/schema.prisma` and `prisma/migrations/` are left in the repo as historical documentation (Task 36) — they are not deleted, only the `prisma`/`@prisma/client` npm packages and all runtime imports are removed.

---
### Task 0: Shared mysql2 pool module + test infrastructure

**Files:**
- Create: `src/config/db.js`
- Create: `src/config/__tests__/db.test.js`
- Modify: `package.json` (add `vitest` devDependency + `test` script)
- Modify: `vitest.config.js` (create if absent)

**Interfaces:**
- Produces: `export default pool` from `src/config/db.js` — a `mysql2/promise` `Pool` instance, built from `process.env.DATABASE_URL`. Every later task imports this as `import pool from "../config/db.js"` (or `../../config/db.js` from a `__tests__` subfolder) and calls `pool.query(sql, params)` (returns `[rows, fields]`) or, for transactions, `pool.getConnection()` (returns a `PoolConnection` with `.beginTransaction()`, `.query()`, `.commit()`, `.rollback()`, `.release()`).
- Produces: the project-wide test mocking pattern (shown below) that every subsequent task's tests must follow verbatim: `vi.mock("../../config/db.js", () => ({ default: { query: vi.fn(), getConnection: vi.fn() } }))`, then per-test `pool.query.mockResolvedValueOnce([[...rows], []])`.

- [ ] **Step 1: Add vitest as a dev dependency**

Run: `npm install --save-dev vitest`

Expected: `package.json`'s `devDependencies` now includes `"vitest": "^3.x.x"` (matching whatever version installs), and `node_modules/.bin/vitest` exists.

- [ ] **Step 2: Add the test script**

Edit `package.json`'s `scripts` block to replace the placeholder test script:
```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "start": "node src/index.js",
  "dev": "nodemon src/index.js"
}
```

- [ ] **Step 3: Create `vitest.config.js`**

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
  },
});
```

- [ ] **Step 4: Write the failing test for the pool module**

Create `src/config/__tests__/db.test.js`:
```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("db pool", () =&gt; {
  const ORIGINAL_ENV = process.env;

  beforeEach(() =&gt; {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: "mysql://testuser:testpass@localhost:3306/testdb",
    };
  });

  afterEach(() =&gt; {
    process.env = ORIGINAL_ENV;
  });

  it("exports a mysql2 pool with a query method", async () =&gt; {
    const { default: pool } = await import("../db.js");
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe("function");
    expect(typeof pool.getConnection).toBe("function");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run src/config/__tests__/db.test.js`
Expected: FAIL with `Cannot find module '../db.js'` (or similar — the file doesn't exist yet).

- [ ] **Step 6: Create `src/config/db.js`**

```js
import mysql from "mysql2/promise";

const pool = mysql.createPool(process.env.DATABASE_URL);

export default pool;
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/config/__tests__/db.test.js`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add package.json vitest.config.js src/config/db.js src/config/__tests__/db.test.js
git commit -m "test: add vitest and a shared mysql2 pool module"
```

---

## Project-wide test pattern (every later task follows this exactly)

Every controller test file lives at `src/controllers/__tests__/<ControllerName>.test.js` and starts with:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () =&gt; ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { someHandler } from "../SomeController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() =&gt; {
  vi.clearAllMocks();
});
```

For a handler that runs ONE `pool.query`:
```js
pool.query.mockResolvedValueOnce([[{ id: 1, name: "Jawa Barat" }], []]);
```

For a handler that runs a transaction via `pool.getConnection()`:
```js
const mockConnection = {
  beginTransaction: vi.fn(),
  query: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  release: vi.fn(),
};
pool.getConnection.mockResolvedValueOnce(mockConnection);
mockConnection.query
  .mockResolvedValueOnce([{ insertId: 0 }]) // first INSERT in the transaction
  .mockResolvedValueOnce([{ insertId: 0 }]); // second INSERT, etc — one mockResolvedValueOnce per query call, in call order
```

Every test asserts BOTH:
1. `pool.query` (or `mockConnection.query`) was called with the expected SQL text and params — using `expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FROM provinces"), [])` (use `stringContaining` on a normalized/trimmed key fragment of the SQL, not the full multi-line string, since whitespace formatting is not behaviorally significant).
2. `res.status`/`res.json` were called with the expected HTTP status and JSON body shape.

**Test coverage target for this migration** (applies to every task below, stated once here to avoid repeating it 20 times): for each converted handler, write tests for (a) the success/happy path, (b) any explicitly-documented not-found/guard-clause path, and (c) any explicitly-flagged edge case from the conversion design (empty array guards, preserved bugs, transaction rollback on error). This is not exhaustive permutation coverage of all 252 queries — it is targeted coverage of every documented behavior, matching what the analysis flagged as worth verifying.
### Task 1: Province, City, Category, Job Controllers (Prisma → mysql2)

**Files:**
- Modify: `src/controllers/ProvinceController.js`
- Modify: `src/controllers/CityController.js`
- Modify: `src/controllers/CategoryController.js`
- Modify: `src/controllers/JobController.js`
- Test: `src/controllers/__tests__/ProvinceController.test.js`
- Test: `src/controllers/__tests__/CityController.test.js`
- Test: `src/controllers/__tests__/CategoryController.test.js`
- Test: `src/controllers/__tests__/JobController.test.js`

**Interfaces:**
- Consumes: `pool` default export from `src/config/db.js` (Task 0) — `pool.query(sql, params)` resolving `[rows, fields]`; `errorResponse`/`successResponse` from `src/helpers/ResponseHelper.js` (unchanged, signatures `(res, data, message, statusCode=200)` and `(res, error, message, statusCode=500)`).
- Produces: mysql2-backed handlers with unchanged export names/signatures so route wiring in `src/routes/*.js` needs no changes — `getProvinces`, `createProvince` (ProvinceController.js), `getCities`, `getCitiesByProvince`, `createCity` (CityController.js), `getCategory` (CategoryController.js), `getJobs`, `getJobTypes` (JobController.js).

Real table/column names (from `prisma/schema.prisma` `@@map` directives, confirmed by reading the schema): `provinces(id, name)`, `cities(id, name, province_id)`, `categories(id, name, path)`, `job_types(id, name, type)` (camelCase `createdAt`/`updatedAt` columns not selected by the current handler), `jobs(id, jobTypeId, createdAt, updatedAt)` (camelCase columns, no relation include in the original Prisma call).

---

#### Cycle 1.1 — ProvinceController

- [ ] **Step 1: Write the failing test for `ProvinceController`**

Create `src/controllers/__tests__/ProvinceController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getProvinces, createProvince } from "../ProvinceController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getProvinces", () => {
  it("returns all provinces", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        { id: 1, name: "Jawa Barat" },
        { id: 2, name: "Jawa Tengah" },
      ],
      [],
    ]);

    await getProvinces(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM provinces")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Province retrieved successfully",
      data: [
        { id: 1, name: "Jawa Barat" },
        { id: 2, name: "Jawa Tengah" },
      ],
    });
  });

  it("returns a 500 error when the query fails", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    await getProvinces(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Failed to retrieve provinces",
      error: "connection lost",
    });
  });
});

describe("createProvince", () => {
  it("inserts a province then returns the re-selected row", async () => {
    const req = { body: { name: "Jawa Barat" } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([{ insertId: 5, affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ id: 5, name: "Jawa Barat" }], []]);

    await createProvince(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO provinces"),
      ["Jawa Barat"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT id, name FROM provinces WHERE id = ?"),
      [5]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menambahkan provinsi baru",
      data: { id: 5, name: "Jawa Barat" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/ProvinceController.test.js`
Expected: FAIL. `ProvinceController.js` still calls the real `PrismaClient` (not the mocked `pool`), so `pool.query` is recorded with 0 calls and the `toHaveBeenCalledWith` assertions fail. (The Prisma call itself may additionally reject/timeout against a missing dev database — either way the test does not reach a passing state.)

- [ ] **Step 3: Convert `src/controllers/ProvinceController.js` to mysql2**

Replace the full file contents with:
```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getProvinces = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name FROM provinces");
    return successResponse(res, rows, "Province retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve provinces");
  }
};

export const createProvince = async (req, res) => {
  try {
    const { name } = req.body;
    const [result] = await pool.query(
      "INSERT INTO provinces (name) VALUES (?)",
      [name]
    );
    const [rows] = await pool.query(
      "SELECT id, name FROM provinces WHERE id = ?",
      [result.insertId]
    );
    const response = rows[0];
    return successResponse(res, response, "Berhasil menambahkan provinsi baru");
  } catch (error) {
    return errorResponse(res, error, "Gagal menambahkan provinsi baru");
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/ProvinceController.test.js`
Expected: PASS (3 tests).

---

#### Cycle 1.2 — CityController

- [ ] **Step 5: Write the failing test for `CityController`**

Create `src/controllers/__tests__/CityController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getCities,
  getCitiesByProvince,
  createCity,
} from "../CityController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCities", () => {
  it("returns all cities", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[{ id: 1, name: "Bandung" }], []]);

    await getCities(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM cities")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Cities retrieved successfully",
      data: [{ id: 1, name: "Bandung" }],
    });
  });
});

describe("getCitiesByProvince", () => {
  it("returns cities filtered by province_id", async () => {
    const req = { params: { id: "3" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [{ id: 1, name: "Bandung", province_id: 3 }],
      [],
    ]);

    await getCitiesByProvince(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM cities WHERE province_id = ?"),
      [3]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil mendapatkan data kota berdasarkan provinsi",
      data: [{ id: 1, name: "Bandung", province_id: 3 }],
    });
  });
});

describe("createCity", () => {
  it("inserts a city under a province then returns the re-selected row", async () => {
    const req = { params: { id: "3" }, body: { name: "Bandung" } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([{ insertId: 7, affectedRows: 1 }, []])
      .mockResolvedValueOnce([
        [{ id: 7, name: "Bandung", province_id: 3 }],
        [],
      ]);

    await createCity(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO cities"),
      ["Bandung", 3]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT id, name, province_id FROM cities WHERE id = ?"),
      [7]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menambahkan kota baru",
      data: { id: 7, name: "Bandung", province_id: 3 },
    });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/CityController.test.js`
Expected: FAIL. `CityController.js` still calls the real `PrismaClient`, so `pool.query` has 0 recorded calls and every `toHaveBeenCalledWith` assertion fails.

- [ ] **Step 7: Convert `src/controllers/CityController.js` to mysql2**

Replace the full file contents with:
```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getCities = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name FROM cities");
    return successResponse(res, rows, "Cities retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve cities");
  }
};

export const getCitiesByProvince = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      "SELECT id, name, province_id FROM cities WHERE province_id = ?",
      [Number(id)]
    );
    return successResponse(
      res,
      rows,
      "Berhasil mendapatkan data kota berdasarkan provinsi"
    );
  } catch (error) {
    return errorResponse(
      res,
      error,
      "Gagal mendapatkan data kota berdasarkan provinsi"
    );
  }
};

export const createCity = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const [result] = await pool.query(
      "INSERT INTO cities (name, province_id) VALUES (?, ?)",
      [name, Number(id)]
    );
    const [rows] = await pool.query(
      "SELECT id, name, province_id FROM cities WHERE id = ?",
      [result.insertId]
    );
    const response = rows[0];
    return successResponse(res, response, "Berhasil menambahkan kota baru");
  } catch (error) {
    return errorResponse(res, error, "Gagal menambahkan kota baru");
  }
};
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/CityController.test.js`
Expected: PASS (3 tests).

---

#### Cycle 1.3 — CategoryController

- [ ] **Step 9: Write the failing test for `CategoryController`**

Create `src/controllers/__tests__/CategoryController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getCategory } from "../CategoryController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCategory", () => {
  it("returns the first page with default pagination when no query params are given", async () => {
    const req = { query: {} };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[{ count: 2 }], []])
      .mockResolvedValueOnce([
        [
          { id: 1, name: "Stunting", path: "/stunting" },
          { id: 2, name: "Gizi", path: "/gizi" },
        ],
        [],
      ]);

    await getCategory(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "SELECT COUNT(*) AS count FROM categories WHERE name LIKE ?"
      ),
      ["%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ORDER BY id ASC LIMIT ? OFFSET ?"),
      ["%%", 10, 0]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Categories retrieved successfully",
      data: {
        totalRows: 2,
        totalPage: 1,
        page: 0,
        limit: 10,
        categories: [
          { id: 1, name: "Stunting", path: "/stunting" },
          { id: 2, name: "Gizi", path: "/gizi" },
        ],
      },
    });
  });

  it("applies search and pagination params to both queries (offset = limit * page)", async () => {
    const req = { query: { page: "2", limit: "5", search: "gizi" } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[{ count: 12 }], []])
      .mockResolvedValueOnce([
        [{ id: 11, name: "Gizi Buruk", path: "/gizi-buruk" }],
        [],
      ]);

    await getCategory(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM categories WHERE name LIKE ?"),
      ["%gizi%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("LIMIT ? OFFSET ?"),
      ["%gizi%", 5, 10]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalRows: 12,
          totalPage: 3,
          page: 2,
          limit: 5,
        }),
      })
    );
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/CategoryController.test.js`
Expected: FAIL. `CategoryController.js` still calls `prisma.category.count`/`findMany`, so `pool.query` has 0 recorded calls and both tests fail on the `toHaveBeenNthCalledWith` assertions.

- [ ] **Step 11: Convert `src/controllers/CategoryController.js` to mysql2**

Replace the full file contents with:
```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getCategory = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const [countRows] = await pool.query(
      "SELECT COUNT(*) AS count FROM categories WHERE name LIKE ?",
      [`%${search}%`]
    );
    const totalRows = countRows[0].count;

    const totalPage = Math.ceil(totalRows / limit);
    const [categories] = await pool.query(
      "SELECT id, name, path FROM categories WHERE name LIKE ? ORDER BY id ASC LIMIT ? OFFSET ?",
      [`%${search}%`, limit, offset]
    );

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, categories },
      "Categories retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/CategoryController.test.js`
Expected: PASS (2 tests).

---

#### Cycle 1.4 — JobController

- [ ] **Step 13: Write the failing test for `JobController`**

Create `src/controllers/__tests__/JobController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getJobs, getJobTypes } from "../JobController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getJobs", () => {
  it("returns all jobs with camelCase columns and no relation include", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        {
          id: 1,
          jobTypeId: 2,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      [],
    ]);

    await getJobs(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "SELECT id, jobTypeId, createdAt, updatedAt FROM jobs"
      )
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        message: "Jobs retrieved successfully",
      })
    );
  });
});

describe("getJobTypes", () => {
  it("returns all job types", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [{ id: 1, name: "Buruh", type: "BURUH" }],
      [],
    ]);

    await getJobTypes(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name, type FROM job_types")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Job types retrieved successfully",
      data: [{ id: 1, name: "Buruh", type: "BURUH" }],
    });
  });
});
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/JobController.test.js`
Expected: FAIL. `JobController.js` still calls `prisma.job.findMany`/`prisma.jobType.findMany`, so `pool.query` has 0 recorded calls and both `toHaveBeenCalledWith` assertions fail.

- [ ] **Step 15: Convert `src/controllers/JobController.js` to mysql2**

Replace the full file contents with:
```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getJobs = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, jobTypeId, createdAt, updatedAt FROM jobs"
    );
    return successResponse(res, rows, "Jobs retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve jobs");
  }
};

export const getJobTypes = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name, type FROM job_types");
    return successResponse(res, rows, "Job types retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve job types");
  }
};
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/JobController.test.js`
Expected: PASS (2 tests).

- [ ] **Step 17: Run the full suite for this task**

Run: `npx vitest run src/controllers/__tests__/ProvinceController.test.js src/controllers/__tests__/CityController.test.js src/controllers/__tests__/CategoryController.test.js src/controllers/__tests__/JobController.test.js`
Expected: PASS (10 tests total: 3 + 3 + 2 + 2).

- [ ] **Step 18: Commit**

```bash
git add src/controllers/ProvinceController.js src/controllers/CityController.js src/controllers/CategoryController.js src/controllers/JobController.js src/controllers/__tests__/ProvinceController.test.js src/controllers/__tests__/CityController.test.js src/controllers/__tests__/CategoryController.test.js src/controllers/__tests__/JobController.test.js
git commit -m "refactor: convert Province, City, Category, Job controllers from Prisma to mysql2"
```

---

### Task 2: Institution, IMT, RefreshToken Controllers (Prisma → mysql2)

**Files:**
- Modify: `src/controllers/InstitutionController.js`
- Modify: `src/controllers/IMTController.js`
- Modify: `src/controllers/RefreshTokenController.js`
- Test: `src/controllers/__tests__/InstitutionController.test.js`
- Test: `src/controllers/__tests__/IMTController.test.js`
- Test: `src/controllers/__tests__/RefreshTokenController.test.js`

**Interfaces:**
- Consumes: `pool` default export from `src/config/db.js`; `errorResponse`/`successResponse` from `src/helpers/ResponseHelper.js` (unchanged); `jsonwebtoken`'s `verify`/`sign` (unchanged, still used as a callback-style API in `RefreshTokenController.js`).
- Produces: mysql2-backed `getInstitutions`, `getInstitutionByUser`, `getInstitutionType`, `getHealthCares` (InstitutionController.js), `calculateIMT` (IMTController.js), `refreshToken` (RefreshTokenController.js) — same export names/signatures. Deliberately preserves two pre-existing bugs in `InstitutionController.js`: the not-found branches of `getInstitutionByUser` and `getInstitutionType` call `errorResponse(res, 404, "...")`, which — because `errorResponse`'s signature is `(res, error, message, statusCode = 500)` — actually resolves to **HTTP 500** with body `{ status: "error", message: "...", error: 404 }`, not HTTP 404. This is NOT fixed in this task.

Real table/column names (from `prisma/schema.prisma`, confirmed by reading the schema): `institutions(id, name, email, address, phone, user_id, city_id, province_id, type, created_at, updated_at)`, `institution_types(id, name)`, `provinces(id, name)`, `cities(id, name)`, `bmi_references(id, ageYear, ageMonthFrom, ageMonthTo, gender, sdMinus3Min, sdMinus3Max, sdMinus2Min, sdMinus2Max, sdMinus1Min, sdMinus1Max, medianMin, medianMax, sdPlus1Min, sdPlus1Max, sdPlus2Min, sdPlus2Max, sdPlus3Min, sdPlus3Max, createdAt)` (all camelCase, no `updatedAt`), `users(id, username, email, password, role_id, refresh_token, created_at, updated_at)`, `roles(id, name)`.

---

#### Cycle 2.1 — InstitutionController

- [ ] **Step 1: Write the failing test for `InstitutionController`**

Create `src/controllers/__tests__/InstitutionController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getInstitutions,
  getInstitutionByUser,
  getInstitutionType,
  getHealthCares,
} from "../InstitutionController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getInstitutions", () => {
  it("returns paginated institutions with nested province/city/institution_type, mapping null FKs to null", async () => {
    const req = { query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ count: 2 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: 1,
            name: "RS A",
            email: "a@rs.com",
            phone: "0800",
            address: "Jl. A",
            province_name: "Jawa Barat",
            city_name: "Bandung",
            institution_type_name: "HealthCare",
          },
          {
            id: 2,
            name: "RS B",
            email: "b@rs.com",
            phone: "0801",
            address: "Jl. B",
            province_name: null,
            city_name: null,
            institution_type_name: null,
          },
        ],
        [],
      ]);

    await getInstitutions(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(DISTINCT i.id) AS count"),
      ["%%", "%%", "%%", "%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "LEFT JOIN institution_types it ON i.type = it.id"
      ),
      ["%%", "%%", "%%", "%%", 10, 0]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Institutions retrieved successfully",
      data: {
        totalRows: 2,
        totalPage: 1,
        page: 0,
        limit: 10,
        institutions: [
          {
            id: 1,
            name: "RS A",
            email: "a@rs.com",
            phone: "0800",
            address: "Jl. A",
            province: { name: "Jawa Barat" },
            city: { name: "Bandung" },
            institution_type: { name: "HealthCare" },
          },
          {
            id: 2,
            name: "RS B",
            email: "b@rs.com",
            phone: "0801",
            address: "Jl. B",
            province: null,
            city: null,
            institution_type: null,
          },
        ],
      },
    });
  });
});

describe("getInstitutionByUser", () => {
  it("returns the institution owned by req.user.id", async () => {
    const req = { user: { id: "user-1" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [{ id: 1, name: "RS A", user_id: "user-1" }],
      [],
    ]);

    await getInstitutionByUser(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM institutions WHERE user_id = ?"),
      ["user-1"]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Institution retrieved successfully",
      data: { id: 1, name: "RS A", user_id: "user-1" },
    });
  });

  it("preserves the existing 404-is-actually-500 bug when no institution is found", async () => {
    const req = { user: { id: "user-404" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await getInstitutionByUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Institution not found",
      error: 404,
    });
  });
});

describe("getInstitutionType", () => {
  it("returns institution types", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        { id: 1, name: "School" },
        { id: 2, name: "HealthCare" },
      ],
      [],
    ]);

    await getInstitutionType(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM institution_types")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Institution types retrieved successfully",
      data: [
        { id: 1, name: "School" },
        { id: 2, name: "HealthCare" },
      ],
    });
  });

  it("preserves the existing 404-is-actually-500 bug on an empty result", async () => {
    const req = {};
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await getInstitutionType(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "No institution types found",
      error: 404,
    });
  });
});

describe("getHealthCares", () => {
  it("returns healthcare institutions without a search filter", async () => {
    const req = { query: {} };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        {
          id: 1,
          name: "RS A",
          address: "Jl. A",
          phone: "0800",
          email: "a@rs.com",
          city_id: 5,
          city_name: "Bandung",
          province_id: 9,
          province_name: "Jawa Barat",
        },
      ],
      [],
    ]);

    await getHealthCares(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "INNER JOIN institution_types it ON i.type = it.id AND it.name = 'HealthCare'"
      ),
      []
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Healthcares retrieved successfully",
      data: [
        {
          id: 1,
          name: "RS A",
          address: "Jl. A",
          phone: "0800",
          email: "a@rs.com",
          city: { id: 5, name: "Bandung" },
          province: { id: 9, name: "Jawa Barat" },
        },
      ],
    });
  });

  it("appends the optional search WHERE clause only when search is non-empty", async () => {
    const req = { query: { search: "bandung" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await getHealthCares(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "WHERE (i.name LIKE ? OR i.address LIKE ? OR i.phone LIKE ?)"
      ),
      ["%bandung%", "%bandung%", "%bandung%"]
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/InstitutionController.test.js`
Expected: FAIL. `InstitutionController.js` still calls `prisma.institution.count`/`findMany`/`findFirst` and `prisma.institutionType.findMany`, so `pool.query` has 0 recorded calls; every assertion on `pool.query` and on the reshaped `res.json` body fails (the not-found bug-preservation tests also fail because the Prisma-based branch never reaches the mocked `pool` at all).

- [ ] **Step 3: Convert `src/controllers/InstitutionController.js` to mysql2**

Replace the full file contents with:
```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getInstitutions = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const searchParam = `%${search}%`;

    const [countRows] = await pool.query(
      `SELECT COUNT(DISTINCT i.id) AS count
       FROM institutions i
       LEFT JOIN provinces p ON i.province_id = p.id
       LEFT JOIN cities c ON i.city_id = c.id
       WHERE i.name LIKE ? OR i.address LIKE ? OR p.name LIKE ? OR c.name LIKE ?`,
      [searchParam, searchParam, searchParam, searchParam]
    );
    const totalRows = countRows[0].count;

    const totalPage = Math.ceil(totalRows / limit);
    const [rows] = await pool.query(
      `SELECT i.id, i.name, i.email, i.phone, i.address,
              p.name AS province_name, c.name AS city_name, it.name AS institution_type_name
       FROM institutions i
       LEFT JOIN provinces p ON i.province_id = p.id
       LEFT JOIN cities c ON i.city_id = c.id
       LEFT JOIN institution_types it ON i.type = it.id
       WHERE i.name LIKE ? OR i.address LIKE ? OR p.name LIKE ? OR c.name LIKE ?
       ORDER BY i.id DESC
       LIMIT ? OFFSET ?`,
      [searchParam, searchParam, searchParam, searchParam, limit, offset]
    );

    const institutions = rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      province: row.province_name ? { name: row.province_name } : null,
      city: row.city_name ? { name: row.city_name } : null,
      institution_type: row.institution_type_name
        ? { name: row.institution_type_name }
        : null,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, institutions },
      "Institutions retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const getInstitutionByUser = async (req, res) => {
  try {
    const user = req.user;
    const [rows] = await pool.query(
      "SELECT * FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = rows[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    return successResponse(
      res,
      institution,
      "Institution retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const getInstitutionType = async (req, res) => {
  try {
    const [institutionTypes] = await pool.query(
      "SELECT id, name FROM institution_types"
    );
    if (institutionTypes.length === 0) {
      return errorResponse(res, 404, "No institution types found");
    }
    return successResponse(
      res,
      institutionTypes,
      "Institution types retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const getHealthCares = async (req, res) => {
  try {
    const search = req.query.search || "";

    let sql = `SELECT i.id, i.name, i.address, i.phone, i.email,
                      c.id AS city_id, c.name AS city_name,
                      p.id AS province_id, p.name AS province_name
               FROM institutions i
               INNER JOIN institution_types it ON i.type = it.id AND it.name = 'HealthCare'
               LEFT JOIN cities c ON i.city_id = c.id
               LEFT JOIN provinces p ON i.province_id = p.id`;
    const params = [];

    if (search) {
      sql += ` WHERE (i.name LIKE ? OR i.address LIKE ? OR i.phone LIKE ?)`;
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam);
    }

    sql += ` ORDER BY i.name ASC`;

    const [rows] = await pool.query(sql, params);

    const healthcares = rows.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      phone: row.phone,
      email: row.email,
      city: row.city_id ? { id: row.city_id, name: row.city_name } : null,
      province: row.province_id
        ? { id: row.province_id, name: row.province_name }
        : null,
    }));

    return successResponse(
      res,
      healthcares,
      "Healthcares retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/InstitutionController.test.js`
Expected: PASS (6 tests).

---

#### Cycle 2.2 — IMTController

- [ ] **Step 5: Write the failing test for `IMTController`**

Create `src/controllers/__tests__/IMTController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { calculateIMT } from "../IMTController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("calculateIMT", () => {
  it("returns 400 when a required field is missing (guard clause, no DB call)", async () => {
    const req = {
      body: { gender: "L", ageMonths: 24, weightKg: "", heightCm: 90 },
    };
    const res = mockRes();

    await calculateIMT(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Semua field wajib diisi",
      error: null,
    });
  });

  it("returns 404 when no bmi reference row matches the age/gender", async () => {
    const req = {
      body: { gender: "L", ageMonths: 24, weightKg: 12, heightCm: 90 },
    };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await calculateIMT(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM bmi_references"),
      ["L", 2, 0, 0]
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Referensi BMI tidak ditemukan untuk usia ini",
      error: null,
    });
  });

  it("computes BMI and returns the normal-status shape on the success path", async () => {
    const req = {
      body: { gender: "L", ageMonths: 24, weightKg: 12, heightCm: 90 },
    };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        {
          id: 1,
          ageYear: 2,
          ageMonthFrom: 0,
          ageMonthTo: 11,
          gender: "L",
          sdMinus2Min: 14.0,
          sdPlus1Max: 18.0,
        },
      ],
      [],
    ]);

    await calculateIMT(req, res);

    // heightM = 0.9, bmi = 12 / (0.9*0.9) = 14.814..., rounded to 14.8,
    // which is between sdMinus2Min (14.0) and sdPlus1Max (18.0) => "baik".
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        data: expect.objectContaining({
          bmi: "14.8",
          bmiStatus: "Gizi Baik (Normal)",
          bmiCategory: "baik",
          sdMinus2: 14.0,
          sdPlus1: 18.0,
        }),
      })
    );
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/IMTController.test.js`
Expected: FAIL. `IMTController.js` still calls `prisma.bmiReference.findFirst`, so `pool.query` has 0 recorded calls; the 404 and success tests fail because `bmiRef` never comes from the mocked rows (the 400 guard-clause test may already pass since it returns before any DB call, but the suite as a whole is red).

- [ ] **Step 7: Convert `src/controllers/IMTController.js` to mysql2**

Replace the full file contents with:
```js
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
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/IMTController.test.js`
Expected: PASS (3 tests).

---

#### Cycle 2.3 — RefreshTokenController

- [ ] **Step 9: Write the failing test for `RefreshTokenController`**

Create `src/controllers/__tests__/RefreshTokenController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("jsonwebtoken", () => ({
  default: {
    verify: vi.fn(),
    sign: vi.fn(),
  },
}));

import pool from "../../config/db.js";
import jwt from "jsonwebtoken";
import { refreshToken } from "../RefreshTokenController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_REFRESH_TOKEN_SECRET = "refresh-secret";
  process.env.APP_ACCESS_TOKEN_SECRET = "access-secret";
});

describe("refreshToken", () => {
  it("returns a new access token when the cookie matches a stored refresh token", async () => {
    const req = { cookies: { refreshToken: "valid-refresh-token" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([
      [
        {
          id: "user-1",
          username: "budi",
          email: "budi@example.com",
          password: "hashed",
          role_id: 2,
          refresh_token: "valid-refresh-token",
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
          role_name: "admin",
        },
      ],
      [],
    ]);
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(null, { id: "user-1" })
    );
    jwt.sign.mockReturnValue("new-access-token");

    await refreshToken(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("LEFT JOIN roles r ON u.role_id = r.id"),
      ["valid-refresh-token"]
    );
    expect(jwt.sign).toHaveBeenCalledWith(
      {
        id: "user-1",
        username: "budi",
        email: "budi@example.com",
        role: "admin",
      },
      "access-secret",
      { expiresIn: "15m" }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Access token berhasil diperbarui",
      data: { accessToken: "new-access-token" },
    });
  });

  it("returns an error when no refresh token cookie is present (guard clause, no DB call)", async () => {
    const req = { cookies: {} };
    const res = mockRes();

    await refreshToken(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak ditemukan",
      error: null,
    });
  });

  it("returns an error when the refresh token is not found in the database", async () => {
    const req = { cookies: { refreshToken: "unknown-token" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await refreshToken(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak valid",
      error: null,
    });
  });

  it("returns an error when jwt.verify rejects the token", async () => {
    const req = { cookies: { refreshToken: "expired-token" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([
      [
        {
          id: "user-1",
          username: "budi",
          email: "budi@example.com",
          password: "hashed",
          role_id: 2,
          refresh_token: "expired-token",
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
          role_name: "admin",
        },
      ],
      [],
    ]);
    const verifyError = new Error("jwt expired");
    jwt.verify.mockImplementation((token, secret, cb) => cb(verifyError, null));

    await refreshToken(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak valid",
      error: "jwt expired",
    });
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/RefreshTokenController.test.js`
Expected: FAIL. `RefreshTokenController.js` still calls `prisma.user.findFirst`, so `pool.query` has 0 recorded calls; the success, not-found, and jwt-verify-error tests all fail because the handler never reaches the mocked `pool` or reshapes `role_name` into `role.name`.

- [ ] **Step 11: Convert `src/controllers/RefreshTokenController.js` to mysql2**

Replace the full file contents with:
```js
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const refreshToken = async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken)
      return errorResponse(res, null, "Refresh token tidak ditemukan");
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.email, u.password, u.role_id, u.refresh_token,
              u.created_at, u.updated_at, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE u.refresh_token = ?
       LIMIT 1`,
      [refreshToken]
    );
    const userRow = rows[0];
    if (!userRow) return errorResponse(res, null, "Refresh token tidak valid");
    const user = { ...userRow, role: { name: userRow.role_name } };
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
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/RefreshTokenController.test.js`
Expected: PASS (4 tests).

- [ ] **Step 13: Run the full suite for this task**

Run: `npx vitest run src/controllers/__tests__/InstitutionController.test.js src/controllers/__tests__/IMTController.test.js src/controllers/__tests__/RefreshTokenController.test.js`
Expected: PASS (13 tests total: 6 + 3 + 4).

- [ ] **Step 14: Commit**

```bash
git add src/controllers/InstitutionController.js src/controllers/IMTController.js src/controllers/RefreshTokenController.js src/controllers/__tests__/InstitutionController.test.js src/controllers/__tests__/IMTController.test.js src/controllers/__tests__/RefreshTokenController.test.js
git commit -m "refactor: convert Institution, IMT, RefreshToken controllers from Prisma to mysql2"
```
### Task 3: UserController.js — Prisma to raw mysql2

**Files:**
- Modify: `src/controllers/UserController.js`
- Create: `src/controllers/__tests__/UserController.test.js`

**Interfaces:**
- Modifies (signatures unchanged, still `async (req, res) => {}`, still named exports): `getUsers`, `getUserById`, `updateUser` (untouched no-op), `deleteUser` — consumed by `src/routes/UserRoute.js` (`GET /users`, `GET /users/:id`, `PATCH /users/:id`, `DELETE /users/:id`).
- Replaces `import { PrismaClient } from "@prisma/client"` + `const prisma = new PrismaClient();` with `import pool from "../config/db.js";`.
- Adds an internal (non-exported) helper `escapeLikeValue(value)` used only inside this file to escape `%`/`_` before building a `LIKE` pattern.
- `getUsers` has **no try/catch** in the current source — preserve that (do not add one). `getUserById` and `deleteUser` keep their existing try/catch. `getUserById`'s catch block keeps its `console.error(error)` call — the only handler in this file that logs to console.
- `deleteUser`'s final success call is `successResponse(res, 200, "Berhasil menghapus user")` — since `successResponse`'s signature is `(res, data, message, statusCode = 200)`, this is a pre-existing bug: `200` is passed as `data`, not as the status code, so the response body is literally `{status:"success", message:"Berhasil menghapus user", data:200}` with HTTP status `200` (the default). Preserve exactly, do not "fix".

- [ ] **Step 1: Write the failing tests**

Create `src/controllers/__tests__/UserController.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getUsers, getUserById, deleteUser } from "../UserController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUsers", () => {
  it("returns paginated users shaped with role/institution/teacher", async () => {
    const req = { query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ total: 2 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "u1",
            username: "alice",
            email: "alice@example.com",
            role_name: "admin",
            institution_id: 5,
            institution_name: "School A",
            institution_phone: "0800",
            teacher_id: null,
            teacher_institution_id: null,
            teacher_institution_name: null,
            teacher_institution_phone: null,
          },
          {
            id: "u2",
            username: "bob",
            email: "bob@example.com",
            role_name: "teacher",
            institution_id: null,
            institution_name: null,
            institution_phone: null,
            teacher_id: "t1",
            teacher_institution_id: 7,
            teacher_institution_name: "School B",
            teacher_institution_phone: "0900",
          },
        ],
        [],
      ]);

    await getUsers(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS total FROM users"),
      ["%%", "%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM users u"),
      ["%%", "%%", 10, 0]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Users retrieved successfully",
      data: {
        totalRows: 2,
        totalPage: 1,
        page: 0,
        limit: 10,
        users: [
          {
            id: "u1",
            username: "alice",
            email: "alice@example.com",
            role: { name: "admin" },
            institution: { id: 5, name: "School A", phone: "0800" },
            teacher: null,
          },
          {
            id: "u2",
            username: "bob",
            email: "bob@example.com",
            role: { name: "teacher" },
            institution: null,
            teacher: {
              institution: { id: 7, name: "School B", phone: "0900" },
            },
          },
        ],
      },
    });
  });

  it("escapes % and _ special characters in the search term before building the LIKE pattern", async () => {
    const req = { query: { search: "50%_off" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []]);

    await getUsers(req, res);

    const expectedPattern = "%50\\%\\_off%";
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS total FROM users"),
      [expectedPattern, expectedPattern]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM users u"),
      [expectedPattern, expectedPattern, 10, 0]
    );
  });
});

describe("getUserById", () => {
  it("returns a user with role and institution", async () => {
    const req = { params: { id: "u1" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([
      [
        {
          id: "u1",
          username: "alice",
          email: "alice@example.com",
          role_name: "admin",
          institution_name: "School A",
          institution_address: "Jl. Mawar",
          institution_email: "school@a.com",
          institution_phone: "0800",
        },
      ],
      [],
    ]);

    await getUserById(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE u.id = ?"),
      ["u1"]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "User with ID: u1 retrieved successfully",
      data: {
        id: "u1",
        username: "alice",
        email: "alice@example.com",
        role: { name: "admin" },
        institution: {
          name: "School A",
          address: "Jl. Mawar",
          email: "school@a.com",
          phone: "0800",
        },
      },
    });
  });

  it("returns 500 'User Not Found' when no row matches", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await getUserById(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User Not Found",
      error: null,
    });
  });

  it("logs the error via console.error and returns 'Error retrieving user' when the query throws", async () => {
    const req = { params: { id: "u1" } };
    const res = mockRes();
    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await getUserById(req, res);

    expect(consoleSpy).toHaveBeenCalledWith(dbError);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error retrieving user",
      error: "connection lost",
    });

    consoleSpy.mockRestore();
  });
});

describe("deleteUser", () => {
  it("deletes a non-admin user and returns the pre-existing 200/data:200 response shape", async () => {
    const req = { params: { id: "u2" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "u2", role_id: 3 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await deleteUser(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id, role_id FROM users WHERE id = ?"),
      ["u2"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("DELETE FROM users WHERE id = ?"),
      ["u2"]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menghapus user",
      data: 200,
    });
  });

  it("returns 500 'User Not Found' when the user does not exist", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await deleteUser(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User Not Found",
      error: null,
    });
  });

  it("refuses to delete a role_id 1 (admin) user without issuing a DELETE", async () => {
    const req = { params: { id: "admin1" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[{ id: "admin1", role_id: 1 }], []]);

    await deleteUser(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Cannot delete admin user",
      error: null,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/UserController.test.js`

Expected: FAIL. The current `src/controllers/UserController.js` still uses `PrismaClient`, not the mocked pool: either constructing `new PrismaClient()` throws at import time (no resolvable `DATABASE_URL` in the test process), or, if it doesn't throw, every assertion against `pool.query` fails because the handlers never call it (they call the real `prisma.user.*` methods instead).

- [ ] **Step 3: Rewrite `src/controllers/UserController.js`**

```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const escapeLikeValue = (value) => value.replace(/([%_])/g, "\\$1");

export const getUsers = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;
  const searchPattern = `%${escapeLikeValue(search)}%`;

  const [countRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM users WHERE username LIKE ? OR email LIKE ?",
    [searchPattern, searchPattern]
  );
  const totalRows = countRows[0].total;
  const totalPage = Math.ceil(totalRows / limit);

  const [rows] = await pool.query(
    `SELECT
       u.id AS id,
       u.username AS username,
       u.email AS email,
       r.name AS role_name,
       i.id AS institution_id,
       i.name AS institution_name,
       i.phone AS institution_phone,
       t.id AS teacher_id,
       ti.id AS teacher_institution_id,
       ti.name AS teacher_institution_name,
       ti.phone AS teacher_institution_phone
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN institutions i ON i.user_id = u.id
     LEFT JOIN teachers t ON t.user_id = u.id
     LEFT JOIN institutions ti ON ti.id = t.school_id
     WHERE u.username LIKE ? OR u.email LIKE ?
     ORDER BY u.id DESC
     LIMIT ? OFFSET ?`,
    [searchPattern, searchPattern, limit, offset]
  );

  const users = rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    role: { name: row.role_name },
    institution: row.institution_id
      ? {
          id: row.institution_id,
          name: row.institution_name,
          phone: row.institution_phone,
        }
      : null,
    teacher: row.teacher_id
      ? {
          institution: row.teacher_institution_id
            ? {
                id: row.teacher_institution_id,
                name: row.teacher_institution_name,
                phone: row.teacher_institution_phone,
              }
            : null,
        }
      : null,
  }));

  return successResponse(
    res,
    {
      totalRows,
      totalPage,
      page,
      limit,
      users,
    },
    "Users retrieved successfully"
  );
};

export const getUserById = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT
         u.id AS id,
         u.username AS username,
         u.email AS email,
         r.name AS role_name,
         i.name AS institution_name,
         i.address AS institution_address,
         i.email AS institution_email,
         i.phone AS institution_phone
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN institutions i ON i.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return errorResponse(res, null, "User Not Found");
    }

    const row = rows[0];
    const user = {
      id: row.id,
      username: row.username,
      email: row.email,
      role: { name: row.role_name },
      institution: row.institution_name
        ? {
            name: row.institution_name,
            address: row.institution_address,
            email: row.institution_email,
            phone: row.institution_phone,
          }
        : null,
    };

    return successResponse(
      res,
      user,
      `User with ID: ${id} retrieved successfully`
    );
  } catch (error) {
    console.error(error);
    return errorResponse(res, error, "Error retrieving user");
  }
};

export const updateUser = async (req, res) => {};

export const deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await pool.query(
      "SELECT id, role_id FROM users WHERE id = ? LIMIT 1",
      [id]
    );

    if (rows.length === 0) {
      return errorResponse(res, null, "User Not Found");
    }

    const user = rows[0];

    if (user.role_id === 1) {
      return errorResponse(res, null, "Cannot delete admin user");
    } else {
      await pool.query("DELETE FROM users WHERE id = ?", [id]);
    }
    return successResponse(res, 200, "Berhasil menghapus user");
  } catch (error) {
    return errorResponse(res, error, "Gagal menghapus user");
  }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/UserController.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/UserController.js src/controllers/__tests__/UserController.test.js
git commit -m "refactor: migrate UserController from Prisma to raw mysql2"
```

---

### Task 4: AuthController.js — Prisma to raw mysql2

**Files:**
- Modify: `src/controllers/AuthController.js`
- Create: `src/controllers/__tests__/AuthController.test.js`

**Interfaces:**
- Modifies (signatures unchanged, still named exports `async (req, res) => {}`): `registerParent`, `registerInstitution`, `login`, `logout` — consumed by `src/routes/AuthRoute.js` (`POST /register/parent`, `POST /register/institution`, `POST /login`, `DELETE /logout`).
- Replaces `import { PrismaClient } from "@prisma/client"` + `const prisma = new PrismaClient();` with `import pool from "../config/db.js";` and adds `import { randomUUID } from "node:crypto";`.
- `registerParent` and `registerInstitution` each run their two inserts inside a `pool.getConnection()` transaction (`beginTransaction` → inserts → `commit`, with `rollback` + `release` in a `catch`/`finally`) — mirroring the two `prisma.$transaction([...])` calls in the current source.
- `User.id` and `Family.id` are client-generated UUIDs via `randomUUID()` (schema has no DB-side default once Prisma's `@default(uuid())` is gone); `Institution.id` stays DB autoincrement — read back via `insertId` if ever needed (not needed here since the response re-SELECTs by `user_id`).
- `registerParent`'s success response is the full constructed user object **including the hashed password** — this replicates Prisma's `create()` with no `select`, which returns every column. Preserve; do not strip the password from the response.
- `registerInstitution` coerces `institutionProvince`/`institutionCity` via `Number(...) || null` before inserting, since raw mysql2 (unlike Prisma) does not validate/coerce input types.
- `login` preserves the exact cookie flags: `res.cookie("refreshToken", refreshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000, secure: true, sameSite: "none" })`. The `UPDATE users SET refresh_token = ?` call does **not** touch `updated_at` (schema has no `@updatedAt` on `users`).
- `logout` has **no try/catch** in the current source, unlike every other function in this file — preserve that; do not add one. Its `SELECT` drops the `roles` join the original code fetched via `include` but never read (only `user.id` was used).

- [ ] **Step 1: Write the failing tests**

Create `src/controllers/__tests__/AuthController.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("argon2", () => ({
  default: {
    hash: vi.fn(async (password) => `hashed:${password}`),
    verify: vi.fn(),
  },
}));

import pool from "../../config/db.js";
import argon2 from "argon2";
import {
  registerParent,
  registerInstitution,
  login,
  logout,
} from "../AuthController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

function mockConnection() {
  return {
    beginTransaction: vi.fn(),
    query: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ACCESS_TOKEN_SECRET = "test-access-secret";
  process.env.APP_REFRESH_TOKEN_SECRET = "test-refresh-secret";
});

describe("registerParent", () => {
  it("creates a user and family record inside a transaction and returns the full user (incl. hashed password)", async () => {
    const req = {
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
        role_id: 2,
      },
    };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no existing user/email

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO users
      .mockResolvedValueOnce([{ insertId: 0 }]); // INSERT INTO families

    await registerParent(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "SELECT id FROM users WHERE username = ? OR email = ?"
      ),
      ["alice", "alice@example.com"]
    );
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO users"),
      [
        expect.any(String),
        "alice",
        "alice@example.com",
        "hashed:secret123",
        2,
        null,
        expect.any(Date),
        expect.any(Date),
      ]
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO families"),
      [expect.any(String), expect.any(String), expect.any(Date), expect.any(Date)]
    );
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat akun",
      data: expect.objectContaining({
        id: expect.any(String),
        username: "alice",
        email: "alice@example.com",
        password: "hashed:secret123",
        role_id: 2,
        refresh_token: null,
        created_at: expect.any(Date),
        updated_at: expect.any(Date),
      }),
    });
  });

  it("refuses when username or email already exists, without opening a connection", async () => {
    const req = {
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
        role_id: 2,
      },
    };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[{ id: "existing" }], []]);

    await registerParent(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Username atau email sudah digunakan",
      error: null,
    });
  });

  it("rolls back and releases the connection when an insert inside the transaction fails", async () => {
    const req = {
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
        role_id: 2,
      },
    };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    const insertError = new Error("duplicate entry");
    connection.query.mockRejectedValueOnce(insertError);

    await registerParent(req, res);

    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat membuat akun",
      error: "duplicate entry",
    });
  });
});

describe("registerInstitution", () => {
  const baseBody = {
    username: "school1",
    email: "school1@example.com",
    password: "secret123",
    role_id: 3,
    institutionName: "SD Merdeka",
    institutionEmail: "sd@merdeka.sch.id",
    institutionPhone: "0811",
    institutionAddress: "Jl. Merdeka 1",
    institutionProvince: "1",
    institutionCity: "2",
    institutionType: 1,
  };

  it("creates a user + institution inside a transaction and returns the nested role/institution/province/city shape", async () => {
    const req = { body: { ...baseBody } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[], []]) // no existing user/email
      .mockResolvedValueOnce([[], []]) // no existing institution
      .mockResolvedValueOnce([
        [
          {
            id: "u9",
            username: "school1",
            email: "school1@example.com",
            role_name: "institution",
            institution_id: 5,
            institution_name: "SD Merdeka",
            institution_email: "sd@merdeka.sch.id",
            institution_phone: "0811",
            institution_address: "Jl. Merdeka 1",
            province_id: 1,
            province_name: "Jawa Barat",
            city_id: 2,
            city_name: "Bandung",
          },
        ],
        [],
      ]); // re-select after commit

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO users
      .mockResolvedValueOnce([{ insertId: 5 }]); // INSERT INTO institutions

    await registerInstitution(req, res);

    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO institutions"),
      [
        "SD Merdeka",
        "sd@merdeka.sch.id",
        "0811",
        "Jl. Merdeka 1",
        1,
        2,
        1,
        expect.any(String),
        expect.any(Date),
        expect.any(Date),
      ]
    );
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat akun",
      data: {
        id: "u9",
        username: "school1",
        email: "school1@example.com",
        role: { name: "institution" },
        institution: {
          id: 5,
          name: "SD Merdeka",
          email: "sd@merdeka.sch.id",
          phone: "0811",
          address: "Jl. Merdeka 1",
          province: { id: 1, name: "Jawa Barat" },
          city: { id: 2, name: "Bandung" },
        },
      },
    });
  });

  it("coerces a non-numeric province/city to null instead of letting an invalid type reach the query", async () => {
    const req = {
      body: {
        ...baseBody,
        institutionProvince: "",
        institutionCity: undefined,
      },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [
          {
            id: "u10",
            username: "school1",
            email: "school1@example.com",
            role_name: "institution",
            institution_id: 6,
            institution_name: "SD Merdeka",
            institution_email: "sd@merdeka.sch.id",
            institution_phone: "0811",
            institution_address: "Jl. Merdeka 1",
            province_id: null,
            province_name: null,
            city_id: null,
            city_name: null,
          },
        ],
        [],
      ]);

    const connection = mockConnection();
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([{ insertId: 6 }]);

    await registerInstitution(req, res);

    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO institutions"),
      [
        "SD Merdeka",
        "sd@merdeka.sch.id",
        "0811",
        "Jl. Merdeka 1",
        null,
        null,
        1,
        expect.any(String),
        expect.any(Date),
        expect.any(Date),
      ]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          institution: expect.objectContaining({ province: null, city: null }),
        }),
      })
    );
  });

  it("refuses when username or email already exists, without opening a connection", async () => {
    const req = { body: { ...baseBody } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[{ id: "existing" }], []]);

    await registerInstitution(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Username atau email sudah digunakan",
      error: null,
    });
  });

  it("refuses when the institution name/email/phone already exists, without opening a connection", async () => {
    const req = { body: { ...baseBody } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[], []]) // no existing user
      .mockResolvedValueOnce([[{ id: 1 }], []]); // existing institution

    await registerInstitution(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Institusi ini sudah digunakan oleh akun lain",
      error: null,
    });
  });
});

describe("login", () => {
  const userRow = {
    id: "u1",
    username: "alice",
    email: "alice@example.com",
    password: "hashed-pw",
    role_id: 2,
    refresh_token: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    role_name: "parent",
  };

  it("logs in with a valid identifier/password, updates refresh_token, and sets the refresh cookie", async () => {
    const req = { body: { identifier: "alice", password: "secret123" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[userRow], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    argon2.verify.mockResolvedValueOnce(true);

    await login(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM users u"),
      ["alice", "alice"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE users SET refresh_token = ?"),
      [expect.any(String), "u1"]
    );
    expect(res.cookie).toHaveBeenCalledWith("refreshToken", expect.any(String), {
      httpOnly: true,
      maxAge: 86400000,
      secure: true,
      sameSite: "none",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Login berhasil",
      data: { accessToken: expect.any(String) },
    });
  });

  it("returns 500 'User tidak ditemukan' when no user matches the identifier", async () => {
    const req = { body: { identifier: "ghost", password: "secret123" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User tidak ditemukan",
      error: null,
    });
  });

  it("returns 500 'Password salah' when argon2.verify does not match", async () => {
    const req = { body: { identifier: "alice", password: "wrongpass" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[userRow], []]);
    argon2.verify.mockResolvedValueOnce(false);

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Password salah",
      error: null,
    });
  });
});

describe("logout", () => {
  it("clears the refresh token in the DB and the cookie for a valid refresh token", async () => {
    const req = { cookies: { refreshToken: "valid-refresh-token" } };
    const res = mockRes();
    pool.query
      .mockResolvedValueOnce([[{ id: "u1" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await logout(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM users WHERE refresh_token = ?"),
      ["valid-refresh-token"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE users SET refresh_token = NULL WHERE id = ?"),
      ["u1"]
    );
    expect(res.clearCookie).toHaveBeenCalledWith("refreshToken", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Logout berhasil",
      data: null,
    });
  });

  it("returns 500 'Refresh token tidak ditemukan' when no cookie is present, without querying the DB", async () => {
    const req = { cookies: {} };
    const res = mockRes();

    await logout(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak ditemukan",
      error: null,
    });
  });

  it("returns 500 'Refresh token tidak valid' when the token doesn't match any user", async () => {
    const req = { cookies: { refreshToken: "stale-token" } };
    const res = mockRes();
    pool.query.mockResolvedValueOnce([[], []]);

    await logout(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Refresh token tidak valid",
      error: null,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/AuthController.test.js`

Expected: FAIL. The current `src/controllers/AuthController.js` still uses `PrismaClient`, not the mocked `pool`/`pool.getConnection`: either constructing `new PrismaClient()` throws at import time, or every assertion against `pool.query`/`pool.getConnection` fails because the handlers call `prisma.user.*`/`prisma.$transaction` instead.

- [ ] **Step 3: Rewrite `src/controllers/AuthController.js`**

```js
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const registerParent = async (req, res) => {
  const { username, email, password, role_id } = req.body;

  const hashPassword = await argon2.hash(password);

  try {
    const [existingRows] = await pool.query(
      "SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1",
      [username, email]
    );

    if (existingRows.length > 0) {
      return errorResponse(res, null, "Username atau email sudah digunakan");
    }

    const userId = randomUUID();
    const familyId = randomUUID();
    const now = new Date();

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query(
        "INSERT INTO users (id, username, email, password, role_id, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [userId, username, email, hashPassword, role_id, null, now, now]
      );

      await connection.query(
        "INSERT INTO families (id, userId, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [familyId, userId, now, now]
      );

      await connection.commit();
    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    const newParent = {
      id: userId,
      username,
      email,
      password: hashPassword,
      role_id,
      refresh_token: null,
      created_at: now,
      updated_at: now,
    };

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
    const [existingUserRows] = await pool.query(
      "SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1",
      [username, email]
    );

    if (existingUserRows.length > 0) {
      return errorResponse(res, null, "Username atau email sudah digunakan");
    }

    const [existingInstitutionRows] = await pool.query(
      "SELECT id FROM institutions WHERE name = ? OR email = ? OR phone = ? LIMIT 1",
      [institutionName, institutionEmail, institutionPhone]
    );

    if (existingInstitutionRows.length > 0) {
      return errorResponse(
        res,
        null,
        "Institusi ini sudah digunakan oleh akun lain"
      );
    }

    const userId = randomUUID();
    const now = new Date();
    const provinceId = Number(institutionProvince) || null;
    const cityId = Number(institutionCity) || null;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query(
        "INSERT INTO users (id, username, email, password, role_id, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [userId, username, email, hashPassword, role_id, null, now, now]
      );

      await connection.query(
        "INSERT INTO institutions (name, email, phone, address, province_id, city_id, type, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          institutionName,
          institutionEmail,
          institutionPhone,
          institutionAddress,
          provinceId,
          cityId,
          institutionType,
          userId,
          now,
          now,
        ]
      );

      await connection.commit();
    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    const [rows] = await pool.query(
      `SELECT
         u.id AS id,
         u.username AS username,
         u.email AS email,
         r.name AS role_name,
         i.id AS institution_id,
         i.name AS institution_name,
         i.email AS institution_email,
         i.phone AS institution_phone,
         i.address AS institution_address,
         p.id AS province_id,
         p.name AS province_name,
         c.id AS city_id,
         c.name AS city_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN institutions i ON i.user_id = u.id
       LEFT JOIN provinces p ON p.id = i.province_id
       LEFT JOIN cities c ON c.id = i.city_id
       WHERE u.id = ?
       LIMIT 1`,
      [userId]
    );

    const row = rows[0];
    const newInstitution = {
      id: row.id,
      username: row.username,
      email: row.email,
      role: { name: row.role_name },
      institution: {
        id: row.institution_id,
        name: row.institution_name,
        email: row.institution_email,
        phone: row.institution_phone,
        address: row.institution_address,
        province: row.province_id
          ? { id: row.province_id, name: row.province_name }
          : null,
        city: row.city_id ? { id: row.city_id, name: row.city_name } : null,
      },
    };

    return successResponse(res, newInstitution, "Berhasil membuat akun");
  } catch (error) {
    return errorResponse(res, error, "Error saat membuat akun");
  }
};

export const login = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.email, u.password, u.role_id, u.refresh_token, u.created_at, u.updated_at, r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.username = ? OR u.email = ?
       LIMIT 1`,
      [req.body.identifier, req.body.identifier]
    );

    if (rows.length === 0) {
      return errorResponse(res, null, "User tidak ditemukan");
    }

    const user = rows[0];

    const match = await argon2.verify(user.password, req.body.password);
    if (!match) return errorResponse(res, null, "Password salah");

    const { id, username, email } = user;
    const roleName = user.role_name;

    const accessToken = jwt.sign(
      { id, username, email, role: roleName },
      process.env.APP_ACCESS_TOKEN_SECRET,
      {
        expiresIn: "15m",
      }
    );
    const refreshToken = jwt.sign(
      { id, username, email, role: roleName },
      process.env.APP_REFRESH_TOKEN_SECRET,
      {
        expiresIn: "1d",
      }
    );

    await pool.query("UPDATE users SET refresh_token = ? WHERE id = ?", [
      refreshToken,
      id,
    ]);

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

  const [rows] = await pool.query(
    "SELECT id FROM users WHERE refresh_token = ? LIMIT 1",
    [refreshToken]
  );

  if (rows.length === 0)
    return errorResponse(res, null, "Refresh token tidak valid");

  const { id } = rows[0];

  await pool.query("UPDATE users SET refresh_token = NULL WHERE id = ?", [id]);

  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  });
  return successResponse(res, null, "Logout berhasil");
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/AuthController.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/AuthController.js src/controllers/__tests__/AuthController.test.js
git commit -m "refactor: migrate AuthController from Prisma to raw mysql2"
```

---

### Task 5: roleBased middleware — Prisma to raw mysql2

**Files:**
- Modify: `src/middelware/roleBased.js`
- Create: `src/middelware/__tests__/roleBased.test.js`

**Interfaces:**
- Modifies `roleBased(roles)` — a factory returning `async (req, res, next) => {}`, signature unchanged, consumed by `src/routes/UserRoute.js` (`roleBased("admin")` on `GET /users`) and any other route wiring it in.
- Replaces `import { PrismaClient } from "@prisma/client"` + `const prisma = new PrismaClient();` with `import pool from "../config/db.js";`. Note the real directory is spelled `src/middelware` (typo preserved, not fixed).
- Replaces the Prisma `findFirst({ include: { role: { select: { name: true } } } })` with a narrow `JOIN roles` query, since only `.role.name` was ever read off the Prisma result.
- Both the "user not found" and "access denied" branches call `errorResponse(res, null, ...)`, which defaults to HTTP 500 — this middleware never sends 401/403 today. Preserve exactly.

- [ ] **Step 1: Write the failing tests**

Create `src/middelware/__tests__/roleBased.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { roleBased } from "../roleBased.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("roleBased", () => {
  it("calls next() when the user's role is in the allowed list", async () => {
    const req = { user: { id: "u1" } };
    const res = mockRes();
    const next = vi.fn();
    pool.query.mockResolvedValueOnce([[{ role_name: "admin" }], []]);

    await roleBased(["admin", "teacher"])(req, res, next);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM users u JOIN roles r"),
      ["u1"]
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts a single role string and normalizes it to an array before checking membership", async () => {
    const req = { user: { id: "u1" } };
    const res = mockRes();
    const next = vi.fn();
    pool.query.mockResolvedValueOnce([[{ role_name: "admin" }], []]);

    await roleBased("admin")(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 500 'User tidak ditemukan' when req.user is missing, without querying the DB", async () => {
    const req = {};
    const res = mockRes();
    const next = vi.fn();

    await roleBased(["admin"])(req, res, next);

    expect(pool.query).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User tidak ditemukan",
      error: null,
    });
  });

  it("returns 500 'User tidak ditemukan' when no row matches req.user.id", async () => {
    const req = { user: { id: "missing" } };
    const res = mockRes();
    const next = vi.fn();
    pool.query.mockResolvedValueOnce([[], []]);

    await roleBased(["admin"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "User tidak ditemukan",
      error: null,
    });
  });

  it("returns 500 'Akses ditolak' when the user's role is not in the allowed list", async () => {
    const req = { user: { id: "u1" } };
    const res = mockRes();
    const next = vi.fn();
    pool.query.mockResolvedValueOnce([[{ role_name: "parent" }], []]);

    await roleBased(["admin", "teacher"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Akses ditolak",
      error: null,
    });
  });

  it("catches a query error and returns 500 'Error checking user role'", async () => {
    const req = { user: { id: "u1" } };
    const res = mockRes();
    const next = vi.fn();
    const dbError = new Error("connection lost");
    pool.query.mockRejectedValueOnce(dbError);

    await roleBased(["admin"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error checking user role",
      error: "connection lost",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/middelware/__tests__/roleBased.test.js`

Expected: FAIL. The current `src/middelware/roleBased.js` still uses `PrismaClient`, not the mocked pool: either constructing `new PrismaClient()` throws at import time, or the assertions against `pool.query` fail because the middleware calls `prisma.user.findFirst` instead.

- [ ] **Step 3: Rewrite `src/middelware/roleBased.js`**

```js
import pool from "../config/db.js";
import { errorResponse } from "../helpers/ResponseHelper.js";

export const roleBased = (roles) => {
  return async (req, res, next) => {
    try {
      if (!req.user) return errorResponse(res, null, "User tidak ditemukan");

      const [rows] = await pool.query(
        "SELECT r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? LIMIT 1",
        [req.user.id]
      );

      if (rows.length === 0)
        return errorResponse(res, null, "User tidak ditemukan");

      const userRole = rows[0].role_name;

      if (typeof roles === "string") {
        roles = [roles];
      }

      if (!roles.includes(userRole)) {
        return errorResponse(res, null, "Akses ditolak");
      }

      next();
    } catch (error) {
      return errorResponse(res, error, "Error checking user role");
    }
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/middelware/__tests__/roleBased.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/middelware/roleBased.js src/middelware/__tests__/roleBased.test.js
git commit -m "refactor: migrate roleBased middleware from Prisma to raw mysql2"
```
### Task 6: Convert QuesionerController.js to raw mysql2 queries

**Files:**
- Modify: `src/controllers/QuesionerController.js`
- Create: `src/controllers/__tests__/QuesionerController.test.js`

**Interfaces:**
- Consumes: `pool` (default export) from `src/config/db.js`, per Task 0.
- Produces: `getQuesioners`, `getQuestion`, `getQuestionByQuesionerId`, `getAllQuestionByQuesionerId`, `updateQuestion` — same exported names and signatures as the current Prisma-based file, so route wiring in `src/routes/` needs no changes.
- Internal (not exported): an `attachOptions(questions)` helper shared by the three read handlers, which runs a second `SELECT ... FROM options WHERE question_id IN (?)` and groups rows onto their parent question in JS (never a JOIN — a JOIN would multiply question rows against the LIMIT/OFFSET pagination).
- `updateQuestion` is the only handler needing a transaction (`pool.getConnection()`), because it must UPDATE the question row, DELETE all its options, and bulk-INSERT the replacement options as one atomic unit.

- [ ] **Step 1: Write the failing test file**

Create `src/controllers/__tests__/QuesionerController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getQuesioners,
  getQuestion,
  getQuestionByQuesionerId,
  getAllQuestionByQuesionerId,
  updateQuestion,
} from "../QuesionerController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getQuesioners", () => {
  it("returns all quesioners", async () => {
    pool.query.mockResolvedValueOnce([
      [{ id: 1, title: "Quiz 1", description: "desc" }],
      [],
    ]);
    const req = {};
    const res = mockRes();

    await getQuesioners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id, title, description FROM quesioners")
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        data: [{ id: 1, title: "Quiz 1", description: "desc" }],
      })
    );
  });
});

describe("getQuestion", () => {
  it("returns paginated questions with grouped options", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [{ id: 1, quesioner_id: 1, title: "Q1", type: "SCALE", is_required: 1 }],
        [],
      ])
      .mockResolvedValueOnce([
        [
          { id: 10, question_id: 1, title: "Opt A", score: 1 },
          { id: 11, question_id: 1, title: "Opt B", score: 0 },
        ],
        [],
      ]);
    const req = { query: {} };
    const res = mockRes();

    await getQuestion(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS total FROM questions WHERE title LIKE ?"),
      ["%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM questions WHERE title LIKE ?"),
      ["%%", 10, 0]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("FROM options WHERE question_id IN (?)"),
      [[1]]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        data: expect.objectContaining({
          totalRows: 1,
          totalPage: 1,
          page: 0,
          limit: 10,
          questions: [
            {
              id: 1,
              quesioner_id: 1,
              title: "Q1",
              type: "SCALE",
              is_required: true,
              options: [
                { id: 10, question_id: 1, title: "Opt A", score: 1 },
                { id: 11, question_id: 1, title: "Opt B", score: 0 },
              ],
            },
          ],
        }),
      })
    );
  });

  it("skips the options query when no questions match", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []]);
    const req = { query: { search: "nomatch" } };
    const res = mockRes();

    await getQuestion(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ questions: [] }),
      })
    );
  });
});

describe("getQuestionByQuesionerId", () => {
  it("filters by quesioner id and uses the raw param in the success message", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [{ id: 2, quesioner_id: 5, title: "Q2", type: "BOOLEAN", is_required: 0 }],
        [],
      ])
      .mockResolvedValueOnce([[{ id: 20, question_id: 2, title: "Yes", score: 1 }], []]);
    const req = { params: { id: "5" }, query: {} };
    const res = mockRes();

    await getQuestionByQuesionerId(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE quesioner_id = ? AND title LIKE ?"),
      [5, "%%"]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Question 5 retrieved successfully" })
    );
  });
});

describe("getAllQuestionByQuesionerId", () => {
  it("returns a bare array without a pagination wrapper", async () => {
    pool.query
      .mockResolvedValueOnce([
        [{ id: 3, quesioner_id: 7, title: "Q3", type: "SCALE", is_required: 1 }],
        [],
      ])
      .mockResolvedValueOnce([[{ id: 30, question_id: 3, title: "Opt", score: 2 }], []]);
    const req = { params: { id: "7" } };
    const res = mockRes();

    await getAllQuestionByQuesionerId(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE quesioner_id = ? ORDER BY id ASC"),
      [7]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Question 7 retrieved successfully",
        data: [
          {
            id: 3,
            quesioner_id: 7,
            title: "Q3",
            type: "SCALE",
            is_required: true,
            options: [{ id: 30, question_id: 3, title: "Opt", score: 2 }],
          },
        ],
      })
    );
  });
});

describe("updateQuestion", () => {
  function mockConnection() {
    return {
      beginTransaction: vi.fn(),
      query: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
  }

  it("updates the question, replaces its options in a transaction, and re-selects", async () => {
    const conn = mockConnection();
    pool.getConnection.mockResolvedValueOnce(conn);
    conn.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE questions
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // DELETE options
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT options (bulk)
      .mockResolvedValueOnce([
        [{ id: 4, quesioner_id: 1, title: "New title", type: "SCALE", is_required: 1 }],
      ]) // SELECT question
      .mockResolvedValueOnce([[{ id: 40, question_id: 4, title: "A", score: 1 }]]); // SELECT options

    const req = {
      params: { id: "4" },
      body: { title: "New title", type: "SCALE", options: [{ title: "A", score: 1 }] },
    };
    const res = mockRes();

    await updateQuestion(req, res);

    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE questions SET title = ?, type = ? WHERE id = ?"),
      ["New title", "SCALE", 4]
    );
    expect(conn.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("DELETE FROM options WHERE question_id = ?"),
      [4]
    );
    expect(conn.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO options (question_id, title, score) VALUES ?"),
      [[[4, "A", 1]]]
    );
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Question updated successfully",
        data: expect.objectContaining({
          id: 4,
          is_required: true,
          options: [{ id: 40, question_id: 4, title: "A", score: 1 }],
        }),
      })
    );
  });

  it("skips the bulk insert when the options array is empty", async () => {
    const conn = mockConnection();
    pool.getConnection.mockResolvedValueOnce(conn);
    conn.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // DELETE
      .mockResolvedValueOnce([[{ id: 4, quesioner_id: 1, title: "T", type: "SCALE", is_required: 1 }]]) // SELECT question
      .mockResolvedValueOnce([[]]); // SELECT options

    const req = { params: { id: "4" }, body: { title: "T", type: "SCALE", options: [] } };
    const res = mockRes();

    await updateQuestion(req, res);

    expect(conn.query).toHaveBeenCalledTimes(4);
    expect(
      conn.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO options"))
    ).toBe(false);
  });

  it("rolls back and releases the connection when a query in the transaction fails", async () => {
    const conn = mockConnection();
    pool.getConnection.mockResolvedValueOnce(conn);
    conn.query.mockRejectedValueOnce(new Error("db exploded"));

    const req = { params: { id: "4" }, body: { title: "T", type: "SCALE", options: [] } };
    const res = mockRes();

    await updateQuestion(req, res);

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Failed to update question" })
    );
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/controllers/__tests__/QuesionerController.test.js`
Expected: FAIL — `QuesionerController.js` still imports `PrismaClient` and calls `prisma.quesioner.findMany` / `prisma.question.*`, so `pool.query` is never called and every assertion on `pool.query` mismatches (or the mocked `pool.query` returns `undefined`, throwing inside the handler and producing a 500 the test doesn't expect).

- [ ] **Step 3: Rewrite `src/controllers/QuesionerController.js`**

```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

async function attachOptions(questions) {
  if (questions.length === 0) return questions;

  const questionIds = questions.map((q) => q.id);
  const [optionRows] = await pool.query(
    "SELECT id, question_id, title, score FROM options WHERE question_id IN (?) ORDER BY id ASC",
    [questionIds]
  );

  const optionsByQuestionId = new Map();
  for (const opt of optionRows) {
    if (!optionsByQuestionId.has(opt.question_id)) {
      optionsByQuestionId.set(opt.question_id, []);
    }
    optionsByQuestionId.get(opt.question_id).push(opt);
  }

  return questions.map((q) => ({
    ...q,
    options: optionsByQuestionId.get(q.id) || [],
  }));
}

export const getQuesioners = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, title, description FROM quesioners"
    );
    return successResponse(res, rows, "Quesioner retrieved successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve quesioners");
  }
};

export const getQuestion = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM questions WHERE title LIKE ?",
      [`%${search}%`]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type, is_required FROM questions WHERE title LIKE ? ORDER BY id ASC LIMIT ? OFFSET ?",
      [`%${search}%`, limit, offset]
    );

    const withBooleans = questionRows.map((q) => ({
      ...q,
      is_required: !!q.is_required,
    }));
    const questions = await attachOptions(withBooleans);

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions },
      "Question retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve question");
  }
};

export const getQuestionByQuesionerId = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;
  const quesionerId = parseInt(req.params.id);

  try {
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM questions WHERE quesioner_id = ? AND title LIKE ?",
      [quesionerId, `%${search}%`]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type, is_required FROM questions WHERE quesioner_id = ? AND title LIKE ? ORDER BY id ASC LIMIT ? OFFSET ?",
      [quesionerId, `%${search}%`, limit, offset]
    );

    const withBooleans = questionRows.map((q) => ({
      ...q,
      is_required: !!q.is_required,
    }));
    const questions = await attachOptions(withBooleans);

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions },
      `Question ${req.params.id} retrieved successfully`
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve question");
  }
};

export const getAllQuestionByQuesionerId = async (req, res) => {
  const quesionerId = parseInt(req.params.id);

  try {
    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type, is_required FROM questions WHERE quesioner_id = ? ORDER BY id ASC",
      [quesionerId]
    );

    const withBooleans = questionRows.map((q) => ({
      ...q,
      is_required: !!q.is_required,
    }));
    const questions = await attachOptions(withBooleans);

    return successResponse(
      res,
      questions,
      `Question ${req.params.id} retrieved successfully`
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve question");
  }
};

export const updateQuestion = async (req, res) => {
  const { id } = req.params;
  const { title, type, options } = req.body;
  const questionId = parseInt(id);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      "UPDATE questions SET title = ?, type = ? WHERE id = ?",
      [title, type, questionId]
    );

    await connection.query("DELETE FROM options WHERE question_id = ?", [
      questionId,
    ]);

    if (Array.isArray(options) && options.length > 0) {
      const values = options.map((o) => [questionId, o.title, o.score ?? 0]);
      await connection.query(
        "INSERT INTO options (question_id, title, score) VALUES ?",
        [values]
      );
    }

    const [[questionRow]] = await connection.query(
      "SELECT id, quesioner_id, title, type, is_required FROM questions WHERE id = ?",
      [questionId]
    );
    const [optionRows] = await connection.query(
      "SELECT id, question_id, title, score FROM options WHERE question_id = ? ORDER BY id ASC",
      [questionId]
    );

    await connection.commit();

    const question = {
      ...questionRow,
      is_required: !!questionRow.is_required,
      options: optionRows,
    };

    return successResponse(res, question, "Question updated successfully");
  } catch (error) {
    await connection.rollback();
    return errorResponse(res, error, "Failed to update question");
  } finally {
    connection.release();
  }
};
```

Note: `options` in the re-select is deliberately built from a fresh `SELECT ... WHERE question_id = ?` (not from `req.body.options`) — the inserted rows' auto-increment `id`s are unknown until re-read, and this also guards against the request body ever driving what gets attached to the response.

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/controllers/__tests__/QuesionerController.test.js`
Expected: PASS (9 tests: 1 for `getQuesioners`, 2 for `getQuestion`, 1 for `getQuestionByQuesionerId`, 1 for `getAllQuestionByQuesionerId`, 3 for `updateQuestion` — 7 total across 5 describe blocks; run the file and confirm the reported count matches what was written, all green).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/QuesionerController.js src/controllers/__tests__/QuesionerController.test.js
git commit -m "refactor: convert QuesionerController from Prisma to mysql2"
```

---

### Task 7: Convert NotificationController.js to raw mysql2 queries

**Files:**
- Modify: `src/controllers/NotificationController.js`
- Create: `src/controllers/__tests__/NotificationController.test.js`

**Interfaces:**
- Consumes: `pool` (default export) from `src/config/db.js`; `randomUUID` from `node:crypto`.
- Produces: `createNotification`, `getNotifications`, `getUnreadCount`, `markAsRead`, `markAllAsRead` — identical exported names.
- **Cross-file dependency, do not change its call sites**: `createNotification(userId, title, message, type, referenceId = null)` is imported directly (not as an HTTP handler) by `src/controllers/RecommendationController.js` at 3 call sites (lines ~190, ~212, ~534 as of this analysis). Its positional signature and return shape (a plain object with `id`, `userId`, `title`, `message`, `isRead` (boolean), `type`, `referenceId`, `createdAt`) must be preserved exactly, since `RecommendationController.js` is out of scope for this task and is not being modified.

- [ ] **Step 1: Write the failing test file**

Create `src/controllers/__tests__/NotificationController.test.js`:
```js
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
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/controllers/__tests__/NotificationController.test.js`
Expected: FAIL — the current file calls `prisma.notification.*`, so `pool.query` is never invoked and every `expect(pool.query)...` assertion fails.

- [ ] **Step 3: Rewrite `src/controllers/NotificationController.js`**

```js
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
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 20;
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
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/controllers/__tests__/NotificationController.test.js`
Expected: PASS (7 tests across 5 describe blocks, all green).

- [ ] **Step 5: Verify the cross-file dependency still holds**

Run: `grep -n "createNotification" src/controllers/RecommendationController.js`
Expected: 3 call sites still present, each calling `createNotification(userId, title, message, type[, referenceId])` positionally — unchanged, because `NotificationController.js`'s exported signature was not altered. No edits to `RecommendationController.js` are made in this task.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/NotificationController.js src/controllers/__tests__/NotificationController.test.js
git commit -m "refactor: convert NotificationController from Prisma to mysql2"
```

---

### Task 8: Convert PartnerController.js to raw mysql2 queries

**Files:**
- Modify: `src/controllers/PartnerController.js`
- Create: `src/controllers/__tests__/PartnerController.test.js`

**Interfaces:**
- Consumes: `pool` (default export) from `src/config/db.js`; `randomUUID` from `node:crypto`.
- Produces: `getPartners`, `addPartners`, `deletePartner` — identical exported names.
- Preserved bug (do not fix): `getPartners` and `addPartners` call `errorResponse(res, null, "Institution not found")` when the caller's institution can't be found — `errorResponse`'s signature is `(res, error, message, statusCode = 500)`, so this resolves to an HTTP **500**, not a 404. This task keeps that behavior byte-for-byte; a future task may file it as a separate fix.
- New guard (not in the original, added per the conversion design): `addPartners` now validates `healthcareIds` is a non-empty array before doing anything else, since raw SQL has no equivalent of Prisma silently no-op'ing `createMany` on an empty `data` array — an empty `VALUES ()` clause is a SQL syntax error.
- `deletePartner` manually checks `result.affectedRows === 0` and throws, to replicate Prisma's `.delete()` throwing `P2025` when the row doesn't exist (a raw `DELETE` never throws on zero affected rows).

- [ ] **Step 1: Write the failing test file**

Create `src/controllers/__tests__/PartnerController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("node:crypto", () => ({ randomUUID: vi.fn() }));

import pool from "../../config/db.js";
import { randomUUID } from "node:crypto";
import { getPartners, addPartners, deletePartner } from "../PartnerController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPartners", () => {
  it("returns a 500 'Institution not found' response when the user has no institution (preserved bug)", async () => {
    pool.query.mockResolvedValueOnce([[], []]);
    const req = { user: { id: "user-1" }, query: {} };
    const res = mockRes();

    await getPartners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT id FROM institutions WHERE user_id = ? LIMIT 1"),
      ["user-1"]
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Institution not found" })
    );
  });

  it("returns joined, reshaped partnerships without a search filter", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [
          {
            p_id: "pt-1",
            p_schoolId: 1,
            p_healthcareId: 9,
            p_createdAt: new Date("2026-01-01"),
            h_id: 9,
            h_name: "Puskesmas A",
            h_address: "Jl. A",
            h_phone: "0800",
            h_email: "a@x.com",
          },
        ],
        [],
      ]);

    const req = { user: { id: "user-1" }, query: {} };
    const res = mockRes();

    await getPartners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "FROM partnerships p JOIN institutions h ON h.id = p.healthcareId"
      ),
      [1]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("ORDER BY p.createdAt DESC"),
      [1, 10, 0]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalRows: 1,
          partnerships: [
            {
              id: "pt-1",
              schoolId: 1,
              healthcareId: 9,
              createdAt: new Date("2026-01-01"),
              healthcare: {
                id: 9,
                name: "Puskesmas A",
                address: "Jl. A",
                phone: "0800",
                email: "a@x.com",
              },
            },
          ],
        }),
      })
    );
  });

  it("applies the search filter across name/address/phone but not email", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }], []])
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []]);

    const req = { user: { id: "user-1" }, query: { search: "puskesmas" } };
    const res = mockRes();

    await getPartners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "h.name LIKE ? OR h.address LIKE ? OR h.phone LIKE ?"
      ),
      [1, "%puskesmas%", "%puskesmas%", "%puskesmas%"]
    );
  });
});

describe("addPartners", () => {
  it("rejects when healthcareIds is missing or empty", async () => {
    const req = { user: { id: "user-1" }, body: { healthcareIds: [] } };
    const res = mockRes();

    await addPartners(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "healthcareIds must be a non-empty array" })
    );
  });

  it("bulk inserts with INSERT IGNORE to replicate skipDuplicates", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }], []])
      .mockResolvedValueOnce([{ affectedRows: 2 }]);
    randomUUID.mockReturnValueOnce("uuid-1").mockReturnValueOnce("uuid-2");

    const req = { user: { id: "user-1" }, body: { healthcareIds: [9, 10] } };
    const res = mockRes();

    await addPartners(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "INSERT IGNORE INTO partnerships (id, schoolId, healthcareId) VALUES ?"
      ),
      [
        [
          ["uuid-1", 1, 9],
          ["uuid-2", 1, 10],
        ],
      ]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Partners added successfully" })
    );
  });

  it("returns 'Institution not found' when the user has no institution", async () => {
    pool.query.mockResolvedValueOnce([[], []]);
    const req = { user: { id: "user-1" }, body: { healthcareIds: [9] } };
    const res = mockRes();

    await addPartners(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Institution not found" })
    );
  });
});

describe("deletePartner", () => {
  it("removes a partnership", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const req = { params: { id: "pt-1" } };
    const res = mockRes();

    await deletePartner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("DELETE FROM partnerships WHERE id = ?"),
      ["pt-1"]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Partner removed successfully" })
    );
  });

  it("throws to replicate Prisma's P2025 when no row is deleted", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const req = { params: { id: "missing" } };
    const res = mockRes();

    await deletePartner(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", message: "Failed to remove partner" })
    );
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/controllers/__tests__/PartnerController.test.js`
Expected: FAIL — the current file calls `prisma.institution.findUnique` / `prisma.partnership.*`, so `pool.query` is never invoked; additionally `addPartners`'s empty-array guard doesn't exist yet in the current source, so that test also fails on the "must not have called pool.query" assertion being moot (it fails earlier, on the response message not matching).

- [ ] **Step 3: Rewrite `src/controllers/PartnerController.js`**

```js
import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getPartners = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const user = req.user;
    const [institutionRows] = await pool.query(
      "SELECT id FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = institutionRows[0];

    if (!institution) return errorResponse(res, null, "Institution not found");

    const searchClause = search
      ? " AND (h.name LIKE ? OR h.address LIKE ? OR h.phone LIKE ?)"
      : "";
    const searchParams = search
      ? [`%${search}%`, `%${search}%`, `%${search}%`]
      : [];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM partnerships p JOIN institutions h ON h.id = p.healthcareId WHERE p.schoolId = ?${searchClause}`,
      [institution.id, ...searchParams]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [rows] = await pool.query(
      `SELECT p.id AS p_id, p.schoolId AS p_schoolId, p.healthcareId AS p_healthcareId, p.createdAt AS p_createdAt,
              h.id AS h_id, h.name AS h_name, h.address AS h_address, h.phone AS h_phone, h.email AS h_email
       FROM partnerships p JOIN institutions h ON h.id = p.healthcareId
       WHERE p.schoolId = ?${searchClause}
       ORDER BY p.createdAt DESC
       LIMIT ? OFFSET ?`,
      [institution.id, ...searchParams, limit, offset]
    );

    const partnerships = rows.map((row) => ({
      id: row.p_id,
      schoolId: row.p_schoolId,
      healthcareId: row.p_healthcareId,
      createdAt: row.p_createdAt,
      healthcare: {
        id: row.h_id,
        name: row.h_name,
        address: row.h_address,
        phone: row.h_phone,
        email: row.h_email,
      },
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, partnerships },
      "Partners retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get partners");
  }
};

export const addPartners = async (req, res) => {
  try {
    const user = req.user;
    const { healthcareIds } = req.body;

    if (!Array.isArray(healthcareIds) || healthcareIds.length === 0) {
      return errorResponse(
        res,
        null,
        "healthcareIds must be a non-empty array"
      );
    }

    const [institutionRows] = await pool.query(
      "SELECT id FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = institutionRows[0];

    if (!institution) return errorResponse(res, null, "Institution not found");

    const values = healthcareIds.map((healthcareId) => [
      randomUUID(),
      institution.id,
      healthcareId,
    ]);

    await pool.query(
      "INSERT IGNORE INTO partnerships (id, schoolId, healthcareId) VALUES ?",
      [values]
    );

    return successResponse(res, null, "Partners added successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to add partners");
  }
};

export const deletePartner = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      "DELETE FROM partnerships WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      throw new Error("Partnership not found");
    }

    return successResponse(res, null, "Partner removed successfully");
  } catch (error) {
    return errorResponse(res, error, "Failed to remove partner");
  }
};
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/controllers/__tests__/PartnerController.test.js`
Expected: PASS (7 tests across 3 describe blocks, all green).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/PartnerController.js src/controllers/__tests__/PartnerController.test.js
git commit -m "refactor: convert PartnerController from Prisma to mysql2"
```

---

### Task 9: Convert StudentController.js to raw mysql2 queries

**Files:**
- Modify: `src/controllers/StudentController.js`
- Create: `src/controllers/__tests__/StudentController.test.js`

**Interfaces:**
- Consumes: `pool` (default export) from `src/config/db.js`.
- Produces: `getStudents`, `getStudentByUser` — identical exported names.
- Internal (not exported): a `reshapeStudentRow(row)` helper shared by both handlers, which turns one flat, alias-prefixed SQL row into the nested `{ id, fullName, nutrition: [...], student: {...} | null }` shape the frontend expects. Every joined table's columns are aliased with a table-specific prefix (`fm_`, `n_`, `ns_`, `s_`, `i_`, `pr_`, `ci_`, `c_`, `t_`) because `family_members`, `students`, `institutions`, `classes`, and `nutrition_status` all have overlapping column names (`id`, `name`, etc.) that would otherwise collide once mysql2 flattens the JOIN into one row object.
- `getStudents` uses `LEFT JOIN` for every relation (nutrition, student, institution, province, city, class, teacher are all optional 0-or-1 relations from a family member's point of view).
- `getStudentByUser` uses `INNER JOIN students s ON s.familyMemberId = fm.id` instead — the original Prisma query filtered through `student: { institution: { id } } }`, a nested relation filter that only matches rows where the `student` relation exists, so the join must be an INNER JOIN to reproduce that semantics (a family member without a `student` row is excluded entirely, not returned with `student: null`).
- Preserved bug (do not fix): the role/institution guard clauses in `getStudentByUser` call `errorResponse(res, 404, "...")`. Since `errorResponse`'s signature is `(res, error, message, statusCode = 500)`, passing `404` positionally as `error` (not `statusCode`) means these guard clauses actually resolve to HTTP **500**, not 404. This task keeps that behavior byte-for-byte.
- After building the page in `getStudentByUser`, a batch query fetches active recommendations (`status IN ('PENDING','PROCESSED')`) for the returned students' ids in one `IN (?)` query, then flags `isRecommending` per row — this batch query is skipped entirely when the page has zero students.

- [ ] **Step 1: Write the failing test file**

Create `src/controllers/__tests__/StudentController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getStudents, getStudentByUser } from "../StudentController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

function fullRow(overrides = {}) {
  return {
    fm_id: "fm-1",
    fm_fullName: "Budi",
    n_id: 1,
    n_height: 120,
    n_weight: 25,
    n_bmi: 17.3,
    ns_id: 2,
    ns_information: "Normal",
    ns_displayName: "Gizi Baik",
    s_id: "st-1",
    s_nis: "12345",
    s_schoolYear: "2025/2026",
    s_semester: "1",
    i_id: 7,
    i_name: "SDN 1",
    i_address: "Jl. Mawar",
    i_phone: "0811",
    i_email: "sdn1@x.com",
    pr_id: 3,
    pr_name: "Jawa Barat",
    ci_id: 4,
    ci_name: "Bandung",
    c_id: 5,
    c_name: "6A",
    t_id: "t-1",
    t_fullName: "Bu Guru",
    t_address: "Jl. Melati",
    t_phone: "0822",
    ...overrides,
  };
}

describe("getStudents", () => {
  it("returns paginated students with all joined relations reshaped", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[fullRow()], []]);

    const req = { query: {} };
    const res = mockRes();

    await getStudents(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "WHERE fm.relation = 'ANAK' AND fm.education = 'SD' AND fm.fullName LIKE ?"
      ),
      ["%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("LEFT JOIN teachers t ON t.id = c.teacher_id"),
      ["%%", 10, 0]
    );

    const [[body]] = res.json.mock.calls;
    const student = body.data.students[0];
    expect(student).toEqual({
      id: "fm-1",
      fullName: "Budi",
      nutrition: [
        {
          id: 1,
          height: 120,
          weight: 25,
          bmi: 17.3,
          nutritionStatus: { id: 2, information: "Normal", displayName: "Gizi Baik" },
        },
      ],
      student: {
        id: "st-1",
        nis: "12345",
        schoolYear: "2025/2026",
        semester: "1",
        institution: {
          id: 7,
          name: "SDN 1",
          address: "Jl. Mawar",
          phone: "0811",
          email: "sdn1@x.com",
          province: { id: 3, name: "Jawa Barat" },
          city: { id: 4, name: "Bandung" },
        },
        class: {
          id: 5,
          name: "6A",
          teacher: { id: "t-1", fullName: "Bu Guru", address: "Jl. Melati", phone: "0822" },
        },
      },
    });
  });

  it("nulls out nutrition and student (and its nested relations) when the joins have no match", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [
          fullRow({
            n_id: null,
            n_height: null,
            n_weight: null,
            n_bmi: null,
            ns_id: null,
            ns_information: null,
            ns_displayName: null,
            s_id: null,
            s_nis: null,
            s_schoolYear: null,
            s_semester: null,
            i_id: null,
            i_name: null,
            i_address: null,
            i_phone: null,
            i_email: null,
            pr_id: null,
            pr_name: null,
            ci_id: null,
            ci_name: null,
            c_id: null,
            c_name: null,
            t_id: null,
            t_fullName: null,
            t_address: null,
            t_phone: null,
          }),
        ],
        [],
      ]);

    const req = { query: {} };
    const res = mockRes();

    await getStudents(req, res);

    const [[body]] = res.json.mock.calls;
    const student = body.data.students[0];
    expect(student.nutrition).toEqual([]);
    expect(student.student).toBeNull();
  });
});

describe("getStudentByUser", () => {
  it("returns a 500 (arg-order bug preserved) when the user role is not 'school'", async () => {
    const req = { user: { id: "user-1", role: "parent" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "User not found or not associated with an institution",
      })
    );
  });

  it("returns a 500 (arg-order bug preserved) when no institution is found for the user", async () => {
    pool.query.mockResolvedValueOnce([[], []]);
    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Institution not found for this user" })
    );
  });

  it("filters by class name (exact match) when a class query param is given, and flags isRecommending", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []]) // institution lookup
      .mockResolvedValueOnce([[{ total: 1 }], []]) // count
      .mockResolvedValueOnce([[fullRow()], []]) // page
      .mockResolvedValueOnce([[{ studentId: "st-1" }], []]); // active recommendations

    const req = {
      user: { id: "user-1", role: "school" },
      query: { class: "6A" },
    };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("AND c.name = ?"),
      ["%%", 7, "6A"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(
        "INNER JOIN students s ON s.familyMemberId = fm.id"
      ),
      ["%%", 7, "6A", 10, 0]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining(
        "FROM recommendations WHERE studentId IN (?) AND status IN ('PENDING', 'PROCESSED')"
      ),
      [["st-1"]]
    );

    const [[body]] = res.json.mock.calls;
    expect(body.data.students[0].isRecommending).toBe(true);
  });

  it("skips the recommendations query when the page has no students", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ total: 0 }], []])
      .mockResolvedValueOnce([[], []]);

    const req = { user: { id: "user-1", role: "school" }, query: {} };
    const res = mockRes();

    await getStudentByUser(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const [[body]] = res.json.mock.calls;
    expect(body.data.students).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/controllers/__tests__/StudentController.test.js`
Expected: FAIL — the current file calls `prisma.familyMember.count` / `.findMany` and `prisma.recommendation.findMany`, so `pool.query` is never invoked and every SQL-fragment/param assertion fails.

- [ ] **Step 3: Rewrite `src/controllers/StudentController.js`**

```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

function reshapeStudentRow(row) {
  const nutrition = row.n_id
    ? [
        {
          id: row.n_id,
          height: row.n_height,
          weight: row.n_weight,
          bmi: row.n_bmi,
          nutritionStatus: row.ns_id
            ? {
                id: row.ns_id,
                information: row.ns_information,
                displayName: row.ns_displayName,
              }
            : null,
        },
      ]
    : [];

  const institution = row.i_id
    ? {
        id: row.i_id,
        name: row.i_name,
        address: row.i_address,
        phone: row.i_phone,
        email: row.i_email,
        province: row.pr_id ? { id: row.pr_id, name: row.pr_name } : null,
        city: row.ci_id ? { id: row.ci_id, name: row.ci_name } : null,
      }
    : null;

  const teacher = row.t_id
    ? {
        id: row.t_id,
        fullName: row.t_fullName,
        address: row.t_address,
        phone: row.t_phone,
      }
    : null;

  const classObj = row.c_id ? { id: row.c_id, name: row.c_name, teacher } : null;

  const student = row.s_id
    ? {
        id: row.s_id,
        nis: row.s_nis,
        schoolYear: row.s_schoolYear,
        semester: row.s_semester,
        institution,
        class: classObj,
      }
    : null;

  return {
    id: row.fm_id,
    fullName: row.fm_fullName,
    nutrition,
    student,
  };
}

const STUDENT_JOIN_SELECT = `
  fm.id AS fm_id, fm.fullName AS fm_fullName,
  n.id AS n_id, n.height AS n_height, n.weight AS n_weight, n.bmi AS n_bmi,
  ns.id AS ns_id, ns.information AS ns_information, ns.displayName AS ns_displayName,
  s.id AS s_id, s.nis AS s_nis, s.schoolYear AS s_schoolYear, s.semester AS s_semester,
  i.id AS i_id, i.name AS i_name, i.address AS i_address, i.phone AS i_phone, i.email AS i_email,
  pr.id AS pr_id, pr.name AS pr_name,
  ci.id AS ci_id, ci.name AS ci_name,
  c.id AS c_id, c.name AS c_name,
  t.id AS t_id, t.fullName AS t_fullName, t.address AS t_address, t.phone AS t_phone
`;

export const getStudents = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM family_members fm WHERE fm.relation = 'ANAK' AND fm.education = 'SD' AND fm.fullName LIKE ?",
      [`%${search}%`]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [rows] = await pool.query(
      `SELECT ${STUDENT_JOIN_SELECT}
       FROM family_members fm
       LEFT JOIN nutritions n ON n.familyMemberId = fm.id
       LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
       LEFT JOIN students s ON s.familyMemberId = fm.id
       LEFT JOIN institutions i ON i.id = s.schoolId
       LEFT JOIN provinces pr ON pr.id = i.province_id
       LEFT JOIN cities ci ON ci.id = i.city_id
       LEFT JOIN classes c ON c.id = s.classId
       LEFT JOIN teachers t ON t.id = c.teacher_id
       WHERE fm.relation = 'ANAK' AND fm.education = 'SD' AND fm.fullName LIKE ?
       ORDER BY fm.id ASC
       LIMIT ? OFFSET ?`,
      [`%${search}%`, limit, offset]
    );

    const students = rows.map(reshapeStudentRow);

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, students },
      "Students retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve students");
  }
};

export const getStudentByUser = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;
  const filteredClass = req.query.class || "";

  try {
    const user = req.user;
    if (!user || user.role !== "school") {
      return errorResponse(
        res,
        404,
        "User not found or not associated with an institution"
      );
    }

    const [institutionRows] = await pool.query(
      "SELECT id FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = institutionRows[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found for this user");
    }

    const classClause = filteredClass ? " AND c.name = ?" : "";
    const classParams = filteredClass ? [filteredClass] : [];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM family_members fm
       INNER JOIN students s ON s.familyMemberId = fm.id
       LEFT JOIN classes c ON c.id = s.classId
       WHERE fm.fullName LIKE ? AND s.schoolId = ?${classClause}`,
      [`%${search}%`, institution.id, ...classParams]
    );
    const totalRows = total;
    const totalPage = Math.ceil(totalRows / limit);

    const [rows] = await pool.query(
      `SELECT ${STUDENT_JOIN_SELECT}
       FROM family_members fm
       INNER JOIN students s ON s.familyMemberId = fm.id
       LEFT JOIN nutritions n ON n.familyMemberId = fm.id
       LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
       LEFT JOIN institutions i ON i.id = s.schoolId
       LEFT JOIN provinces pr ON pr.id = i.province_id
       LEFT JOIN cities ci ON ci.id = i.city_id
       LEFT JOIN classes c ON c.id = s.classId
       LEFT JOIN teachers t ON t.id = c.teacher_id
       WHERE fm.fullName LIKE ? AND s.schoolId = ?${classClause}
       ORDER BY fm.id ASC
       LIMIT ? OFFSET ?`,
      [`%${search}%`, institution.id, ...classParams, limit, offset]
    );

    const students = rows.map(reshapeStudentRow);

    const studentIds = students.map((s) => s.student?.id).filter(Boolean);

    let activeRecStudentIds = new Set();
    if (studentIds.length > 0) {
      const [recRows] = await pool.query(
        "SELECT studentId FROM recommendations WHERE studentId IN (?) AND status IN ('PENDING', 'PROCESSED')",
        [studentIds]
      );
      activeRecStudentIds = new Set(recRows.map((r) => r.studentId));
    }

    const studentsWithFlag = students.map((s) => ({
      ...s,
      isRecommending: s.student ? activeRecStudentIds.has(s.student.id) : false,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, students: studentsWithFlag },
      "Students retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve students");
  }
};
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/controllers/__tests__/StudentController.test.js`
Expected: PASS (6 tests across 2 describe blocks, all green).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/StudentController.js src/controllers/__tests__/StudentController.test.js
git commit -m "refactor: convert StudentController from Prisma to mysql2"
```
### Task 10: StaffController.js → raw mysql2

**Files:**
- Modify: `src/controllers/StaffController.js`
- Create: `src/controllers/__tests__/StaffController.test.js`

**Interfaces:**
- Exports unchanged: `addStaff`, `deleteStaff`, `updateStafff` (typo preserved), `getStaffs` — all `(req, res) => Promise<void>`.
- Drops `new PrismaClient({ log: ["error"], errorFormat: "pretty" })` entirely; imports `pool` from `../config/db.js` instead.
- Keeps `import { errorResponse } from "../helpers/ResponseHelper.js"` (this file has never imported `successResponse` — it builds its own inline `res.status(...).json({ status: "Success", message, data })` responses with a **capital-S** `"Success"`, unlike every other controller's lowercase `"success"`. Preserve this inconsistency verbatim; do not unify with `ResponseHelper`).
- Internal (unexported) helper `getUserInstitution(userId)` is intentionally buggy: if the joined institution row is absent it returns `institution.id` where `institution` is `null`, reproducing the original `TypeError: Cannot read properties of null (reading 'id')`. This is a **different, separately-implemented** helper from the safe one in `ClassesController.js` (Task 11) — do not consolidate them.

- [ ] **Step 1: Write the failing test file for `StaffController.js`**

Create `src/controllers/__tests__/StaffController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("argon2", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed-password") },
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(),
}));

import pool from "../../config/db.js";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import {
  addStaff,
  deleteStaff,
  updateStafff,
  getStaffs,
} from "../StaffController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function mockConnection() {
  return {
    beginTransaction: vi.fn(),
    query: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addStaff", () => {
  it("creates a user + staff row in a transaction and returns 201 with capital-S status", async () => {
    randomUUID.mockReturnValueOnce("user-id-1").mockReturnValueOnce("staff-id-1");
    const req = {
      user: { id: "admin-id" },
      body: {
        fullName: "Jane Nurse",
        address: "Jl. Sehat 1",
        phone: "08123",
        email: "jane@example.com",
        password: "plainpass",
        username: "janenurse",
      },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[], []]) // existing user check -> none
      .mockResolvedValueOnce([[{ id: 6 }], []]); // role 6 exists
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO users
      .mockResolvedValueOnce([{ insertId: 0 }]) // INSERT INTO staffs
      .mockResolvedValueOnce([[{ id: "user-id-1", username: "janenurse", email: "jane@example.com", password: "hashed-password", role_id: 6 }], []]) // reselect user
      .mockResolvedValueOnce([[{ id: "staff-id-1", fullName: "Jane Nurse", healthcare_id: 5, user_id: "user-id-1" }], []]); // reselect staff

    await addStaff(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("LEFT JOIN institutions"),
      ["admin-id"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT * FROM users WHERE username = ? AND email = ?"),
      ["janenurse", "jane@example.com"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("SELECT id FROM roles WHERE id = ?"),
      [6]
    );
    expect(connection.beginTransaction).toHaveBeenCalled();
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO users"),
      ["user-id-1", "janenurse", "jane@example.com", "hashed-password", 6]
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO staffs"),
      ["staff-id-1", "Jane Nurse", "Jl. Sehat 1", "08123", 5, "staff", "user-id-1"]
    );
    expect(connection.commit).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      status: "Success",
      message: "User berhasil dibuat",
      data: {
        id: "user-id-1",
        username: "janenurse",
        email: "jane@example.com",
        password: "hashed-password",
        role_id: 6,
        staff: { id: "staff-id-1", fullName: "Jane Nurse", healthcare_id: 5, user_id: "user-id-1" },
      },
    });
  });

  it("creates a new 'staff' role when role id 6 does not exist yet", async () => {
    randomUUID.mockReturnValueOnce("user-id-2").mockReturnValueOnce("staff-id-2");
    const req = {
      user: { id: "admin-id" },
      body: { fullName: "A", address: "B", phone: "C", email: "a@b.com", password: "p", username: "u" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]) // role 6 not found
      .mockResolvedValueOnce([{ insertId: 42 }]); // INSERT INTO roles
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([[{ id: "user-id-2" }], []])
      .mockResolvedValueOnce([[{ id: "staff-id-2" }], []]);

    await addStaff(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(4, expect.stringContaining("INSERT INTO roles"), ["staff"]);
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO users"),
      ["user-id-2", "u", "a@b.com", "hashed-password", 42]
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("throws 'User sudah ada' when username+email already exist (guard clause)", async () => {
    const req = { user: { id: "admin-id" }, body: { username: "dup", email: "dup@x.com", password: "p" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "existing" }], []]);

    await addStaff(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal menambahkan staff",
      error: "User sudah ada",
    });
  });

  it("reproduces the pre-existing TypeError when the caller's user has no institution", async () => {
    const req = { user: { id: "admin-id" }, body: { username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ institution_id: null }], []]);

    await addStaff(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal menambahkan staff",
      error: expect.stringContaining("null"),
    });
  });
});

describe("deleteStaff", () => {
  it("deletes the staff row and returns the pre-delete row as data", async () => {
    const req = { params: { id: "staff-1" }, user: { id: "admin-id" } };
    const res = mockRes();
    const staffRow = { id: "staff-1", healthcare_id: 5, fullName: "Jane" };

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[staffRow], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await deleteStaff(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("DELETE FROM staffs WHERE id = ?"), ["staff-1"]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "Success",
      message: "Berhasil menghapus staff",
      data: staffRow,
    });
  });

  it("guard: throws when id param is missing", async () => {
    const req = { params: {}, user: { id: "admin-id" } };
    const res = mockRes();

    await deleteStaff(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Terjadi kesalahan saat menghapus staff",
      error: "Id dibutuhkan untuk menghapus staff",
    });
  });

  it("guard: throws when staff belongs to a different institution", async () => {
    const req = { params: { id: "staff-1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", healthcare_id: 99 }], []]);

    await deleteStaff(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Terjadi kesalahan saat menghapus staff",
      error: "Tidak bisa menghapus akun institusi lain",
    });
  });
});

describe("updateStafff", () => {
  it("updates staffs and conditionally-built users fields, then re-selects both", async () => {
    randomUUID; // no ids generated by this handler
    const req = {
      params: { id: "staff-1" },
      user: { id: "admin-id" },
      body: { fullName: "New Name", address: "Addr", phone: "Ph", username: "newuser", email: "", password: "" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", user_id: "user-1" }], []]);
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE staffs
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE users (username only, email/password empty)
      .mockResolvedValueOnce([[{ id: "user-1", username: "newuser" }], []]) // reselect user
      .mockResolvedValueOnce([[{ id: "staff-1", fullName: "New Name" }], []]); // reselect staff

    await updateStafff(req, res);

    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE staffs SET"),
      ["New Name", "Addr", "Ph", 5, "staff", "staff-1"]
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE users SET username = ?"),
      ["newuser", "user-1"]
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      status: "Success",
      message: "User berhasil diupdate",
      data: { id: "user-1", username: "newuser", staff: { id: "staff-1", fullName: "New Name" } },
    });
  });

  it("skips the users UPDATE entirely when username/email/password are all falsy, but still re-selects", async () => {
    const req = {
      params: { id: "staff-1" },
      user: { id: "admin-id" },
      body: { fullName: "New Name", address: "Addr", phone: "Ph" },
    };
    const res = mockRes();
    const connection = mockConnection();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", user_id: "user-1" }], []]);
    pool.getConnection.mockResolvedValueOnce(connection);
    connection.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE staffs
      .mockResolvedValueOnce([[{ id: "user-1" }], []]) // reselect user
      .mockResolvedValueOnce([[{ id: "staff-1" }], []]); // reselect staff

    await updateStafff(req, res);

    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.query.mock.calls[1][0]).toEqual(expect.stringContaining("SELECT * FROM users"));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("guard: throws 'User tidak ditemukan' when staff has no linked user_id", async () => {
    const req = { params: { id: "staff-1" }, user: { id: "admin-id" }, body: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: "staff-1", user_id: null }], []]);

    await updateStafff(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal Mengubah staff",
      error: "User tidak ditemukan",
    });
  });

  it("edge: reproduces the pre-existing TypeError when the staff row itself does not exist", async () => {
    const req = { params: { id: "missing" }, user: { id: "admin-id" }, body: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]); // no staff row

    await updateStafff(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal Mengubah staff",
      error: expect.any(String),
    });
  });
});

describe("getStaffs", () => {
  it("filters by healthcare_id only when no keyword is given", async () => {
    const req = { user: { id: "admin-id" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // inline institution lookup
      .mockResolvedValueOnce([[{ total: 2 }], []])
      .mockResolvedValueOnce([[{ id: "s1" }, { id: "s2" }], []]);

    await getStaffs(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE healthcare_id = ?"),
      [5]
    );
    expect(pool.query.mock.calls[2][0]).not.toContain("fullName LIKE");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "Success",
      message: "Berhasil mendapatkan data",
      data: { staffs: [{ id: "s1" }, { id: "s2" }], page: 0, limit: 10, totalPages: 1, totalRows: 2 },
    });
  });

  it("edge: drops the healthcare_id filter (not NULL-matching) when institution_id is null, safely via ??", async () => {
    const req = { user: { id: "admin-id" }, query: { keyword: "bud" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: null }], []])
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[{ id: "s1" }], []]);

    await getStaffs(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE fullName LIKE ?"),
      ["%bud%"]
    );
    expect(pool.query.mock.calls[1][0]).not.toContain("healthcare_id");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("guard: throws when the caller has no user row at all", async () => {
    const req = { user: { id: "ghost" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await getStaffs(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Gagal mendapatkan staff",
      error: "User tidak di institusi manapun",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/StaffController.test.js`
Expected: FAIL — `StaffController.js` still imports `@prisma/client`; also `pool.query`/`pool.getConnection` are never called since the current implementation uses `prisma.*`.

- [ ] **Step 3: Rewrite `src/controllers/StaffController.js` against raw mysql2**

```js
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse } from "../helpers/ResponseHelper.js";

const getUserInstitution = async (userId) => {
  const [rows] = await pool.query(
    `SELECT i.id AS institution_id
     FROM users u
     LEFT JOIN institutions i ON i.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  const user = rows[0];
  if (!user) {
    throw new Error("user tidak ditemukan");
  }
  // Preserved bug: when the user has no institution, `institution` is null
  // and `.id` throws a TypeError, exactly like the original
  // `user.institution.id` on a Prisma `institution: null` result.
  const institution = user.institution_id != null ? { id: user.institution_id } : null;
  return institution.id;
};

export const addStaff = async (req, res) => {
  try {
    const user = req.user;
    const institutionId = await getUserInstitution(user.id);
    const { fullName, address, phone, email, password, username } = req.body;
    const hashedPassword = await argon2.hash(password);

    const [existingRows] = await pool.query(
      `SELECT * FROM users WHERE username = ? AND email = ? LIMIT 1`,
      [username, email]
    );
    const isUserExist = existingRows[0];
    console.log({ isUserExist });
    if (!!isUserExist) {
      throw new Error("User sudah ada");
    }

    const [roleRows] = await pool.query(`SELECT id FROM roles WHERE id = ?`, [6]);
    let roleId;
    if (roleRows[0]) {
      roleId = 6;
    } else {
      const [roleInsert] = await pool.query(`INSERT INTO roles (name) VALUES (?)`, ["staff"]);
      roleId = roleInsert.insertId;
    }

    const connection = await pool.getConnection();
    let newUser;
    try {
      await connection.beginTransaction();
      const userId = randomUUID();
      await connection.query(
        `INSERT INTO users (id, username, email, password, role_id) VALUES (?, ?, ?, ?, ?)`,
        [userId, username, email, hashedPassword, roleId]
      );
      const staffId = randomUUID();
      await connection.query(
        `INSERT INTO staffs (id, fullName, address, phone, healthcare_id, role, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [staffId, fullName, address, phone, institutionId, "staff", userId]
      );
      const [userRows] = await connection.query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [userId]);
      const [staffRows] = await connection.query(`SELECT * FROM staffs WHERE id = ? LIMIT 1`, [staffId]);
      await connection.commit();
      newUser = { ...userRows[0], staff: staffRows[0] };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    res.status(201).json({
      status: "Success",
      message: "User berhasil dibuat",
      data: newUser,
    });
  } catch (err) {
    return errorResponse(res, err, "Gagal menambahkan staff");
  }
};

export const deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new Error("Id dibutuhkan untuk menghapus staff");
    }
    const user = req.user;
    const institutionId = await getUserInstitution(user.id);

    const [staffRows] = await pool.query(`SELECT * FROM staffs WHERE id = ? LIMIT 1`, [id]);
    const existingStaff = staffRows[0];
    if (!existingStaff) {
      throw new Error("Staff tidak ditemukan");
    }
    if (existingStaff.healthcare_id !== institutionId) {
      throw new Error("Tidak bisa menghapus akun institusi lain");
    }

    await pool.query(`DELETE FROM staffs WHERE id = ?`, [id]);

    res.status(200).json({
      status: "Success",
      message: "Berhasil menghapus staff",
      data: existingStaff,
    });
  } catch (err) {
    return errorResponse(res, err, "Terjadi kesalahan saat menghapus staff");
  }
};

export const updateStafff = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new Error("Id dibutuhkan");
    }
    const user = req.user;
    const institutionId = await getUserInstitution(user.id);
    const { fullName, address, phone, username, email, password } = req.body;

    const [rows] = await pool.query(
      `SELECT s.*, u.username AS user_username, u.email AS user_email
       FROM staffs s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?
       LIMIT 1`,
      [id]
    );
    const isUserExist = rows[0];
    if (!isUserExist.user_id) {
      throw new Error("User tidak ditemukan");
    }

    const connection = await pool.getConnection();
    let updatedUser;
    try {
      await connection.beginTransaction();
      await connection.query(
        `UPDATE staffs SET fullName = ?, address = ?, phone = ?, healthcare_id = ?, role = ? WHERE id = ?`,
        [fullName, address, phone, institutionId, "staff", id]
      );

      const fields = [];
      const values = [];
      if (username) {
        fields.push("username = ?");
        values.push(username);
      }
      if (email) {
        fields.push("email = ?");
        values.push(email);
      }
      if (password) {
        const hashedPassword = await argon2.hash(password);
        fields.push("password = ?");
        values.push(hashedPassword);
      }

      if (fields.length > 0) {
        values.push(isUserExist.user_id);
        await connection.query(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, values);
      }

      const [userRows] = await connection.query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [isUserExist.user_id]);
      const [staffRows] = await connection.query(`SELECT * FROM staffs WHERE id = ? LIMIT 1`, [id]);
      await connection.commit();
      updatedUser = { ...userRows[0], staff: staffRows[0] };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    res.status(201).json({
      status: "Success",
      message: "User berhasil diupdate",
      data: updatedUser,
    });
  } catch (err) {
    return errorResponse(res, err, "Gagal Mengubah staff");
  }
};

export const getStaffs = async (req, res) => {
  try {
    const user = req.user;
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const keyword = req.query.keyword ?? "";
    const skip = limit * page;

    const [instRows] = await pool.query(
      `SELECT i.id AS institution_id
       FROM users u
       LEFT JOIN institutions i ON i.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
      [user.id]
    );
    const userInstitution = instRows[0];
    if (!userInstitution) {
      throw new Error("User tidak di institusi manapun");
    }
    const healthcareId = userInstitution.institution_id ?? undefined;

    const conditions = [];
    const params = [];
    if (healthcareId !== undefined) {
      conditions.push("healthcare_id = ?");
      params.push(healthcareId);
    }
    if (keyword !== "") {
      conditions.push("fullName LIKE ?");
      params.push(`%${keyword}%`);
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[countRows], [staffs]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM staffs ${whereSql}`, params),
      pool.query(`SELECT * FROM staffs ${whereSql} LIMIT ? OFFSET ?`, [...params, limit, skip]),
    ]);

    const totalRows = countRows[0].total;
    const totalPages = Math.ceil(totalRows / limit);

    res.status(200).json({
      status: "Success",
      message: "Berhasil mendapatkan data",
      data: {
        staffs,
        page,
        limit,
        totalPages,
        totalRows,
      },
    });
  } catch (err) {
    return errorResponse(res, err, "Gagal mendapatkan staff");
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/StaffController.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/StaffController.js src/controllers/__tests__/StaffController.test.js
git commit -m "refactor: migrate StaffController from Prisma to raw mysql2"
```

---

### Task 11: ClassesController.js → raw mysql2

**Files:**
- Modify: `src/controllers/ClassesController.js`
- Create: `src/controllers/__tests__/ClassesController.test.js`

**Interfaces:**
- Exports unchanged: `getClasses`, `createClasses`, `updateClasses`, `deleteClasses`, `getClassesByInstitution`.
- Keeps `import { errorResponse, successResponse } from "../helpers/ResponseHelper.js"` (this file already used both — that does not change).
- Internal `getUserInstitution(userId)` here is the **safe** version (`if (!row || row.institution_id == null) throw ...`), implemented separately from `StaffController.js`'s buggy one — do not consolidate them into a shared helper.
- Preserves three pre-existing bugs verbatim: (1) `createClasses`'s single-object branch calls `errorResponse(res, "Kelas sudah tersedia", "Tidak dapat membuat kelas yang sudah ada")` — the "already exists" string lands in the `error` arg position, not `message`, so the actual response is HTTP 500 with `message: "Tidak dapat membuat kelas yang sudah ada"` and `error: "Kelas sudah tersedia"`; (2) `updateClasses`'s and `deleteClasses`'s not-found/forbidden guards call `errorResponse(res, 404, ...)` / `errorResponse(res, 403, ...)` — since `errorResponse`'s second parameter is `error`, not `statusCode`, these always resolve to HTTP 500 regardless of the literal 404/403 passed; (3) `createClasses`'s array branch does one `SELECT ... WHERE name = ? AND school_id = ?` per class with no transaction — a duplicate `name` under a *different* `school_id` passes this check and then throws an uncaught unique-constraint violation on the raw `INSERT`, aborting the whole request without rolling back classes already inserted earlier in the loop. None of these are fixed.

- [ ] **Step 1: Write the failing test file for `ClassesController.js`**

Create `src/controllers/__tests__/ClassesController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getClasses,
  createClasses,
  updateClasses,
  deleteClasses,
  getClassesByInstitution,
} from "../ClassesController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getClasses", () => {
  it("returns paginated classes with a teacher object shaped {id, fullName}", async () => {
    const req = { query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [{ id: 1, name: "1A", school_id: 5, teacher_id: "t1", teacher_fullName: "Mrs. Ana" }],
        [],
      ]);

    await getClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining("WHERE name LIKE ?"), ["%%"]);
    expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LEFT JOIN teachers"), ["%%", 10, 0]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Classes retrieved successfully",
      data: {
        totalRows: 1,
        totalPage: 1,
        page: 0,
        limit: 10,
        classes: [{ id: 1, name: "1A", school_id: 5, teacher: { id: "t1", fullName: "Mrs. Ana" } }],
      },
    });
  });

  it("reshapes teacher as null when the class has no teacher_id", async () => {
    const req = { query: { search: "1A" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[{ id: 2, name: "1B", school_id: 5, teacher_id: null, teacher_fullName: null }], []]);

    await getClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining("WHERE name LIKE ?"), ["%1A%"]);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ classes: [{ id: 2, name: "1B", school_id: 5, teacher: null }] }),
      })
    );
  });
});

describe("createClasses", () => {
  it("creates every class in the array that doesn't already exist under this school", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: [{ name: "1A" }, { name: "1B" }] } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[], []]) // 1A does not exist
      .mockResolvedValueOnce([{ insertId: 10 }]) // INSERT 1A
      .mockResolvedValueOnce([[{ id: 10, name: "1A", school_id: 5 }], []]) // reselect 1A
      .mockResolvedValueOnce([[{ id: 99, name: "1B", school_id: 5 }], []]); // 1B already exists -> skipped

    await createClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE name = ? AND school_id = ?"),
      ["1A", 5]
    );
    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("INSERT INTO classes"), ["1A", 5]);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat kelas",
      data: [{ id: 10, name: "1A", school_id: 5 }],
    });
  });

  it("edge: does not roll back an earlier successful insert when a later class in the array throws", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: [{ name: "1A" }, { name: "1A" }] } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]) // first "1A" (school 5) not found -> inserted
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([[{ id: 10, name: "1A", school_id: 5 }], []])
      .mockResolvedValueOnce([[], []]) // second "1A" under a different school_id also passes the scoped check
      .mockRejectedValueOnce(new Error("Duplicate entry '1A' for key 'classes.name'")); // raw global-unique INSERT fails

    await createClasses(req, res);

    // The first class's INSERT already ran and is not undone (no transaction, no catch inside the loop).
    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("INSERT INTO classes"), ["1A", 5]);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Internal server error",
      error: "Duplicate entry '1A' for key 'classes.name'",
    });
  });

  it("creates a single class object when it doesn't exist yet", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: { name: "2A" } } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 20 }])
      .mockResolvedValueOnce([[{ id: 20, name: "2A", school_id: 5 }], []]);

    await createClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil membuat kelas",
      data: { id: 20, name: "2A", school_id: 5 },
    });
  });

  it("bug: single-object duplicate passes 'already exists' string as the error arg, not the message", async () => {
    const req = { user: { id: "admin-id" }, body: { classes: { name: "2A" } } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 20, name: "2A", school_id: 5 }], []]);

    await createClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Tidak dapat membuat kelas yang sudah ada",
      error: "Kelas sudah tersedia",
    });
  });
});

describe("updateClasses", () => {
  it("updates the class name and cascades to the teacher's role when teacher_id is set", async () => {
    const req = { params: { id: "1" }, body: { name: "1A Renamed" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: "1A", teacher_id: "t1" }], []]) // existing
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE classes
      .mockResolvedValueOnce([[{ id: 1, name: "1A Renamed", teacher_id: "t1" }], []]) // reselect
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE teachers

    await updateClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining("UPDATE classes SET name = ?"), ["1A Renamed", 1]);
    expect(pool.query).toHaveBeenNthCalledWith(4, expect.stringContaining("UPDATE teachers SET role = ?"), ["1A Renamed", "t1"]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Kelas berhasil diperbarui",
      data: { id: 1, name: "1A Renamed", teacher_id: "t1" },
    });
  });

  it("skips the teacher cascade when the class has no teacher_id", async () => {
    const req = { params: { id: "2" }, body: { name: "2A" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 2, name: "2A-old", teacher_id: null }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: 2, name: "2A", teacher_id: null }], []]);

    await updateClasses(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it("bug: not-found guard passes literal 404 as the error arg, resolving to HTTP 500", async () => {
    const req = { params: { id: "999" }, body: { name: "X" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await updateClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Kelas tidak ditemukan",
      error: 404,
    });
  });
});

describe("deleteClasses", () => {
  it("nulls the teacher's role before deleting the class", async () => {
    const req = { params: { id: "1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // getUserInstitution
      .mockResolvedValueOnce([[{ id: 1, school_id: 5, teacher_id: "t1" }], []]) // existing class
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE teachers role=null
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE class

    await deleteClasses(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("UPDATE teachers SET role = ?"), [null, "t1"]);
    expect(pool.query).toHaveBeenNthCalledWith(4, expect.stringContaining("DELETE FROM classes WHERE id = ?"), [1]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "success", message: "Kelas berhasil dihapus", data: null });
  });

  it("bug: wrong-school guard passes literal 403 as the error arg, resolving to HTTP 500", async () => {
    const req = { params: { id: "1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, school_id: 99, teacher_id: null }], []]);

    await deleteClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Kelas bukan milik sekolah anda", error: 403 });
  });

  it("guard: throws via the safe getUserInstitution helper when the caller has no institution", async () => {
    const req = { params: { id: "1" }, user: { id: "admin-id" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ institution_id: null }], []]);

    await deleteClasses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Error saat menghapus teacher",
      error: "User tidak terdaftar di institusi manapun",
    });
  });
});

describe("getClassesByInstitution", () => {
  it("returns id+name classes for a school ordered by id", async () => {
    const req = { params: { institutionId: "5" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ id: 1, name: "1A" }, { id: 2, name: "1B" }], []]);

    await getClassesByInstitution(req, res);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM classes WHERE school_id = ? ORDER BY id ASC"),
      [5]
    );
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Kelas berhasil diambil berdasarkan institusi",
      data: [{ id: 1, name: "1A" }, { id: 2, name: "1B" }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/ClassesController.test.js`
Expected: FAIL — current implementation still calls `prisma.class.*` / `prisma.teacher.update`, never touches `pool`.

- [ ] **Step 3: Rewrite `src/controllers/ClassesController.js` against raw mysql2**

```js
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const getUserInstitution = async (userId) => {
  const [rows] = await pool.query(
    `SELECT i.id AS institution_id
     FROM users u
     LEFT JOIN institutions i ON i.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  const row = rows[0];
  if (!row || row.institution_id == null) {
    throw new Error("User tidak terdaftar di institusi manapun");
  }
  return row.institution_id;
};

export const getClasses = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const likeParam = `%${search}%`;
    const [[countRows], [classRows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM classes WHERE name LIKE ?`, [likeParam]),
      pool.query(
        `SELECT c.id, c.name, c.school_id, t.id AS teacher_id, t.fullName AS teacher_fullName
         FROM classes c
         LEFT JOIN teachers t ON t.id = c.teacher_id
         WHERE c.name LIKE ?
         ORDER BY c.id ASC
         LIMIT ? OFFSET ?`,
        [likeParam, limit, offset]
      ),
    ]);

    const totalRows = countRows[0].total;
    const totalPage = Math.ceil(totalRows / limit);
    const classes = classRows.map((row) => ({
      id: row.id,
      name: row.name,
      school_id: row.school_id,
      teacher: row.teacher_id ? { id: row.teacher_id, fullName: row.teacher_fullName } : null,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, classes },
      "Classes retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve classes");
  }
};

export const createClasses = async (req, res) => {
  const { classes } = req.body;

  try {
    const school_id = await getUserInstitution(req.user.id);

    if (Array.isArray(classes)) {
      const createdClasses = [];
      for (const cls of classes) {
        const [existingRows] = await pool.query(
          `SELECT * FROM classes WHERE name = ? AND school_id = ? LIMIT 1`,
          [cls.name, school_id]
        );

        if (!existingRows[0]) {
          const [insertResult] = await pool.query(`INSERT INTO classes (name, school_id) VALUES (?, ?)`, [
            cls.name,
            school_id,
          ]);
          const [newRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [insertResult.insertId]);
          createdClasses.push(newRows[0]);
        }
      }

      return successResponse(res, createdClasses, "Berhasil membuat kelas");
    } else {
      const [existingRows] = await pool.query(
        `SELECT * FROM classes WHERE name = ? AND school_id = ? LIMIT 1`,
        [classes.name, school_id]
      );

      if (existingRows[0]) {
        return errorResponse(res, "Kelas sudah tersedia", "Tidak dapat membuat kelas yang sudah ada");
      }

      const [insertResult] = await pool.query(`INSERT INTO classes (name, school_id) VALUES (?, ?)`, [
        classes.name,
        school_id,
      ]);
      const [newRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [insertResult.insertId]);

      return successResponse(res, newRows[0], "Berhasil membuat kelas");
    }
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};

export const updateClasses = async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  try {
    const [existingRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [parseInt(id)]);
    const existingClass = existingRows[0];

    if (!existingClass) {
      return errorResponse(res, 404, "Kelas tidak ditemukan");
    }

    await pool.query(`UPDATE classes SET name = ? WHERE id = ?`, [name, parseInt(id)]);
    const [updatedRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [parseInt(id)]);
    const updatedClass = updatedRows[0];

    if (existingClass.teacher_id) {
      await pool.query(`UPDATE teachers SET role = ? WHERE id = ?`, [name, existingClass.teacher_id]);
    }

    return successResponse(res, updatedClass, "Kelas berhasil diperbarui");
  } catch (error) {
    return errorResponse(res, error, "Error saat memperbarui kelas");
  }
};

export const deleteClasses = async (req, res) => {
  const { id } = req.params;

  try {
    const school_id = await getUserInstitution(req.user.id);

    const [existingRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [parseInt(id)]);
    const existingClass = existingRows[0];

    if (!existingClass) {
      return errorResponse(res, 404, "Kelas tidak ditemukan");
    }

    if (existingClass.school_id !== school_id) {
      return errorResponse(res, 403, "Kelas bukan milik sekolah anda");
    }

    if (existingClass.teacher_id) {
      await pool.query(`UPDATE teachers SET role = ? WHERE id = ?`, [null, existingClass.teacher_id]);
    }

    await pool.query(`DELETE FROM classes WHERE id = ?`, [parseInt(id)]);

    return successResponse(res, null, "Kelas berhasil dihapus");
  } catch (error) {
    return errorResponse(res, error, "Error saat menghapus teacher");
  }
};

export const getClassesByInstitution = async (req, res) => {
  const { institutionId } = req.params;

  try {
    const [classes] = await pool.query(`SELECT id, name FROM classes WHERE school_id = ? ORDER BY id ASC`, [
      Number(institutionId),
    ]);
    return successResponse(res, classes, "Kelas berhasil diambil berdasarkan institusi");
  } catch (error) {
    return errorResponse(res, error, "Error saat mengambil kelas berdasarkan institusi");
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/ClassesController.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ClassesController.js src/controllers/__tests__/ClassesController.test.js
git commit -m "refactor: migrate ClassesController from Prisma to raw mysql2"
```

---

### Task 12: TeacherController.js → raw mysql2

**Files:**
- Modify: `src/controllers/TeacherController.js`
- Create: `src/controllers/__tests__/TeacherController.test.js`

**Interfaces:**
- Exports unchanged: `getTeachers`, `createTeacher`, `updateTeacher`, `deleteTeacher`.
- Keeps `import { errorResponse, successResponse } from "../helpers/ResponseHelper.js"` and `argon2`.
- `getTeachers`: single JOIN query for the to-one relations (`users`, `institutions` → `provinces`/`cities`), plus a **separate** follow-up `SELECT id, name, teacher_id FROM classes WHERE teacher_id IN (?)` for the to-many `classes` relation, grouped in JS by `teacher_id`; guarded so the follow-up query is skipped entirely when the page of teachers is empty.
- `createTeacher`: preserves the pre-existing bug where the "existing user" branch calls `successResponse(res, updateTeacher, ...)` in the original — `updateTeacher` there refers to the *exported function itself* (hoisted), which serializes to `undefined`, so the response body omits the `data` key entirely. The converted code reproduces this by calling `successResponse(res, undefined, "Berhasil menambahkan wali kelas")` in that branch specifically — do not "fix" it to pass the real inserted data.
- `deleteTeacher`: preserves the bug where only the linked `users` row is deleted (cascading via FK `onDelete: CASCADE` to the `teachers` row) `if (existingTeacher.user_id)` — if there is no linked user, nothing is deleted and the handler still reports success. Do not add a fallback direct `DELETE FROM teachers`.

- [ ] **Step 1: Write the failing test file for `TeacherController.js`**

Create `src/controllers/__tests__/TeacherController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("argon2", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed-password") },
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(),
}));

import pool from "../../config/db.js";
import { randomUUID } from "node:crypto";
import { getTeachers, createTeacher, updateTeacher, deleteTeacher } from "../TeacherController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getTeachers", () => {
  it("joins to-one relations in one query and groups to-many classes from a follow-up query", async () => {
    const req = { query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "t1",
            fullName: "Mrs. Ana",
            role: "Wali Kelas",
            address: "Jl. A",
            phone: "081",
            user_id: "u1",
            user_username: "ana",
            user_email: "ana@x.com",
            institution_id: 5,
            institution_name: "SDN 1",
            institution_address: "Jl. B",
            institution_phone: "082",
            province_id: 1,
            province_name: "Jawa Barat",
            city_id: 2,
            city_name: "Bandung",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ id: 10, name: "1A", teacher_id: "t1" }], []]);

    await getTeachers(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE fullName LIKE ? OR role LIKE ?"),
      ["%%", "%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("SELECT id, name, teacher_id FROM classes WHERE teacher_id IN (?)"),
      [["t1"]]
    );
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Teachers retrieved successfully",
      data: {
        totalRows: 1,
        totalPage: 1,
        page: 0,
        limit: 10,
        teachers: [
          {
            id: "t1",
            fullName: "Mrs. Ana",
            role: "Wali Kelas",
            address: "Jl. A",
            phone: "081",
            user: { id: "u1", username: "ana", email: "ana@x.com" },
            institution: {
              id: 5,
              name: "SDN 1",
              address: "Jl. B",
              phone: "082",
              province: { id: 1, name: "Jawa Barat" },
              city: { id: 2, name: "Bandung" },
            },
            classes: [{ id: 10, name: "1A" }],
          },
        ],
      },
    });
  });

  it("edge: skips the classes follow-up query entirely when the teacher page is empty", async () => {
    const req = { query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ total: 0 }], []]).mockResolvedValueOnce([[], []]);

    await getTeachers(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe("createTeacher", () => {
  it("guard: 404 when the caller has no institution", async () => {
    const req = { user: { id: "admin-id" }, body: { classId: 1, username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no institution row

    await createTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Institusi tidak ditemukan", error: 404 });
  });

  it("guard: requires classId to be present", async () => {
    const req = { user: { id: "admin-id" }, body: { username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ id: 5 }], []]);

    await createTeacher(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "ID kelas harus disertakan", error: null });
  });

  it("guard: class already has a teacher_id", async () => {
    const req = { user: { id: "admin-id" }, body: { classId: 1, username: "u", email: "e", password: "p" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, teacher_id: "existing-teacher" }], []]);

    await createTeacher(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Kelas sudah memiliki wali kelas", error: null });
  });

  it("links a NEW teacher record to an existing userless-teacher user, but the response omits `data` (preserved bug)", async () => {
    randomUUID.mockReturnValueOnce("teacher-id-1");
    const req = {
      user: { id: "admin-id" },
      body: { classId: 1, username: "existing", email: "existing@x.com", fullName: "Mr. Budi", role: "Wali 1A", address: "Jl. C", phone: "083", password: "p" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []]) // institution
      .mockResolvedValueOnce([[{ id: 1, teacher_id: null }], []]) // class exists, no teacher yet
      .mockResolvedValueOnce([[{ id: "existing-user-id", username: "existing", email: "existing@x.com" }], []]) // existing user
      .mockResolvedValueOnce([[], []]) // that user has no teacher row yet
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT INTO teachers
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE classes teacher_id

    await createTeacher(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO teachers"),
      ["teacher-id-1", "Mr. Budi", "Wali 1A", "Jl. C", "083", 5, "existing-user-id"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(6, expect.stringContaining("UPDATE classes SET teacher_id = ?"), ["teacher-id-1", 1]);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menambahkan wali kelas",
      data: undefined,
    });
  });

  it("guard: existing user that already has a teacher record", async () => {
    const req = {
      user: { id: "admin-id" },
      body: { classId: 1, username: "existing", email: "existing@x.com", password: "p" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, teacher_id: null }], []])
      .mockResolvedValueOnce([[{ id: "existing-user-id" }], []])
      .mockResolvedValueOnce([[{ id: "already-a-teacher" }], []]);

    await createTeacher(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Username atau email sudah digunakan", error: null });
  });

  it("creates a brand new user + teacher and links the class when no existing user matches", async () => {
    randomUUID.mockReturnValueOnce("user-id-1").mockReturnValueOnce("teacher-id-1");
    const req = {
      user: { id: "admin-id" },
      body: {
        classId: 1,
        username: "newteacher",
        email: "new@x.com",
        password: "plain",
        role_id: 4,
        fullName: "Ms. Citra",
        role: "Wali 2A",
        address: "Jl. D",
        phone: "084",
      },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 5 }], []])
      .mockResolvedValueOnce([[{ id: 1, teacher_id: null }], []])
      .mockResolvedValueOnce([[], []]) // no existing user
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT INTO users
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT INTO teachers
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE classes
      .mockResolvedValueOnce([[{ id: "user-id-1", username: "newteacher", email: "new@x.com", role_id: 4 }], []]) // reselect user
      .mockResolvedValueOnce([[{ id: "teacher-id-1", fullName: "Ms. Citra" }], []]); // reselect teacher

    await createTeacher(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO users"),
      ["user-id-1", "newteacher", "new@x.com", "hashed-password", 4]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO teachers"),
      ["teacher-id-1", "Ms. Citra", "Wali 2A", "Jl. D", "084", 5, "user-id-1"]
    );
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Berhasil menambahkan wali kelas",
      data: { id: "user-id-1", username: "newteacher", email: "new@x.com", role_id: 4, teacher: { id: "teacher-id-1", fullName: "Ms. Citra" } },
    });
  });
});

describe("updateTeacher", () => {
  it("nulls the old class then assigns the class named by `role` to this teacher", async () => {
    const req = { params: { id: "t1" }, body: { role: "2A", address: "Jl. E", phone: "085" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "t1" }], []]) // existing teacher
      .mockResolvedValueOnce([[{ id: 1 }], []]) // old class
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // null out old class
      .mockResolvedValueOnce([[{ id: 2, name: "2A" }], []]) // new class found by name
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // assign new class
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE teachers
      .mockResolvedValueOnce([[{ id: "t1", role: "2A", address: "Jl. E", phone: "085" }], []]); // reselect

    await updateTeacher(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("UPDATE classes SET teacher_id = ?"), [null, 1]);
    expect(pool.query).toHaveBeenNthCalledWith(4, expect.stringContaining("SELECT * FROM classes WHERE name = ?"), ["2A"]);
    expect(pool.query).toHaveBeenNthCalledWith(5, expect.stringContaining("UPDATE classes SET teacher_id = ?"), ["t1", 2]);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Guru berhasil diperbarui",
      data: { id: "t1", role: "2A", address: "Jl. E", phone: "085" },
    });
  });

  it("edge: skips nulling out when the teacher has no old class", async () => {
    const req = { params: { id: "t1" }, body: { role: "2A", address: "Jl. E", phone: "085" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "t1" }], []])
      .mockResolvedValueOnce([[], []]) // no old class
      .mockResolvedValueOnce([[{ id: 2, name: "2A" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: "t1" }], []]);

    await updateTeacher(req, res);

    expect(pool.query).toHaveBeenCalledTimes(6);
  });

  it("guard: teacher not found (404-as-500 preserved)", async () => {
    const req = { params: { id: "missing" }, body: { role: "2A" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await updateTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Guru tidak ditemukan", error: 404 });
  });

  it("guard: target class named by `role` does not exist", async () => {
    const req = { params: { id: "t1" }, body: { role: "Nonexistent" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "t1" }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]); // class named "Nonexistent" not found

    await updateTeacher(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Kelas baru tidak ditemukan", error: 404 });
  });
});

describe("deleteTeacher", () => {
  it("deletes the linked users row, which cascades to remove the teacher", async () => {
    const req = { params: { id: "t1" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "t1", user_id: "u1" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await deleteTeacher(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining("DELETE FROM users WHERE id = ?"), ["u1"]);
    expect(res.json).toHaveBeenCalledWith({ status: "success", message: "Guru berhasil dihapus", data: null });
  });

  it("bug: reports success without deleting anything when the teacher has no linked user_id", async () => {
    const req = { params: { id: "t1" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[{ id: "t1", user_id: null }], []]);

    await deleteTeacher(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ status: "success", message: "Guru berhasil dihapus", data: null });
  });

  it("guard: teacher not found (404-as-500 preserved)", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await deleteTeacher(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ status: "error", message: "Guru tidak ditemukan", error: 404 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/controllers/__tests__/TeacherController.test.js`
Expected: FAIL — current implementation still calls `prisma.teacher.*` / `prisma.user.*` / `prisma.class.*`.

- [ ] **Step 3: Rewrite `src/controllers/TeacherController.js` against raw mysql2**

```js
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

export const getTeachers = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const offset = limit * page;

  try {
    const likeParam = `%${search}%`;
    const [[countRows], [teacherRows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM teachers WHERE fullName LIKE ? OR role LIKE ?`, [likeParam, likeParam]),
      pool.query(
        `SELECT
           t.id, t.fullName, t.role, t.address, t.phone,
           u.id AS user_id, u.username AS user_username, u.email AS user_email,
           i.id AS institution_id, i.name AS institution_name, i.address AS institution_address, i.phone AS institution_phone,
           p.id AS province_id, p.name AS province_name,
           c.id AS city_id, c.name AS city_name
         FROM teachers t
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN institutions i ON i.id = t.school_id
         LEFT JOIN provinces p ON p.id = i.province_id
         LEFT JOIN cities c ON c.id = i.city_id
         WHERE t.fullName LIKE ? OR t.role LIKE ?
         ORDER BY t.id DESC
         LIMIT ? OFFSET ?`,
        [likeParam, likeParam, limit, offset]
      ),
    ]);

    const totalRows = countRows[0].total;
    const totalPage = Math.ceil(totalRows / limit);

    const teacherIds = teacherRows.map((row) => row.id);
    let classesByTeacher = {};
    if (teacherIds.length > 0) {
      const [classRows] = await pool.query(`SELECT id, name, teacher_id FROM classes WHERE teacher_id IN (?)`, [teacherIds]);
      classesByTeacher = classRows.reduce((acc, cls) => {
        if (!acc[cls.teacher_id]) acc[cls.teacher_id] = [];
        acc[cls.teacher_id].push({ id: cls.id, name: cls.name });
        return acc;
      }, {});
    }

    const teachers = teacherRows.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      role: row.role,
      address: row.address,
      phone: row.phone,
      user: row.user_id ? { id: row.user_id, username: row.user_username, email: row.user_email } : null,
      institution: row.institution_id
        ? {
            id: row.institution_id,
            name: row.institution_name,
            address: row.institution_address,
            phone: row.institution_phone,
            province: row.province_id ? { id: row.province_id, name: row.province_name } : null,
            city: row.city_id ? { id: row.city_id, name: row.city_name } : null,
          }
        : null,
      classes: classesByTeacher[row.id] || [],
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, teachers },
      "Teachers retrieved successfully"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to retrieve teachers");
  }
};

export const createTeacher = async (req, res) => {
  const { username, email, password, role_id, fullName, role, classId, address, phone } = req.body;

  const hashPassword = await argon2.hash(password);

  try {
    const user = req.user;
    const [institutionRows] = await pool.query(`SELECT * FROM institutions WHERE user_id = ? LIMIT 1`, [user.id]);
    const institution = institutionRows[0];

    if (!institution) {
      return errorResponse(res, 404, "Institusi tidak ditemukan");
    }

    if (classId) {
      const [classRows] = await pool.query(`SELECT * FROM classes WHERE id = ? LIMIT 1`, [classId]);
      const existingClass = classRows[0];

      if (!existingClass) {
        return errorResponse(res, null, "Kelas tidak ditemukan");
      }

      if (existingClass.teacher_id) {
        return errorResponse(res, null, "Kelas sudah memiliki wali kelas");
      }
    } else {
      return errorResponse(res, null, "ID kelas harus disertakan");
    }

    const [existingUserRows] = await pool.query(`SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1`, [
      username,
      email,
    ]);
    const existingUser = existingUserRows[0];

    if (existingUser) {
      const [existingTeacherRows] = await pool.query(`SELECT id FROM teachers WHERE user_id = ? LIMIT 1`, [existingUser.id]);
      if (existingTeacherRows[0]) {
        return errorResponse(res, null, "Username atau email sudah digunakan");
      }

      const teacherId = randomUUID();
      await pool.query(
        `INSERT INTO teachers (id, fullName, role, address, phone, school_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [teacherId, fullName, role, address, phone, institution.id, existingUser.id]
      );

      await pool.query(`UPDATE classes SET teacher_id = ? WHERE id = ?`, [teacherId, classId]);

      // Preserved bug: the original passed the exported `updateTeacher` function
      // itself here (hoisted reference, not the local result), which
      // JSON.stringify()s to undefined — so `data` is omitted from the response.
      return successResponse(res, undefined, "Berhasil menambahkan wali kelas");
    } else {
      const userId = randomUUID();
      await pool.query(`INSERT INTO users (id, username, email, password, role_id) VALUES (?, ?, ?, ?, ?)`, [
        userId,
        username,
        email,
        hashPassword,
        role_id,
      ]);

      const teacherId = randomUUID();
      await pool.query(
        `INSERT INTO teachers (id, fullName, role, address, phone, school_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [teacherId, fullName, role, address, phone, institution.id, userId]
      );

      await pool.query(`UPDATE classes SET teacher_id = ? WHERE id = ?`, [teacherId, classId]);

      const [newUserRows] = await pool.query(`SELECT id, username, email, role_id FROM users WHERE id = ? LIMIT 1`, [userId]);
      const [newTeacherRows] = await pool.query(`SELECT * FROM teachers WHERE id = ? LIMIT 1`, [teacherId]);
      const newTeacher = { ...newUserRows[0], teacher: newTeacherRows[0] };

      return successResponse(res, newTeacher, "Berhasil menambahkan wali kelas");
    }
  } catch (error) {
    return errorResponse(res, error, "Error saat menambahkan wali kelas");
  }
};

export const updateTeacher = async (req, res) => {
  const { id } = req.params;
  const { role, address, phone } = req.body;

  try {
    const [teacherRows] = await pool.query(`SELECT * FROM teachers WHERE id = ? LIMIT 1`, [id]);
    const existingTeacher = teacherRows[0];

    if (!existingTeacher) {
      return errorResponse(res, 404, "Guru tidak ditemukan");
    }

    const [oldClassRows] = await pool.query(`SELECT * FROM classes WHERE teacher_id = ? LIMIT 1`, [id]);
    const oldClass = oldClassRows[0];

    if (oldClass) {
      await pool.query(`UPDATE classes SET teacher_id = ? WHERE id = ?`, [null, oldClass.id]);
    }

    // NOTE: `role` here doubles as the target class NAME, confusingly — preserved from the original.
    const [newClassRows] = await pool.query(`SELECT * FROM classes WHERE name = ? LIMIT 1`, [role]);
    const newClass = newClassRows[0];

    if (!newClass) {
      return errorResponse(res, 404, "Kelas baru tidak ditemukan");
    }

    await pool.query(`UPDATE classes SET teacher_id = ? WHERE id = ?`, [id, newClass.id]);

    await pool.query(`UPDATE teachers SET role = ?, address = ?, phone = ? WHERE id = ?`, [role, address, phone, id]);
    const [updatedRows] = await pool.query(`SELECT * FROM teachers WHERE id = ? LIMIT 1`, [id]);
    const updatedTeacher = updatedRows[0];

    return successResponse(res, updatedTeacher, "Guru berhasil diperbarui");
  } catch (error) {
    return errorResponse(res, error, "Error saat memperbarui guru");
  }
};

export const deleteTeacher = async (req, res) => {
  const { id } = req.params;

  try {
    const [teacherRows] = await pool.query(`SELECT * FROM teachers WHERE id = ? LIMIT 1`, [id]);
    const existingTeacher = teacherRows[0];

    if (!existingTeacher) {
      return errorResponse(res, 404, "Guru tidak ditemukan");
    }

    if (existingTeacher.user_id) {
      await pool.query(`DELETE FROM users WHERE id = ?`, [existingTeacher.user_id]);
    }

    return successResponse(res, null, "Guru berhasil dihapus");
  } catch (error) {
    return errorResponse(res, error, "Error saat menghapus teacher");
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/controllers/__tests__/TeacherController.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/TeacherController.js src/controllers/__tests__/TeacherController.test.js
git commit -m "refactor: migrate TeacherController from Prisma to raw mysql2"
```
### Task 13: FamilyController — read queries (getFamily, getFamilyMemberByUser, getFamilyMember, getParentsByFamilyMemberId)

**Context on the shared file:** `src/controllers/FamilyController.js` has 7 exported handlers. This task converts 4 of them (the pure-read ones). The other 3 (`createFamilyMember`, `updateFamilyMember`, `deleteFamilyMember`) are converted in Task 14 and Task 15. Until Task 15 finishes, the file keeps **both** `import { PrismaClient } from "@prisma/client"` / `const prisma = new PrismaClient();` (for the not-yet-converted handlers) **and** `import pool from "../config/db.js"` (for the handlers converted so far). The Prisma import is only removed in Task 15's final step, once every handler in the file uses `pool`.

**Files:**
- Modify: `src/controllers/FamilyController.js`
- Create: `src/controllers/__tests__/FamilyController.test.js`

**Interfaces:**
- Consumes `pool` (default export) from `src/config/db.js` per the project-wide pattern (`pool.query(sql, params)` → `[rows, fields]`).
- No change to exported function names/signatures (`getFamily`, `getFamilyMemberByUser`, `getFamilyMember`, `getParentsByFamilyMemberId`) or to `src/routes/FamilyRoute.js`.
- No validator exists for these routes (checked `src/routes/FamilyRoute.js` and `src/validators/` — only `AuthValidator.js` exists, unrelated), so there is no allow-list cross-check needed for this task (that concern is specific to Task 15's `updateFamilyMember`).

---

- [ ] **Step 1: Write the test file covering all 4 read handlers**

Create `src/controllers/__tests__/FamilyController.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getFamily,
  getFamilyMemberByUser,
  getFamilyMember,
  getParentsByFamilyMemberId,
} from "../FamilyController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getFamily", () => {
  it("returns families joined with user and role", async () => {
    pool.query.mockResolvedValueOnce([
      [
        {
          family_id: "family-1",
          user_id: "user-1",
          user_username: "budi",
          user_email: "budi@example.com",
          role_id: 2,
          role_name: "parent",
        },
      ],
      [],
    ]);

    const req = {};
    const res = mockRes();

    await getFamily(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("JOIN users u ON u.id = f.userId"),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Family retrieved successfully",
      data: [
        {
          id: "family-1",
          user: {
            id: "user-1",
            username: "budi",
            email: "budi@example.com",
            role: { id: 2, name: "parent" },
          },
        },
      ],
    });
  });
});

describe("getFamilyMemberByUser", () => {
  it("returns paginated family members with joined job/socioEconomic/nutrition/student data", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[{ count: 1 }], []]) // COUNT(*)
      .mockResolvedValueOnce([
        [
          {
            fm_id: "fm-1",
            fm_fullName: "Anak Satu",
            fm_birthDate: "2020-01-01",
            fm_age: null,
            fm_education: "SD",
            fm_gender: "L",
            fm_relation: "ANAK",
            fm_phone: "0800",
            fm_isCompleted: 1,
            job_id: null,
            jobType_id: null,
            jobType_name: null,
            se_id: 5,
            se_residenceStatus: "MILIK_SENDIRI",
            se_address: "Jl. Mawar",
            se_childrenCount: "SATU",
            se_underFiveCount: "TIDAK_ADA",
            se_familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
            nu_id: 9,
            nu_height: 90,
            nu_weight: 12,
            nu_bmi: 14.8,
            ns_id: 1,
            ns_information: "info",
            ns_displayName: "Gizi Baik",
            st_id: "student-1",
            st_nis: "12345",
            st_schoolYear: "2025/2026",
            st_semester: "1",
            class_id: 3,
            class_name: "Kelas 1A",
            inst_id: 7,
            inst_name: "SD Negeri 1",
            inst_email: "sdn1@example.com",
            inst_address: "Jl. Sekolah",
            inst_phone: "0811",
            itp_id: 1,
            itp_name: "Sekolah",
            prov_id: 32,
            prov_name: "Jawa Barat",
            city_id: 320,
            city_name: "Bandung",
          },
        ],
        [],
      ]); // main JOIN query

    const req = {
      query: { page: "0", limit: "10", search: "" },
      user: { id: "user-1" },
    };
    const res = mockRes();

    await getFamilyMemberByUser(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM families WHERE userId = ?"),
      ["user-1"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("family_members WHERE familyId IN (?)"),
      [["family-1"], "%%"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("JOIN socio_economic se ON se.id = fm.socioEconomicId"),
      [["family-1"], "%%"],
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.totalRows).toBe(1);
    expect(body.data.familyMembers[0]).toEqual({
      id: "fm-1",
      fullName: "Anak Satu",
      birthDate: "2020-01-01",
      age: null,
      education: "SD",
      gender: "L",
      relation: "ANAK",
      phone: "0800",
      job: null,
      SocioEconomic: {
        id: 5,
        residenceStatus: "MILIK_SENDIRI",
        address: "Jl. Mawar",
        childrenCount: "SATU",
        underFiveCount: "TIDAK_ADA",
        familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
      },
      nutrition: [
        {
          id: 9,
          height: 90,
          weight: 12,
          bmi: 14.8,
          nutritionStatus: { id: 1, information: "info", displayName: "Gizi Baik" },
        },
      ],
      student: {
        id: "student-1",
        nis: "12345",
        schoolYear: "2025/2026",
        semester: "1",
        class: { id: 3, name: "Kelas 1A" },
        institution: {
          id: 7,
          name: "SD Negeri 1",
          email: "sdn1@example.com",
          address: "Jl. Sekolah",
          institution_type: { id: 1, name: "Sekolah" },
          phone: "0811",
          province: { id: 32, name: "Jawa Barat" },
          city: { id: 320, name: "Bandung" },
        },
      },
      isCompleted: true,
    });
  });

  it("returns an empty result without querying family_members when the user has no families (and never hits the dead !family guard)", async () => {
    pool.query.mockResolvedValueOnce([[], []]); // families lookup returns zero rows

    const req = {
      query: {},
      user: { id: "user-with-no-family" },
    };
    const res = mockRes();

    await getFamilyMemberByUser(req, res);

    // Only the families lookup ran — the empty-familyIds guard short-circuits
    // before any IN (?) query (an empty IN() is a MySQL syntax error), and it
    // returns success (not the dead "Family not found" errorResponse, since
    // `family` is an array — always truthy — even when empty).
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "Family Member retrieved successfully",
      data: { totalRows: 0, totalPage: 0, page: 0, limit: 10, familyMembers: [] },
    });
  });
});

describe("getFamilyMember", () => {
  it("returns paginated family members ordered by id with LIMIT/OFFSET applied", async () => {
    pool.query
      .mockResolvedValueOnce([[{ count: 1 }], []])
      .mockResolvedValueOnce([
        [{ id: "fm-1", fullName: "Budi", isCompleted: 0 }],
        [],
      ]);

    const req = { query: { page: "1", limit: "5", search: "Bud" } };
    const res = mockRes();

    await getFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT COUNT(*) AS count FROM family_members WHERE fullName LIKE ?"),
      ["%Bud%"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ORDER BY id ASC LIMIT ? OFFSET ?"),
      ["%Bud%", 5, 5],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.familyMembers).toEqual([
      { id: "fm-1", fullName: "Budi", isCompleted: false },
    ]);
  });
});

describe("getParentsByFamilyMemberId", () => {
  it("returns IBU/AYAH parents for the family member's family", async () => {
    pool.query
      .mockResolvedValueOnce([[{ familyId: "family-1" }], []])
      .mockResolvedValueOnce([
        [
          {
            fm_id: "parent-1",
            fm_fullName: "Ibu Satu",
            fm_birthDate: "1990-01-01",
            fm_age: 34,
            fm_education: "S1",
            fm_phone: "0800",
            job_id: 2,
            jobType_id: 3,
            jobType_name: "ASN",
            se_id: 5,
            se_residenceStatus: "MILIK_SENDIRI",
            se_address: "Jl. Mawar",
            se_childrenCount: "SATU",
            se_underFiveCount: "TIDAK_ADA",
            se_familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
          },
        ],
        [],
      ]);

    const req = { params: { id: "child-1" } };
    const res = mockRes();

    await getParentsByFamilyMemberId(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT familyId FROM family_members WHERE id = ?"),
      ["child-1"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("fm.relation = 'AYAH' OR fm.relation = 'IBU'"),
      ["family-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data[0]).toEqual({
      id: "parent-1",
      fullName: "Ibu Satu",
      birthDate: "1990-01-01",
      age: 34,
      education: "S1",
      phone: "0800",
      job: { id: 2, jobType: { id: 3, name: "ASN" } },
      SocioEconomic: {
        id: 5,
        residenceStatus: "MILIK_SENDIRI",
        address: "Jl. Mawar",
        childrenCount: "SATU",
        underFiveCount: "TIDAK_ADA",
        familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
      },
    });
  });

  it("returns 'Family member not found' when the member does not exist", async () => {
    pool.query.mockResolvedValueOnce([[], []]);

    const req = { params: { id: "missing-id" } };
    const res = mockRes();

    await getParentsByFamilyMemberId(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family member not found",
      error: null,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/FamilyController.test.js`
Expected: FAIL — `pool.query` is never called because the handlers still call `prisma.*`; assertions on `pool.query` call counts/args fail (0 calls recorded).

- [ ] **Step 3: Convert the 4 read handlers to raw SQL**

In `src/controllers/FamilyController.js`, add the pool import alongside the existing Prisma import (top of file, currently lines 1-4):

```js
import { PrismaClient } from "@prisma/client";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();
```

Replace `getFamily` (originally lines 6-30) with:

```js
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
```

Replace `getFamilyMemberByUser` (originally lines 32-178) with:

```js
export const getFamilyMemberByUser = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
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
```

Replace `getFamilyMember` (originally lines 180-216) with:

```js
export const getFamilyMember = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
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
```

Replace `getParentsByFamilyMemberId` (originally lines 218-323, including the dead commented-out Prisma block at the end — dropped as inert unreachable code) with:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/FamilyController.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/FamilyController.js src/controllers/__tests__/FamilyController.test.js
git commit -m "test: convert FamilyController read handlers to raw mysql2 queries"
```

---

### Task 14: FamilyController — createFamilyMember (ibu/ayah/anak upsert branches)

**Files:**
- Modify: `src/controllers/FamilyController.js`
- Modify: `src/controllers/__tests__/FamilyController.test.js`

**Interfaces:**
- Adds `import { randomUUID } from "node:crypto"` to `FamilyController.js` — first use of the String-PK UUID convention in this file (`FamilyMember.id`, `Student.id`).
- `SocioEconomic` (autoincrement Int PK) uses `result.insertId`; `Job` (autoincrement Int PK) likewise.
- Test file gains a `vi.mock("node:crypto", ...)` so generated ids are deterministic and assertable (added once, reused by Task 15 too).
- No transactions: the whole function stays a non-atomic sequential-write loop that pushes `{ error, member }` and `continue`s on recoverable failure, exactly as the Prisma version did.

---

- [ ] **Step 1: Extend the test file's shared setup with a deterministic `randomUUID` mock**

Edit `src/controllers/__tests__/FamilyController.test.js`. Add the crypto mock right after the existing `db.js` mock, and extend the shared `beforeEach` to reset a counter-based implementation:

```js
vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(),
}));

import pool from "../../config/db.js";
import { randomUUID } from "node:crypto";
import {
  getFamily,
  getFamilyMemberByUser,
  getFamilyMember,
  getParentsByFamilyMemberId,
  createFamilyMember,
} from "../FamilyController.js";
```

Replace the existing `beforeEach` block with:

```js
let uuidCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  randomUUID.mockImplementation(() => `uuid-${++uuidCounter}`);
});
```

- [ ] **Step 2: Write the failing tests for `createFamilyMember`**

Append to `src/controllers/__tests__/FamilyController.test.js`:

```js
describe("createFamilyMember", () => {
  it("returns 'Family not found' when the caller has no family yet", async () => {
    pool.query.mockResolvedValueOnce([[], []]); // families lookup, empty

    const req = {
      user: { id: "user-1" },
      body: [{ type: "ibu", relation: "IBU" }],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family not found",
      error: null,
    });
  });

  it("creates a new ibu member with a new socio_economic row and a new job row", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup (none yet)
      .mockResolvedValueOnce([{ insertId: 10 }]) // INSERT socio_economic
      .mockResolvedValueOnce([{ insertId: 20 }]) // INSERT jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT family_members

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "ibu",
          fullName: "Ibu Satu",
          age: "30",
          education: "S1",
          jobTypeId: 2,
          relation: "IBU",
          phone: "0800",
          residenceStatus: "MILIK_SENDIRI",
          address: "Jl. Mawar",
          childrenCount: "SATU",
          underFiveCount: "TIDAK_ADA",
          familyIncomeLevel: "LEBIH_DARI_SEPULUH_JUTA",
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE fm.familyId = ? AND fm.relation = ?"),
      ["family-1", "IBU"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO socio_economic"),
      ["MILIK_SENDIRI", "Jl. Mawar", "SATU", "TIDAK_ADA", "LEBIH_DARI_SEPULUH_JUTA"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO jobs (jobTypeId) VALUES (?)"),
      [2],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO family_members"),
      ["uuid-1", "Ibu Satu", 30, "S1", "IBU", "family-1", "0800", 20, 10, true],
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data[0].familyMember).toEqual({
      id: "uuid-1",
      fullName: "Ibu Satu",
      age: 30,
      education: "S1",
      relation: "IBU",
      familyId: "family-1",
      phone: "0800",
      jobId: 20,
      socioEconomicId: 10,
      isCompleted: true,
    });
  });

  it("updates an existing ibu member and reuses/updates the existing job row", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([
        [{ id: "existing-fm-1", job_id: 99, job_jobTypeId: 5 }],
        [],
      ]) // existingFamilyMember lookup (found, has a job)
      .mockResolvedValueOnce([{ insertId: 11 }]) // INSERT socio_economic (still created fresh for ibu)
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE family_members

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "ibu",
          fullName: "Ibu Satu Updated",
          age: "31",
          education: "S2",
          jobTypeId: 6,
          relation: "IBU",
          phone: "0801",
          residenceStatus: "MENYEWA",
          address: "Jl. Melati",
          childrenCount: "DUA_SAMPAI_TIGA",
          underFiveCount: "SATU",
          familyIncomeLevel: "KURANG_DARI_LIMA_JUTA",
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("UPDATE jobs SET jobTypeId = ? WHERE id = ?"),
      [6, 99],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("UPDATE family_members"),
      [
        "Ibu Satu Updated",
        31,
        "S2",
        "IBU",
        "family-1",
        "0801",
        99,
        11,
        true,
        "existing-fm-1",
      ],
    );

    const body = res.json.mock.calls[0][0];
    expect(body.data[0].familyMember.id).toBe("existing-fm-1");
    expect(body.data[0].familyMember.jobId).toBe(99);
  });

  it("creates an ayah member with sameSocioEconomic reusing the IBU's socioEconomicId", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup (none)
      .mockResolvedValueOnce([[{ socioEconomicId: 10 }], []]) // IBU lookup
      .mockResolvedValueOnce([{ insertId: 21 }]) // INSERT jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT family_members

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "ayah",
          fullName: "Ayah Satu",
          age: "35",
          education: "S1",
          jobTypeId: 3,
          relation: "AYAH",
          phone: "0802",
          sameSocioEconomic: true,
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("relation = 'IBU'"),
      ["family-1"],
    );
    // No socio_economic INSERT should run when sameSocioEconomic reuses IBU's id.
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO socio_economic"),
      expect.anything(),
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO family_members"),
      ["uuid-1", "Ayah Satu", 35, "S1", "AYAH", "family-1", "0802", 21, 10, true],
    );

    const body = res.json.mock.calls[0][0];
    expect(body.data[0].familyMember.socioEconomicId).toBe(10);
  });

  it("pushes an error and continues when sameSocioEconomic is set but no IBU exists yet", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup for ayah (none)
      .mockResolvedValueOnce([[], []]) // IBU lookup — not found
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup for the 2nd member (invalid type)
      ;

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "ayah",
          relation: "AYAH",
          sameSocioEconomic: true,
        },
        {
          type: "unknown-type",
          relation: "LAINNYA",
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    // The loop must continue to the 2nd member instead of aborting.
    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe(
      "Data ibu tidak ditemukan, isi data ibu terlebih dahulu",
    );
    expect(body.error.errors).toEqual([
      {
        error: "Data ibu tidak ditemukan, isi data ibu terlebih dahulu",
        member: req.body[0],
      },
      { error: "Invalid type", member: req.body[1] },
    ]);
  });

  it("creates an anak member with bmi/nutrition/student rows derived from bmi_references", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families lookup
      .mockResolvedValueOnce([[], []]) // existingFamilyMember lookup (none)
      .mockResolvedValueOnce([
        [{ sdMinus2Min: 14, sdPlus1Max: 20 }],
        [],
      ]) // bmi_references lookup
      .mockResolvedValueOnce([[{ id: 1, status: "GIZI_BAIK" }], []]) // nutrition_status lookup
      .mockResolvedValueOnce([[{ socioEconomicId: 10 }], []]) // parent lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT family_members
      .mockResolvedValueOnce([[], []]) // existingStudent lookup (none)
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT students
      .mockResolvedValueOnce([[], []]) // existingNutrition lookup (none)
      .mockResolvedValueOnce([{ insertId: 55 }]); // INSERT nutritions

    const req = {
      user: { id: "user-1" },
      body: [
        {
          type: "anak",
          fullName: "Anak Satu",
          birthDate: "2020-01-01",
          education: "TIDAK_SEKOLAH",
          gender: "L",
          relation: "ANAK",
          phone: "0803",
          height: "90",
          weight: "13",
          nis: "12345",
          schoolYear: "2025/2026",
          semester: "1",
          schoolId: 7,
          classId: 3,
        },
      ],
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("FROM bmi_references WHERE gender = ?"),
      expect.arrayContaining(["L"]),
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("INSERT INTO family_members"),
      expect.arrayContaining(["uuid-1", "Anak Satu", "TIDAK_SEKOLAH", "L", "ANAK", "family-1", "0803", 10, true]),
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      8,
      expect.stringContaining("INSERT INTO students"),
      ["uuid-2", "12345", "2025/2026", "1", 7, 3, "uuid-1"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      10,
      expect.stringContaining("INSERT INTO nutritions"),
      [90, 13, expect.closeTo(16.05, 1), 1, "uuid-1", "user-1"],
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data[0].student.id).toBe("uuid-2");
    expect(body.data[0].nutrition.id).toBe(55);
  });

  it("pushes an error when no bmi_references match the child's age", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([[], []]) // existingFamilyMember
      .mockResolvedValueOnce([[], []]); // bmi_references — no match

    const req = {
      user: { id: "user-1" },
      body: {
        type: "anak",
        birthDate: "2020-01-01",
        gender: "L",
        relation: "ANAK",
        height: "90",
        weight: "13",
      },
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Referensi BMI tidak ditemukan untuk usia anak ini");
  });

  it("pushes an error when neither parent has a socioEconomicId yet", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([[], []]) // existingFamilyMember
      .mockResolvedValueOnce([[{ sdMinus2Min: 14, sdPlus1Max: 20 }], []]) // bmi_references
      .mockResolvedValueOnce([[{ id: 1, status: "GIZI_BAIK" }], []]) // nutrition_status
      .mockResolvedValueOnce([[], []]); // parent lookup — none found

    const req = {
      user: { id: "user-1" },
      body: {
        type: "anak",
        birthDate: "2020-01-01",
        gender: "L",
        relation: "ANAK",
        height: "90",
        weight: "13",
      },
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Data orang tua tidak ditemukan");
  });

  it("pushes an 'Invalid type' error for unrecognized member types", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([[], []]); // existingFamilyMember lookup still runs before the type check

    const req = {
      user: { id: "user-1" },
      body: { type: "kakek", relation: "LAINNYA" },
    };
    const res = mockRes();

    await createFamilyMember(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Invalid type");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/FamilyController.test.js`
Expected: FAIL on every `createFamilyMember` test — `pool.query` is not called (handler still uses `prisma.*`).

- [ ] **Step 4: Convert `createFamilyMember` to raw SQL**

Add the crypto import near the top of `src/controllers/FamilyController.js` (alongside the pool import added in Task 13):

```js
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();
```

Replace `createFamilyMember` (originally lines 325-702) with:

```js
export const createFamilyMember = async (req, res) => {
  try {
    const user = req.user;
    let members = req.body;

    if (!Array.isArray(members)) {
      members = [members];
    }

    const [familyByUserRows] = await pool.query(
      "SELECT * FROM families WHERE userId = ? LIMIT 1",
      [user.id],
    );
    const familyByUser = familyByUserRows[0];

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

      const [existingRows] = await pool.query(
        `SELECT fm.id, job.id AS job_id, job.jobTypeId AS job_jobTypeId
         FROM family_members fm
         LEFT JOIN jobs job ON job.id = fm.jobId
         WHERE fm.familyId = ? AND fm.relation = ?
         LIMIT 1`,
        [familyByUser.id, relation],
      );
      const existingRow = existingRows[0];
      const existingFamilyMember = existingRow
        ? {
            id: existingRow.id,
            job: existingRow.job_id
              ? { id: existingRow.job_id, jobTypeId: existingRow.job_jobTypeId }
              : null,
          }
        : null;

      if (type === "ibu") {
        const [seResult] = await pool.query(
          "INSERT INTO socio_economic (residenceStatus, address, childrenCount, underFiveCount, familyIncomeLevel) VALUES (?, ?, ?, ?, ?)",
          [residenceStatus, address, childrenCount, underFiveCount, familyIncomeLevel],
        );
        socioEconomic = {
          id: seResult.insertId,
          residenceStatus,
          address,
          childrenCount,
          underFiveCount,
          familyIncomeLevel,
        };

        if (existingFamilyMember && existingFamilyMember.job) {
          await pool.query("UPDATE jobs SET jobTypeId = ? WHERE id = ?", [
            jobTypeId,
            existingFamilyMember.job.id,
          ]);
          job = { id: existingFamilyMember.job.id, jobTypeId };
        } else {
          const [jobResult] = await pool.query(
            "INSERT INTO jobs (jobTypeId) VALUES (?)",
            [jobTypeId],
          );
          job = { id: jobResult.insertId, jobTypeId };
        }

        if (!job || !job.id) {
          results.push({ error: "Job gagal dibuat", member });
          continue;
        }

        if (existingFamilyMember) {
          await pool.query(
            `UPDATE family_members
             SET fullName = ?, age = ?, education = ?, relation = ?, familyId = ?, phone = ?, jobId = ?, socioEconomicId = ?, isCompleted = ?
             WHERE id = ?`,
            [
              fullName,
              age ? parseInt(age) : null,
              education,
              relation,
              familyByUser.id,
              phone,
              job.id,
              socioEconomic.id,
              true,
              existingFamilyMember.id,
            ],
          );
          familyMember = {
            id: existingFamilyMember.id,
            fullName,
            age: age ? parseInt(age) : null,
            education,
            relation,
            familyId: familyByUser.id,
            phone,
            jobId: job.id,
            socioEconomicId: socioEconomic.id,
            isCompleted: true,
          };
        } else {
          const newId = randomUUID();
          await pool.query(
            `INSERT INTO family_members
               (id, fullName, age, education, relation, familyId, phone, jobId, socioEconomicId, isCompleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              newId,
              fullName,
              age ? parseInt(age) : null,
              education,
              relation,
              familyByUser.id,
              phone,
              job.id,
              socioEconomic.id,
              true,
            ],
          );
          familyMember = {
            id: newId,
            fullName,
            age: age ? parseInt(age) : null,
            education,
            relation,
            familyId: familyByUser.id,
            phone,
            jobId: job.id,
            socioEconomicId: socioEconomic.id,
            isCompleted: true,
          };
        }
      } else if (type === "ayah") {
        let socioEconomicId;

        if (sameSocioEconomic) {
          const [ibuRows] = await pool.query(
            "SELECT socioEconomicId FROM family_members WHERE familyId = ? AND relation = 'IBU' LIMIT 1",
            [familyByUser.id],
          );
          const ibu = ibuRows[0];

          if (!ibu || !ibu.socioEconomicId) {
            results.push({
              error: "Data ibu tidak ditemukan, isi data ibu terlebih dahulu",
              member,
            });
            continue;
          }

          socioEconomicId = ibu.socioEconomicId;
        } else {
          const [seResult] = await pool.query(
            "INSERT INTO socio_economic (residenceStatus, address, childrenCount, underFiveCount, familyIncomeLevel) VALUES (?, ?, ?, ?, ?)",
            [residenceStatus, address, childrenCount, underFiveCount, familyIncomeLevel],
          );
          socioEconomic = {
            id: seResult.insertId,
            residenceStatus,
            address,
            childrenCount,
            underFiveCount,
            familyIncomeLevel,
          };
          socioEconomicId = socioEconomic.id;
        }

        if (existingFamilyMember && existingFamilyMember.job) {
          await pool.query("UPDATE jobs SET jobTypeId = ? WHERE id = ?", [
            jobTypeId,
            existingFamilyMember.job.id,
          ]);
          job = { id: existingFamilyMember.job.id, jobTypeId };
        } else {
          const [jobResult] = await pool.query(
            "INSERT INTO jobs (jobTypeId) VALUES (?)",
            [jobTypeId],
          );
          job = { id: jobResult.insertId, jobTypeId };
        }

        if (!job || !job.id) {
          results.push({ error: "Job gagal dibuat", member });
          continue;
        }

        if (existingFamilyMember) {
          await pool.query(
            `UPDATE family_members
             SET fullName = ?, age = ?, education = ?, relation = ?, familyId = ?, phone = ?, jobId = ?, socioEconomicId = ?, isCompleted = ?
             WHERE id = ?`,
            [
              fullName,
              age ? parseInt(age) : null,
              education,
              relation,
              familyByUser.id,
              phone,
              job.id,
              socioEconomicId,
              true,
              existingFamilyMember.id,
            ],
          );
          familyMember = {
            id: existingFamilyMember.id,
            fullName,
            age: age ? parseInt(age) : null,
            education,
            relation,
            familyId: familyByUser.id,
            phone,
            jobId: job.id,
            socioEconomicId,
            isCompleted: true,
          };
        } else {
          const newId = randomUUID();
          await pool.query(
            `INSERT INTO family_members
               (id, fullName, age, education, relation, familyId, phone, jobId, socioEconomicId, isCompleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              newId,
              fullName,
              age ? parseInt(age) : null,
              education,
              relation,
              familyByUser.id,
              phone,
              job.id,
              socioEconomicId,
              true,
            ],
          );
          familyMember = {
            id: newId,
            fullName,
            age: age ? parseInt(age) : null,
            education,
            relation,
            familyId: familyByUser.id,
            phone,
            jobId: job.id,
            socioEconomicId,
            isCompleted: true,
          };
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

        const [bmiRefRows] = await pool.query(
          "SELECT * FROM bmi_references WHERE gender = ? AND ageYear = ? AND ageMonthFrom <= ? AND ageMonthTo >= ? LIMIT 1",
          [gender, ageYear, ageMonthRemainder, ageMonthRemainder],
        );
        const bmiRef = bmiRefRows[0];

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

        const [nutritionStatusRows] = await pool.query(
          "SELECT * FROM nutrition_status WHERE status = ? LIMIT 1",
          [nutritionStatusEnum],
        );
        const nutritionStatusRecord = nutritionStatusRows[0];

        if (!nutritionStatusRecord) {
          results.push({
            error: "Nutrition status not found",
            member,
          });
          continue;
        }

        const [parentRows] = await pool.query(
          "SELECT socioEconomicId FROM family_members WHERE familyId = ? AND (relation = 'IBU' OR relation = 'AYAH') LIMIT 1",
          [familyByUser.id],
        );
        parent = parentRows[0];

        if (!parent || !parent.socioEconomicId) {
          results.push({
            error: "Data orang tua tidak ditemukan",
            member,
          });
          continue;
        }

        if (existingFamilyMember) {
          await pool.query(
            `UPDATE family_members
             SET fullName = ?, birthDate = ?, education = ?, gender = ?, relation = ?, familyId = ?, phone = ?, socioEconomicId = ?, isCompleted = ?
             WHERE id = ?`,
            [
              fullName,
              childBirthDate,
              education,
              gender,
              relation,
              familyByUser.id,
              phone,
              parent.socioEconomicId,
              true,
              existingFamilyMember.id,
            ],
          );
          familyMember = {
            id: existingFamilyMember.id,
            fullName,
            birthDate: childBirthDate,
            education,
            gender,
            relation,
            familyId: familyByUser.id,
            phone,
            socioEconomicId: parent.socioEconomicId,
            isCompleted: true,
          };
        } else {
          const newId = randomUUID();
          await pool.query(
            `INSERT INTO family_members
               (id, fullName, birthDate, education, gender, relation, familyId, phone, socioEconomicId, isCompleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              newId,
              fullName,
              childBirthDate,
              education,
              gender,
              relation,
              familyByUser.id,
              phone,
              parent.socioEconomicId,
              true,
            ],
          );
          familyMember = {
            id: newId,
            fullName,
            birthDate: childBirthDate,
            education,
            gender,
            relation,
            familyId: familyByUser.id,
            phone,
            socioEconomicId: parent.socioEconomicId,
            isCompleted: true,
          };
        }

        const [existingStudentRows] = await pool.query(
          "SELECT * FROM students WHERE nis = ?",
          [nis],
        );
        const existingStudent = existingStudentRows[0];

        if (existingStudent) {
          await pool.query(
            "UPDATE students SET schoolYear = ?, semester = ?, schoolId = ?, classId = ?, familyMemberId = ? WHERE nis = ?",
            [schoolYear, semester, schoolId, classId, familyMember.id, nis],
          );
          student = {
            id: existingStudent.id,
            nis,
            schoolYear,
            semester,
            schoolId,
            classId,
            familyMemberId: familyMember.id,
          };
        } else {
          const newStudentId = randomUUID();
          await pool.query(
            `INSERT INTO students (id, nis, schoolYear, semester, schoolId, classId, familyMemberId)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [newStudentId, nis, schoolYear, semester, schoolId, classId, familyMember.id],
          );
          student = {
            id: newStudentId,
            nis,
            schoolYear,
            semester,
            schoolId,
            classId,
            familyMemberId: familyMember.id,
          };
        }

        const [existingNutritionRows] = await pool.query(
          "SELECT * FROM nutritions WHERE familyMemberId = ? LIMIT 1",
          [familyMember.id],
        );
        const existingNutrition = existingNutritionRows[0];

        if (existingNutrition) {
          await pool.query(
            "UPDATE nutritions SET height = ?, weight = ?, bmi = ?, nutritionStatusId = ? WHERE id = ?",
            [
              Number(height),
              Number(weight),
              calculateBMI,
              nutritionStatusRecord.id,
              existingNutrition.id,
            ],
          );
          nutrition = {
            id: existingNutrition.id,
            height: Number(height),
            weight: Number(weight),
            bmi: calculateBMI,
            nutritionStatusId: nutritionStatusRecord.id,
          };
        } else {
          const [nutritionResult] = await pool.query(
            `INSERT INTO nutritions (height, weight, bmi, nutritionStatusId, familyMemberId, createdBy)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              Number(height),
              Number(weight),
              calculateBMI,
              nutritionStatusRecord.id,
              familyMember.id,
              user.id,
            ],
          );
          nutrition = {
            id: nutritionResult.insertId,
            height: Number(height),
            weight: Number(weight),
            bmi: calculateBMI,
            nutritionStatusId: nutritionStatusRecord.id,
            familyMemberId: familyMember.id,
            createdBy: user.id,
          };
        }
      } else {
        results.push({ error: "Invalid type", member });
        continue;
      }

      results.push({ job, socioEconomic, familyMember, nutrition, student });
    }

    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      return errorResponse(res, { results, errors }, errors[0].error);
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/FamilyController.test.js`
Expected: PASS (all `createFamilyMember` tests, 15 total in the file so far).

- [ ] **Step 6: Commit**

```bash
git add src/controllers/FamilyController.js src/controllers/__tests__/FamilyController.test.js
git commit -m "test: convert FamilyController.createFamilyMember to raw mysql2 queries"
```

---

### Task 15: FamilyController — updateFamilyMember (allow-list security fix) + deleteFamilyMember

**Files:**
- Modify: `src/controllers/FamilyController.js`
- Modify: `src/controllers/__tests__/FamilyController.test.js`

**Interfaces:**
- Introduces `const ALLOWED_FAMILY_MEMBER_FIELDS = [...]` at module scope in `FamilyController.js` — the column allow-list for the dynamic `UPDATE family_members SET ...` built from `req.body`. This is a genuine behavior hardening versus the original Prisma code (which spread `req.body` into `data` and relied on Prisma's schema to reject unknown fields); a raw SQL string-interpolated column list has no such protection, so the allow-list is mandatory here, not optional preservation.
- Checked `src/routes/FamilyRoute.js` (no body-shape middleware on `PUT /families/:id`) and `src/validators/` (only `AuthValidator.js` exists, unrelated to family routes) — there is no existing validator to cross-check the allow-list against, so `ALLOWED_FAMILY_MEMBER_FIELDS` is derived directly from `family_members`' updatable columns per `prisma/schema.prisma` (excluding `id`, `createdAt`, `updatedAt`, and `isCompleted`, which the handler already manages separately/unconditionally).
- This is the last task touching this file: its final step removes `import { PrismaClient } from "@prisma/client"` and `const prisma = new PrismaClient();`, since every handler now uses `pool`.

---

- [ ] **Step 1: Write the failing tests for `updateFamilyMember` and `deleteFamilyMember`**

Append to `src/controllers/__tests__/FamilyController.test.js` (also add `updateFamilyMember, deleteFamilyMember` to the existing import from `"../FamilyController.js"`):

```js
describe("updateFamilyMember", () => {
  it("returns 'Family member not found' when the member does not exist", async () => {
    pool.query.mockResolvedValueOnce([[], []]);

    const req = { params: { id: "missing-id" }, body: { fullName: "New Name" } };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family member not found",
      error: null,
    });
  });

  it("updates only allow-listed fields, ignores an unrecognized column-name key (SQL injection guard), and always sets isCompleted = true", async () => {
    pool.query
      .mockResolvedValueOnce([
        [{ id: "fm-1", fullName: "Old Name", gender: "L", birthDate: null }],
        [],
      ]) // fetch familyMember + nutrition + student (both empty via LEFT JOIN => no nu_id/st_id keys)
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE family_members (allow-listed fields only)
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // final UPDATE isCompleted

    const req = {
      params: { id: "fm-1" },
      body: {
        fullName: "New Name",
        phone: "0899",
        // Attempted injection: not in ALLOWED_FAMILY_MEMBER_FIELDS, must be silently dropped.
        "id = (SELECT 1); --": "malicious",
      },
    };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const [, setSql, setParams] = pool.query.mock.calls[1];
    expect(setSql).toContain("UPDATE family_members SET");
    expect(setSql).not.toContain("id = (SELECT 1); --");
    expect(setSql).toContain("fullName = ?");
    expect(setSql).toContain("phone = ?");
    expect(setParams).toEqual(["New Name", "0899", "fm-1"]);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE family_members SET isCompleted = ? WHERE id = ?"),
      [true, "fm-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("silently ignores the request when every body key is unrecognized (no family_members SET query at all)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", fullName: "Old Name" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // only the final isCompleted UPDATE

    const req = {
      params: { id: "fm-1" },
      body: { "DROP TABLE family_members; --": "x" },
    };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET isCompleted = ?"),
      [true, "fm-1"],
    );
  });

  it("updates nutrition height/weight/bmi/nutritionStatusId when type is anak and a nutrition row exists", async () => {
    pool.query
      .mockResolvedValueOnce([
        [
          {
            id: "fm-1",
            gender: "L",
            birthDate: new Date("2020-01-01"),
            nu_id: 9,
            nu_height: 80,
            nu_weight: 10,
            nu_bmi: 15.6,
            nu_nutritionStatusId: 1,
          },
        ],
        [],
      ]) // fetch with nutrition present
      .mockResolvedValueOnce([[{ sdMinus2Min: 14, sdPlus1Max: 20 }], []]) // bmi_references
      .mockResolvedValueOnce([[{ id: 2, status: "GIZI_BAIK" }], []]) // nutrition_status
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE nutritions
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // final isCompleted UPDATE

    const req = {
      params: { id: "fm-1" },
      body: { type: "anak", height: "92", weight: "14" },
    };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM bmi_references WHERE gender = ?"),
      expect.arrayContaining(["L"]),
    );
    const [, nutritionSql, nutritionParams] = pool.query.mock.calls[3];
    expect(nutritionSql).toContain("UPDATE nutritions SET");
    expect(nutritionParams[nutritionParams.length - 1]).toBe(9);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("creates a students row when type is anak, student fields are present, and no student exists yet", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", gender: "L", birthDate: null }], []]) // fetch, no nutrition/student
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT students
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // final isCompleted UPDATE

    const req = {
      params: { id: "fm-1" },
      body: {
        type: "anak",
        nis: "999",
        schoolYear: "2025/2026",
        semester: "2",
        schoolId: 4,
        classId: 1,
      },
    };
    const res = mockRes();

    await updateFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO students"),
      ["uuid-1", "999", "2025/2026", "2", 4, 1, "fm-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("deleteFamilyMember", () => {
  it("deletes the job row then the family member when jobId is set", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", jobId: 42 }], []]) // fetch
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // DELETE jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE family_members

    const req = { params: { id: "fm-1" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("DELETE FROM jobs WHERE id = ?"),
      [42],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("DELETE FROM family_members WHERE id = ?"),
      ["fm-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("skips job deletion when jobId is null", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", jobId: null }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE family_members only

    const req = { params: { id: "fm-1" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 'Family member not found' when the member does not exist", async () => {
    pool.query.mockResolvedValueOnce([[], []]);

    const req = { params: { id: "missing-id" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family member not found",
      error: null,
    });
  });

  it("throws (replicating Prisma's P2025) when the job delete affects zero rows", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fm-1", jobId: 42 }], []])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // DELETE jobs affected nothing

    const req = { params: { id: "fm-1" } };
    const res = mockRes();

    await deleteFamilyMember(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Gagal menghapus anggota keluarga");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/FamilyController.test.js`
Expected: FAIL on every `updateFamilyMember`/`deleteFamilyMember` test — handlers still call `prisma.*`.

- [ ] **Step 3: Convert `updateFamilyMember` and `deleteFamilyMember` to raw SQL, and add the field allow-list**

Add the allow-list constant near the top of `src/controllers/FamilyController.js`, after the imports:

```js
const ALLOWED_FAMILY_MEMBER_FIELDS = [
  "fullName",
  "birthDate",
  "age",
  "education",
  "gender",
  "relation",
  "phone",
  "jobId",
  "institutionId",
  "socioEconomicId",
  "familyId",
];
```

Replace `updateFamilyMember` (originally lines 704-837) with:

```js
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

    const [rows] = await pool.query(
      `SELECT fm.*,
              nu.id AS nu_id, nu.height AS nu_height, nu.weight AS nu_weight,
              nu.bmi AS nu_bmi, nu.nutritionStatusId AS nu_nutritionStatusId,
              st.id AS st_id, st.nis AS st_nis, st.schoolYear AS st_schoolYear,
              st.semester AS st_semester, st.schoolId AS st_schoolId, st.classId AS st_classId
       FROM family_members fm
       LEFT JOIN nutritions nu ON nu.familyMemberId = fm.id
       LEFT JOIN students st ON st.familyMemberId = fm.id
       WHERE fm.id = ?`,
      [id],
    );
    const row = rows[0];

    if (!row) {
      return errorResponse(res, null, "Family member not found");
    }

    const familyMember = {
      id: row.id,
      fullName: row.fullName,
      birthDate: row.birthDate,
      age: row.age,
      education: row.education,
      jobId: row.jobId,
      gender: row.gender,
      relation: row.relation,
      familyId: row.familyId,
      institutionId: row.institutionId,
      phone: row.phone,
      isCompleted: !!row.isCompleted,
      socioEconomicId: row.socioEconomicId,
      nutrition: row.nu_id
        ? [
            {
              id: row.nu_id,
              height: row.nu_height,
              weight: row.nu_weight,
              bmi: row.nu_bmi,
              nutritionStatusId: row.nu_nutritionStatusId,
            },
          ]
        : [],
      student: row.st_id
        ? {
            id: row.st_id,
            nis: row.st_nis,
            schoolYear: row.st_schoolYear,
            semester: row.st_semester,
            schoolId: row.st_schoolId,
            classId: row.st_classId,
          }
        : null,
    };

    // SECURITY: `fields` is whatever is left of req.body after destructuring
    // out the known nutrition/student/type keys above — i.e. arbitrary,
    // caller-controlled JSON keys. The original Prisma code spread this
    // directly into `data`, relying on Prisma's generated client to reject
    // unknown columns. A raw `UPDATE ... SET ${key} = ?` has no such
    // protection: an attacker-chosen key becomes a literal column/SQL
    // fragment. Only allow-listed column names may reach the SQL string.
    const updatableKeys = Object.keys(fields).filter((key) =>
      ALLOWED_FAMILY_MEMBER_FIELDS.includes(key),
    );

    if (updatableKeys.length > 0) {
      if (fields.birthDate) fields.birthDate = new Date(fields.birthDate);
      const setClause = updatableKeys.map((key) => `${key} = ?`).join(", ");
      const params = updatableKeys.map((key) => fields[key]);
      await pool.query(`UPDATE family_members SET ${setClause} WHERE id = ?`, [
        ...params,
        id,
      ]);
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

          const [bmiRefRows] = await pool.query(
            "SELECT * FROM bmi_references WHERE gender = ? AND ageYear = ? AND ageMonthFrom <= ? AND ageMonthTo >= ? LIMIT 1",
            [familyMember.gender, ageYear, ageMonthRemainder, ageMonthRemainder],
          );
          const bmiRef = bmiRefRows[0];

          if (bmiRef) {
            let nutritionStatusEnum;
            if (bmi < bmiRef.sdMinus2Min) {
              nutritionStatusEnum = "GIZI_BURUK_KURANG";
            } else if (bmi > bmiRef.sdPlus1Max) {
              nutritionStatusEnum = "OVERWEIGHT_OBESITAS";
            } else {
              nutritionStatusEnum = "GIZI_BAIK";
            }

            const [nutritionStatusRows] = await pool.query(
              "SELECT * FROM nutrition_status WHERE status = ? LIMIT 1",
              [nutritionStatusEnum],
            );
            nutritionStatusId = nutritionStatusRows[0]?.id;
          }
        }
      }

      const nutritionFields = {};
      if (height !== undefined) nutritionFields.height = Number(height);
      if (weight !== undefined) nutritionFields.weight = Number(weight);
      if (bmi !== undefined) nutritionFields.bmi = bmi;
      if (nutritionStatusId) nutritionFields.nutritionStatusId = nutritionStatusId;

      const nutritionKeys = Object.keys(nutritionFields);
      if (nutritionKeys.length > 0) {
        const setClause = nutritionKeys.map((key) => `${key} = ?`).join(", ");
        const params = nutritionKeys.map((key) => nutritionFields[key]);
        await pool.query(`UPDATE nutritions SET ${setClause} WHERE id = ?`, [
          ...params,
          familyMember.nutrition[0].id,
        ]);
      }
    }

    if (type === "anak") {
      const studentFields = {};
      if (nis !== undefined) studentFields.nis = nis;
      if (schoolYear !== undefined) studentFields.schoolYear = schoolYear;
      if (semester !== undefined) studentFields.semester = semester;
      if (schoolId !== undefined) studentFields.schoolId = schoolId;
      if (classId !== undefined) studentFields.classId = classId;

      const studentKeys = Object.keys(studentFields);

      if (studentKeys.length > 0 && familyMember.student) {
        const setClause = studentKeys.map((key) => `${key} = ?`).join(", ");
        const params = studentKeys.map((key) => studentFields[key]);
        await pool.query(`UPDATE students SET ${setClause} WHERE id = ?`, [
          ...params,
          familyMember.student.id,
        ]);
      } else if (studentKeys.length > 0 && !familyMember.student) {
        const newStudentId = randomUUID();
        const columns = ["id", ...studentKeys, "familyMemberId"];
        const values = [
          newStudentId,
          ...studentKeys.map((key) => studentFields[key]),
          familyMember.id,
        ];
        await pool.query(
          `INSERT INTO students (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          values,
        );
      }
    }

    await pool.query("UPDATE family_members SET isCompleted = ? WHERE id = ?", [
      true,
      id,
    ]);

    return successResponse(res, null, "Berhasil mengupdate anggota keluarga");
  } catch (error) {
    return errorResponse(res, error, "Gagal mengupdate anggota keluarga");
  }
};
```

Replace `deleteFamilyMember` (originally lines 839-865) with:

```js
export const deleteFamilyMember = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      "SELECT * FROM family_members WHERE id = ?",
      [id],
    );
    const familyMember = rows[0];

    if (!familyMember) {
      return errorResponse(res, null, "Family member not found");
    }

    if (familyMember.jobId) {
      const [jobDeleteResult] = await pool.query(
        "DELETE FROM jobs WHERE id = ?",
        [familyMember.jobId],
      );
      if (jobDeleteResult.affectedRows === 0) {
        // Raw DELETE doesn't throw on a missing row the way Prisma's
        // `.delete()` does (P2025) — replicate that behavior explicitly so a
        // race (job already deleted) still surfaces as an error here.
        throw new Error("Record to delete does not exist.");
      }
    }

    const [fmDeleteResult] = await pool.query(
      "DELETE FROM family_members WHERE id = ?",
      [id],
    );
    if (fmDeleteResult.affectedRows === 0) {
      throw new Error("Record to delete does not exist.");
    }

    return successResponse(res, null, "Berhasil menghapus anggota keluarga");
  } catch (error) {
    return errorResponse(res, error, "Gagal menghapus anggota keluarga");
  }
};
```

Finally, remove the now-unused Prisma import/instance at the top of the file (this is the last handler in the file to convert):

```js
import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const ALLOWED_FAMILY_MEMBER_FIELDS = [
  "fullName",
  "birthDate",
  "age",
  "education",
  "gender",
  "relation",
  "phone",
  "jobId",
  "institutionId",
  "socioEconomicId",
  "familyId",
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/FamilyController.test.js`
Expected: PASS (all tests in the file, ~24 total across `getFamily`, `getFamilyMemberByUser`, `getFamilyMember`, `getParentsByFamilyMemberId`, `createFamilyMember`, `updateFamilyMember`, `deleteFamilyMember`).

Run: `npx vitest run` (full suite) to confirm no other test file imports `@prisma/client` through `FamilyController.js` in a way that breaks now that the import is gone.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/FamilyController.js src/controllers/__tests__/FamilyController.test.js
git commit -m "test: convert FamilyController.updateFamilyMember/deleteFamilyMember to raw mysql2 queries and allow-list update columns"
```
## `src/controllers/ResponseQuesionerController.js` conversion (Tasks 6-14)

This file has 9 exported handlers, all currently using `prisma`. Because they share
one file, the Prisma import/instantiation stays in place until the **last** handler
(`showResponseForInstitution`, Task 24) is converted — at that point it is deleted.
Every other task leaves `import { PrismaClient } from "@prisma/client";` and
`const prisma = new PrismaClient();` untouched even though nothing in the file uses
them anymore after their own handler is done — only Task 24 removes them, once no
handler references `prisma` at all.

The test file `src/controllers/__tests__/ResponseQuesionerController.test.js` is
created in Task 16 and extended (new `describe` block + updated import line) in every
subsequent task. It follows the project-wide pattern from Task 0: `vi.mock("../../config/db.js", ...)`,
a `mockRes()` helper, `beforeEach(() => vi.clearAllMocks())`, and assertions on both
the exact SQL text (`expect.stringContaining(...)`) + params passed to `pool.query`,
and the `res.status`/`res.json` shape.

Two cross-cutting behaviors apply to every handler below and are called out inline
only where a test exercises them:
- Every `errorResponse(res, 404, "...")` / `errorResponse(res, 400, "...")` /
  `errorResponse(res, 401, "...")` call passes the numeric code as `error`, not
  `statusCode` — `errorResponse`'s real signature is `(res, error, message, statusCode = 500)`
  — so these **all** resolve to HTTP 500 with `error: 404` (a number) in the JSON body.
  This is a preserved pre-existing bug; do not "fix" it by adding a real status code.
- Every `... IN (?)` query is guarded: if the id array is empty, skip the query and
  default to `0` (counts) or `[]` (rows), because `IN ()` is invalid SQL but Prisma's
  `{ in: [] }` always matches zero rows.

---

### Task 16: Convert `getResponseQuesioner`

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Create: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- `src/controllers/ResponseQuesionerController.js` gains `import pool from "../config/db.js";` (added under the existing Prisma import, which stays for the other 8 not-yet-converted handlers).
- Preserves the hardcoded `limit: 10` (not the parsed `limit` variable) in the no-response early return — a known bug, kept intentionally.
- `questions` are paginated via `LIMIT ? OFFSET ?` directly on the questions query (this handler is the one that paginates questions, unlike the Institution/parent variants which paginate answers instead).

- [ ] **Step 1: Add the `pool` import to the controller**

Edit the top of `src/controllers/ResponseQuesionerController.js`:
```js
import { PrismaClient } from "@prisma/client";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();
```

- [ ] **Step 2: Write the failing tests**

Create `src/controllers/__tests__/ResponseQuesionerController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getResponseQuesioner } from "../ResponseQuesionerController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getResponseQuesioner", () => {
  it("returns paginated questions with options and boolean-coerced answers", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ]) // family_members
      .mockResolvedValueOnce([
        [{ id: "resp-1", familyMemberId: "member-1", quisionerId: 5 }],
        [],
      ]) // responses
      .mockResolvedValueOnce([[{ count: 1 }], []]) // totalRows count
      .mockResolvedValueOnce([
        [{ id: 10, quesioner_id: 5, title: "Q1", type: "BOOLEAN" }],
        [],
      ]) // questions (paginated)
      .mockResolvedValueOnce([
        [{ id: 100, question_id: 10, title: "Yes", score: 1 }],
        [],
      ]) // options
      .mockResolvedValueOnce([
        [
          {
            id: 1000,
            questionId: 10,
            responseId: "resp-1",
            option_id: 100,
            score: 1,
            boolean_value: 1,
            scaleValue: null,
          },
          {
            id: 1001,
            questionId: 10,
            responseId: "resp-1",
            option_id: null,
            score: 0,
            boolean_value: null,
            scaleValue: null,
          },
        ],
        [],
      ]); // answers

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM families WHERE userId"),
      ["user-1"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("FROM responses WHERE familyMemberId"),
      ["member-1", 5]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("LIMIT ? OFFSET ?"),
      [5, "%%", 10, 0]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("FROM options WHERE question_id IN"),
      [[10]]
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.questions).toEqual([
      {
        id: 10,
        quesioner_id: 5,
        title: "Q1",
        type: "BOOLEAN",
        options: [{ id: 100, title: "Yes", score: 1 }],
      },
    ]);
    expect(payload.data.answers[0].boolean_value).toBe(true);
    expect(payload.data.answers[1].boolean_value).toBeNull();
  });

  it("returns 500 (errorResponse code-as-error bug) when family not found", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // families empty

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error: 404,
        message: "Family not found",
      })
    );
  });

  it("returns the hardcoded empty shape (limit:10 preserved bug) when no response exists", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      query: { limit: "3" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "AYAH" }],
        [],
      ])
      .mockResolvedValueOnce([[], []]); // no response

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(res.json).toHaveBeenCalledWith({
      totalRows: 0,
      totalPage: 0,
      page: 0,
      limit: 10,
      questions: [],
      answers: [],
    });
  });

  it("skips the options and answers queries when no questions match (empty IN guard)", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([
        [{ id: "resp-1", familyMemberId: "member-1", quisionerId: 5 }],
        [],
      ])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[], []]); // no questions

    await getResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(5); // no options query, no answers query
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.questions).toEqual([]);
    expect(payload.data.answers).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL — `getResponseQuesioner` still calls `prisma.*`, so `pool.query` is never invoked and every assertion on `pool.query` mock calls fails (or the handler throws because `prisma` isn't mocked and errors out, also failing).

- [ ] **Step 4: Replace `getResponseQuesioner`'s body**

Replace the whole `getResponseQuesioner` function with:
```js
export const getResponseQuesioner = async (req, res) => {
  try {
    const user = req.user;
    const id = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [families] = await pool.query(
      "SELECT * FROM families WHERE userId = ? LIMIT 1",
      [user.id]
    );
    const family = families[0];

    if (!family) {
      return errorResponse(res, 404, "Family not found");
    }

    const [familyMembers] = await pool.query(
      "SELECT * FROM family_members WHERE familyId = ? AND (relation = ? OR relation = ?) LIMIT 1",
      [family.id, "IBU", "AYAH"]
    );
    const familyMember = familyMembers[0];

    if (!familyMember) {
      return errorResponse(res, 404, "Family member not found");
    }

    const [responses] = await pool.query(
      "SELECT * FROM responses WHERE familyMemberId = ? AND quisionerId = ? LIMIT 1",
      [familyMember.id, id]
    );
    const response = responses[0];

    if (!response) {
      return res.json({
        totalRows: 0,
        totalPage: 0,
        page: 0,
        limit: 10,
        questions: [],
        answers: [],
      });
    }

    const [totalRowsResult] = await pool.query(
      "SELECT COUNT(*) AS count FROM questions WHERE quesioner_id = ? AND title LIKE ?",
      [id, `%${search}%`]
    );
    const totalRows = totalRowsResult[0].count;

    const totalPage = Math.ceil(totalRows / limit);

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ? LIMIT ? OFFSET ?",
      [id, `%${search}%`, limit, offset]
    );

    const questionIds = questionRows.map((q) => q.id);

    let optionRows = [];
    if (questionIds.length > 0) {
      const [rows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds]
      );
      optionRows = rows;
    }

    const questions = questionRows.map((q) => ({
      ...q,
      options: optionRows
        .filter((o) => o.question_id === q.id)
        .map((o) => ({ id: o.id, title: o.title, score: o.score })),
    }));

    let answerRows = [];
    if (questionIds.length > 0) {
      const [rows] = await pool.query(
        "SELECT * FROM answers WHERE responseId = ? AND questionId IN (?) ORDER BY id ASC",
        [response.id, questionIds]
      );
      answerRows = rows;
    }

    const answers = answerRows.map((a) => ({
      ...a,
      boolean_value: a.boolean_value === null ? null : !!a.boolean_value,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions, answers },
      "Berhasil mendapatkan data"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert getResponseQuesioner to raw mysql2"
```

---

### Task 17: Convert `createResponseQuesioner`

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Modify: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- Adds `import { randomUUID } from "node:crypto";` to the controller — `Response.id` is client-generated.
- No transaction wraps insert-response → bulk-insert-answers → update-totalScore. This matches the original (Prisma also ran 3 independent calls, not `$transaction`). Do not add a transaction here — a failed bulk-insert is allowed to leave an orphaned zero-score response row, exactly as before.
- New edge case introduced by the raw-SQL conversion: bulk `INSERT ... VALUES ?` with an **empty** values array is invalid SQL (Prisma's `createMany({data: []})` silently returns `{count: 0}`), so the bulk insert must be skipped when `sanitizedData.length === 0`.

- [ ] **Step 1: Write the failing tests**

Edit the test file's mock/import section to add crypto mocking and the new handler import:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("node:crypto", () => ({
  randomUUID: () => "11111111-1111-1111-1111-111111111111",
}));

import pool from "../../config/db.js";
import {
  getResponseQuesioner,
  createResponseQuesioner,
} from "../ResponseQuesionerController.js";
```

Append a new `describe` block at the end of the file:
```js
describe("createResponseQuesioner", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  it("inserts the response, bulk-inserts answers, and updates totalScore", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: {
        answers: [
          { questionId: 10, option_id: 100, score: 3, boolean_value: true, scaleValue: 2 },
          { questionId: 11, option_id: 101, score: 1 },
        ],
      },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ]) // family_members
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }]) // INSERT responses
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // bulk INSERT answers
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE responses totalScore

    await createResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO responses"),
      [UUID, 5, 0, "member-1", null]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO answers"),
      [
        [
          [10, UUID, 100, 3, true, 2],
          [11, UUID, 101, 1, null, null],
        ],
      ]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("UPDATE responses SET totalScore"),
      [4, UUID]
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        data: { count: 2 },
      })
    );
  });

  it("returns 500 (401-as-error bug) when there is no user on the request", async () => {
    const req = { user: null, params: { id: "5" }, body: { answers: [] } };
    const res = mockRes();

    await createResponseQuesioner(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 401, message: "Unauthorized" })
    );
  });

  it("returns 400 (as-error bug) when 'answers' is not an array", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: { answers: "not-an-array" },
    };
    const res = mockRes();

    await createResponseQuesioner(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 400,
        message: "Data must be an array in 'answers'",
      })
    );
  });

  it("skips the bulk insert and reports count:0 when answers is an empty array", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: { answers: [] },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }]) // INSERT responses
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE responses totalScore (no bulk insert call)

    await createResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(4); // no INSERT INTO answers call
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { count: 0 } })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL on the new `createResponseQuesioner` tests (handler still uses `prisma.*`).

- [ ] **Step 3: Add the crypto import and replace `createResponseQuesioner`'s body**

Add near the top of the controller (below the other imports):
```js
import { randomUUID } from "node:crypto";
```

Replace the whole `createResponseQuesioner` function with:
```js
export const createResponseQuesioner = async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return errorResponse(res, 401, "Unauthorized");
    }

    const { id } = req.params;

    const answers = req.body.answers;
    if (!Array.isArray(answers)) {
      return errorResponse(res, 400, "Data must be an array in 'answers'");
    }

    const [families] = await pool.query(
      "SELECT * FROM families WHERE userId = ? LIMIT 1",
      [user.id]
    );
    const family = families[0];

    if (!family) {
      return errorResponse(res, 404, "Family not found");
    }

    const [familyMembers] = await pool.query(
      "SELECT * FROM family_members WHERE familyId = ? AND (relation = ? OR relation = ?) LIMIT 1",
      [family.id, "IBU", "AYAH"]
    );
    const familyMember = familyMembers[0];

    if (!familyMember) {
      return errorResponse(res, 404, "Family member not found");
    }

    const responseId = randomUUID();

    await pool.query(
      "INSERT INTO responses (id, quisionerId, created_at, totalScore, familyMemberId, institutionId) VALUES (?, ?, NOW(3), ?, ?, ?)",
      [responseId, Number(id), 0, familyMember.id, null]
    );

    const sanitizedData = answers.map((item) => ({
      questionId: Number(item.questionId),
      responseId,
      option_id: Number(item.option_id),
      score: Number(item.score),
      boolean_value: item.boolean_value ? Boolean(item.boolean_value) : null,
      scaleValue: item.scaleValue ? Number(item.scaleValue) : null,
    }));

    for (const item of sanitizedData) {
      if (
        typeof item.questionId !== "number" ||
        typeof item.responseId !== "string" ||
        typeof item.score !== "number"
      ) {
        return errorResponse(res, 400, "Invalid data format");
      }
      // Field optional: hanya validasi jika ada
      if (
        item.boolean_value !== undefined &&
        item.boolean_value !== null &&
        typeof item.boolean_value !== "boolean"
      ) {
        return errorResponse(res, 400, "Invalid boolean value format");
      }
      if (
        item.scaleValue !== undefined &&
        item.scaleValue !== null &&
        typeof item.scaleValue !== "number"
      ) {
        return errorResponse(res, 400, "Invalid scale value format");
      }
    }

    let insertResult = { affectedRows: 0 };
    if (sanitizedData.length > 0) {
      const values = sanitizedData.map((item) => [
        item.questionId,
        item.responseId,
        item.option_id,
        item.score,
        item.boolean_value,
        item.scaleValue,
      ]);
      const [result] = await pool.query(
        "INSERT INTO answers (questionId, responseId, option_id, score, boolean_value, scaleValue) VALUES ?",
        [values]
      );
      insertResult = result;
    }

    const HitungScore = sanitizedData.reduce(
      (sum, item) => sum + (item.score || 0),
      0
    );

    await pool.query("UPDATE responses SET totalScore = ? WHERE id = ?", [
      HitungScore,
      responseId,
    ]);

    return successResponse(
      res,
      { count: insertResult.affectedRows },
      "Berhasil menjawab kuisioner"
    );
  } catch (error) {
    return errorResponse(
      res,
      error,
      "Gagal menjawab kuisioner, silahkan diulang"
    );
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (8 tests total: 4 from Task 16 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert createResponseQuesioner to raw mysql2"
```

---

### Task 18: Convert `checkAnsweredQuesioner`

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Modify: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- The original fetches the response with `include: { answers: true }`, but never reads `response.answers` anywhere in the function body (it only uses `response.id` to run a separate `COUNT` query). This eager-load is dead weight in Prisma and has **no raw-SQL equivalent needed** — drop it; a plain `SELECT * FROM responses WHERE ...` is sufficient and behaviorally identical.

- [ ] **Step 1: Write the failing tests**

Update the import line:
```js
import {
  getResponseQuesioner,
  createResponseQuesioner,
  checkAnsweredQuesioner,
} from "../ResponseQuesionerController.js";
```

Append:
```js
describe("checkAnsweredQuesioner", () => {
  it("returns answered:true when totalAnswers equals totalQuestions", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([[{ id: "resp-1", familyMemberId: "member-1" }], []]) // responses, no join
      .mockResolvedValueOnce([[{ count: 3 }], []]) // totalQuestions
      .mockResolvedValueOnce([[{ count: 3 }], []]); // totalAnswers

    await checkAnsweredQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(5);
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("FROM responses WHERE familyMemberId"),
      ["member-1", 5]
    );
    expect(res.json).toHaveBeenCalledWith({ answered: true });
  });

  it("returns answered:false when counts differ", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([[{ id: "resp-1", familyMemberId: "member-1" }], []])
      .mockResolvedValueOnce([[{ count: 3 }], []])
      .mockResolvedValueOnce([[{ count: 2 }], []]);

    await checkAnsweredQuesioner(req, res);

    expect(res.json).toHaveBeenCalledWith({ answered: false });
  });

  it("returns 500 (404-as-error bug) when family not found", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await checkAnsweredQuesioner(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 404, message: "Family not found" })
    );
  });

  it("returns the paginated-empty shape (page/totalPage/totalRows, no 'limit' key) when no response exists", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "family-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([[], []]); // no response

    await checkAnsweredQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(res.json).toHaveBeenCalledWith({
      answers: [],
      questions: [],
      page: 0,
      totalPage: 0,
      totalRows: 0,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL on the 4 new `checkAnsweredQuesioner` tests.

- [ ] **Step 3: Replace `checkAnsweredQuesioner`'s body**

```js
export const checkAnsweredQuesioner = async (req, res) => {
  try {
    const user = req.user;
    const id = Number(req.params.id);

    const [families] = await pool.query(
      "SELECT * FROM families WHERE userId = ? LIMIT 1",
      [user.id]
    );
    const family = families[0];

    if (!family) return errorResponse(res, 404, "Family not found");

    const [familyMembers] = await pool.query(
      "SELECT * FROM family_members WHERE familyId = ? AND (relation = ? OR relation = ?) LIMIT 1",
      [family.id, "IBU", "AYAH"]
    );
    const familyMember = familyMembers[0];

    if (!familyMember)
      return errorResponse(res, 404, "Family member not found");

    const [responses] = await pool.query(
      "SELECT * FROM responses WHERE familyMemberId = ? AND quisionerId = ? LIMIT 1",
      [familyMember.id, id]
    );
    const response = responses[0];

    if (!response) {
      return res.json({
        answers: [],
        questions: [],
        page: 0,
        totalPage: 0,
        totalRows: 0,
      });
    }

    const [totalQuestionsResult] = await pool.query(
      "SELECT COUNT(*) AS count FROM questions WHERE quesioner_id = ?",
      [id]
    );
    const totalQuestions = totalQuestionsResult[0].count;

    const [totalAnswersResult] = await pool.query(
      "SELECT COUNT(*) AS count FROM answers WHERE responseId = ?",
      [response.id]
    );
    const totalAnswers = totalAnswersResult[0].count;

    return res.json({ answered: totalAnswers === totalQuestions });
  } catch (error) {
    return errorResponse(res, error, "Failed to check answered status");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert checkAnsweredQuesioner to raw mysql2"
```

---

### Task 19: Convert `updateResponseQuesioner`

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Modify: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- Prisma's `prisma.answer.update({ where: { id } })` throws (P2025) when the target row doesn't exist. A raw `UPDATE ... WHERE id = ?` silently no-ops instead — this handler **must** check `updateResult.affectedRows === 0` and `throw` to replicate that behavior, otherwise a bad id would 200 with garbage data.
- Prisma's `_sum.score` is `null` when the response has zero answer rows; the original guards with `totalScore._sum.score || 0`. The raw `SELECT SUM(score) AS total ...` also returns `null` in that case (one row is always returned by `SUM` with no matching rows) — same `|| 0` guard applies.
- The re-selected answer row (post-UPDATE) gets the same `boolean_value` coercion as every other place an answers row reaches a response.

- [ ] **Step 1: Write the failing tests**

Update the import line:
```js
import {
  getResponseQuesioner,
  createResponseQuesioner,
  checkAnsweredQuesioner,
  updateResponseQuesioner,
} from "../ResponseQuesionerController.js";
```

Append:
```js
describe("updateResponseQuesioner", () => {
  it("updates the answer, recomputes totalScore, and returns the boolean-coerced row", async () => {
    const req = {
      params: { id: "1000" },
      body: { option_id: 100, boolean_value: true, scaleValue: 2, score: 3 },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE answers
      .mockResolvedValueOnce([
        [
          {
            id: 1000,
            questionId: 10,
            responseId: "resp-1",
            option_id: 100,
            score: 3,
            boolean_value: 1,
            scaleValue: 2,
          },
        ],
        [],
      ]) // re-select
      .mockResolvedValueOnce([[{ total: 7 }], []]) // SUM
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE responses totalScore

    await updateResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE answers SET"),
      [100, true, 2, 3, 1000]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("SUM(score)"),
      ["resp-1"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("UPDATE responses SET totalScore"),
      [7, "resp-1"]
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.boolean_value).toBe(true);
    expect(payload.status).toBe("success");
  });

  it("throws and returns 500 when the target answer row does not exist (affectedRows === 0)", async () => {
    const req = {
      params: { id: "9999" },
      body: { option_id: 100, boolean_value: false, scaleValue: 1, score: 0 },
    };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]); // UPDATE answers, no match

    await updateResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1); // no re-select, no SUM, no second UPDATE
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to update response",
      })
    );
  });

  it("guards SUM(score) returning null with || 0 when the response has no other answers", async () => {
    const req = {
      params: { id: "1000" },
      body: { option_id: 100, boolean_value: null, scaleValue: null, score: 0 },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([
        [
          {
            id: 1000,
            questionId: 10,
            responseId: "resp-1",
            option_id: 100,
            score: 0,
            boolean_value: null,
            scaleValue: null,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ total: null }], []]) // SUM with no rows -> null
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await updateResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("UPDATE responses SET totalScore"),
      [0, "resp-1"]
    );
  });

  it("coerces an undefined boolean_value in the request body to null", async () => {
    const req = {
      params: { id: "1000" },
      body: { option_id: 100, scaleValue: 1, score: 2 },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([
        [
          {
            id: 1000,
            questionId: 10,
            responseId: "resp-1",
            option_id: 100,
            score: 2,
            boolean_value: null,
            scaleValue: 1,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ total: 2 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await updateResponseQuesioner(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE answers SET"),
      [100, null, 1, 2, 1000]
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL on the 4 new `updateResponseQuesioner` tests.

- [ ] **Step 3: Replace `updateResponseQuesioner`'s body**

```js
export const updateResponseQuesioner = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { option_id, boolean_value, scaleValue, score } = req.body;

    const coercedBooleanValue =
      boolean_value === undefined || boolean_value === null
        ? null
        : Boolean(boolean_value);

    const [updateResult] = await pool.query(
      "UPDATE answers SET option_id = ?, boolean_value = ?, scaleValue = ?, score = ? WHERE id = ?",
      [Number(option_id), coercedBooleanValue, Number(scaleValue), Number(score), id]
    );

    if (updateResult.affectedRows === 0) {
      throw new Error("Record to update not found.");
    }

    const [updatedRows] = await pool.query(
      "SELECT * FROM answers WHERE id = ? LIMIT 1",
      [id]
    );
    const updatedAnswerRow = updatedRows[0];
    const updatedAnswer = {
      ...updatedAnswerRow,
      boolean_value:
        updatedAnswerRow.boolean_value === null
          ? null
          : !!updatedAnswerRow.boolean_value,
    };

    const [sumResult] = await pool.query(
      "SELECT SUM(score) AS total FROM answers WHERE responseId = ?",
      [updatedAnswer.responseId]
    );
    const totalScore = sumResult[0].total || 0;

    await pool.query("UPDATE responses SET totalScore = ? WHERE id = ?", [
      totalScore,
      updatedAnswer.responseId,
    ]);

    return successResponse(res, updatedAnswer, "Berhasil mengupdate jawaban");
  } catch (error) {
    return errorResponse(res, error, "Failed to update response");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (16 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert updateResponseQuesioner to raw mysql2, preserve affectedRows-throw parity"
```

---

### Task 20: Convert `getResponseQuesionerInstitution`

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Modify: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- Unlike `getResponseQuesioner`, this handler paginates the **answers** (`LIMIT ? OFFSET ?` on the answers query) and fetches **all** matching questions unpaginated. `totalRows` here counts matching **answers**, not questions.
- Institution lookup is by the `user_id` column (`institutions.user_id = ?`), matching the logged-in user — different from `showResponseForInstitution` (Task 24), which looks the institution up by its own primary key.

- [ ] **Step 1: Write the failing tests**

Update the import line to add `getResponseQuesionerInstitution`.

Append:
```js
describe("getResponseQuesionerInstitution", () => {
  it("returns all questions with paginated, boolean-coerced answers", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      query: {},
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, user_id: "user-1" }], []]) // institutions
      .mockResolvedValueOnce([
        [{ id: "resp-1", institutionId: 1, quisionerId: 5 }],
        [],
      ]) // responses
      .mockResolvedValueOnce([
        [{ id: 10, quesioner_id: 5, title: "Q1", type: "BOOLEAN" }],
        [],
      ]) // questions, unpaginated
      .mockResolvedValueOnce([
        [{ id: 100, question_id: 10, title: "Yes", score: 1 }],
        [],
      ]) // options
      .mockResolvedValueOnce([[{ count: 1 }], []]) // totalRows (answers count)
      .mockResolvedValueOnce([
        [
          {
            id: 1000,
            questionId: 10,
            responseId: "resp-1",
            option_id: 100,
            score: 1,
            boolean_value: 0,
            scaleValue: null,
          },
        ],
        [],
      ]); // answers, paginated

    await getResponseQuesionerInstitution(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM institutions WHERE user_id"),
      ["user-1"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.not.stringContaining("LIMIT"),
      [5, "%%"]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("LIMIT ? OFFSET ?"),
      ["resp-1", [10], 10, 0]
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.answers[0].boolean_value).toBe(false);
  });

  it("returns 500 (404-as-error bug) when institution not found", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await getResponseQuesionerInstitution(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 404, message: "Institution not found" })
    );
  });

  it("returns the hardcoded empty shape (limit:10 preserved bug) when no response exists", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      query: { limit: "5" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[], []]);

    await getResponseQuesionerInstitution(req, res);

    expect(res.json).toHaveBeenCalledWith({
      totalRows: 0,
      totalPage: 0,
      page: 0,
      limit: 10,
      questions: [],
      answers: [],
    });
  });

  it("skips the options, count, and paginated-answers queries when no questions match", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, user_id: "user-1" }], []])
      .mockResolvedValueOnce([
        [{ id: "resp-1", institutionId: 1, quisionerId: 5 }],
        [],
      ])
      .mockResolvedValueOnce([[], []]); // no questions

    await getResponseQuesionerInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.totalRows).toBe(0);
    expect(payload.data.answers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL on the 4 new `getResponseQuesionerInstitution` tests.

- [ ] **Step 3: Replace `getResponseQuesionerInstitution`'s body**

```js
export const getResponseQuesionerInstitution = async (req, res) => {
  try {
    const user = req.user;
    const quesionerId = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [institutions] = await pool.query(
      "SELECT * FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = institutions[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    const [responses] = await pool.query(
      "SELECT * FROM responses WHERE institutionId = ? AND quisionerId = ? LIMIT 1",
      [institution.id, quesionerId]
    );
    const response = responses[0];

    if (!response) {
      return res.json({
        totalRows: 0,
        totalPage: 0,
        page: 0,
        limit: 10,
        questions: [],
        answers: [],
      });
    }

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ?",
      [quesionerId, `%${search}%`]
    );

    const questionIds = questionRows.map((q) => q.id);

    let optionRows = [];
    if (questionIds.length > 0) {
      const [rows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds]
      );
      optionRows = rows;
    }

    const questions = questionRows.map((q) => ({
      ...q,
      options: optionRows
        .filter((o) => o.question_id === q.id)
        .map((o) => ({ id: o.id, title: o.title, score: o.score })),
    }));

    let totalRows = 0;
    let answerRows = [];
    if (questionIds.length > 0) {
      const [totalRowsResult] = await pool.query(
        "SELECT COUNT(*) AS count FROM answers WHERE responseId = ? AND questionId IN (?)",
        [response.id, questionIds]
      );
      totalRows = totalRowsResult[0].count;

      const [rows] = await pool.query(
        "SELECT * FROM answers WHERE responseId = ? AND questionId IN (?) ORDER BY id ASC LIMIT ? OFFSET ?",
        [response.id, questionIds, limit, offset]
      );
      answerRows = rows;
    }

    const totalPage = Math.ceil(totalRows / limit);

    const answers = answerRows.map((a) => ({
      ...a,
      boolean_value: a.boolean_value === null ? null : !!a.boolean_value,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions, answers },
      "Berhasil mendapatkan data"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (20 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert getResponseQuesionerInstitution to raw mysql2"
```

---

### Task 21: Convert `createResponseQuesionerInstitution`

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Modify: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- Same insert/bulk-insert/update-totalScore shape as `createResponseQuesioner` (Task 17), no transaction, same empty-array bulk-insert guard.
- The `sanitizedData` mapping here differs subtly from `createResponseQuesioner`'s and must be preserved exactly: `option_id` is `item.option_id !== undefined ? Number(item.option_id) : null` (an explicit `undefined` check, not a truthy check), and `boolean_value`/`scaleValue` use `!== undefined` checks rather than truthy checks.

- [ ] **Step 1: Write the failing tests**

Update the import line to add `createResponseQuesionerInstitution`.

Append:
```js
describe("createResponseQuesionerInstitution", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  it("inserts the response, bulk-inserts answers, and updates totalScore", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: {
        answers: [
          { questionId: 10, score: 3, boolean_value: false, scaleValue: 0 },
        ],
      },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, user_id: "user-1" }], []]) // institutions
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }]) // INSERT responses
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // bulk INSERT answers
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE responses totalScore

    await createResponseQuesionerInstitution(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO responses"),
      [UUID, 5, 0, null, 1]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO answers"),
      [[[10, UUID, null, 3, false, 0]]]
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { count: 1 } })
    );
  });

  it("returns 500 (401-as-error bug) when there is no user on the request", async () => {
    const req = { user: null, params: { id: "5" }, body: { answers: [] } };
    const res = mockRes();

    await createResponseQuesionerInstitution(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 401, message: "Unauthorized" })
    );
  });

  it("returns 500 (404-as-error bug) when institution not found", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: { answers: [] },
    };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await createResponseQuesionerInstitution(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 404, message: "Institution not found" })
    );
  });

  it("defaults option_id to null (not NaN) when the item omits it, and skips the bulk insert when answers is empty", async () => {
    const req = {
      user: { id: "user-1" },
      params: { id: "5" },
      body: { answers: [] },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, user_id: "user-1" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE responses totalScore (no bulk insert call)

    await createResponseQuesionerInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3); // no INSERT INTO answers call
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { count: 0 } })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL on the 4 new `createResponseQuesionerInstitution` tests.

- [ ] **Step 3: Replace `createResponseQuesionerInstitution`'s body**

```js
export const createResponseQuesionerInstitution = async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return errorResponse(res, 401, "Unauthorized");
    }

    const { id } = req.params;
    const answers = req.body.answers;
    if (!Array.isArray(answers)) {
      return errorResponse(res, 400, "Data must be an array in 'answers'");
    }

    // Cari institution milik user
    const [institutions] = await pool.query(
      "SELECT * FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = institutions[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    // Buat response baru untuk institution
    const responseId = randomUUID();

    await pool.query(
      "INSERT INTO responses (id, quisionerId, created_at, totalScore, familyMemberId, institutionId) VALUES (?, ?, NOW(3), ?, ?, ?)",
      [responseId, Number(id), 0, null, institution.id]
    );

    const sanitizedData = answers.map((item) => ({
      questionId: Number(item.questionId),
      responseId,
      option_id: item.option_id !== undefined ? Number(item.option_id) : null,
      score: Number(item.score),
      boolean_value:
        item.boolean_value !== undefined ? Boolean(item.boolean_value) : null,
      scaleValue:
        item.scaleValue !== undefined ? Number(item.scaleValue) : null,
    }));

    for (const item of sanitizedData) {
      if (
        typeof item.questionId !== "number" ||
        typeof item.responseId !== "string" ||
        typeof item.score !== "number"
      ) {
        return errorResponse(res, 400, "Invalid data format");
      }
      if (
        item.boolean_value !== undefined &&
        item.boolean_value !== null &&
        typeof item.boolean_value !== "boolean"
      ) {
        return errorResponse(res, 400, "Invalid boolean value format");
      }
      if (
        item.scaleValue !== undefined &&
        item.scaleValue !== null &&
        typeof item.scaleValue !== "number"
      ) {
        return errorResponse(res, 400, "Invalid scale value format");
      }
    }

    let insertResult = { affectedRows: 0 };
    if (sanitizedData.length > 0) {
      const values = sanitizedData.map((item) => [
        item.questionId,
        item.responseId,
        item.option_id,
        item.score,
        item.boolean_value,
        item.scaleValue,
      ]);
      const [result] = await pool.query(
        "INSERT INTO answers (questionId, responseId, option_id, score, boolean_value, scaleValue) VALUES ?",
        [values]
      );
      insertResult = result;
    }

    const HitungScore = sanitizedData.reduce(
      (sum, item) => sum + (item.score || 0),
      0
    );

    await pool.query("UPDATE responses SET totalScore = ? WHERE id = ?", [
      HitungScore,
      responseId,
    ]);

    return successResponse(
      res,
      { count: insertResult.affectedRows },
      "Berhasil menjawab kuisioner"
    );
  } catch (error) {
    return errorResponse(
      res,
      error,
      "Gagal menjawab kuisioner, silahkan diulang"
    );
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (24 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert createResponseQuesionerInstitution to raw mysql2"
```

---

### Task 22: Convert `checkAnsweredQuesionerInstitution`

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Modify: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- This handler's early-return on no-response is `res.json({ answered: false })` — a **different** shape from `checkAnsweredQuesioner`'s paginated-empty-shape early return (Task 18). Preserve this difference exactly; do not unify the two "check" handlers' no-response responses.
- Unlike `checkAnsweredQuesioner`, the original here never fetched an `include: { answers: true }` in the first place, so there is nothing to drop — the response lookup was already a plain query.

- [ ] **Step 1: Write the failing tests**

Update the import line to add `checkAnsweredQuesionerInstitution`.

Append:
```js
describe("checkAnsweredQuesionerInstitution", () => {
  it("returns answered:true when totalAnswers equals totalQuestions", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, user_id: "user-1" }], []]) // institutions
      .mockResolvedValueOnce([
        [{ id: "resp-1", institutionId: 1, quisionerId: 5 }],
        [],
      ]) // responses
      .mockResolvedValueOnce([[{ count: 4 }], []]) // totalQuestions
      .mockResolvedValueOnce([[{ count: 4 }], []]); // totalAnswers

    await checkAnsweredQuesionerInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(res.json).toHaveBeenCalledWith({ answered: true });
  });

  it("returns 500 (404-as-error bug) when institution not found", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await checkAnsweredQuesionerInstitution(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 404, message: "Institution not found" })
    );
  });

  it("returns the bare {answered:false} shape (distinct from checkAnsweredQuesioner's shape) when no response exists", async () => {
    const req = { user: { id: "user-1" }, params: { id: "5" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[], []]); // no response

    await checkAnsweredQuesionerInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith({ answered: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL on the 3 new `checkAnsweredQuesionerInstitution` tests.

- [ ] **Step 3: Replace `checkAnsweredQuesionerInstitution`'s body**

```js
export const checkAnsweredQuesionerInstitution = async (req, res) => {
  try {
    const user = req.user;
    const quesionerId = Number(req.params.id);

    // Cari institution milik user
    const [institutions] = await pool.query(
      "SELECT * FROM institutions WHERE user_id = ? LIMIT 1",
      [user.id]
    );
    const institution = institutions[0];

    if (!institution) return errorResponse(res, 404, "Institution not found");

    // Cari response untuk institution & quesioner
    const [responses] = await pool.query(
      "SELECT * FROM responses WHERE institutionId = ? AND quisionerId = ? LIMIT 1",
      [institution.id, quesionerId]
    );
    const response = responses[0];

    // Jika belum pernah menjawab, return answered: false
    if (!response) return res.json({ answered: false });

    // Hitung total pertanyaan pada quesioner
    const [totalQuestionsResult] = await pool.query(
      "SELECT COUNT(*) AS count FROM questions WHERE quesioner_id = ?",
      [quesionerId]
    );
    const totalQuestions = totalQuestionsResult[0].count;

    // Hitung total jawaban pada response
    const [totalAnswersResult] = await pool.query(
      "SELECT COUNT(*) AS count FROM answers WHERE responseId = ?",
      [response.id]
    );
    const totalAnswers = totalAnswersResult[0].count;

    return res.json({ answered: totalAnswers === totalQuestions });
  } catch (error) {
    return errorResponse(res, error, "Failed to check answered status");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (27 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert checkAnsweredQuesionerInstitution to raw mysql2"
```

---

### Task 23: Convert `showResponseForParent`

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Modify: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- The `req.params.userId` value is used directly as `family_members.familyId` (it is a family id despite the misleading param name) — no `Number()` conversion, preserved as-is.
- Same "paginate answers, fetch all questions" shape as `getResponseQuesionerInstitution`.
- The original fetches the response with `include: { answers: true }` but never reads `response.answers` (a separate paginated `answer.findMany` runs later) — same dead-weight eager-load as Task 18; drop it, use a plain `SELECT`.

- [ ] **Step 1: Write the failing tests**

Update the import line to add `showResponseForParent`.

Append:
```js
describe("showResponseForParent", () => {
  it("returns all questions with paginated, boolean-coerced answers", async () => {
    const req = {
      params: { userId: "family-1", id: "5" },
      query: {},
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ]) // family_members
      .mockResolvedValueOnce([
        [{ id: "resp-1", familyMemberId: "member-1", quisionerId: 5 }],
        [],
      ]) // responses, no join
      .mockResolvedValueOnce([
        [{ id: 10, quesioner_id: 5, title: "Q1", type: "SCALE" }],
        [],
      ]) // questions, unpaginated
      .mockResolvedValueOnce([
        [{ id: 100, question_id: 10, title: "Low", score: 0 }],
        [],
      ]) // options
      .mockResolvedValueOnce([[{ count: 1 }], []]) // totalRows (answers count)
      .mockResolvedValueOnce([
        [
          {
            id: 1000,
            questionId: 10,
            responseId: "resp-1",
            option_id: 100,
            score: 0,
            boolean_value: null,
            scaleValue: 1,
          },
        ],
        [],
      ]); // answers, paginated

    await showResponseForParent(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM family_members WHERE familyId"),
      ["family-1", "IBU", "AYAH"]
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.answers[0].boolean_value).toBeNull();
    expect(payload.data.questions[0].options).toEqual([
      { id: 100, title: "Low", score: 0 },
    ]);
  });

  it("returns 500 (404-as-error bug) when family member not found", async () => {
    const req = { params: { userId: "family-1", id: "5" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await showResponseForParent(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 404, message: "Family member not found" })
    );
  });

  it("returns the hardcoded empty shape (limit:10 preserved bug) when no response exists", async () => {
    const req = {
      params: { userId: "family-1", id: "5" },
      query: { limit: "20" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([[], []]);

    await showResponseForParent(req, res);

    expect(res.json).toHaveBeenCalledWith({
      totalRows: 0,
      totalPage: 0,
      page: 0,
      limit: 10,
      questions: [],
      answers: [],
    });
  });

  it("skips the options, count, and answers queries when no questions match", async () => {
    const req = { params: { userId: "family-1", id: "5" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([
        [{ id: "member-1", familyId: "family-1", relation: "IBU" }],
        [],
      ])
      .mockResolvedValueOnce([
        [{ id: "resp-1", familyMemberId: "member-1", quisionerId: 5 }],
        [],
      ])
      .mockResolvedValueOnce([[], []]); // no questions

    await showResponseForParent(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.totalRows).toBe(0);
    expect(payload.data.answers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL on the 4 new `showResponseForParent` tests.

- [ ] **Step 3: Replace `showResponseForParent`'s body**

```js
export const showResponseForParent = async (req, res) => {
  try {
    const userId = req.params.userId;
    const id = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [familyMembers] = await pool.query(
      "SELECT * FROM family_members WHERE familyId = ? AND (relation = ? OR relation = ?) LIMIT 1",
      [userId, "IBU", "AYAH"]
    );
    const familyMember = familyMembers[0];

    if (!familyMember) {
      return errorResponse(res, 404, "Family member not found");
    }

    const [responses] = await pool.query(
      "SELECT * FROM responses WHERE familyMemberId = ? AND quisionerId = ? LIMIT 1",
      [familyMember.id, id]
    );
    const response = responses[0];

    if (!response) {
      return res.json({
        totalRows: 0,
        totalPage: 0,
        page: 0,
        limit: 10,
        questions: [],
        answers: [],
      });
    }

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ?",
      [id, `%${search}%`]
    );

    const questionIds = questionRows.map((q) => q.id);

    let optionRows = [];
    if (questionIds.length > 0) {
      const [rows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds]
      );
      optionRows = rows;
    }

    const questions = questionRows.map((q) => ({
      ...q,
      options: optionRows
        .filter((o) => o.question_id === q.id)
        .map((o) => ({ id: o.id, title: o.title, score: o.score })),
    }));

    let totalRows = 0;
    let answerRows = [];
    if (questionIds.length > 0) {
      const [totalRowsResult] = await pool.query(
        "SELECT COUNT(*) AS count FROM answers WHERE responseId = ? AND questionId IN (?)",
        [response.id, questionIds]
      );
      totalRows = totalRowsResult[0].count;

      const [rows] = await pool.query(
        "SELECT * FROM answers WHERE responseId = ? AND questionId IN (?) ORDER BY id ASC LIMIT ? OFFSET ?",
        [response.id, questionIds, limit, offset]
      );
      answerRows = rows;
    }

    const totalPage = Math.ceil(totalRows / limit);

    const answers = answerRows.map((a) => ({
      ...a,
      boolean_value: a.boolean_value === null ? null : !!a.boolean_value,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions, answers },
      "Berhasil mendapatkan data"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (31 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert showResponseForParent to raw mysql2"
```

---

### Task 24: Convert `showResponseForInstitution` and remove Prisma from this file

**Files:**
- Modify: `src/controllers/ResponseQuesionerController.js`
- Modify: `src/controllers/__tests__/ResponseQuesionerController.test.js`

**Interfaces:**
- This is the last handler in the file to use `prisma`. Once it's converted, `import { PrismaClient } from "@prisma/client";` and `const prisma = new PrismaClient();` are dead code and must be deleted.
- The institution lookup here is by the institution's own primary key (`institutions.id = ?`, from `req.params.user_id`) — **not** by `institutions.user_id` (the FK to the logged-in user), which is what `getResponseQuesionerInstitution` (Task 20) and `checkAnsweredQuesionerInstitution` (Task 22) use. Preserve this difference exactly; it is not a typo to "fix", it's how `req.params.user_id` is actually used in this handler.

- [ ] **Step 1: Write the failing tests**

Update the import line to add `showResponseForInstitution`.

Append:
```js
describe("showResponseForInstitution", () => {
  it("returns all questions with paginated, boolean-coerced answers", async () => {
    const req = {
      params: { user_id: "1", id: "5" },
      query: {},
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: "Puskesmas A" }], []]) // institutions, looked up by id
      .mockResolvedValueOnce([
        [{ id: "resp-1", institutionId: 1, quisionerId: 5 }],
        [],
      ]) // responses
      .mockResolvedValueOnce([
        [{ id: 10, quesioner_id: 5, title: "Q1", type: "SCALE" }],
        [],
      ]) // questions, unpaginated
      .mockResolvedValueOnce([
        [{ id: 100, question_id: 10, title: "High", score: 2 }],
        [],
      ]) // options
      .mockResolvedValueOnce([[{ count: 1 }], []]) // totalRows (answers count)
      .mockResolvedValueOnce([
        [
          {
            id: 1000,
            questionId: 10,
            responseId: "resp-1",
            option_id: 100,
            score: 2,
            boolean_value: 1,
            scaleValue: 2,
          },
        ],
        [],
      ]); // answers, paginated

    await showResponseForInstitution(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM institutions WHERE id"),
      [1]
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.answers[0].boolean_value).toBe(true);
  });

  it("returns 500 (404-as-error bug) when institution not found", async () => {
    const req = { params: { user_id: "999", id: "5" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await showResponseForInstitution(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 404, message: "Institution not found" })
    );
  });

  it("returns the hardcoded empty shape (limit:10 preserved bug) when no response exists", async () => {
    const req = {
      params: { user_id: "1", id: "5" },
      query: { limit: "50" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: "Puskesmas A" }], []])
      .mockResolvedValueOnce([[], []]);

    await showResponseForInstitution(req, res);

    expect(res.json).toHaveBeenCalledWith({
      totalRows: 0,
      totalPage: 0,
      page: 0,
      limit: 10,
      questions: [],
      answers: [],
    });
  });

  it("skips the options, count, and answers queries when no questions match", async () => {
    const req = { params: { user_id: "1", id: "5" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: "Puskesmas A" }], []])
      .mockResolvedValueOnce([
        [{ id: "resp-1", institutionId: 1, quisionerId: 5 }],
        [],
      ])
      .mockResolvedValueOnce([[], []]); // no questions

    await showResponseForInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.totalRows).toBe(0);
    expect(payload.data.answers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: FAIL on the 4 new `showResponseForInstitution` tests.

- [ ] **Step 3: Replace `showResponseForInstitution`'s body, then remove Prisma**

Replace the function body:
```js
export const showResponseForInstitution = async (req, res) => {
  try {
    const user_id = Number(req.params.user_id);
    const quesionerId = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [institutions] = await pool.query(
      "SELECT * FROM institutions WHERE id = ? LIMIT 1",
      [user_id]
    );
    const institution = institutions[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    const [responses] = await pool.query(
      "SELECT * FROM responses WHERE institutionId = ? AND quisionerId = ? LIMIT 1",
      [institution.id, quesionerId]
    );
    const response = responses[0];

    if (!response) {
      return res.json({
        totalRows: 0,
        totalPage: 0,
        page: 0,
        limit: 10,
        questions: [],
        answers: [],
      });
    }

    const [questionRows] = await pool.query(
      "SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ?",
      [quesionerId, `%${search}%`]
    );

    const questionIds = questionRows.map((q) => q.id);

    let optionRows = [];
    if (questionIds.length > 0) {
      const [rows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds]
      );
      optionRows = rows;
    }

    const questions = questionRows.map((q) => ({
      ...q,
      options: optionRows
        .filter((o) => o.question_id === q.id)
        .map((o) => ({ id: o.id, title: o.title, score: o.score })),
    }));

    let totalRows = 0;
    let answerRows = [];
    if (questionIds.length > 0) {
      const [totalRowsResult] = await pool.query(
        "SELECT COUNT(*) AS count FROM answers WHERE responseId = ? AND questionId IN (?)",
        [response.id, questionIds]
      );
      totalRows = totalRowsResult[0].count;

      const [rows] = await pool.query(
        "SELECT * FROM answers WHERE responseId = ? AND questionId IN (?) ORDER BY id ASC LIMIT ? OFFSET ?",
        [response.id, questionIds, limit, offset]
      );
      answerRows = rows;
    }

    const totalPage = Math.ceil(totalRows / limit);

    const answers = answerRows.map((a) => ({
      ...a,
      boolean_value: a.boolean_value === null ? null : !!a.boolean_value,
    }));

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, questions, answers },
      "Berhasil mendapatkan data"
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};
```

Then delete the now-unused Prisma import/instantiation at the top of the file:
```js
// DELETE these two lines — nothing in this file references `prisma` anymore:
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
```
leaving the top of the file as:
```js
import pool from "../config/db.js";
import { randomUUID } from "node:crypto";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/ResponseQuesionerController.test.js`
Expected: PASS (35 tests total). Also run `npx vitest run` (full suite) to confirm removing the Prisma import/instantiation didn't break anything else that imports this file.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/ResponseQuesionerController.js src/controllers/__tests__/ResponseQuesionerController.test.js
git commit -m "test: convert showResponseForInstitution to raw mysql2, drop Prisma from this controller"
```
### Task 25: `getRecomendations` — role-scoped list with nested LEFT JOIN chain + separate nutrition query

**Files:**
- Create: `src/controllers/__tests__/RecommendationController.test.js`
- Modify: `src/controllers/RecommendationController.js`

**Interfaces:**
- Replaces the Prisma-backed `getRecomendations` export with a `pool.query`-backed version. Signature unchanged: `(req, res) => Promise<void>`.
- File-level change (applies once, first task to touch the file): drop `import { PrismaClient } from "@prisma/client";` and `const prisma = new PrismaClient();`; add `import pool from "../config/db.js";` and `import { randomUUID } from "node:crypto";` (the latter used starting Task 26). Keep `import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";` and `import { createNotification } from "./NotificationController.js";` unchanged.
- Reminder for every task in this file: `ResponseHelper.js`'s real signature is `errorResponse(res, error, message, statusCode = 500)`. Every call site in this controller that passes a raw number (`403`/`404`/`400`) as the **second** argument is binding that number to the `error` param, not `statusCode` — so `statusCode` silently defaults to `500`. These guard clauses have always returned HTTP `500` in production (body `{status:"error", message:"...", error: 404}` etc.), never the intended 404/403/400. This is not on the approved bug-fix list (only `getResponseParent` and `getSingleRecommendation` are approved fixes) — preserve this behavior exactly when converting. Tests below assert `res.status(500)` for these guard clauses, not the number that appears in the source.

- [ ] **Step 1: Write the test file skeleton + first test (healthcare role, happy path)**

Create `src/controllers/__tests__/RecommendationController.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import { getRecomendations } from "../RecommendationController.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRecomendations", () => {
  it("scopes to the healthcare institution and returns nested paginated data", async () => {
    const req = {
      user: { id: "u-health-1", role: "healthcare" },
      query: { page: "0", limit: "10" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 7 }], []]) // institution lookup
      .mockResolvedValueOnce([[{ count: 1 }], []]) // count query
      .mockResolvedValueOnce([
        [
          {
            id: "rec-1",
            status: "PENDING",
            createdAt: new Date("2026-01-01"),
            submittedBy_id: "u-school-1",
            si_id: 3,
            si_name: "SD Negeri 1",
            si_address: "Jl. A",
            si_phone: "0800",
            si_email: "sd@x.com",
            sic_id: 1,
            sic_name: "Bandung",
            sip_id: 1,
            sip_name: "Jawa Barat",
            student_id: "st-1",
            student_nis: "12345",
            student_schoolYear: "2025/2026",
            student_semester: "1",
            sti_id: 3,
            sti_name: "SD Negeri 1",
            sti_address: "Jl. A",
            sti_phone: "0800",
            sti_email: "sd@x.com",
            stic_id: 1,
            stic_name: "Bandung",
            stip_id: 1,
            stip_name: "Jawa Barat",
            class_id: 9,
            class_name: "5A",
            fm_id: "fm-1",
            fm_fullName: "Budi",
            fm_birthDate: new Date("2015-01-01"),
            fm_gender: "L",
            fm_familyId: "fam-1",
            se_id: 4,
            se_address: "Jl. Rumah",
          },
        ],
        [],
      ]) // main list query
      .mockResolvedValueOnce([
        [{ id: 20, familyMemberId: "fm-1", ns_id: 2, ns_information: "Gizi Baik" }],
        [],
      ]); // nutrition follow-up query

    await getRecomendations(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM institutions WHERE user_id = ?"),
      ["u-health-1"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT COUNT(*) AS count FROM recommendations r"),
      [7],
    );
    expect(pool.query.mock.calls[2][0]).toContain("r.healthcareInstitutionId = ?");
    expect(pool.query.mock.calls[2][1]).toEqual([7, 10, 0]);
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("FROM nutritions n"),
      [["fm-1"]],
    );

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("success");
    expect(data.data.totalRows).toBe(1);
    expect(data.data.recomend[0].student.familyMember.nutrition).toEqual([
      { id: 20, nutritionStatus: { id: 2, information: "Gizi Baik" } },
    ]);
    expect(data.data.recomend[0].student.familyMember.SocioEconomic).toEqual({
      address: "Jl. Rumah",
    });
  });

  it("applies no institution filter and skips the nutrition query when no family members are returned", async () => {
    const req = {
      user: { id: "u-admin", role: "admin" },
      query: {},
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ count: 0 }], []]) // count query (no institution lookup for this role)
      .mockResolvedValueOnce([[], []]); // main list query, empty

    await getRecomendations(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).not.toContain("WHERE");
    const [data] = res.json.mock.calls[0];
    expect(data.data.recomend).toEqual([]);
    expect(data.data.totalRows).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — `getRecomendations` is not exported as a mysql2-backed function yet (still imports `@prisma/client`, and `pool` is mocked to an empty stub so the Prisma-backed implementation will error or the mock assertions won't match).

- [ ] **Step 3: Implement**

In `src/controllers/RecommendationController.js`, replace the top imports:
```js
import pool from "../config/db.js";
import { randomUUID } from "node:crypto";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";
import { createNotification } from "./NotificationController.js";
```

Replace `getRecomendations` with:
```js
export const getRecomendations = async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 10;
  const offset = limit * page;

  try {
    let institution = null;
    if (req.user?.role === "healthcare" || req.user?.role === "school") {
      const [instRows] = await pool.query(
        "SELECT id FROM institutions WHERE user_id = ? LIMIT 1",
        [req.user.id],
      );
      institution = instRows[0] || null;
    }

    const joinSql = `
      LEFT JOIN users su ON su.id = r.submittedById
      LEFT JOIN institutions si ON si.user_id = su.id
      LEFT JOIN cities sic ON sic.id = si.city_id
      LEFT JOIN provinces sip ON sip.id = si.province_id
      LEFT JOIN students st ON st.id = r.studentId
      LEFT JOIN institutions sti ON sti.id = st.schoolId
      LEFT JOIN cities stic ON stic.id = sti.city_id
      LEFT JOIN provinces stip ON stip.id = sti.province_id
      LEFT JOIN classes cl ON cl.id = st.classId
      LEFT JOIN family_members fm ON fm.id = st.familyMemberId
      LEFT JOIN socio_economic se ON se.id = fm.socioEconomicId
    `;

    let filterSql = "";
    let filterParams = [];
    if (req.user?.role === "healthcare" && institution) {
      filterSql = "WHERE r.healthcareInstitutionId = ?";
      filterParams = [institution.id];
    } else if (req.user?.role === "school" && institution) {
      filterSql = "WHERE si.id = ?";
      filterParams = [institution.id];
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS count FROM recommendations r ${joinSql} ${filterSql}`,
      filterParams,
    );
    const totalRows = countRows[0].count;

    const [rows] = await pool.query(
      `SELECT
        r.id, r.status, r.createdAt,
        su.id AS submittedBy_id,
        si.id AS si_id, si.name AS si_name, si.address AS si_address, si.phone AS si_phone, si.email AS si_email,
        sic.id AS sic_id, sic.name AS sic_name,
        sip.id AS sip_id, sip.name AS sip_name,
        st.id AS student_id, st.nis AS student_nis, st.schoolYear AS student_schoolYear, st.semester AS student_semester,
        sti.id AS sti_id, sti.name AS sti_name, sti.address AS sti_address, sti.phone AS sti_phone, sti.email AS sti_email,
        stic.id AS stic_id, stic.name AS stic_name,
        stip.id AS stip_id, stip.name AS stip_name,
        cl.id AS class_id, cl.name AS class_name,
        fm.id AS fm_id, fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate, fm.gender AS fm_gender, fm.familyId AS fm_familyId,
        se.id AS se_id, se.address AS se_address
      FROM recommendations r
      ${joinSql}
      ${filterSql}
      ORDER BY r.createdAt ASC
      LIMIT ? OFFSET ?`,
      [...filterParams, limit, offset],
    );

    const familyMemberIds = [...new Set(rows.filter((row) => row.fm_id).map((row) => row.fm_id))];
    let nutritionRows = [];
    if (familyMemberIds.length > 0) {
      const [nRows] = await pool.query(
        `SELECT n.id, n.familyMemberId, ns.id AS ns_id, ns.information AS ns_information
         FROM nutritions n
         LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
         WHERE n.familyMemberId IN (?)`,
        [familyMemberIds],
      );
      nutritionRows = nRows;
    }
    const nutritionByFamilyMember = new Map();
    for (const n of nutritionRows) {
      const list = nutritionByFamilyMember.get(n.familyMemberId) || [];
      list.push({
        id: n.id,
        nutritionStatus: n.ns_id ? { id: n.ns_id, information: n.ns_information } : null,
      });
      nutritionByFamilyMember.set(n.familyMemberId, list);
    }

    const recomend = rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      submittedBy: row.submittedBy_id
        ? {
            id: row.submittedBy_id,
            institution: row.si_id
              ? {
                  id: row.si_id,
                  name: row.si_name,
                  address: row.si_address,
                  phone: row.si_phone,
                  email: row.si_email,
                  city: row.sic_id ? { id: row.sic_id, name: row.sic_name } : null,
                  province: row.sip_id ? { id: row.sip_id, name: row.sip_name } : null,
                }
              : null,
          }
        : null,
      student: row.student_id
        ? {
            id: row.student_id,
            nis: row.student_nis,
            schoolYear: row.student_schoolYear,
            semester: row.student_semester,
            institution: row.sti_id
              ? {
                  id: row.sti_id,
                  name: row.sti_name,
                  address: row.sti_address,
                  phone: row.sti_phone,
                  email: row.sti_email,
                  city: row.stic_id ? { id: row.stic_id, name: row.stic_name } : null,
                  province: row.stip_id ? { id: row.stip_id, name: row.stip_name } : null,
                }
              : null,
            class: row.class_id ? { id: row.class_id, name: row.class_name } : null,
            familyMember: row.fm_id
              ? {
                  id: row.fm_id,
                  fullName: row.fm_fullName,
                  birthDate: row.fm_birthDate,
                  gender: row.fm_gender,
                  familyId: row.fm_familyId,
                  SocioEconomic: row.se_id ? { address: row.se_address } : null,
                  nutrition: nutritionByFamilyMember.get(row.fm_id) || [],
                }
              : null,
          }
        : null,
    }));

    const totalPage = Math.ceil(totalRows / limit);

    return successResponse(
      res,
      { totalRows, totalPage, page, limit, recomend },
      "List of recommendations retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Internal server error");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS (2 tests in the `getRecomendations` describe block).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "refactor: convert getRecomendations to raw mysql2 queries"
```

---

### Task 26: `createRecommendation` — conditional WHERE construction (undefined `studentId` guard) + notifications

**Files:**
- Modify: `src/controllers/RecommendationController.js`
- Modify: `src/controllers/__tests__/RecommendationController.test.js` (append a new `describe("createRecommendation", ...)` block)

**Interfaces:**
- Replaces `createRecommendation` with a `pool.query`-backed version, same signature.
- Key conversion nuance: Prisma silently drops `undefined` where-keys, so the original `prisma.student.findFirst({ where: { id: studentId, familyMemberId } })` only applies the `id` filter when `studentId !== undefined`. In raw SQL this must be built conditionally in JS — binding `undefined` as a mysql2 param throws (`Bind parameters must not contain undefined`), and binding `null` would change the query's meaning (`id = NULL` never matches, whereas Prisma's dropped-key behavior means "no `id` filter at all"). So the query text itself must change based on whether `studentId` is present, not just the bound value.
- `randomUUID()` generates `Recommendation.id`. `createdAt`/`updatedAt` are set explicitly to the same `new Date()` in JS (the schema uses `@default(now())`, not `@updatedAt`, so nothing else may ever touch `updatedAt` again after this insert) — this lets the handler return the exact created row without a re-select, matching Prisma's `create()` return shape.

- [ ] **Step 1: Write the failing tests**

Append to `src/controllers/__tests__/RecommendationController.test.js` (add `createRecommendation` and `randomUUID` to the existing imports — `import { getRecomendations, createRecommendation } from "../RecommendationController.js";`; mock `node:crypto` at the top alongside the `db.js` mock: `vi.mock("node:crypto", () => ({ randomUUID: vi.fn(() => "rec-uuid-1") }));` then `import { randomUUID } from "node:crypto";`):

```js
describe("createRecommendation", () => {
  const baseReq = () => ({
    user: { id: "user-school-1", role: "school" },
    body: { familyMemberId: "fm-1", healthCareId: "5" },
  });

  it("creates a recommendation when studentId is omitted from the body (undefined-key guard)", async () => {
    const req = baseReq(); // no studentId in body
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "st-1", familyMemberId: "fm-1", fm_fullName: "Budi" }], []]) // student lookup
      .mockResolvedValueOnce([[], []]) // existing PENDING/PROCESSED check -> none
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // insert
      .mockResolvedValueOnce([[{ id: 5, name: "Puskesmas A", user_id: "user-health-1" }], []]) // healthcare institution + user
      .mockResolvedValueOnce([[{ id: 9, name: "SD Negeri 1" }], []]) // submitting school's own institution
      .mockResolvedValueOnce([[{ id: "fm-1", fullName: "Budi", family_id: "fam-1", user_id: "user-parent-1" }], []]); // family member -> family -> user

    await createRecommendation(req, res);

    const [studentSql, studentParams] = pool.query.mock.calls[0];
    expect(studentSql).toContain("FROM students s");
    expect(studentSql).not.toContain("AND s.id = ?");
    expect(studentParams).toEqual(["fm-1"]);

    expect(pool.query.mock.calls[1][0]).toContain("status IN (?)");
    expect(pool.query.mock.calls[1][1]).toEqual(["st-1", ["PENDING", "PROCESSED"]]);

    expect(pool.query.mock.calls[2][0]).toContain("INSERT INTO recommendations");
    expect(pool.query.mock.calls[2][1]).toEqual([
      "rec-uuid-1",
      "st-1",
      "user-school-1",
      5,
      "PENDING",
      null,
      expect.any(Date),
      expect.any(Date),
    ]);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.data.id).toBe("rec-uuid-1");
    expect(data.data.status).toBe("PENDING");
  });

  it("includes s.id = ? when studentId IS present in the body", async () => {
    const req = baseReq();
    req.body.studentId = "st-2";
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "st-2", familyMemberId: "fm-1", fm_fullName: "Budi" }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[], []]) // no healthCareId row match -> not exercised since healthCareId given; kept for call-count symmetry
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]);

    await createRecommendation(req, res);

    const [studentSql, studentParams] = pool.query.mock.calls[0];
    expect(studentSql).toContain("AND s.id = ?");
    expect(studentParams).toEqual(["fm-1", "st-2"]);
  });

  it("returns the guard-clause response (actual HTTP 500, per ResponseHelper's real arg order) when the user is not a school", async () => {
    const req = { user: { id: "u1", role: "healthcare" }, body: {} };
    const res = mockRes();

    await createRecommendation(req, res);

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("error");
    expect(data.error).toBe(403);
    expect(data.message).toBe("User is not associated with an institution");
  });

  it("returns the guard-clause response when a PENDING/PROCESSED recommendation already exists for the student", async () => {
    const req = baseReq();
    req.body.studentId = "st-1";
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "st-1", familyMemberId: "fm-1", fm_fullName: "Budi" }], []])
      .mockResolvedValueOnce([[{ id: "existing-rec" }], []]); // existing found

    await createRecommendation(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.error).toBe(400);
    expect(data.message).toBe("Murid ini sudah direkomendasikan sebelumnya");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — `createRecommendation` still uses Prisma; import of `createRecommendation` also fails until exported correctly against the new mocks.

- [ ] **Step 3: Implement**

Replace `createRecommendation` with:
```js
export const createRecommendation = async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "school") {
      return errorResponse(
        res,
        403,
        "User is not associated with an institution",
      );
    }

    const { familyMemberId, studentId, healthCareId } = req.body;
    if (!familyMemberId) {
      return errorResponse(res, 400, "familyMemberId is required");
    }

    let studentSql = `
      SELECT s.id, s.familyMemberId, fm.fullName AS fm_fullName
      FROM students s
      LEFT JOIN family_members fm ON fm.id = s.familyMemberId
      WHERE s.familyMemberId = ?
    `;
    const studentParams = [familyMemberId];
    if (studentId !== undefined) {
      studentSql += " AND s.id = ?";
      studentParams.push(studentId);
    }
    studentSql += " LIMIT 1";

    const [studentRows] = await pool.query(studentSql, studentParams);
    const student = studentRows[0];

    if (!student) {
      return errorResponse(res, 404, "Student (anak) not found");
    }

    const [existingRows] = await pool.query(
      "SELECT id FROM recommendations WHERE studentId = ? AND status IN (?)",
      [student.id, ["PENDING", "PROCESSED"]],
    );

    if (existingRows[0]) {
      return errorResponse(
        res,
        400,
        "Murid ini sudah direkomendasikan sebelumnya",
      );
    }

    const id = randomUUID();
    const now = new Date();
    const healthcareInstitutionId = healthCareId ? Number(healthCareId) : null;

    await pool.query(
      `INSERT INTO recommendations
        (id, studentId, submittedById, healthcareInstitutionId, status, pdfUrl, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, student.id, user.id, healthcareInstitutionId, "PENDING", null, now, now],
    );

    const recommendation = {
      id,
      studentId: student.id,
      submittedById: user.id,
      healthcareInstitutionId,
      status: "PENDING",
      pdfUrl: null,
      createdAt: now,
      updatedAt: now,
    };

    // Notifikasi ke puskesmas
    let healthcareInstitution = null;
    if (healthCareId) {
      const [hcRows] = await pool.query(
        `SELECT i.id, i.name, u.id AS user_id
         FROM institutions i
         LEFT JOIN users u ON u.id = i.user_id
         WHERE i.id = ? LIMIT 1`,
        [Number(healthCareId)],
      );
      healthcareInstitution = hcRows[0] || null;
    }

    if (healthcareInstitution?.user_id) {
      const [schoolInstRows] = await pool.query(
        "SELECT id, name FROM institutions WHERE user_id = ? LIMIT 1",
        [user.id],
      );
      const schoolInstitution = schoolInstRows[0] || null;

      await createNotification(
        healthcareInstitution.user_id,
        "Rekomendasi Baru",
        `Siswa ${student.fm_fullName || "tersebut"} dari ${
          schoolInstitution?.name || "sekolah"
        } telah direkomendasikan untuk penanganan gizi. Silakan ditindaklanjuti.`,
        "recommendation_received",
        recommendation.id,
      );
    }

    // Notifikasi ke parent siswa
    const [familyMemberRows] = await pool.query(
      `SELECT fm.id, fm.fullName, f.id AS family_id, u.id AS user_id
       FROM family_members fm
       LEFT JOIN families f ON f.id = fm.familyId
       LEFT JOIN users u ON u.id = f.userId
       WHERE fm.id = ? LIMIT 1`,
      [student.familyMemberId],
    );
    const familyMember = familyMemberRows[0];

    if (familyMember?.user_id) {
      await createNotification(
        familyMember.user_id,
        "Rekomendasi Dikirim",
        `Ananda ${familyMember.fullName} telah direkomendasikan ke Puskesmas ${
          healthcareInstitution?.name || "puskesmas"
        } untuk pemeriksaan lanjutan. Silakan pantau perkembangannya.`,
        "recommendation_sent",
        recommendation.id,
      );
    }

    return successResponse(
      res,
      recommendation,
      "Recommendation created successfully",
    );
  } catch (error) {
    console.error(error);
    return errorResponse(res, error, "Failed to create recommendation");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS (`getRecomendations` block still green, all 4 new `createRecommendation` tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "refactor: convert createRecommendation to raw mysql2, guard undefined studentId explicitly"
```

---

### Task 27: `changeStatusToProcessed` — UPDATE with manual affectedRows guard

**Files:**
- Modify: `src/controllers/RecommendationController.js`
- Modify: `src/controllers/__tests__/RecommendationController.test.js` (append `describe("changeStatusToProcessed", ...)`)

**Interfaces:**
- Replaces `changeStatusToProcessed` with a `pool.query`-backed version, same signature.
- Prisma's `.update({ where: { id } })` throws `P2025` when no row matches; raw `UPDATE ... WHERE id = ?` does not throw natively on zero rows affected — must check `result.affectedRows === 0` and throw explicitly to replicate that behavior (caught by the existing `catch` block, which calls `errorResponse` — a real error object this time, so the guard-clause arg-order quirk does not apply here: statusCode is correctly `500`, matching original Prisma behavior where `P2025` also fell into this same catch and returned 500).
- `UPDATE` statement only sets `status` — must NOT touch `updatedAt` (no `@updatedAt` in the schema; nothing else ever sets it after insert).

- [ ] **Step 1: Write the failing tests**

Append to the test file (add `changeStatusToProcessed` to the controller import):

```js
describe("changeStatusToProcessed", () => {
  it("updates status and re-selects the row", async () => {
    const req = { params: { id: "rec-1" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
      .mockResolvedValueOnce([[{ id: "rec-1", status: "PROCESSED" }], []]); // re-select

    await changeStatusToProcessed(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE recommendations SET status = ? WHERE id = ?"),
      ["PROCESSED", "rec-1"],
    );
    expect(pool.query.mock.calls[0][0]).not.toContain("updatedAt");
    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.data).toEqual({ id: "rec-1", status: "PROCESSED" });
    expect(data.message).toBe("Berhasil dimasukan ke dalam antrian proses");
  });

  it("errors when the recommendation id does not exist (affectedRows === 0)", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

    await changeStatusToProcessed(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1); // no re-select attempted
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.message).toBe("Gagal memasukan ke dalam antrian proses");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — old Prisma implementation still in place.

- [ ] **Step 3: Implement**

Replace `changeStatusToProcessed` with:
```js
export const changeStatusToProcessed = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await pool.query(
      "UPDATE recommendations SET status = ? WHERE id = ?",
      ["PROCESSED", id],
    );

    if (result.affectedRows === 0) {
      throw new Error(`No 'Recommendation' record(s) found for id ${id}.`);
    }

    const [rows] = await pool.query(
      "SELECT * FROM recommendations WHERE id = ? LIMIT 1",
      [id],
    );

    return successResponse(
      res,
      rows[0],
      "Berhasil dimasukan ke dalam antrian proses",
    );
  } catch (error) {
    return errorResponse(res, error, "Gagal memasukan ke dalam antrian proses");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS (all prior blocks + 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "refactor: convert changeStatusToProcessed to raw mysql2 with manual affectedRows guard"
```

---

### Task 28: `getResponseParent` — BUG FIX (undefined `id` ReferenceError + un-scoped answers query)

**Files:**
- Modify: `src/controllers/RecommendationController.js`
- Modify: `src/controllers/__tests__/RecommendationController.test.js` (append `describe("getResponseParent", ...)`)

**Interfaces:**
- Replaces `getResponseParent` with a `pool.query`-backed version, same signature. This is one of the two approved bug fixes.

**Bug context (read carefully before implementing):** in the current source, `getResponseParent` destructures `const { userId } = req.body;` but then queries `prisma.question.findMany({ where: { quesioner_id: id, ... } })` — `id` is never declared anywhere in this function (no `req.params` destructure exists), so every call throws `ReferenceError: id is not defined` and the endpoint always 500s. Approved fix: replace that bare `id` with `userId`.

That fix alone exposes a second, previously-latent bug: `response` is an array (`prisma.response.findMany(...)`, i.e. potentially many responses for this family member across different questionnaires), yet the subsequent `answer.count`/`answer.findMany` calls filter only by `questionId: { in: questionIds }` — they never scope by `responseId` at all. In the original code this was because `response.id` (an array has no `.id`) was `undefined`, and Prisma silently drops `undefined` where-keys — so the missing scoping was itself just a symptom of the same variable confusion. Once `id` is corrected to `userId`, the sensible reading of the surrounding code is: fetch all of this family member's responses, then find the ONE response whose `quisionerId` matches the target quesioner (now identified via `userId` per the approved fix — the field is unfortunately named `userId` in the request body but is being used as a quesioner id, per the product decision already made), and scope the answer queries to that specific `response.id`. This task implements that full fix (not just the minimal rename) — anything less would leave the endpoint "working" but returning nonsensical unscoped answers, which does not meet the "ship a working, sensible endpoint" bar.

Two additional, purely mechanical raw-SQL requirements (true regardless of the bug fix): (a) `IN (?)` with an empty JS array produces invalid SQL (`IN ()`) via mysql2 — the options-per-question and answers-scoped-by-response queries must guard `questionIds.length > 0` before executing; (b) `title: { contains: search }` becomes a parameterized `LIKE ?` with `%${search}%` — never string-concatenate `search` into the SQL text itself.

- [ ] **Step 1: Write the failing tests**

Append to the test file (add `getResponseParent` to the controller import):

```js
describe("getResponseParent", () => {
  it("scopes answers to the response matching the requested quesioner (full bug fix)", async () => {
    const req = {
      body: { userId: 42 },
      query: { page: "0", limit: "10", search: "" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1" }], []]) // family lookup
      .mockResolvedValueOnce([[{ id: "fm-1" }], []]) // familyMember (IBU/AYAH) lookup
      .mockResolvedValueOnce([
        [
          { id: "resp-other", quisionerId: 99 },
          { id: "resp-match", quisionerId: 42 },
        ],
        [],
      ]) // responses for this family member (array, unscoped fetch preserved)
      .mockResolvedValueOnce([[{ id: 1, quesioner_id: 42, title: "Q1", type: "SCALE" }], []]) // questions
      .mockResolvedValueOnce([[{ id: 10, question_id: 1, title: "Opt A", score: 1 }], []]) // options
      .mockResolvedValueOnce([[{ count: 1 }], []]) // answers count, scoped
      .mockResolvedValueOnce([[{ id: 100, responseId: "resp-match", questionId: 1 }], []]); // answers, scoped

    await getResponseParent(req, res);

    expect(pool.query.mock.calls[0][1]).toEqual([42]);
    expect(pool.query.mock.calls[3][0]).toContain("quesioner_id = ?");
    expect(pool.query.mock.calls[3][1]).toEqual([42, "%%"]);

    const countCall = pool.query.mock.calls[5];
    expect(countCall[0]).toContain("responseId = ?");
    expect(countCall[0]).toContain("questionId IN (?)");
    expect(countCall[1]).toEqual(["resp-match", [1]]);

    const answersCall = pool.query.mock.calls[6];
    expect(answersCall[1]).toEqual(["resp-match", [1], 10, 0]);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.data.questions[0].options).toEqual([{ id: 10, title: "Opt A", score: 1 }]);
    expect(data.data.answers).toEqual([{ id: 100, responseId: "resp-match", questionId: 1 }]);
  });

  it("returns empty answers/totalRows=0 without querying when no response matches the quesioner", async () => {
    const req = { body: { userId: 7 }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1" }], []])
      .mockResolvedValueOnce([[{ id: "fm-1" }], []])
      .mockResolvedValueOnce([[{ id: "resp-other", quisionerId: 99 }], []]) // no match for quesionerId 7
      .mockResolvedValueOnce([[{ id: 1, quesioner_id: 7, title: "Q1", type: "SCALE" }], []])
      .mockResolvedValueOnce([[], []]); // options (empty, guarded)

    await getResponseParent(req, res);

    expect(pool.query).toHaveBeenCalledTimes(5); // no count/answers queries executed
    const [data] = res.json.mock.calls[0];
    expect(data.data.totalRows).toBe(0);
    expect(data.data.answers).toEqual([]);
  });

  it("returns the guard-clause response (actual HTTP 500) when no family is found", async () => {
    const req = { body: { userId: 1 }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no family

    await getResponseParent(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.error).toBe(404);
    expect(data.message).toBe("Family not found");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — old Prisma implementation still in place (and still contains the `ReferenceError`-inducing bare `id`).

- [ ] **Step 3: Implement**

Replace `getResponseParent` with:
```js
export const getResponseParent = async (req, res) => {
  try {
    const { userId } = req.body;
    const quesionerId = userId;

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [familyRows] = await pool.query(
      "SELECT id FROM families WHERE userId = ? LIMIT 1",
      [userId],
    );
    const family = familyRows[0];

    if (!family) {
      return errorResponse(res, 404, "Family not found");
    }

    const [familyMemberRows] = await pool.query(
      `SELECT id FROM family_members
       WHERE familyId = ? AND (relation = 'IBU' OR relation = 'AYAH')
       LIMIT 1`,
      [family.id],
    );
    const familyMember = familyMemberRows[0];

    if (!familyMember) {
      return errorResponse(res, 404, "Family member not found");
    }

    const [responses] = await pool.query(
      "SELECT id, quisionerId FROM responses WHERE familyMemberId = ?",
      [familyMember.id],
    );

    const [questions] = await pool.query(
      `SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ?`,
      [quesionerId, `%${search}%`],
    );

    const questionIds = questions.map((q) => q.id);
    const optionsByQuestion = new Map();
    if (questionIds.length > 0) {
      const [optionRows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds],
      );
      for (const o of optionRows) {
        const list = optionsByQuestion.get(o.question_id) || [];
        list.push({ id: o.id, title: o.title, score: o.score });
        optionsByQuestion.set(o.question_id, list);
      }
    }
    const questionsWithOptions = questions.map((q) => ({
      id: q.id,
      quesioner_id: q.quesioner_id,
      title: q.title,
      type: q.type,
      options: optionsByQuestion.get(q.id) || [],
    }));

    // The response actually relevant to this quesioner (fixes the latent
    // un-scoped-answers bug that shipped alongside the `id` ReferenceError).
    const targetResponse = responses.find((r) => r.quisionerId === quesionerId);

    let totalRows = 0;
    let answers = [];
    if (targetResponse && questionIds.length > 0) {
      const [countRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM answers WHERE responseId = ? AND questionId IN (?)",
        [targetResponse.id, questionIds],
      );
      totalRows = countRows[0].count;

      const [answerRows] = await pool.query(
        `SELECT * FROM answers WHERE responseId = ? AND questionId IN (?)
         ORDER BY id ASC LIMIT ? OFFSET ?`,
        [targetResponse.id, questionIds, limit, offset],
      );
      answers = answerRows;
    }

    const totalPage = Math.ceil(totalRows / limit);

    return successResponse(
      res,
      {
        totalRows,
        totalPage,
        page,
        limit,
        questions: questionsWithOptions,
        answers,
      },
      "Berhasil mendapatkan data",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};
```

Note: `quesioner_id` is an `Int` column while `userId`/`quesionerId` here is whatever the client sent as `req.body.userId` (a User id, typically a UUID string, per the product decision already made to reuse this field). This mismatch is a known consequence of the approved fix, not a new bug introduced by this conversion — it will typically just yield zero matching questions rather than crashing, which satisfies "ship a working endpoint."

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS (all prior blocks + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "fix: getResponseParent ReferenceError (id -> userId) and scope answers to the matching response"
```

---

### Task 29: `getResponseInstitution` — clean conversion (no bugs, paired empty-array guard)

**Files:**
- Modify: `src/controllers/RecommendationController.js`
- Modify: `src/controllers/__tests__/RecommendationController.test.js` (append `describe("getResponseInstitution", ...)`)

**Interfaces:**
- Replaces `getResponseInstitution` with a `pool.query`-backed version, same signature. This handler has no logic bugs in the original — convert it faithfully, including the same empty-`questionIds` SQL-safety guard applied in Task 28 (mysql2's `IN (?)` with an empty array is invalid SQL; the original Prisma code tolerated an empty `in: []` array silently, so the guard is required here purely to avoid a raw-SQL crash, not to change behavior — an empty `questionIds` array already implies zero possible answers).
- Guard-clause note: `errorResponse(res, 404, "Institution not found")` and `errorResponse(res, 404, "Response not found")` both resolve to actual HTTP `500` per the arg-order quirk documented in Task 25 — preserve, do not fix.

- [ ] **Step 1: Write the failing tests**

Append to the test file (add `getResponseInstitution` to the controller import):

```js
describe("getResponseInstitution", () => {
  it("returns paginated answers scoped by responseId and questionId", async () => {
    const req = {
      body: { userId: "user-inst-1" },
      params: { id: "3" },
      query: { page: "0", limit: "10", search: "" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 8 }], []]) // institution lookup
      .mockResolvedValueOnce([[{ id: "resp-1" }], []]) // response lookup
      .mockResolvedValueOnce([[{ id: 1, quesioner_id: 3, title: "Q1", type: "BOOLEAN" }], []]) // questions
      .mockResolvedValueOnce([[{ id: 11, question_id: 1, title: "Ya", score: 1 }], []]) // options
      .mockResolvedValueOnce([[{ count: 2 }], []]) // answers count
      .mockResolvedValueOnce([[{ id: 200, responseId: "resp-1", questionId: 1 }], []]); // answers

    await getResponseInstitution(req, res);

    expect(pool.query.mock.calls[2][1]).toEqual([3, "%%"]);
    expect(pool.query.mock.calls[4][1]).toEqual(["resp-1", [1]]);
    expect(pool.query.mock.calls[5][1]).toEqual(["resp-1", [1], 10, 0]);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.data.totalRows).toBe(2);
    expect(data.data.answers).toEqual([{ id: 200, responseId: "resp-1", questionId: 1 }]);
  });

  it("skips the answers query when no questions match (empty questionIds guard)", async () => {
    const req = { body: { userId: "user-inst-1" }, params: { id: "3" }, query: {} };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ id: 8 }], []])
      .mockResolvedValueOnce([[{ id: "resp-1" }], []])
      .mockResolvedValueOnce([[], []]); // no questions

    await getResponseInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const [data] = res.json.mock.calls[0];
    expect(data.data.totalRows).toBe(0);
    expect(data.data.answers).toEqual([]);
  });

  it("returns the guard-clause response (actual HTTP 500) when the institution is not found", async () => {
    const req = { body: { userId: "no-such-user" }, params: { id: "3" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await getResponseInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.error).toBe(404);
    expect(data.message).toBe("Institution not found");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — old Prisma implementation still in place.

- [ ] **Step 3: Implement**

Replace `getResponseInstitution` with:
```js
export const getResponseInstitution = async (req, res) => {
  try {
    const { userId } = req.body;
    const quesionerId = Number(req.params.id);

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = limit * page;

    const [institutionRows] = await pool.query(
      "SELECT id FROM institutions WHERE user_id = ? LIMIT 1",
      [userId],
    );
    const institution = institutionRows[0];

    if (!institution) {
      return errorResponse(res, 404, "Institution not found");
    }

    const [responseRows] = await pool.query(
      "SELECT id FROM responses WHERE institutionId = ? LIMIT 1",
      [institution.id],
    );
    const response = responseRows[0];

    if (!response) {
      return errorResponse(res, 404, "Response not found");
    }

    const [questions] = await pool.query(
      `SELECT id, quesioner_id, title, type FROM questions WHERE quesioner_id = ? AND title LIKE ?`,
      [quesionerId, `%${search}%`],
    );

    const questionIds = questions.map((q) => q.id);
    const optionsByQuestion = new Map();
    if (questionIds.length > 0) {
      const [optionRows] = await pool.query(
        "SELECT id, question_id, title, score FROM options WHERE question_id IN (?)",
        [questionIds],
      );
      for (const o of optionRows) {
        const list = optionsByQuestion.get(o.question_id) || [];
        list.push({ id: o.id, title: o.title, score: o.score });
        optionsByQuestion.set(o.question_id, list);
      }
    }
    const questionsWithOptions = questions.map((q) => ({
      id: q.id,
      quesioner_id: q.quesioner_id,
      title: q.title,
      type: q.type,
      options: optionsByQuestion.get(q.id) || [],
    }));

    let totalRows = 0;
    let answers = [];
    if (questionIds.length > 0) {
      const [countRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM answers WHERE responseId = ? AND questionId IN (?)",
        [response.id, questionIds],
      );
      totalRows = countRows[0].count;

      const [answerRows] = await pool.query(
        `SELECT * FROM answers WHERE responseId = ? AND questionId IN (?)
         ORDER BY id ASC LIMIT ? OFFSET ?`,
        [response.id, questionIds, limit, offset],
      );
      answers = answerRows;
    }

    const totalPage = Math.ceil(totalRows / limit);

    return successResponse(
      res,
      {
        totalRows,
        totalPage,
        page,
        limit,
        questions: questionsWithOptions,
        answers,
      },
      "Berhasil mendapatkan data",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get response");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS (all prior blocks + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "refactor: convert getResponseInstitution to raw mysql2"
```

---

### Task 30: `createIntervention` — THE transaction (bulk two-row insert + status update, commit/rollback)

**Files:**
- Modify: `src/controllers/RecommendationController.js`
- Modify: `src/controllers/__tests__/RecommendationController.test.js` (append `describe("createIntervention", ...)`)

**Interfaces:**
- Replaces `createIntervention` with a `pool.getConnection()`-backed transaction, same signature.
- Guard clauses (`user.role !== "healthcare"`, missing `id` param) run **before** `pool.getConnection()` is ever called — mirrors the original, where these checks happen before `prisma.$transaction(...)` is invoked, so no connection/transaction is opened for those failure paths. Tests must assert `pool.getConnection` was NOT called for guard-clause cases.
- `content` is Prisma's `Json` field on `Intervention.options` — Prisma auto-serializes on write; mysql2 does not, so `JSON.stringify(content)` must be applied explicitly to both inserted rows.
- Bulk insert: ONE `INSERT ... VALUES (...), (...)` with two value tuples — one for the request's `forType`, one for the opposite (`forType === "PARENT" ? "SCHOOL" : "PARENT"`) — each with its own `randomUUID()`.
- `UPDATE recommendations SET status = 'COMPLETED' WHERE id = ?` runs inside the same transaction, after the insert, before commit.
- The response's `data` field must be `{ count: insertResult.affectedRows }` — matching Prisma's `createMany()` return shape (a count, NOT the created rows) — preserve this exactly; do not "improve" it into returning the actual rows.
- After `commit()`, two more plain (non-transactional) `pool.query` lookups run for the parent notification — these use `pool` directly, not the transaction connection, and must still execute even though the transaction already committed.
- On any error after `beginTransaction()`, `connection.rollback()` must run, and `connection.release()` must always run in a `finally` block (whether or not a connection was ever acquired).

- [ ] **Step 1: Write the failing tests**

Append to the test file (add `createIntervention` to the controller import; extend the `node:crypto` mock's `randomUUID` to return values in sequence — `vi.mock("node:crypto", () => ({ randomUUID: vi.fn() }));` then per-test `randomUUID.mockReturnValueOnce("iv-uuid-1").mockReturnValueOnce("iv-uuid-2")`; this replaces the single fixed-value mock from Task 26 — update that test's expectation to use `randomUUID.mockReturnValueOnce("rec-uuid-1")` instead of the mock factory's default):

```js
describe("createIntervention", () => {
  it("bulk-inserts both intervention rows, marks the recommendation COMPLETED, commits, and notifies the parent", async () => {
    const req = {
      user: { id: "user-health-1", role: "healthcare" },
      params: { id: "rec-1" },
      body: { content: { note: "periksa gizi" }, forType: "PARENT", notes: "catatan" },
    };
    const res = mockRes();

    randomUUID.mockReturnValueOnce("iv-uuid-1").mockReturnValueOnce("iv-uuid-2");

    const mockConnection = {
      beginTransaction: vi.fn(),
      query: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    pool.getConnection.mockResolvedValueOnce(mockConnection);
    mockConnection.query
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // bulk INSERT
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE status

    pool.query
      .mockResolvedValueOnce([
        [{ id: "rec-1", fm_id: "fm-1", fm_fullName: "Budi", parent_user_id: "user-parent-1" }],
        [],
      ]) // recommendation -> student -> familyMember -> family -> user
      .mockResolvedValueOnce([[{ institution_name: "Kecamatan A" }], []]); // puskesmas institution name

    await createIntervention(req, res);

    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(mockConnection.beginTransaction).toHaveBeenCalledTimes(1);

    const [insertSql, insertParams] = mockConnection.query.mock.calls[0];
    expect(insertSql).toContain("INSERT INTO interventions");
    expect(insertParams).toEqual([
      "iv-uuid-1", "rec-1", "PARENT", JSON.stringify({ note: "periksa gizi" }), "catatan", expect.any(Date), "user-health-1",
      "iv-uuid-2", "rec-1", "SCHOOL", JSON.stringify({ note: "periksa gizi" }), "catatan", expect.any(Date), "user-health-1",
    ]);

    expect(mockConnection.query.mock.calls[1][0]).toContain("UPDATE recommendations SET status = ? WHERE id = ?");
    expect(mockConnection.query.mock.calls[1][1]).toEqual(["COMPLETED", "rec-1"]);

    expect(mockConnection.commit).toHaveBeenCalledTimes(1);
    expect(mockConnection.rollback).not.toHaveBeenCalled();
    expect(mockConnection.release).toHaveBeenCalledTimes(1);

    expect(res.status).toHaveBeenCalledWith(201);
    const [data] = res.json.mock.calls[0];
    expect(data.status).toBe("Success");
    expect(data.data).toEqual({ count: 2 });
  });

  it("returns the guard-clause response without opening a connection when the user is not healthcare", async () => {
    const req = { user: { id: "u1", role: "school" }, params: { id: "rec-1" }, body: {} };
    const res = mockRes();

    await createIntervention(req, res);

    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.message).toBe("Failed to get response");
  });

  it("rolls back and releases the connection when the transaction fails", async () => {
    const req = {
      user: { id: "user-health-1", role: "healthcare" },
      params: { id: "rec-1" },
      body: { content: {}, forType: "PARENT", notes: null },
    };
    const res = mockRes();

    const mockConnection = {
      beginTransaction: vi.fn(),
      query: vi.fn().mockRejectedValueOnce(new Error("insert failed")),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    pool.getConnection.mockResolvedValueOnce(mockConnection);

    await createIntervention(req, res);

    expect(mockConnection.rollback).toHaveBeenCalledTimes(1);
    expect(mockConnection.commit).not.toHaveBeenCalled();
    expect(mockConnection.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — old Prisma implementation still in place.

- [ ] **Step 3: Implement**

Replace `createIntervention` with:
```js
export const createIntervention = async (req, res) => {
  let connection;
  try {
    const user = req.user;
    if (user.role !== "healthcare") {
      throw new Error("User not have access to this resource");
    }
    const { id } = req.params;
    if (!id) {
      throw new Error("RecommendationId is required in params");
    }
    const { content, forType, notes } = req.body;

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const oppositeForType = forType === "PARENT" ? "SCHOOL" : "PARENT";
    const serializedOptions = JSON.stringify(content);
    const now = new Date();

    const [insertResult] = await connection.query(
      `INSERT INTO interventions
        (id, recommendationId, forType, options, notes, createdAt, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), id, forType, serializedOptions, notes, now, user.id,
        randomUUID(), id, oppositeForType, serializedOptions, notes, now, user.id,
      ],
    );

    await connection.query(
      "UPDATE recommendations SET status = ? WHERE id = ?",
      ["COMPLETED", id],
    );

    await connection.commit();

    const intervention = { count: insertResult.affectedRows };

    // Notifikasi ke parent (plain, non-transactional lookups after commit)
    const [recRows] = await pool.query(
      `SELECT r.id, fm.id AS fm_id, fm.fullName AS fm_fullName, u.id AS parent_user_id
       FROM recommendations r
       LEFT JOIN students st ON st.id = r.studentId
       LEFT JOIN family_members fm ON fm.id = st.familyMemberId
       LEFT JOIN families f ON f.id = fm.familyId
       LEFT JOIN users u ON u.id = f.userId
       WHERE r.id = ? LIMIT 1`,
      [id],
    );
    const recWithParent = recRows[0];

    if (recWithParent?.parent_user_id) {
      const [puskesmasRows] = await pool.query(
        `SELECT i.name AS institution_name
         FROM users u
         LEFT JOIN institutions i ON i.user_id = u.id
         WHERE u.id = ? LIMIT 1`,
        [user.id],
      );
      const rawName = puskesmasRows[0]?.institution_name || "";
      const puskesmasName = rawName
        ? rawName.toLowerCase().includes("puskesmas")
          ? rawName
          : `Puskesmas ${rawName}`
        : "Puskesmas";

      await createNotification(
        recWithParent.parent_user_id,
        "Tindak Lanjut Rekomendasi",
        `${puskesmasName} telah mengirimkan surat tindak lanjut untuk ${recWithParent.fm_fullName}. Silakan periksa halaman rekomendasi.`,
        "intervention_created",
        id,
      );
    }

    res.status(201).json({
      status: "Success",
      message: "Intervention created",
      data: intervention,
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
    }
    console.log(err.message);
    return errorResponse(res, err, "Failed to get response");
  } finally {
    if (connection) {
      connection.release();
    }
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS (all prior blocks + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "refactor: convert createIntervention to a raw mysql2 transaction"
```

---

### Task 31: `getSingleRecommendation` — BUG FIX (drop the nonexistent `residence` include)

**Files:**
- Modify: `src/controllers/RecommendationController.js`
- Modify: `src/controllers/__tests__/RecommendationController.test.js` (append `describe("getSingleRecommendation", ...)`)

**Interfaces:**
- Replaces `getSingleRecommendation` with a `pool.query`-backed version, same signature. This is the second approved bug fix.

**Bug context:** the current source includes `residence: true` under `student.familyMember`'s nested include (`prisma/schema.prisma`'s `FamilyMember` model has no `residence` relation or field at all — `FamilyMember` has `SocioEconomic` for address/residence-status data, but no relation literally named `residence`). Prisma throws `PrismaClientValidationError` on every call because the relation doesn't exist, so the endpoint always 500s. Approved fix: drop that key entirely — do not invent a substitute mapping for it (there is no valid data source for a `residence` key; `SocioEconomic` is a separate, already-differently-named concept and was never part of this endpoint's original shape).
- Preserves the original's lack of a not-found guard: `prisma.recommendation.findUnique` returns `null` for a missing id, and the original code never checked for that — it always responded `res.status(200).json({ ..., data: recommendation })`, i.e. `data: null` on a 200 when the id doesn't exist. Preserve this (do not add a 404 guard — that would be a behavior change beyond the approved fix list).
- Nested structure (all preserved, minus `residence`): `submittedBy.institution.name`, `Intervention[]` (to-many, separate query keyed by `recommendationId`), `student.class`, `student.familyMember.family.user.family.familyMember` (the "siblings" self-referential chain — literally: this family member's family → that family's owning user → that SAME user's own family record → that family's members; per the schema `Family.userId` is `@unique`, so mathematically the innermost family always resolves back to the same family as the outermost, but the query is written as the literal 4-hop chain to faithfully match the original Prisma `include`, not "simplified" into a single self-join). The nested-family id in the middle of that chain must be fetched as a plain scalar column in the main query (it is a 1:1 hop, safe to join inline) and the final `familyMember` array must come from a SEPARATE follow-up query keyed by that id, guarded for when it is absent — joining it inline would fan out the single main row into one row per sibling.

- [ ] **Step 1: Write the failing tests**

Append to the test file (add `getSingleRecommendation` to the controller import):

```js
describe("getSingleRecommendation", () => {
  it("returns the full nested shape with no residence key", async () => {
    const req = { params: { id: "rec-1" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([
        [
          {
            id: "rec-1",
            studentId: "st-1",
            submittedById: "user-school-1",
            healthcareInstitutionId: 5,
            status: "COMPLETED",
            pdfUrl: null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-02"),
            si_name: "SD Negeri 1",
            student_id: "st-1",
            student_nis: "12345",
            student_schoolYear: "2025/2026",
            student_semester: "1",
            student_classId: 9,
            class_id: 9,
            class_name: "5A",
            fm_id: "fm-1",
            fm_fullName: "Budi",
            fm_birthDate: new Date("2015-01-01"),
            fm_gender: "L",
            fm_relation: "ANAK",
            fm_familyId: "fam-1",
            family_id: "fam-1",
            user_id: "user-parent-1",
            user_family_id: "fam-1",
          },
        ],
        [],
      ]) // main row
      .mockResolvedValueOnce([[{ id: "iv-1", forType: "PARENT" }], []]) // Intervention[]
      .mockResolvedValueOnce([
        [{ id: "fm-1", fullName: "Budi", birthDate: new Date("2015-01-01"), gender: "L", relation: "ANAK" }],
        [],
      ]); // siblings

    await getSingleRecommendation(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const [data] = res.json.mock.calls[0];
    expect(data.data.submittedBy).toEqual({ institution: { name: "SD Negeri 1" } });
    expect(data.data.Intervention).toEqual([{ id: "iv-1", forType: "PARENT" }]);
    expect(data.data.student.familyMember).not.toHaveProperty("residence");
    expect(data.data.student.familyMember.family.user.family.familyMember).toEqual([
      { id: "fm-1", fullName: "Budi", birthDate: new Date("2015-01-01"), gender: "L", relation: "ANAK" },
    ]);
  });

  it("returns 200 with data: null when the recommendation id does not exist (no added 404 guard)", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no matching row -> no Intervention/siblings queries run

    await getSingleRecommendation(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    const [data] = res.json.mock.calls[0];
    expect(data.data).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — old Prisma implementation still in place (and still contains the invalid `residence` include).

- [ ] **Step 3: Implement**

Replace `getSingleRecommendation` with:
```js
export const getSingleRecommendation = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT
        r.id, r.studentId, r.submittedById, r.healthcareInstitutionId, r.status, r.pdfUrl, r.createdAt, r.updatedAt,
        si.name AS si_name,
        st.id AS student_id, st.nis AS student_nis, st.schoolYear AS student_schoolYear, st.semester AS student_semester, st.classId AS student_classId,
        cl.id AS class_id, cl.name AS class_name,
        fm.id AS fm_id, fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate, fm.gender AS fm_gender, fm.relation AS fm_relation, fm.familyId AS fm_familyId,
        f.id AS family_id,
        u.id AS user_id,
        uf.id AS user_family_id
      FROM recommendations r
      LEFT JOIN users su ON su.id = r.submittedById
      LEFT JOIN institutions si ON si.user_id = su.id
      LEFT JOIN students st ON st.id = r.studentId
      LEFT JOIN classes cl ON cl.id = st.classId
      LEFT JOIN family_members fm ON fm.id = st.familyMemberId
      LEFT JOIN families f ON f.id = fm.familyId
      LEFT JOIN users u ON u.id = f.userId
      LEFT JOIN families uf ON uf.userId = u.id
      WHERE r.id = ?
      LIMIT 1`,
      [id],
    );
    const row = rows[0];

    let recommendation = null;
    if (row) {
      const [interventionRows] = await pool.query(
        "SELECT * FROM interventions WHERE recommendationId = ?",
        [id],
      );

      let siblings = [];
      if (row.user_family_id) {
        const [siblingRows] = await pool.query(
          "SELECT id, fullName, birthDate, gender, relation FROM family_members WHERE familyId = ?",
          [row.user_family_id],
        );
        siblings = siblingRows;
      }

      recommendation = {
        id: row.id,
        studentId: row.studentId,
        submittedById: row.submittedById,
        healthcareInstitutionId: row.healthcareInstitutionId,
        status: row.status,
        pdfUrl: row.pdfUrl,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        submittedBy: { institution: row.si_name != null ? { name: row.si_name } : null },
        Intervention: interventionRows,
        student: row.student_id
          ? {
              id: row.student_id,
              nis: row.student_nis,
              schoolYear: row.student_schoolYear,
              semester: row.student_semester,
              classId: row.student_classId,
              class: row.class_id ? { id: row.class_id, name: row.class_name } : null,
              familyMember: row.fm_id
                ? {
                    id: row.fm_id,
                    fullName: row.fm_fullName,
                    birthDate: row.fm_birthDate,
                    gender: row.fm_gender,
                    relation: row.fm_relation,
                    familyId: row.fm_familyId,
                    family: row.family_id
                      ? {
                          id: row.family_id,
                          user: row.user_id
                            ? {
                                id: row.user_id,
                                family: row.user_family_id
                                  ? { id: row.user_family_id, familyMember: siblings }
                                  : null,
                              }
                            : null,
                        }
                      : null,
                  }
                : null,
            }
          : null,
      };
    }

    res.status(200).json({
      status: "Success",
      message: "Recommendation fetched",
      data: recommendation,
    });
  } catch (err) {
    console.log({ err });
    return errorResponse(res, err, "Failed to get response");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS (all prior blocks + 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "fix: getSingleRecommendation drop nonexistent residence include"
```

---

### Task 32: `getInterventionsBelongToInstitution` + `getInterventionsBelongToFamily` — preserved pagination bugs, `DISTINCT ON` via window function, preserved double-decode

**Files:**
- Modify: `src/controllers/RecommendationController.js`
- Modify: `src/controllers/__tests__/RecommendationController.test.js` (append `describe("getInterventionsBelongToInstitution", ...)` and `describe("getInterventionsBelongToFamily", ...)`)

**Interfaces:**
- Replaces both handlers with `pool.query`-backed versions, same signatures. Both have **pre-existing pagination bugs that are NOT on the approved fix list** — preserve them exactly:
  - Only `OFFSET` is ever applied; there is no `LIMIT` in the original Prisma call (no `take`). Express this in raw SQL with MySQL's "no limit" idiom: `LIMIT 18446744073709551615 OFFSET ?` (MySQL requires a `LIMIT` clause for `OFFSET` to be valid syntax; this constant is the documented way to mean "unbounded"). **Verify target MySQL/MariaDB version compatibility before relying on this** — it works on stock MySQL back to 5.x. This is unrelated to the window-function requirement below.
  - `totalPages` is computed from the LENGTH of the already-offset (but not limited) result array, not a true `COUNT(*)`. For `getInterventionsBelongToInstitution`: `Math.ceil(interventions.length / limit)`. For `getInterventionsBelongToFamily`: just `interventions.length` (no division at all — this asymmetry between the two handlers is itself part of the original bug and must be preserved as two DIFFERENT formulas, not unified).
- `getInterventionsBelongToInstitution` additionally used Prisma's `distinct: ["recommendationId"]` (keep only one intervention per recommendation — the original Prisma default keeps the first row per Prisma's internal ordering, but combined with `orderBy: { createdAt: "desc" }` the practical effect is "most recent per recommendation"). MySQL has no `DISTINCT ON`; reproduce with `ROW_NUMBER() OVER (PARTITION BY iv.recommendationId ORDER BY iv.createdAt DESC) AS rn` wrapped in a derived table, filtering `WHERE rn = 1` in the outer query. **This requires MySQL 8.0+ or MariaDB 10.2+ (window function support) — verify against the target server before shipping; if window functions are unavailable, fall back to a correlated subquery**: `WHERE iv.createdAt = (SELECT MAX(iv2.createdAt) FROM interventions iv2 WHERE iv2.recommendationId = iv.recommendationId)`, accepting that ties on `createdAt` would then return multiple rows (a window function does not have this tie problem, since `ROW_NUMBER()` always picks exactly one).
- The nested self-referential "siblings" chain (`recommendation.student.familyMember.family.user.family.familyMember`, same 4-hop chain as Task 31) must NOT be joined inline into the windowed/main query — doing so would fan out one row per sibling and corrupt both the `ROW_NUMBER()` partitioning (institution version) and the already-broken-but-must-stay-exactly-as-broken `interventions.length` count (family version). Fetch the nested family id as a scalar column in the main query (safe 1:1 hops), then batch-fetch siblings in a SEPARATE follow-up query keyed by the distinct set of those ids, guarding the empty-array case.
- Both map `options: JSON.parse(row.options)` in the response — exactly ONE explicit `JSON.parse` call in this JS code. This is intentionally "on top of" mysql2's own automatic JSON-column parse-on-read (mysql2 parses the `JSON` column type automatically, same as Prisma did) — the net effect across the two automatic+explicit decodes only produces the correct value because `options` was originally double-JSON-encoded at insert time (see Task 30: if a caller ever passes an already-stringified `content`, `JSON.stringify(content)` there wraps it a second time). Do not add a second explicit `JSON.parse` call and do not remove the one that is there — both would break the field for rows that rely on the historical double-encoding.
- Keyword filter (`fullName: { contains: keyword }`) only applies when `keyword !== ""`, exactly as in the original — append `AND fm.fullName LIKE ?` conditionally, parameterized as `%${keyword}%`.
- `getInterventionsBelongToInstitution`'s user-institution guard: `prisma.user.findUnique(...)` returning `null` (user id doesn't exist) is the only case the original guards against (`if (!userInstitution) throw ...`); if the user exists but has no institution, the original would actually throw a `TypeError` reading `.id` off `null` deeper in the code (a separate pre-existing bug, not on the approved fix list and not one this task changes). The raw-SQL LEFT JOIN version is null-safe where Prisma would have thrown — document this known minor divergence in a code comment rather than spending effort reproducing the crash; it is not part of any documented/tested behavior.

- [ ] **Step 1: Write the failing tests**

Append to the test file (add both function names to the controller import):

```js
describe("getInterventionsBelongToInstitution", () => {
  it("dedupes to one intervention per recommendation via ROW_NUMBER, applies OFFSET with no LIMIT, and preserves the length-based totalPages bug", async () => {
    const req = {
      user: { id: "user-health-1" },
      query: { page: "0", limit: "10", keyword: "" },
    };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []]) // userInstitution lookup
      .mockResolvedValueOnce([
        [
          {
            iv_id: "iv-1", iv_forType: "PARENT", iv_notes: "n", iv_options: JSON.stringify({ a: 1 }), iv_createdAt: new Date("2026-01-02"),
            r_id: "rec-1", r_status: "COMPLETED", r_createdAt: new Date("2026-01-01"),
            st_nis: "12345", cl_id: 9, cl_name: "5A",
            fm_fullName: "Budi", fm_birthDate: new Date("2015-01-01"), fm_gender: "L",
            se_address: "Jl. A", of2_id: "fam-2",
            subu_i_id: 3, subu_i_name: "SD Negeri 1",
            vi_name: "Puskesmas A", vi_address: "Jl. B", vi_phone: "0800", vi_email: "p@x.com",
            vu_username: "petugas1",
          },
        ],
        [],
      ]) // main windowed query
      .mockResolvedValueOnce([[{ familyId: "fam-2", id: "sib-1", fullName: "Ani" }], []]); // siblings batch

    await getInterventionsBelongToInstitution(req, res);

    expect(pool.query.mock.calls[1][0]).toContain("ROW_NUMBER() OVER (PARTITION BY iv.recommendationId ORDER BY iv.createdAt DESC)");
    expect(pool.query.mock.calls[1][0]).toContain("LIMIT 18446744073709551615 OFFSET ?");
    expect(pool.query.mock.calls[1][1]).toEqual([5, 0]);
    expect(pool.query.mock.calls[2][1]).toEqual([["fam-2"]]);

    expect(res.status).toHaveBeenCalledWith(200);
    const [data] = res.json.mock.calls[0];
    expect(data.data.totalPages).toBe(Math.ceil(1 / 10)); // length-based, not a real count
    expect(data.data.interventions[0].options).toEqual({ a: 1 });
    expect(
      data.data.interventions[0].recommendation.student.familyMember.family.user.family.familyMember,
    ).toEqual([{ fullName: "Ani" }]);
  });

  it("appends the keyword LIKE filter only when keyword is non-empty", async () => {
    const req = { user: { id: "user-health-1" }, query: { keyword: "Budi" } };
    const res = mockRes();

    pool.query
      .mockResolvedValueOnce([[{ institution_id: 5 }], []])
      .mockResolvedValueOnce([[], []]);

    await getInterventionsBelongToInstitution(req, res);

    expect(pool.query.mock.calls[1][0]).toContain("fm.fullName LIKE ?");
    expect(pool.query.mock.calls[1][1]).toEqual([5, "%Budi%", 0]);
  });

  it("throws when the requesting user does not exist", async () => {
    const req = { user: { id: "ghost" }, query: {} };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]); // no user row

    await getInterventionsBelongToInstitution(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("getInterventionsBelongToFamily", () => {
  it("orders by the joined recommendation's updatedAt (not the intervention's own createdAt) and preserves the un-divided totalPages bug", async () => {
    const req = { user: { id: "user-parent-1" }, query: { page: "0", limit: "10", keyword: "" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([
      [
        {
          iv_id: "iv-1", iv_forType: "PARENT", iv_notes: null, iv_options: JSON.stringify({ b: 2 }), iv_createdAt: new Date("2026-01-01"),
          r_id: "rec-1", r_status: "COMPLETED", r_createdAt: new Date("2025-12-01"),
          st_nis: "999", cl_id: 4, cl_name: "3B",
          fm_fullName: "Sari", fm_birthDate: new Date("2016-01-01"), fm_gender: "P",
          se_address: "Jl. C", of2_id: null,
          subu_i_id: 2, subu_i_name: "SD Negeri 2",
          vi_name: "Puskesmas B", vi_address: "Jl. D", vi_phone: "0801", vi_email: "b@x.com",
          vu_username: "petugas2",
        },
      ],
      [],
    ]);

    await getInterventionsBelongToFamily(req, res);

    expect(pool.query.mock.calls[0][0]).toContain("ORDER BY r.updatedAt DESC");
    expect(pool.query.mock.calls[0][0]).toContain("iv.forType = 'PARENT'");
    expect(pool.query.mock.calls[0][0]).toContain("LIMIT 18446744073709551615 OFFSET ?");

    const [data] = res.json.mock.calls[0];
    expect(data.data.totalPages).toBe(1); // interventions.length, NOT Math.ceil(length/limit)
    expect(data.data.interventions[0].recommendation.student.familyMember.family.user.family).toBeNull();
    expect(data.data.interventions[0].options).toEqual({ b: 2 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — old Prisma implementations still in place.

- [ ] **Step 3: Implement**

Replace `getInterventionsBelongToInstitution` with:
```js
export const getInterventionsBelongToInstitution = async (req, res) => {
  try {
    const user = req.user;
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const keyword = req.query.keyword ?? "";
    const skip = limit * page;

    const [userRows] = await pool.query(
      `SELECT u.id AS user_id, i.id AS institution_id
       FROM users u
       LEFT JOIN institutions i ON i.user_id = u.id
       WHERE u.id = ? LIMIT 1`,
      [user.id],
    );
    const userInstitution = userRows[0];
    if (!userInstitution) {
      throw new Error("user not found");
    }
    // NOTE: if the user exists but has no institution, userInstitution.institution_id
    // is null and the WHERE below naturally matches nothing (Prisma's equivalent threw
    // a TypeError here instead — a separate pre-existing bug not covered by this task).

    const keywordParams = keyword !== "" ? [`%${keyword}%`] : [];
    const keywordSql = keyword !== "" ? "AND fm.fullName LIKE ?" : "";

    const [rows] = await pool.query(
      `SELECT * FROM (
        SELECT
          iv.id AS iv_id, iv.forType AS iv_forType, iv.notes AS iv_notes, iv.options AS iv_options, iv.createdAt AS iv_createdAt,
          iv.recommendationId AS recommendationId,
          r.id AS r_id, r.status AS r_status, r.createdAt AS r_createdAt,
          st.nis AS st_nis,
          cl.id AS cl_id, cl.name AS cl_name,
          fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate, fm.gender AS fm_gender,
          se.address AS se_address,
          of2.id AS of2_id,
          subu_i.id AS subu_i_id, subu_i.name AS subu_i_name,
          vi.name AS vi_name, vi.address AS vi_address, vi.phone AS vi_phone, vi.email AS vi_email,
          vu.username AS vu_username,
          ROW_NUMBER() OVER (PARTITION BY iv.recommendationId ORDER BY iv.createdAt DESC) AS rn
        FROM interventions iv
        JOIN users vu ON vu.id = iv.user_id
        JOIN institutions vi ON vi.user_id = vu.id
        LEFT JOIN recommendations r ON r.id = iv.recommendationId
        LEFT JOIN students st ON st.id = r.studentId
        LEFT JOIN classes cl ON cl.id = st.classId
        LEFT JOIN family_members fm ON fm.id = st.familyMemberId
        LEFT JOIN socio_economic se ON se.id = fm.socioEconomicId
        LEFT JOIN families f ON f.id = fm.familyId
        LEFT JOIN users ofu ON ofu.id = f.userId
        LEFT JOIN families of2 ON of2.userId = ofu.id
        LEFT JOIN users subu ON subu.id = r.submittedById
        LEFT JOIN institutions subu_i ON subu_i.user_id = subu.id
        WHERE vi.id = ? ${keywordSql}
      ) t
      WHERE t.rn = 1
      ORDER BY t.iv_createdAt DESC
      LIMIT 18446744073709551615 OFFSET ?`,
      [userInstitution.institution_id, ...keywordParams, skip],
    );

    const familyIds = [...new Set(rows.filter((r) => r.of2_id).map((r) => r.of2_id))];
    let siblingsByFamily = new Map();
    if (familyIds.length > 0) {
      const [siblingRows] = await pool.query(
        "SELECT familyId, id, fullName FROM family_members WHERE familyId IN (?)",
        [familyIds],
      );
      for (const s of siblingRows) {
        const list = siblingsByFamily.get(s.familyId) || [];
        list.push({ fullName: s.fullName });
        siblingsByFamily.set(s.familyId, list);
      }
    }

    const totalPages = Math.ceil(rows.length / limit);

    const interventions = rows.map((row) => ({
      recommendation: {
        student: {
          nis: row.st_nis,
          class: row.cl_id ? { name: row.cl_name } : null,
          familyMember: {
            fullName: row.fm_fullName,
            birthDate: row.fm_birthDate,
            gender: row.fm_gender,
            SocioEconomic: row.se_address !== null ? { address: row.se_address } : null,
            family: {
              user: {
                family: row.of2_id
                  ? { familyMember: siblingsByFamily.get(row.of2_id) || [] }
                  : null,
              },
            },
          },
        },
        id: row.r_id,
        status: row.r_status,
        createdAt: row.r_createdAt,
        submittedBy: { institution: row.subu_i_id ? { id: row.subu_i_id, name: row.subu_i_name } : null },
      },
      id: row.iv_id,
      forType: row.iv_forType,
      notes: row.iv_notes,
      options: JSON.parse(row.iv_options),
      createdAt: row.iv_createdAt,
      user: {
        institution: { name: row.vi_name, address: row.vi_address, phone: row.vi_phone, email: row.vi_email },
        username: row.vu_username,
      },
    }));

    res.status(200).json({
      status: "Success",
      message: "Interventions Belongs to Institution fetched",
      data: { totalPages, skip, page, limit, interventions },
    });
  } catch (err) {
    console.log({ err });
    return errorResponse(res, err, "Failed to get response");
  }
};
```

Replace `getInterventionsBelongToFamily` with:
```js
export const getInterventionsBelongToFamily = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      throw new Error("user not found");
    }
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const keyword = req.query.keyword ?? "";
    const skip = limit * page;

    const keywordParams = keyword !== "" ? [`%${keyword}%`] : [];
    const keywordSql = keyword !== "" ? "AND fm.fullName LIKE ?" : "";

    const [rows] = await pool.query(
      `SELECT
        iv.id AS iv_id, iv.forType AS iv_forType, iv.notes AS iv_notes, iv.options AS iv_options, iv.createdAt AS iv_createdAt,
        r.id AS r_id, r.status AS r_status, r.createdAt AS r_createdAt,
        st.nis AS st_nis,
        cl.id AS cl_id, cl.name AS cl_name,
        fm.fullName AS fm_fullName, fm.birthDate AS fm_birthDate, fm.gender AS fm_gender,
        se.address AS se_address,
        of2.id AS of2_id,
        subu_i.id AS subu_i_id, subu_i.name AS subu_i_name,
        vi.name AS vi_name, vi.address AS vi_address, vi.phone AS vi_phone, vi.email AS vi_email,
        vu.username AS vu_username
      FROM interventions iv
      JOIN users vu ON vu.id = iv.user_id
      LEFT JOIN institutions vi ON vi.user_id = vu.id
      LEFT JOIN recommendations r ON r.id = iv.recommendationId
      LEFT JOIN students st ON st.id = r.studentId
      LEFT JOIN classes cl ON cl.id = st.classId
      LEFT JOIN family_members fm ON fm.id = st.familyMemberId
      LEFT JOIN socio_economic se ON se.id = fm.socioEconomicId
      LEFT JOIN families f ON f.id = fm.familyId
      LEFT JOIN users ofu ON ofu.id = f.userId
      LEFT JOIN families of2 ON of2.userId = ofu.id
      LEFT JOIN users subu ON subu.id = r.submittedById
      LEFT JOIN institutions subu_i ON subu_i.user_id = subu.id
      WHERE f.userId = ? AND iv.forType = 'PARENT' ${keywordSql}
      ORDER BY r.updatedAt DESC
      LIMIT 18446744073709551615 OFFSET ?`,
      [user.id, ...keywordParams, skip],
    );

    const familyIds = [...new Set(rows.filter((r) => r.of2_id).map((r) => r.of2_id))];
    let siblingsByFamily = new Map();
    if (familyIds.length > 0) {
      const [siblingRows] = await pool.query(
        "SELECT familyId, id, fullName FROM family_members WHERE familyId IN (?)",
        [familyIds],
      );
      for (const s of siblingRows) {
        const list = siblingsByFamily.get(s.familyId) || [];
        list.push({ fullName: s.fullName });
        siblingsByFamily.set(s.familyId, list);
      }
    }

    const totalPages = rows.length;

    const interventions = rows.map((row) => ({
      recommendation: {
        student: {
          nis: row.st_nis,
          class: row.cl_id ? { name: row.cl_name } : null,
          familyMember: {
            fullName: row.fm_fullName,
            birthDate: row.fm_birthDate,
            gender: row.fm_gender,
            SocioEconomic: row.se_address !== null ? { address: row.se_address } : null,
            family: {
              user: {
                family: row.of2_id
                  ? { familyMember: siblingsByFamily.get(row.of2_id) || [] }
                  : null,
              },
            },
          },
        },
        id: row.r_id,
        status: row.r_status,
        createdAt: row.r_createdAt,
        submittedBy: { institution: row.subu_i_id ? { id: row.subu_i_id, name: row.subu_i_name } : null },
      },
      id: row.iv_id,
      forType: row.iv_forType,
      notes: row.iv_notes,
      options: JSON.parse(row.iv_options),
      createdAt: row.iv_createdAt,
      user: {
        institution: { name: row.vi_name, email: row.vi_email, address: row.vi_address, phone: row.vi_phone },
        username: row.vu_username,
      },
    }));

    res.status(200).json({
      status: "Success",
      message: "Intervention belongs to family fetched",
      data: { totalPages, skip, page, limit, interventions },
    });
  } catch (err) {
    console.log({ err });
    return errorResponse(res, err, "Failed to get response");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS (all prior blocks + 4 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "refactor: convert getInterventionsBelongToInstitution/Family to raw mysql2, preserve pagination bugs"
```

---

### Task 33: `getInterventionById` + `deleteIntervention` — simple lookups, preserved JSON.parse asymmetry

**Files:**
- Modify: `src/controllers/RecommendationController.js`
- Modify: `src/controllers/__tests__/RecommendationController.test.js` (append `describe("getInterventionById", ...)` and `describe("deleteIntervention", ...)`)

**Interfaces:**
- Replaces both handlers with `pool.query`-backed versions, same signatures.
- `getInterventionById` DOES explicitly `JSON.parse(intervention.options)` in the response (on top of mysql2's automatic JSON-column parse — same double-decode pattern as Task 32).
- `deleteIntervention` does NOT do this — it returns the pre-delete row's `options` exactly as mysql2's automatic single parse returns it, with no additional explicit `JSON.parse` call. This asymmetry between the two handlers is intentional in the original and must be preserved, not "fixed" into consistency.
- Both throw plain `Error`s for "Id is required" / "not found" (no `errorResponse` arg-order quirk here — both call sites correctly pass the real caught error object as the second argument to `errorResponse`, so these DO return real HTTP 500s, consistent with original behavior).

- [ ] **Step 1: Write the failing tests**

Append to the test file (add both function names to the controller import):

```js
describe("getInterventionById", () => {
  it("returns the intervention with options explicitly JSON.parse'd", async () => {
    const req = { params: { id: "iv-1" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([
      [{ id: "iv-1", forType: "PARENT", options: JSON.stringify({ x: 1 }), notes: null }],
      [],
    ]);

    await getInterventionById(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT * FROM interventions WHERE id = ?"),
      ["iv-1"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const [data] = res.json.mock.calls[0];
    expect(data.data.options).toEqual({ x: 1 });
  });

  it("errors (real HTTP 500) when the intervention id does not exist", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await getInterventionById(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const [data] = res.json.mock.calls[0];
    expect(data.message).toBe("Failed to get response");
  });
});

describe("deleteIntervention", () => {
  it("fetches then deletes, returning the pre-delete row WITHOUT parsing options", async () => {
    const req = { params: { id: "iv-1" } };
    const res = mockRes();
    const rawOptions = JSON.stringify({ x: 1 });

    pool.query
      .mockResolvedValueOnce([[{ id: "iv-1", forType: "PARENT", options: rawOptions }], []]) // fetch
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete

    await deleteIntervention(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining("DELETE FROM interventions WHERE id = ?"), ["iv-1"]);
    expect(res.status).toHaveBeenCalledWith(200);
    const [data] = res.json.mock.calls[0];
    expect(data.data.options).toBe(rawOptions); // NOT JSON.parse'd, unlike getInterventionById
  });

  it("errors (real HTTP 500) when the intervention id does not exist", async () => {
    const req = { params: { id: "missing" } };
    const res = mockRes();

    pool.query.mockResolvedValueOnce([[], []]);

    await deleteIntervention(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1); // no DELETE attempted
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: FAIL — old Prisma implementations still in place.

- [ ] **Step 3: Implement**

Replace `getInterventionById` with:
```js
export const getInterventionById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new Error("Id is required");
    }
    const [rows] = await pool.query(
      "SELECT * FROM interventions WHERE id = ? LIMIT 1",
      [id],
    );
    const intervention = rows[0];
    if (!intervention) {
      throw new Error(`Intervention with id ${id} is not found`);
    }
    res.status(200).json({
      status: "Success",
      message: "Intervention retrieved",
      data: {
        ...intervention,
        options: JSON.parse(intervention.options),
      },
    });
  } catch (err) {
    return errorResponse(res, err, "Failed to get response");
  }
};
```

Replace `deleteIntervention` with:
```js
export const deleteIntervention = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new Error("Id is required");
    }
    const [rows] = await pool.query(
      "SELECT * FROM interventions WHERE id = ? LIMIT 1",
      [id],
    );
    const intervention = rows[0];
    if (!intervention) {
      throw new Error(`Intervention with id ${id} is not found`);
    }
    await pool.query("DELETE FROM interventions WHERE id = ?", [id]);
    res.status(200).json({
      status: "Success",
      message: "Intervention deleted",
      data: intervention,
    });
  } catch (err) {
    return errorResponse(res, err, "Failed to get response");
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/controllers/__tests__/RecommendationController.test.js`
Expected: PASS — full suite green (all 11 handlers across Tasks 7-15 covered).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/RecommendationController.js src/controllers/__tests__/RecommendationController.test.js
git commit -m "refactor: convert getInterventionById/deleteIntervention to raw mysql2"
```

---

## Cross-task notes

- All 11 functions in `src/controllers/RecommendationController.js` share one Prisma import removal (Task 25) — do not re-add `PrismaClient` in any later task in this file.
- `randomUUID` is imported from `node:crypto` once (Task 25's import edit); Tasks 8 and 12 are the only two call sites (`Recommendation.id`, `Intervention.id`).
- Every `UPDATE` statement in this file (`changeStatusToProcessed`, `createIntervention`'s status-to-COMPLETED update) touches only the specific column(s) the original Prisma call touched — never `updatedAt`, since the schema has no `@updatedAt` directive anywhere.
- The `errorResponse(res, <number>, message)` arg-order quirk means every guard clause of this shape returns actual HTTP 500 (not the number that appears at the call site) with `error: <that number>` in the JSON body. This is true for every function in this file except the two approved bug fixes' own new guard clauses (which follow the same existing pattern and are therefore equally affected) and the `catch` blocks that pass a real `Error` object (which correctly produce 500 with `error: err.message`).

### Task 34: Convert `getAdminDashboardSummary` + `getParentDashboardSummary` (StatisticsController.js)

**Files:**
- Modify: `src/controllers/StatisticsController.js` (only `getAdminDashboardSummary` and `getParentDashboardSummary` — leave `getSchoolDashboardSummary`/`getHealthcareDashboardSummary` and the top-of-file `PrismaClient` import/instantiation untouched; they are still used by the two not-yet-converted functions and are removed in Task 35)
- Create: `src/controllers/__tests__/StatisticsController.test.js`

**Interfaces:**
- Depends on: `pool` default export from `src/config/db.js` (Task 0).
- Produces: `getAdminDashboardSummary` and `getParentDashboardSummary` converted to raw `mysql2` via `pool.query(sql, params)`, preserving every documented Prisma behavior below exactly (including two intentionally-different "missing group" behaviors and one intentionally-preserved "flat column, not nested relation" read).
- Produces: `src/controllers/__tests__/StatisticsController.test.js`, which Task 35 will extend (not replace) with two more `describe` blocks for the school/healthcare handlers.

This file is the highest-bug-injection-risk file in the whole migration (37 Prisma calls, 5 `groupBy`s, 10 `_count`s across all 4 handlers). The two behaviors below must **not** be unified even though they look similar:
- Admin dashboard's `usersByRole` / `instByType` / `recByStatus` `groupBy`s: a role/type/status with zero rows simply **does not appear** in the array. No zero-fill.
- Admin dashboard's `schoolResponses` completion tracking: **does** zero-fill, but the zero-fill happens in JS by iterating the separately-fetched `schools` list, not in SQL.
- (Task 35's healthcare dashboard has a *third* variant — a fixed 3-element array that always zero-fills all 3 statuses, built from 3 counts, not a `groupBy` at all. Do not let these three patterns bleed into each other.)

Every `COUNT(*)`/`COUNT(id)` result is coerced with `Number(...)` before use in arithmetic or comparisons — mysql2 can hand back BIGINT-backed counts as strings depending on driver/row configuration, and `"12" + 1` is not `13`.

---

- [ ] **Step 1: Write the failing tests for `getAdminDashboardSummary`**

Create `src/controllers/__tests__/StatisticsController.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/db.js", () => ({
  default: { query: vi.fn(), getConnection: vi.fn() },
}));

import pool from "../../config/db.js";
import {
  getAdminDashboardSummary,
  getParentDashboardSummary,
} from "../StatisticsController.js";

function mockReq(overrides = {}) {
  return { user: { id: "user-1" }, ...overrides };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Queues the 16 sequential pool.query calls getAdminDashboardSummary issues,
// in call order, with sane defaults. Pass `overrides[N]` (1-indexed, matching
// the numbered list in the implementation step) to replace one call's result.
function queueAdminDashboardMocks(overrides = {}) {
  const defaults = {
    1: [[{ id: 1, name: "admin" }], []], // adminRole
    2: [[{ count: 10 }], []], // totalUsers
    3: [
      [
        { role_id: 1, count: 1 },
        { role_id: 2, count: 5 },
        { role_id: 3, count: 4 },
      ],
      [],
    ], // usersByRole
    4: [
      [
        { id: 1, name: "admin" },
        { id: 2, name: "parent" },
        { id: 3, name: "school" },
      ],
      [],
    ], // roles
    5: [[{ count: 3 }], []], // totalInstitutions
    6: [
      [
        { type: 1, count: 2 },
        { type: 2, count: 1 },
      ],
      [],
    ], // instByType
    7: [
      [
        { id: 1, name: "School" },
        { id: 2, name: "Healthcare" },
      ],
      [],
    ], // instTypes
    8: [[], []], // nutrition rows (family_members LEFT JOIN nutritions LEFT JOIN nutrition_status)
    9: [[{ count: 2 }], []], // totalTeachers
    10: [[{ count: 4 }], []], // totalClasses
    11: [[{ count: 0 }], []], // totalRecommendations
    12: [[], []], // recByStatus
    13: [[{ id: 9, title: "Pelayanan Kesehatan Sekolah" }], []], // schoolQuesioner
    14: [[], []], // schools
    15: [[], []], // schoolResponses
    16: [[], []], // recentRecs
  };
  for (let i = 1; i <= 16; i++) {
    pool.query.mockResolvedValueOnce(overrides[i] ?? defaults[i]);
  }
}

describe("getAdminDashboardSummary", () => {
  it("returns a full admin dashboard summary on the happy path", async () => {
    queueAdminDashboardMocks();
    const req = mockReq();
    const res = mockRes();

    await getAdminDashboardSummary(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM roles WHERE name = ?"),
      ["admin"],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.data).toEqual(
      expect.objectContaining({
        totalUsers: 10,
        totalInstitutions: 3,
        totalTeachers: 2,
        totalClasses: 4,
        totalRecommendations: 0,
      }),
    );
  });

  it("defaults adminRoleId to -1 when the admin role is missing", async () => {
    queueAdminDashboardMocks({ 1: [[], []] });
    const req = mockReq();
    const res = mockRes();

    await getAdminDashboardSummary(req, res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("role_id != ?"),
      [-1],
    );
  });

  it("usersByRole: filters out the admin's own row and does NOT zero-fill roles with no users", async () => {
    // roles table has admin(1), parent(2), school(3), healthcare(4) — but the
    // groupBy only returned rows for admin and parent. healthcare(4) and
    // school(3) must simply be absent from userByRole, not zeroed.
    queueAdminDashboardMocks({
      3: [
        [
          { role_id: 1, count: "7" }, // string count — must be Number()-coerced
          { role_id: 2, count: 5 },
        ],
        [],
      ],
      4: [
        [
          { id: 1, name: "admin" },
          { id: 2, name: "parent" },
          { id: 3, name: "school" },
          { id: 4, name: "healthcare" },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.userByRole).toEqual([{ role: "parent", total: 5 }]);
  });

  it("institutionByType: does NOT zero-fill institution types with no institutions", async () => {
    queueAdminDashboardMocks({
      6: [[{ type: 2, count: "3" }], []],
      7: [
        [
          { id: 1, name: "School" },
          { id: 2, name: "Healthcare" },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.institutionByType).toEqual([
      { type: "Healthcare", total: 3 },
    ]);
  });

  it("nutritionDistribution: buckets the true-latest nutrition status per family member, with a Tidak Terdata catch-all", async () => {
    queueAdminDashboardMocks({
      8: [
        [
          { id: "fm-1", displayName: "Gizi Baik" },
          { id: "fm-2", displayName: null },
          { id: "fm-3", displayName: "Gizi Baik" },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      8,
      expect.stringContaining("MAX(n2.updatedAt)"),
      [],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.nutritionDistribution).toEqual(
      expect.arrayContaining([
        { displayName: "Gizi Baik", total: 2 },
        { displayName: "Tidak Terdata", total: 1 },
      ]),
    );
    expect(body.data.nutritionDistribution).toHaveLength(2);
  });

  it("recommendationsByStatus: groupBy does NOT zero-fill missing statuses (contrast with the healthcare dashboard's fixed 3-status backfill)", async () => {
    queueAdminDashboardMocks({
      12: [
        [
          { status: "PENDING", count: "2" },
          { status: "COMPLETED", count: 1 },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.recommendationsByStatus).toEqual([
      { status: "pending", total: 2 },
      { status: "selesai", total: 1 },
    ]);
  });

  it("schoolResponses: adds the quisionerId filter ONLY when schoolQuesioner exists, and JS-side zero-fills schools with no responses", async () => {
    queueAdminDashboardMocks({
      13: [[{ id: 9, title: "Pelayanan Kesehatan Sekolah" }], []],
      14: [
        [
          { id: 100, name: "School A" },
          { id: 101, name: "School B" },
        ],
        [],
      ],
      15: [[{ institutionId: 100, count: "4" }], []],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      15,
      expect.stringContaining("AND quisionerId = ?"),
      [9],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.questionnaireProgress.institutionDetails).toEqual([
      { id: 100, name: "School A", completedQuests: 4, totalQuests: 1 },
      { id: 101, name: "School B", completedQuests: 0, totalQuests: 1 },
    ]);
  });

  it("schoolResponses: drops the quisionerId filter entirely when schoolQuesioner is missing (does not bind NULL into '= ?')", async () => {
    queueAdminDashboardMocks({
      13: [[], []], // schoolQuesioner not found
      14: [[{ id: 100, name: "School A" }], []],
      15: [[{ institutionId: 100, count: 2 }], []],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    const [sql, params] = pool.query.mock.calls[14]; // 15th call, 0-indexed
    expect(sql).not.toContain("quisionerId");
    expect(params).toEqual([]);
    const body = res.json.mock.calls[0][0];
    expect(body.data.questionnaireProgress.institutionDetails[0]).toEqual({
      id: 100,
      name: "School A",
      completedQuests: 2,
      totalQuests: 0,
    });
  });

  it("recentRecommendations: INNER JOINs student/familyMember/institution and maps to the flattened shape", async () => {
    queueAdminDashboardMocks({
      16: [
        [
          {
            id: "rec-1",
            createdAt: new Date("2026-07-01T00:00:00Z"),
            status: "PROCESSED",
            studentName: "Budi",
            institutionName: "School A",
          },
        ],
        [],
      ],
    });
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      16,
      expect.stringContaining("INNER JOIN students"),
      [],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.recentRecommendations).toEqual([
      {
        id: "rec-1",
        studentName: "Budi",
        institutionName: "School A",
        status: "proses",
        createdAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);
  });

  it("returns the errorResponse shape when pool.query rejects", async () => {
    pool.query.mockRejectedValueOnce(new Error("connection refused"));
    const res = mockRes();

    await getAdminDashboardSummary(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Failed to get admin dashboard summary",
      }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/StatisticsController.test.js`

Expected: FAIL. `getAdminDashboardSummary` still calls `prisma.role.findUnique(...)` etc, so `pool.query` is never invoked — assertions like `toHaveBeenNthCalledWith(1, ...)` fail with "Number of calls: 0". (If the real `PrismaClient` attempts to open an actual DB connection in this environment, the test may instead fail with a Prisma connection error or time out — either failure mode confirms the handler has not been converted yet.)

- [ ] **Step 3: Implement `getAdminDashboardSummary` against `pool`**

In `src/controllers/StatisticsController.js`, add the pool import alongside the existing Prisma import (Prisma stays for now — `getSchoolDashboardSummary`/`getHealthcareDashboardSummary` still use it until Task 35):

```js
import { PrismaClient } from "@prisma/client";
import pool from "../config/db.js";
import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";

const prisma = new PrismaClient();

// NOTE: mysql2 can return COUNT(*)/COUNT(id) results as a JS number or as a
// string representation of a BIGINT, depending on driver/row configuration.
// Every count in this file is wrapped in Number(...) before arithmetic or
// comparison to avoid string-concatenation bugs ("12" + 1 !== 13).
```

Replace the body of `getAdminDashboardSummary` with:

```js
export const getAdminDashboardSummary = async (req, res) => {
  try {
    // 1. admin role lookup
    const [adminRoleRows] = await pool.query(
      `SELECT id FROM roles WHERE name = ? LIMIT 1`,
      ["admin"],
    );
    const adminRoleId = adminRoleRows[0]?.id ?? -1;

    // 2. totalUsers excluding admin
    const [totalUsersRows] = await pool.query(
      `SELECT COUNT(id) AS count FROM users WHERE role_id != ?`,
      [adminRoleId],
    );
    const totalUsers = Number(totalUsersRows[0].count);

    // 3+4. usersByRole groupBy (no zero-fill) + roles list for labeling
    const [usersByRoleRows] = await pool.query(
      `SELECT role_id, COUNT(id) AS count FROM users GROUP BY role_id`,
    );
    const [roleRows] = await pool.query(`SELECT id, name FROM roles`);
    const roleMap = {};
    roleRows.forEach((r) => {
      roleMap[r.id] = r.name;
    });
    const userByRole = usersByRoleRows
      .filter((u) => u.role_id !== adminRoleId)
      .map((u) => ({ role: roleMap[u.role_id], total: Number(u.count) }));

    // 5. totalInstitutions
    const [totalInstitutionsRows] = await pool.query(
      `SELECT COUNT(id) AS count FROM institutions`,
    );
    const totalInstitutions = Number(totalInstitutionsRows[0].count);

    // 6+7. instByType groupBy (no zero-fill) + institution_types list for labeling
    const [instByTypeRows] = await pool.query(
      `SELECT type, COUNT(id) AS count FROM institutions GROUP BY type`,
    );
    const [instTypeRows] = await pool.query(
      `SELECT id, name FROM institution_types`,
    );
    const instTypeMap = {};
    instTypeRows.forEach((t) => {
      instTypeMap[t.id] = t.name;
    });
    const institutionByType = instByTypeRows.map((i) => ({
      type: instTypeMap[i.type],
      total: Number(i.count),
    }));

    // 8. true-latest nutrition status per family member (ALL members, not scoped
    // to any family). Correlated subquery is used instead of ROW_NUMBER() OVER()
    // for compatibility with MariaDB/MySQL versions that predate window function
    // support; if the target server is confirmed MySQL 8+/MariaDB 10.2+, this can
    // be swapped for a ROW_NUMBER() OVER (PARTITION BY familyMemberId ORDER BY
    // updatedAt DESC) = 1 filter with identical results.
    const [nutritionRows] = await pool.query(
      `SELECT fm.id, ns.displayName
       FROM family_members fm
       LEFT JOIN nutritions n
         ON n.familyMemberId = fm.id
         AND n.updatedAt = (
           SELECT MAX(n2.updatedAt) FROM nutritions n2 WHERE n2.familyMemberId = fm.id
         )
       LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId`,
    );
    const nutritionMap = {};
    nutritionRows.forEach((fm) => {
      const name = fm.displayName || "Tidak Terdata";
      nutritionMap[name] = (nutritionMap[name] || 0) + 1;
    });
    const nutritionDistribution = Object.entries(nutritionMap).map(
      ([displayName, total]) => ({ displayName, total }),
    );

    // 9-11. simple counts, run in parallel (independent of each other)
    const [teacherRows, classRows, recommendationRows] = await Promise.all([
      pool.query(`SELECT COUNT(id) AS count FROM teachers`),
      pool.query(`SELECT COUNT(id) AS count FROM classes`),
      pool.query(`SELECT COUNT(id) AS count FROM recommendations`),
    ]);
    const totalTeachers = Number(teacherRows[0][0].count);
    const totalClasses = Number(classRows[0][0].count);
    const totalRecommendations = Number(recommendationRows[0][0].count);

    // 12. recByStatus groupBy — NO zero-fill (contrast with healthcare dashboard,
    // which fixed-array zero-fills all 3 statuses; do not unify these)
    const [recByStatusRows] = await pool.query(
      `SELECT status, COUNT(id) AS count FROM recommendations GROUP BY status`,
    );
    const statusLabelMap = {
      PENDING: "pending",
      PROCESSED: "proses",
      COMPLETED: "selesai",
    };
    const recommendationsByStatus = recByStatusRows.map((r) => ({
      status: statusLabelMap[r.status] || r.status.toLowerCase(),
      total: Number(r.count),
    }));

    // 13. schoolQuesioner lookup
    const [schoolQuesionerRows] = await pool.query(
      `SELECT id, title FROM quesioners WHERE title = ? LIMIT 1`,
      ["Pelayanan Kesehatan Sekolah"],
    );
    const schoolQuesioner = schoolQuesionerRows[0] ?? null;

    // 14. schools list
    const [schools] = await pool.query(
      `SELECT i.id, i.name
       FROM institutions i
       INNER JOIN institution_types it ON it.id = i.type
       WHERE it.name = ?`,
      ["School"],
    );

    // 15. schoolResponses groupBy. The quisionerId filter is added conditionally
    // in JS — replicating Prisma's "undefined drops the where key" semantics.
    // Binding `schoolQuesioner?.id ?? null` into `= ?` would be WRONG: SQL
    // `= NULL` is always unknown/false, so it would silently return zero groups
    // instead of "count every response" when the questionnaire is missing.
    let schoolResponsesSql = `SELECT institutionId, COUNT(id) AS count FROM responses WHERE institutionId IS NOT NULL`;
    const schoolResponsesParams = [];
    if (schoolQuesioner) {
      schoolResponsesSql += ` AND quisionerId = ?`;
      schoolResponsesParams.push(schoolQuesioner.id);
    }
    schoolResponsesSql += ` GROUP BY institutionId`;
    const [schoolResponses] = await pool.query(
      schoolResponsesSql,
      schoolResponsesParams,
    );
    const responseMap = {};
    schoolResponses.forEach((r) => {
      if (r.institutionId) responseMap[r.institutionId] = Number(r.count);
    });

    // JS-side zero-fill: every school defaults to 0 completed quests. This is
    // the REAL backfill in this handler — it happens here, in JS, over the
    // independently-fetched `schools` list, not in SQL.
    const institutionDetails = schools.map((s) => ({
      id: s.id,
      name: s.name,
      completedQuests: responseMap[s.id] || 0,
      totalQuests: schoolQuesioner ? 1 : 0,
    }));

    const completedInstitutions = institutionDetails.filter(
      (d) => d.completedQuests >= d.totalQuests,
    ).length;
    const totalSchoolInst = schools.length;
    const percentage =
      totalSchoolInst > 0
        ? Math.round((completedInstitutions / totalSchoolInst) * 100)
        : 0;

    // 16. recentRecs — student/familyMember/institution are all required
    // (non-optional) relations in the schema, so INNER JOIN is safe here
    // (mirrors Prisma's guarantee that `include` on a required relation never
    // returns null).
    const [recentRecs] = await pool.query(
      `SELECT r.id, r.createdAt, r.status, fm.fullName AS studentName, i.name AS institutionName
       FROM recommendations r
       INNER JOIN students s ON s.id = r.studentId
       INNER JOIN family_members fm ON fm.id = s.familyMemberId
       INNER JOIN institutions i ON i.id = s.schoolId
       ORDER BY r.createdAt DESC
       LIMIT 5`,
    );
    const recentRecommendations = recentRecs.map((r) => ({
      id: r.id,
      studentName: r.studentName,
      institutionName: r.institutionName,
      status: statusLabelMap[r.status] || r.status.toLowerCase(),
      createdAt: r.createdAt,
    }));

    return successResponse(
      res,
      {
        totalUsers,
        userByRole,
        totalInstitutions,
        institutionByType,
        nutritionDistribution,
        totalTeachers,
        totalClasses,
        totalRecommendations,
        recommendationsByStatus,
        questionnaireProgress: {
          totalInstitutions: totalSchoolInst,
          completedInstitutions,
          percentage,
          institutionDetails,
        },
        recentRecommendations,
      },
      "Admin dashboard summary retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get admin dashboard summary");
  }
};
```

- [ ] **Step 4: Run the tests to verify `getAdminDashboardSummary` passes**

Run: `npx vitest run src/controllers/__tests__/StatisticsController.test.js -t getAdminDashboardSummary`

Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/StatisticsController.js src/controllers/__tests__/StatisticsController.test.js
git commit -m "refactor: convert getAdminDashboardSummary to raw mysql2"
```

- [ ] **Step 6: Write the failing tests for `getParentDashboardSummary`**

Append to `src/controllers/__tests__/StatisticsController.test.js` (same file, new `describe` block, after the `getAdminDashboardSummary` block):

```js
describe("getParentDashboardSummary", () => {
  it("returns the errorResponse default (500) shape when the family is not found, and issues no further queries", async () => {
    pool.query.mockResolvedValueOnce([[], []]); // families lookup — empty
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Family not found",
      error: null,
    });
  });

  it("guards the empty-members case: skips nutrition/students/socioEconomic queries entirely when the family has no members", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([[], []]); // family_members — empty
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(2);
    const body = res.json.mock.calls[0][0];
    expect(body.data.totalFamilyMembers).toBe(0);
    expect(body.data.totalChildren).toBe(0);
    expect(body.data.questionnaireProgress).toBe(0);
    expect(body.data.schoolHealthService).toBeNull();
  });

  it("guards on parent existence separately from the empty-members guard: skips totalQuestionnaires/parentResponses when there is no IBU/AYAH member, but still runs nutrition/students/socioEconomic for the ANAK member", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [
          {
            id: "child-1",
            fullName: "Anak Satu",
            relation: "ANAK",
            socioEconomicId: 1,
            education: null,
          },
        ],
        [],
      ]) // family_members — only a child, no parent
      .mockResolvedValueOnce([[], []]) // nutrition rows
      .mockResolvedValueOnce([[], []]) // students rows
      .mockResolvedValueOnce([[], []]); // socio_economic rows
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(5);
    const body = res.json.mock.calls[0][0];
    expect(body.data.totalQuestionnaires).toBe(0);
    expect(body.data.questionnaireResults).toEqual([]);
  });

  it("composes the true-latest nutrition per member from a separately-fetched, correlated-subquery-ordered query (same true-latest pattern as the admin dashboard)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [
          {
            id: "child-1",
            fullName: "Anak Satu",
            relation: "ANAK",
            socioEconomicId: 1,
            education: null,
          },
        ],
        [],
      ]) // family_members
      .mockResolvedValueOnce([
        [
          {
            familyMemberId: "child-1",
            id: 5,
            height: 90,
            weight: 12,
            bmi: 14.8,
            updatedAt: new Date("2026-07-10T00:00:00Z"),
            displayName: "Gizi Baik",
          },
        ],
        [],
      ]) // nutrition rows
      .mockResolvedValueOnce([[], []]) // students rows
      .mockResolvedValueOnce([[{ id: 1, residenceStatus: null }], []]); // socio_economic rows
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("MAX(n2.updatedAt)"),
      [["child-1"]],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.latestNutritionStatus).toBe("Gizi Baik");
    expect(body.data.nutritionDistribution).toEqual([
      { displayName: "Gizi Baik", total: 1 },
    ]);
  });

  it("parentResponses: INNER JOINs quesioners (required relation) and reads the flat r.quisionerId column directly, not a nested quesioner.id (preserving original non-typo behavior)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []]) // families
      .mockResolvedValueOnce([
        [
          {
            id: "parent-1",
            fullName: "Ibu Satu",
            relation: "IBU",
            socioEconomicId: 1,
            education: "SMA",
          },
        ],
        [],
      ]) // family_members
      .mockResolvedValueOnce([[], []]) // nutrition rows
      .mockResolvedValueOnce([[], []]) // students rows
      .mockResolvedValueOnce([[{ id: 1, residenceStatus: null }], []]) // socio_economic rows
      .mockResolvedValueOnce([[{ count: 2 }], []]) // totalQuestionnaires
      .mockResolvedValueOnce([
        [
          {
            id: "resp-1",
            quisionerId: 42,
            totalScore: 40,
            quesionerTitle: "Kebiasaan Sehari-hari Anak",
          },
        ],
        [],
      ]); // parentResponses
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("title IN (?)"),
      [["Tingkat Pengetahuan Gizi Seimbang", "Kebiasaan Sehari-hari Anak"]],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("INNER JOIN quesioners"),
      ["parent-1"],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.questionnaireResults).toEqual([
      {
        quesionerId: 42, // from the flat r.quisionerId column
        title: "Kebiasaan Sehari-hari Anak",
        totalScore: 40,
        interpretation: "Baik",
      },
    ]);
  });

  it("schoolHealthService: stays null when no child has a schoolId (queries 8/9 are skipped)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "child-1",
            fullName: "Anak Satu",
            relation: "ANAK",
            socioEconomicId: 1,
            education: null,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]) // students rows — no student record at all
      .mockResolvedValueOnce([[{ id: 1, residenceStatus: null }], []]);
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(5);
    const body = res.json.mock.calls[0][0];
    expect(body.data.schoolHealthService).toBeNull();
  });

  it("schoolHealthService: fetches schoolQuesioner + latest response when a child has a schoolId, applies the 17-point Tinggi/Rendah threshold", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "child-1",
            fullName: "Anak Satu",
            relation: "ANAK",
            socioEconomicId: 1,
            education: null,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [{ id: "stu-1", familyMemberId: "child-1", schoolId: 200 }],
        [],
      ]) // students rows
      .mockResolvedValueOnce([[{ id: 1, residenceStatus: null }], []])
      .mockResolvedValueOnce([
        [{ id: 9, title: "Pelayanan Kesehatan Sekolah" }],
        [],
      ]) // schoolQuesioner
      .mockResolvedValueOnce([[{ id: "resp-2", totalScore: 20 }], []]); // schoolResponse
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("ORDER BY created_at DESC"),
      [200, 9],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.schoolHealthService).toEqual({
      title: "Pelayanan Kesehatan Sekolah",
      totalScore: 20,
      interpretation: "Tinggi",
    });
  });

  it("socioEconomic: computes totalScore from the composed SocioEconomic row and applies the 8-point Menengah-Tinggi/Rendah threshold", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: "fam-1", userId: "user-1" }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "parent-1",
            fullName: "Ibu Satu",
            relation: "IBU",
            socioEconomicId: 5,
            education: "SD",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [
          {
            id: 5,
            residenceStatus: "MILIK_SENDIRI", // 3
            childrenCount: "SATU", // 3
            underFiveCount: "TIDAK_ADA", // 4
            familyIncomeLevel: "KURANG_DARI_LIMA_JUTA", // 1
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ count: 2 }], []])
      .mockResolvedValueOnce([[], []]);
    const res = mockRes();

    await getParentDashboardSummary(mockReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.socioEconomic).toEqual(
      expect.objectContaining({ totalScore: 11, interpretation: "Menengah-Tinggi" }),
    );
    expect(body.data.parentEducation.ibu).toEqual({
      education: "SD",
      category: "Dasar",
    });
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/StatisticsController.test.js -t getParentDashboardSummary`

Expected: FAIL. `getParentDashboardSummary` still calls `prisma.family.findUnique(...)`, so `pool.query` is never invoked (or the real `PrismaClient` errors/times out trying to reach a database). Either failure confirms the handler is not yet converted.

- [ ] **Step 8: Implement `getParentDashboardSummary` against `pool`**

Replace the body of `getParentDashboardSummary` in `src/controllers/StatisticsController.js`:

```js
export const getParentDashboardSummary = async (req, res) => {
  try {
    const user = req.user;

    // 1. family lookup
    const [familyRows] = await pool.query(
      `SELECT id, userId FROM families WHERE userId = ? LIMIT 1`,
      [user.id],
    );
    const family = familyRows[0] ?? null;

    if (!family) {
      return errorResponse(res, null, "Family not found");
    }

    // 2. members — the base list this whole handler is composed around
    const [members] = await pool.query(
      `SELECT id, fullName, birthDate, age, education, jobId, gender, relation,
              familyId, institutionId, phone, isCompleted, socioEconomicId,
              createdAt, updatedAt
       FROM family_members
       WHERE familyId = ?`,
      [family.id],
    );

    const memberIds = members.map((m) => m.id);

    // 3. true-latest nutrition per member, scoped to this family's members only
    // (same true-latest pattern as the admin dashboard's ALL-members version —
    // correlated subquery, not ROW_NUMBER(), for MariaDB/older-MySQL compat).
    // Guarded: an empty IN (?) is invalid SQL, so skip the query entirely when
    // there are no members.
    let nutritionRows = [];
    if (memberIds.length > 0) {
      [nutritionRows] = await pool.query(
        `SELECT n.familyMemberId, n.id, n.height, n.weight, n.bmi, n.updatedAt, ns.displayName
         FROM nutritions n
         LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
         WHERE n.familyMemberId IN (?)
           AND n.updatedAt = (
             SELECT MAX(n2.updatedAt) FROM nutritions n2 WHERE n2.familyMemberId = n.familyMemberId
           )`,
        [memberIds],
      );
    }
    const nutritionByMember = {};
    nutritionRows.forEach((n) => {
      nutritionByMember[n.familyMemberId] = n;
    });

    // 4. students keyed by familyMemberId
    let studentRows = [];
    if (memberIds.length > 0) {
      [studentRows] = await pool.query(
        `SELECT id, schoolId, familyMemberId, nis, schoolYear, semester, classId
         FROM students
         WHERE familyMemberId IN (?)`,
        [memberIds],
      );
    }
    const studentByMember = {};
    studentRows.forEach((s) => {
      studentByMember[s.familyMemberId] = s;
    });

    // 5. socio_economic keyed by id (distinct ids, guarded)
    const socioEconomicIds = [...new Set(members.map((m) => m.socioEconomicId))];
    let socioRows = [];
    if (socioEconomicIds.length > 0) {
      [socioRows] = await pool.query(
        `SELECT id, residenceStatus, address, childrenCount, underFiveCount,
                familyIncomeLevel, createdAt, updatedAt
         FROM socio_economic
         WHERE id IN (?)`,
        [socioEconomicIds],
      );
    }
    const socioById = {};
    socioRows.forEach((se) => {
      socioById[se.id] = se;
    });

    // Compose the in-memory shape the (unchanged) pure-JS logic below expects,
    // matching Prisma's nested include shape.
    const familyMembers = members.map((m) => {
      const n = nutritionByMember[m.id];
      return {
        ...m,
        nutrition: n
          ? [
              {
                id: n.id,
                height: n.height,
                weight: n.weight,
                bmi: n.bmi,
                updatedAt: n.updatedAt,
                nutritionStatus:
                  n.displayName != null ? { displayName: n.displayName } : null,
              },
            ]
          : [],
        SocioEconomic: socioById[m.socioEconomicId] ?? null,
        student: studentByMember[m.id] ?? null,
      };
    });

    const totalFamilyMembers = familyMembers.length;
    const children = familyMembers.filter((m) => m.relation === "ANAK");
    const totalChildren = children.length;

    const parent =
      familyMembers.find((m) => m.relation === "IBU") ||
      familyMembers.find((m) => m.relation === "AYAH");

    let totalQuestionnaires = 0;
    let answeredQuestionnaires = 0;
    let questionnaireProgress = 0;
    const questionnaireResults = [];

    const parentTitles = [
      "Tingkat Pengetahuan Gizi Seimbang",
      "Kebiasaan Sehari-hari Anak",
    ];

    if (parent) {
      // 6. totalQuestionnaires
      const [totalQuestionnairesRows] = await pool.query(
        `SELECT COUNT(id) AS count FROM quesioners WHERE title IN (?)`,
        [parentTitles],
      );
      totalQuestionnaires = Number(totalQuestionnairesRows[0].count);

      // 7. parentResponses — INNER JOIN quesioners (required relation).
      // NOTE: `r.quisionerId` (the flat column) is read directly below rather
      // than a nested quesioner.id — this is the original behavior, not a typo,
      // and must be preserved as-is.
      const [parentResponses] = await pool.query(
        `SELECT r.id, r.quisionerId, r.totalScore, r.familyMemberId, r.institutionId,
                r.created_at, q.title AS quesionerTitle
         FROM responses r
         INNER JOIN quesioners q ON q.id = r.quisionerId
         WHERE r.familyMemberId = ?`,
        [parent.id],
      );

      answeredQuestionnaires = parentResponses.length;
      questionnaireProgress =
        totalQuestionnaires > 0
          ? Math.round((answeredQuestionnaires / totalQuestionnaires) * 100)
          : 0;

      for (const r of parentResponses) {
        const threshold = QUESTIONNAIRE_THRESHOLDS[r.quesionerTitle];
        if (threshold) {
          questionnaireResults.push({
            quesionerId: r.quisionerId,
            title: r.quesionerTitle,
            totalScore: r.totalScore,
            interpretation:
              r.totalScore >= threshold.min ? threshold.good : threshold.bad,
          });
        }
      }
    }

    let socioEconomic = null;
    if (parent?.SocioEconomic) {
      const se = parent.SocioEconomic;
      const residencePoints = POINTS_RESIDENCE[se.residenceStatus] ?? 0;
      const childrenPoints = POINTS_CHILDREN[se.childrenCount] ?? 0;
      const underFivePoints = POINTS_UNDER_FIVE[se.underFiveCount] ?? 0;
      const incomePoints = POINTS_INCOME[se.familyIncomeLevel] ?? 0;
      const totalScore =
        residencePoints + childrenPoints + underFivePoints + incomePoints;

      socioEconomic = {
        residenceStatus: se.residenceStatus,
        residencePoints,
        childrenCount: se.childrenCount,
        childrenPoints,
        underFiveCount: se.underFiveCount,
        underFivePoints,
        familyIncomeLevel: se.familyIncomeLevel,
        incomePoints,
        totalScore,
        interpretation:
          totalScore >= SOCIO_ECONOMIC_THRESHOLD ? "Menengah-Tinggi" : "Rendah",
      };
    }

    const parentEducation = {};
    const ibu = familyMembers.find((m) => m.relation === "IBU");
    const ayah = familyMembers.find((m) => m.relation === "AYAH");
    if (ibu)
      parentEducation.ibu = {
        education: ibu.education,
        category: categorizeEducation(ibu.education),
      };
    if (ayah)
      parentEducation.ayah = {
        education: ayah.education,
        category: categorizeEducation(ayah.education),
      };

    const latestNutrition = children
      .flatMap((c) => c.nutrition)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];

    const nutritionDistribution = {};
    children.forEach((child) => {
      const status = child.nutrition?.[0]?.nutritionStatus?.displayName;
      if (status) {
        nutritionDistribution[status] =
          (nutritionDistribution[status] || 0) + 1;
      }
    });
    const nutritionDistArray = Object.entries(nutritionDistribution).map(
      ([displayName, total]) => ({ displayName, total }),
    );

    let schoolHealthService = null;
    const childWithSchool = children.find((c) => c.student?.schoolId);
    if (childWithSchool) {
      const schoolId = childWithSchool.student.schoolId;
      // 8. schoolQuesioner lookup
      const [schoolQuesionerRows] = await pool.query(
        `SELECT id, title FROM quesioners WHERE title = ? LIMIT 1`,
        ["Pelayanan Kesehatan Sekolah"],
      );
      const schoolQuesioner = schoolQuesionerRows[0] ?? null;
      if (schoolQuesioner) {
        // 9. latest response for that school+questionnaire
        const [schoolResponseRows] = await pool.query(
          `SELECT id, quisionerId, totalScore, familyMemberId, institutionId, created_at
           FROM responses
           WHERE institutionId = ? AND quisionerId = ?
           ORDER BY created_at DESC
           LIMIT 1`,
          [schoolId, schoolQuesioner.id],
        );
        const schoolResponse = schoolResponseRows[0] ?? null;
        if (schoolResponse) {
          const threshold = 17;
          schoolHealthService = {
            title: schoolQuesioner.title,
            totalScore: schoolResponse.totalScore,
            interpretation:
              schoolResponse.totalScore >= threshold ? "Tinggi" : "Rendah",
          };
        }
      }
    }

    return successResponse(
      res,
      {
        totalFamilyMembers,
        totalChildren,
        totalQuestionnaires,
        answeredQuestionnaires,
        questionnaireProgress,
        questionnaireResults,
        socioEconomic,
        parentEducation,
        latestNutritionStatus:
          latestNutrition?.nutritionStatus?.displayName ?? null,
        nutritionDistribution: nutritionDistArray,
        schoolHealthService,
      },
      "Dashboard summary retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get dashboard summary");
  }
};
```

- [ ] **Step 9: Run the tests to verify `getParentDashboardSummary` passes**

Run: `npx vitest run src/controllers/__tests__/StatisticsController.test.js`

Expected: PASS (all `getAdminDashboardSummary` + `getParentDashboardSummary` tests, ~18 total).

- [ ] **Step 10: Commit**

```bash
git add src/controllers/StatisticsController.js src/controllers/__tests__/StatisticsController.test.js
git commit -m "refactor: convert getParentDashboardSummary to raw mysql2"
```

---

### Task 35: Convert `getSchoolDashboardSummary` + `getHealthcareDashboardSummary` (StatisticsController.js)

**Files:**
- Modify: `src/controllers/StatisticsController.js` (`getSchoolDashboardSummary`, `getHealthcareDashboardSummary`, and — as a final cleanup once both are converted — remove the now-unused `import { PrismaClient } from "@prisma/client";` and `const prisma = new PrismaClient();` lines, since no function in this file uses Prisma anymore)
- Modify: `src/controllers/__tests__/StatisticsController.test.js` (append two new `describe` blocks; do not touch the existing `getAdminDashboardSummary`/`getParentDashboardSummary` blocks from Task 34)

**Interfaces:**
- Depends on: `pool` default export from `src/config/db.js` (Task 0); the test file and mock helpers established in Task 34.
- Produces: all 4 `StatisticsController.js` exports fully converted off Prisma — this is the last StatisticsController task.

Two behaviors in this task are deliberately different from anything in Task 34 and from each other — do not "fix" either one:
- `getSchoolDashboardSummary`'s nutrition distribution has **no** true-latest ordering in the original Prisma call, and reads array index `[0]` of an **unsorted** result. This must be reproduced bug-for-bug: query `ORDER BY fm.id, n.id ASC` and take the first nutrition row encountered per family member (dedup via a `Set`), NOT the true latest. This is intentionally different from Task 34's two true-latest implementations.
- `getHealthcareDashboardSummary`'s `recommendationsByStatus` **does** zero-fill all 3 statuses — but via 3 parallel `COUNT` queries built into a fixed 3-element array, not a SQL `groupBy` at all. This is intentionally different from Task 34's admin dashboard `groupBy`s, which never zero-fill.

Continue coercing every `COUNT(*)`/`COUNT(id)` result with `Number(...)` before arithmetic — see the note already added at the top of this file in Task 34.

---

- [ ] **Step 1: Write the failing tests for `getSchoolDashboardSummary`**

Append to `src/controllers/__tests__/StatisticsController.test.js` (add the import for the two new handlers to the existing top-of-file import, and add a new `describe` block after `getParentDashboardSummary`'s):

```js
// add to the existing import at the top of the file:
// import {
//   getAdminDashboardSummary,
//   getParentDashboardSummary,
//   getSchoolDashboardSummary,
//   getHealthcareDashboardSummary,
// } from "../StatisticsController.js";

describe("getSchoolDashboardSummary", () => {
  it("returns the errorResponse default (500) shape when no institution matches user_id, issuing only 1 query", async () => {
    pool.query.mockResolvedValueOnce([[], []]); // institutions lookup — empty
    const res = mockRes();

    await getSchoolDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM institutions WHERE user_id = ?"),
      ["user-1"],
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Institution not found",
      error: null,
    });
  });

  it("counts totalStudents/totalPartners against schoolId (camelCase) and totalClasses/totalTeachers against school_id (snake_case) — schema column casing is NOT uniform", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 55, user_id: "user-1" }], []]) // institution
      .mockResolvedValueOnce([[{ count: 12 }], []]) // totalStudents
      .mockResolvedValueOnce([[{ count: 3 }], []]) // totalClasses
      .mockResolvedValueOnce([[{ count: 2 }], []]) // totalTeachers
      .mockResolvedValueOnce([[{ count: 1 }], []]) // totalPartners
      .mockResolvedValueOnce([[], []]) // nutrition rows
      .mockResolvedValueOnce([[], []]) // classGroups
      .mockResolvedValueOnce([[], []]); // quesioner lookup
    const res = mockRes();

    await getSchoolDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM students WHERE schoolId = ?"),
      [55],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("FROM classes WHERE school_id = ?"),
      [55],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("FROM teachers WHERE school_id = ?"),
      [55],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("FROM partnerships WHERE schoolId = ?"),
      [55],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data).toEqual(
      expect.objectContaining({
        totalStudents: 12,
        totalClasses: 3,
        totalTeachers: 2,
        totalPartners: 1,
      }),
    );
  });

  it("nutritionDistribution reproduces the original bug: takes the FIRST nutrition row per member in (fm.id, n.id ASC) order, not the true latest", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 55, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[{ count: 2 }], []])
      .mockResolvedValueOnce([[{ count: 1 }], []])
      .mockResolvedValueOnce([[{ count: 1 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([
        [
          // member fm-1 has TWO nutrition rows (n.id 10 then 20, ASC order).
          // The bug-for-bug behavior takes n.id=10's status ("Gizi Kurang"),
          // ignoring n.id=20's status ("Gizi Baik") even though 20 is the
          // more-recently-inserted row. This is NOT "fixed" to be latest-first.
          { familyMemberId: "fm-1", nutritionId: 10, displayName: "Gizi Kurang" },
          { familyMemberId: "fm-1", nutritionId: 20, displayName: "Gizi Baik" },
          // member fm-2 has zero nutrition rows -> Tidak Terdata
          { familyMemberId: "fm-2", nutritionId: null, displayName: null },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []]) // classGroups
      .mockResolvedValueOnce([[], []]); // quesioner
    const res = mockRes();

    await getSchoolDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("ORDER BY fm.id ASC, n.id ASC"),
      [55],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.nutritionDistribution).toEqual(
      expect.arrayContaining([
        { displayName: "Gizi Kurang", total: 1 },
        { displayName: "Tidak Terdata", total: 1 },
      ]),
    );
    expect(body.data.nutritionDistribution).not.toEqual(
      expect.arrayContaining([{ displayName: "Gizi Baik", total: 1 }]),
    );
  });

  it("classGroups: groupBy does NOT zero-fill classes with no students, and skips the classes IN(?) lookup entirely when there are no groups", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 55, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[], []]) // nutrition rows
      .mockResolvedValueOnce([[], []]) // classGroups — empty
      .mockResolvedValueOnce([[], []]); // quesioner
    const res = mockRes();

    await getSchoolDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(8); // classes IN(?) lookup skipped
    const body = res.json.mock.calls[0][0];
    expect(body.data.studentsPerClass).toEqual([]);
  });

  it("classGroups: defaults an orphaned classId (no matching row in classes) to 'Unknown'", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 55, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[{ count: 5 }], []])
      .mockResolvedValueOnce([[{ count: 1 }], []])
      .mockResolvedValueOnce([[{ count: 1 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ classId: 7, count: "5" }], []]) // classGroups
      .mockResolvedValueOnce([[], []]) // classes IN(?) — classId 7 not found
      .mockResolvedValueOnce([[], []]); // quesioner
    const res = mockRes();

    await getSchoolDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      8,
      expect.stringContaining("FROM classes WHERE id IN (?)"),
      [[7]],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.studentsPerClass).toEqual([
      { className: "Unknown", total: 5 },
    ]);
  });

  it("questionnaireResult: skips the response lookup when quesioner is missing, leaving schoolConclusion null", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 55, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]); // quesioner — not found
    const res = mockRes();

    await getSchoolDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(8);
    const body = res.json.mock.calls[0][0];
    expect(body.data.questionnaireResult).toBeNull();
    expect(body.data.schoolConclusion).toBeNull();
  });

  it("questionnaireResult: applies the 17-point Tinggi/Rendah threshold and builds the matching schoolConclusion when a response exists", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 55, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [{ id: 9, title: "Pelayanan Kesehatan Sekolah" }],
        [],
      ]) // quesioner
      .mockResolvedValueOnce([[{ id: "resp-1", totalScore: 10 }], []]); // response
    const res = mockRes();

    await getSchoolDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      9,
      expect.stringContaining("ORDER BY created_at DESC"),
      [55, 9],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.questionnaireResult).toEqual({
      quesionerId: 9,
      title: "Pelayanan Kesehatan Sekolah",
      totalScore: 10,
      interpretation: "Rendah",
    });
    expect(body.data.schoolConclusion.kategori).toBe(
      "Pelayanan Kesehatan Sekolah Perlu Ditingkatkan",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/StatisticsController.test.js -t getSchoolDashboardSummary`

Expected: FAIL — `getSchoolDashboardSummary` still calls `prisma.institution.findUnique(...)`, so `pool.query` is never invoked (or the real `PrismaClient` errors/times out).

- [ ] **Step 3: Implement `getSchoolDashboardSummary` against `pool`**

Replace the body of `getSchoolDashboardSummary` in `src/controllers/StatisticsController.js`:

```js
export const getSchoolDashboardSummary = async (req, res) => {
  try {
    const user = req.user;

    const [institutionRows] = await pool.query(
      `SELECT id, user_id, name FROM institutions WHERE user_id = ? LIMIT 1`,
      [user.id],
    );
    const institution = institutionRows[0] ?? null;

    if (!institution) return errorResponse(res, null, "Institution not found");

    const institutionId = institution.id;

    // NOTE the column-name inconsistency: students.schoolId and
    // partnerships.schoolId are camelCase, but classes.school_id and
    // teachers.school_id are snake_case. This mirrors the actual DB schema —
    // do not "normalize" the casing, it would break these queries.
    const [studentCountRows, classCountRows, teacherCountRows, partnerCountRows] =
      await Promise.all([
        pool.query(`SELECT COUNT(id) AS count FROM students WHERE schoolId = ?`, [
          institutionId,
        ]),
        pool.query(`SELECT COUNT(id) AS count FROM classes WHERE school_id = ?`, [
          institutionId,
        ]),
        pool.query(`SELECT COUNT(id) AS count FROM teachers WHERE school_id = ?`, [
          institutionId,
        ]),
        pool.query(
          `SELECT COUNT(id) AS count FROM partnerships WHERE schoolId = ?`,
          [institutionId],
        ),
      ]);
    const totalStudents = Number(studentCountRows[0][0].count);
    const totalClasses = Number(classCountRows[0][0].count);
    const totalTeachers = Number(teacherCountRows[0][0].count);
    const totalPartners = Number(partnerCountRows[0][0].count);

    // Nutrition distribution — INTENTIONAL BUG-FOR-BUG REPRODUCTION. The
    // original Prisma call has no orderBy/take on the nutrition relation, and
    // the downstream JS reads array index [0] of an unsorted array — i.e. it
    // reads whichever row the DB's default order happens to put first, NOT the
    // true latest nutrition record. This is reproduced here by ordering
    // (fm.id, n.id) ASC and taking the first nutrition row seen per member via
    // a Set, NOT by ordering on updatedAt DESC like Task 34's two dashboards.
    // Do not "fix" this to also be latest-first.
    const [nutritionRows] = await pool.query(
      `SELECT fm.id AS familyMemberId, n.id AS nutritionId, ns.displayName
       FROM family_members fm
       INNER JOIN students st ON st.familyMemberId = fm.id
       LEFT JOIN nutritions n ON n.familyMemberId = fm.id
       LEFT JOIN nutrition_status ns ON ns.id = n.nutritionStatusId
       WHERE st.schoolId = ?
       ORDER BY fm.id ASC, n.id ASC`,
      [institutionId],
    );
    const seenMembers = new Set();
    const nutritionMap = {};
    nutritionRows.forEach((row) => {
      if (seenMembers.has(row.familyMemberId)) return;
      seenMembers.add(row.familyMemberId);
      const name = row.displayName || "Tidak Terdata";
      nutritionMap[name] = (nutritionMap[name] || 0) + 1;
    });
    const nutritionDistribution = Object.entries(nutritionMap).map(
      ([displayName, total]) => ({ displayName, total }),
    );

    // classGroups groupBy — no zero-fill
    const [classGroups] = await pool.query(
      `SELECT classId, COUNT(id) AS count FROM students WHERE schoolId = ? GROUP BY classId`,
      [institutionId],
    );
    const classIds = classGroups.map((g) => g.classId);
    let classes = [];
    if (classIds.length > 0) {
      [classes] = await pool.query(
        `SELECT id, name FROM classes WHERE id IN (?)`,
        [classIds],
      );
    }
    const classMap = {};
    classes.forEach((c) => {
      classMap[c.id] = c.name;
    });
    const studentsPerClass = classGroups.map((g) => ({
      className: classMap[g.classId] || "Unknown",
      total: Number(g.count),
    }));

    const QUESTIONNAIRE_THRESHOLDS = {
      "Pelayanan Kesehatan Sekolah": { min: 17, good: "Tinggi", bad: "Rendah" },
    };

    const [quesionerRows] = await pool.query(
      `SELECT id, title FROM quesioners WHERE title = ? LIMIT 1`,
      ["Pelayanan Kesehatan Sekolah"],
    );
    const quesioner = quesionerRows[0] ?? null;

    let questionnaireResult = null;
    let questionnaireProgress = 0;
    let totalQuestionnaires = 0;
    let answeredQuestionnaires = 0;

    if (quesioner) {
      totalQuestionnaires = 1;
      const [responseRows] = await pool.query(
        `SELECT id, quisionerId, totalScore, institutionId, created_at
         FROM responses
         WHERE institutionId = ? AND quisionerId = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [institutionId, quesioner.id],
      );
      const response = responseRows[0] ?? null;

      if (response) {
        answeredQuestionnaires = 1;
        const threshold = QUESTIONNAIRE_THRESHOLDS[quesioner.title]?.min ?? 17;
        const totalScore = response.totalScore || 0;
        questionnaireResult = {
          quesionerId: quesioner.id,
          title: quesioner.title,
          totalScore,
          interpretation:
            totalScore >= threshold
              ? (QUESTIONNAIRE_THRESHOLDS[quesioner.title]?.good ?? "Tinggi")
              : (QUESTIONNAIRE_THRESHOLDS[quesioner.title]?.bad ?? "Rendah"),
        };
      }
    }

    questionnaireProgress =
      totalQuestionnaires > 0
        ? Math.round((answeredQuestionnaires / totalQuestionnaires) * 100)
        : 0;

    const schoolConclusion = questionnaireResult
      ? questionnaireResult.interpretation === "Tinggi"
        ? {
            kategori: "Pelayanan Kesehatan Sekolah Baik",
            icon: "🏆",
            color: "from-emerald-500 to-teal-600",
            saran: ["Budayakan perilaku hidup sehat dalam lingkungan sekolah"],
          }
        : {
            kategori: "Pelayanan Kesehatan Sekolah Perlu Ditingkatkan",
            icon: "⚠️",
            color: "from-amber-500 to-orange-600",
            saran: [
              "Rekomendasi tindaklanjut Puskesmas",
              "Budayakan perilaku hidup sehat dalam lingkungan sekolah",
            ],
          }
      : null;

    return successResponse(
      res,
      {
        totalStudents,
        totalClasses,
        totalTeachers,
        totalPartners,
        questionnaireProgress,
        questionnaireResult,
        nutritionDistribution,
        studentsPerClass,
        schoolConclusion,
      },
      "School dashboard summary retrieved successfully",
    );
  } catch (error) {
    return errorResponse(res, error, "Failed to get school dashboard summary");
  }
};
```

- [ ] **Step 4: Run the tests to verify `getSchoolDashboardSummary` passes**

Run: `npx vitest run src/controllers/__tests__/StatisticsController.test.js -t getSchoolDashboardSummary`

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/StatisticsController.js src/controllers/__tests__/StatisticsController.test.js
git commit -m "refactor: convert getSchoolDashboardSummary to raw mysql2"
```

- [ ] **Step 6: Write the failing tests for `getHealthcareDashboardSummary`**

Append a final `describe` block to `src/controllers/__tests__/StatisticsController.test.js`:

```js
describe("getHealthcareDashboardSummary", () => {
  it("returns the errorResponse default (500) shape when no institution matches user_id", async () => {
    pool.query.mockResolvedValueOnce([[], []]); // institutions lookup — empty
    const res = mockRes();

    await getHealthcareDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      message: "Institution not found",
      error: null,
    });
  });

  it("recommendationsByStatus zero-fills all 3 statuses via 3 parallel COUNTs — NOT a groupBy — contrasting the admin dashboard's no-backfill groupBy", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 77, user_id: "user-1" }], []]) // institution
      .mockResolvedValueOnce([[{ count: "5" }], []]) // pending
      .mockResolvedValueOnce([[{ count: 2 }], []]) // processed
      .mockResolvedValueOnce([[{ count: 0 }], []]) // completed — zero, but must still appear
      .mockResolvedValueOnce([[{ count: 3 }], []]) // totalPartnerSchools
      .mockResolvedValueOnce([[], []]); // recentRecs
    const res = mockRes();

    await getHealthcareDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("status = ?"),
      [77, "PENDING"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(3, expect.any(String), [
      77,
      "PROCESSED",
    ]);
    expect(pool.query).toHaveBeenNthCalledWith(4, expect.any(String), [
      77,
      "COMPLETED",
    ]);
    const body = res.json.mock.calls[0][0];
    expect(body.data.totalPending).toBe(5);
    expect(body.data.totalProcessed).toBe(2);
    expect(body.data.totalCompleted).toBe(0);
    expect(body.data.recommendationsByStatus).toEqual([
      { status: "PENDING", total: 5 },
      { status: "PROCESSED", total: 2 },
      { status: "COMPLETED", total: 0 }, // present even though zero — no dropping
    ]);
  });

  it("totalPartnerSchools filters by the healthcareId column", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 77, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 4 }], []])
      .mockResolvedValueOnce([[], []]);
    const res = mockRes();

    await getHealthcareDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("FROM partnerships WHERE healthcareId = ?"),
      [77],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.totalPartnerSchools).toBe(4);
  });

  it("recentRecommendations reshapes flat joined rows into the genuinely nested student.{familyMember,institution,class} shape, emitting class: null (not {name: null}) when the LEFT JOIN finds no class", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 77, user_id: "user-1" }], []])
      .mockResolvedValueOnce([[{ count: 2 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 0 }], []])
      .mockResolvedValueOnce([[{ count: 1 }], []])
      .mockResolvedValueOnce([
        [
          {
            id: "rec-1",
            createdAt: new Date("2026-07-15T00:00:00Z"),
            nis: "12345",
            familyMemberFullName: "Anak Satu",
            institutionName: "School A",
            className: "Kelas 1A",
          },
          {
            id: "rec-2",
            createdAt: new Date("2026-07-14T00:00:00Z"),
            nis: "67890",
            familyMemberFullName: "Anak Dua",
            institutionName: "School B",
            className: null, // no class assigned — LEFT JOIN found nothing
          },
        ],
        [],
      ]); // recentRecs
    const res = mockRes();

    await getHealthcareDashboardSummary(mockReq(), res);

    expect(pool.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("LEFT JOIN classes"),
      [77, "PENDING"],
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.recentRecommendations).toEqual([
      {
        id: "rec-1",
        createdAt: new Date("2026-07-15T00:00:00Z"),
        student: {
          nis: "12345",
          familyMember: { fullName: "Anak Satu" },
          institution: { name: "School A" },
          class: { name: "Kelas 1A" },
        },
      },
      {
        id: "rec-2",
        createdAt: new Date("2026-07-14T00:00:00Z"),
        student: {
          nis: "67890",
          familyMember: { fullName: "Anak Dua" },
          institution: { name: "School B" },
          class: null,
        },
      },
    ]);
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run src/controllers/__tests__/StatisticsController.test.js -t getHealthcareDashboardSummary`

Expected: FAIL — `getHealthcareDashboardSummary` still calls `prisma.institution.findFirst(...)`, so `pool.query` is never invoked (or the real `PrismaClient` errors/times out).

- [ ] **Step 8: Implement `getHealthcareDashboardSummary` against `pool`**

Replace the body of `getHealthcareDashboardSummary` in `src/controllers/StatisticsController.js`:

```js
export const getHealthcareDashboardSummary = async (req, res) => {
  try {
    const user = req.user;

    // findFirst in the original vs findUnique in the school dashboard — both
    // compile to LIMIT 1 since institutions.user_id is @unique; no behavior
    // difference, so a plain LIMIT 1 SELECT covers both.
    const [institutionRows] = await pool.query(
      `SELECT id, user_id, name FROM institutions WHERE user_id = ? LIMIT 1`,
      [user.id],
    );
    const institution = institutionRows[0] ?? null;

    if (!institution) return errorResponse(res, null, "Institution not found");

    const institutionId = institution.id;

    // Three counts, run in parallel — preserving the original Promise.all
    // parallelism exactly. This fixed 3-element array IS the zero-fill for
    // this handler: PENDING/PROCESSED/COMPLETED always appear, even at 0.
    // Contrast with the admin dashboard's recByStatus groupBy (Task 34), which
    // drops any status with zero rows instead of zero-filling it.
    const [pendingResult, processedResult, completedResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(id) AS count FROM recommendations WHERE healthcareInstitutionId = ? AND status = ?`,
        [institutionId, "PENDING"],
      ),
      pool.query(
        `SELECT COUNT(id) AS count FROM recommendations WHERE healthcareInstitutionId = ? AND status = ?`,
        [institutionId, "PROCESSED"],
      ),
      pool.query(
        `SELECT COUNT(id) AS count FROM recommendations WHERE healthcareInstitutionId = ? AND status = ?`,
        [institutionId, "COMPLETED"],
      ),
    ]);
    const pending = Number(pendingResult[0][0].count);
    const processed = Number(processedResult[0][0].count);
    const completed = Number(completedResult[0][0].count);

    const [totalPartnerSchoolsRows] = await pool.query(
      `SELECT COUNT(id) AS count FROM partnerships WHERE healthcareId = ?`,
      [institutionId],
    );
    const totalPartnerSchools = Number(totalPartnerSchoolsRows[0].count);

    // recentRecs — the ONE spot in this file where the response is genuinely
    // nested, not flattened by a .map(). student.familyMember/institution are
    // required relations (INNER JOIN safe); student.class is declared optional
    // in the schema even though the FK itself is non-nullable (a schema
    // quirk), so it needs a LEFT JOIN and must emit `class: null` — not
    // `{ name: null }` — when absent.
    const [recentRecsRows] = await pool.query(
      `SELECT r.id, r.createdAt, s.nis, fm.fullName AS familyMemberFullName,
              i.name AS institutionName, c.name AS className
       FROM recommendations r
       INNER JOIN students s ON s.id = r.studentId
       INNER JOIN family_members fm ON fm.id = s.familyMemberId
       INNER JOIN institutions i ON i.id = s.schoolId
       LEFT JOIN classes c ON c.id = s.classId
       WHERE r.healthcareInstitutionId = ? AND r.status = ?
       ORDER BY r.createdAt DESC
       LIMIT 5`,
      [institutionId, "PENDING"],
    );
    const recentRecommendations = recentRecsRows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      student: {
        nis: r.nis,
        familyMember: { fullName: r.familyMemberFullName },
        institution: { name: r.institutionName },
        class: r.className != null ? { name: r.className } : null,
      },
    }));

    const recByStatus = [
      { status: "PENDING", total: pending },
      { status: "PROCESSED", total: processed },
      { status: "COMPLETED", total: completed },
    ];

    return successResponse(
      res,
      {
        totalPending: pending,
        totalProcessed: processed,
        totalCompleted: completed,
        totalPartnerSchools,
        recentRecommendations,
        recommendationsByStatus: recByStatus,
      },
      "Healthcare dashboard summary retrieved successfully",
    );
  } catch (error) {
    return errorResponse(
      res,
      error,
      "Failed to get healthcare dashboard summary",
    );
  }
};
```

- [ ] **Step 9: Remove the now-unused Prisma import**

All 4 exports in `src/controllers/StatisticsController.js` now use `pool` exclusively. Remove the two lines added by the original file:

```diff
-import { PrismaClient } from "@prisma/client";
 import pool from "../config/db.js";
 import { errorResponse, successResponse } from "../helpers/ResponseHelper.js";
-
-const prisma = new PrismaClient();
```

- [ ] **Step 10: Run the full test file to verify everything passes**

Run: `npx vitest run src/controllers/__tests__/StatisticsController.test.js`

Expected: PASS (all tests across all 4 handlers, ~32 total).

- [ ] **Step 11: Commit**

```bash
git add src/controllers/StatisticsController.js src/controllers/__tests__/StatisticsController.test.js
git commit -m "refactor: convert getHealthcareDashboardSummary to raw mysql2, drop Prisma from StatisticsController"
```
### Task 36: Remove Prisma dependency and run full verification

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: every controller/middleware file converted in Tasks 1-35 (none of them should still import `@prisma/client` or instantiate `PrismaClient` by this point).

- [ ] **Step 1: Confirm no file still references Prisma at runtime**

Run: `grep -rn "PrismaClient\|@prisma/client" src/`
Expected: no output (empty). If anything is still found, stop here and go back to the task that converted that file — do not proceed until this is clean.

- [ ] **Step 2: Remove Prisma packages from package.json**

Run:
```bash
npm uninstall prisma @prisma/client
```
Expected: `package.json`'s `dependencies` no longer lists `prisma` or `@prisma/client`; `package-lock.json` is regenerated without them.

- [ ] **Step 3: Update the GitHub Actions deploy workflow**

Edit `.github/workflows/deploy.yml` — remove the `PRISMA_CLI_BINARY_TARGETS` env var and the `npx prisma generate` step from the "Install dependencies and generate Prisma Client" step (rename it to "Install dependencies"), since there is no Prisma Client to generate anymore:

```yaml
      - name: Install dependencies
        run: |
          npm ci --omit=dev
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests from Tasks 0-35 pass (this should be several hundred tests given ~20 converted files). If anything fails, fix it in place before proceeding — this is the single point where cross-task regressions would surface (e.g. two files accidentally using different pool import conventions).

- [ ] **Step 5: Manual smoke test against the real database**

With `DATABASE_URL` pointed at a real (ideally non-production, or production during a low-traffic window) MySQL/MariaDB instance, start the app locally:
```bash
npm start
```
Then exercise a handful of representative endpoints with `curl` to confirm real end-to-end behavior beyond what the mocked unit tests can verify — pick at least one from each of: a simple lookup (e.g. `GET /api/provinces`), an authenticated flow (`POST /api/login` then a protected route with the returned token), a paginated list with search (e.g. `GET /api/institutions?search=...`), and the one dashboard endpoint most likely to have subtle SQL mistakes (`GET /api/statistics/admin` or equivalent route). Confirm response shapes match what the frontend expects (same field names/nesting as before the migration) and HTTP status codes match what the tests asserted.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .github/workflows/deploy.yml
git commit -m "chore: remove Prisma dependency now that all controllers use raw mysql2"
```

---

## Post-migration note (not a task step, just context for whoever runs this)

`prisma/schema.prisma` and `prisma/migrations/` are left in place after this migration — they're not deleted. They remain useful as living documentation of the schema (table/column names, relations, enums) even though nothing at runtime reads them anymore. If a future schema change is needed, it should be written directly as a `.sql` migration file and the corresponding raw queries in the affected controller(s) updated by hand, since there is no more Prisma Migrate workflow driving schema changes.
