# Jalinan Anak Sehat - Backend API

Jalinan Anak Sehat ("Connected Healthy Children") is a child health and nutrition tracking and screening system built for the Indonesian school and healthcare ecosystem. This repository is the backend REST API that powers the platform: it manages family and student records, health/nutrition questionnaires, BMI (IMT) and nutrition-status tracking, healthcare provider recommendations and interventions, partnerships between institutions, and role-based dashboards for the different actors in the system - parents, schools/teachers, healthcare institutions (puskesmas), administrative staff, and system administrators.

## Tech Stack

- **Runtime**: Node.js (ESM modules, `"type": "module"`)
- **Framework**: Express 5
- **Database**: MySQL / MariaDB
- **Data access**: [`mysql2`](https://www.npmjs.com/package/mysql2) (raw SQL via a connection pool, `src/config/db.js`) - the project has been fully migrated off Prisma at runtime; see [Prisma to mysql2 migration](#prisma-to-mysql2-migration) below
- **Schema reference (historical, not executed at runtime)**: [Prisma ORM](https://www.prisma.io/) schema and migration files (`prisma/schema.prisma`, `prisma/migrations/`) are kept in the repo as living documentation of the data model - the `prisma`/`@prisma/client` packages themselves are no longer a dependency
- **Auth**: JSON Web Tokens (access + refresh), `argon2` password hashing, httpOnly cookie-based refresh tokens
- **Validation**: Joi
- **Testing**: Vitest

## Features

Grouped by domain, based on the actual routes exposed by the API:

- **Authentication & accounts** - parent and institution registration, login/logout, access + refresh token issuance, refresh-token rotation via cookie
- **Users & roles** - user listing/lookup/update/delete, role-based access control (`admin`, `parent`, `school`, `teacher`, `healthcare`, `staff`)
- **Institutions** - institution and institution-type management, healthcare institution listing, institution lookup by user
- **Geography** - provinces and cities (including cities-by-province)
- **Schools** - classes (by institution), teachers, students, categories, jobs/job types
- **Family & family members** - family records, family members, parent lookups by family member
- **Health questionnaires (Quesioner)** - questionnaires, questions and options, responses for both parents and institutions, answer-checking
- **Nutrition tracking** - IMT/BMI calculation, nutrition status and BMI reference data
- **Recommendations & interventions** - healthcare recommendations for students, status changes, interventions belonging to institutions or families
- **Partnerships** - partner institution management
- **Notifications** - list, unread count, mark as read (single/all)
- **Statistics dashboards** - summary endpoints per role (admin, parent, school, healthcare)
- **Staff management** - CRUD for institutional staff accounts

## Prerequisites

- Node.js 24 (matches the version used in the GitHub Actions deploy pipeline; Node 18+ should also work for local development)
- MySQL or MariaDB server
- npm or yarn (both a `package-lock.json` and `yarn.lock` are present in the repo)

## Setup

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd be_projectapp
   ```

2. **Install dependencies**

   ```bash
   npm install
   # or
   yarn install
   ```

3. **Configure environment variables**

   Create a `.env` file in the project root (it is git-ignored). The following variables are read by the app:

   | Variable | Description |
   | --- | --- |
   | `DATABASE_URL` | MySQL connection string used to create the `mysql2` connection pool, e.g. `mysql://user:password@host:3306/dbname` |
   | `APP_ACCESS_TOKEN_SECRET` | Secret used to sign/verify short-lived JWT access tokens |
   | `APP_REFRESH_TOKEN_SECRET` | Secret used to sign/verify longer-lived JWT refresh tokens |
   | `CORS_ORIGIN` | Comma-separated list of allowed CORS origins (defaults to `http://localhost:5173` if unset) |
   | `PORT` / `API_PORT` | Port the Express server listens on (defaults to `3000` if neither is set) |

4. **Set up the database schema**

   `prisma/schema.prisma` and `prisma/migrations/` are kept in the repo purely as living documentation of the schema (table/column names, relations, enums) - the `prisma` CLI is no longer a project dependency, so migrations are no longer applied via `prisma migrate`. Apply `prisma/migrations/*.sql` directly against your MySQL/MariaDB instance (e.g. `mysql -u user -p dbname < prisma/migrations/<folder>/migration.sql`, in order), or restore from an existing database dump. Any future schema change should be written as a new hand-authored `.sql` migration alongside the corresponding raw-query changes in the affected controller(s).

5. **Seed the database (optional)**

   The seed script (`prisma/seed.js`) populates roles, an initial user, provinces/cities, institution types, categories, questionnaires/questions/options, job types, nutrition status reference data, and IMT/BMI reference data. Run it directly with Node (it no longer runs through the Prisma CLI):

   ```bash
   node prisma/seed.js
   ```

## Running the App

```bash
# Development (auto-restarts via nodemon)
npm run dev

# Production
npm start
```

The server exposes a health check at `GET /api/healthcheck`.

## Running Tests

Tests are written with [Vitest](https://vitest.dev/) and live alongside the code in `__tests__` directories. Controller tests mock the `mysql2` pool (`src/config/db.js`) so they run without a live database connection.

```bash
# Run once
npm test

# Watch mode
npm run test:watch
```

## Project Structure

```
prisma/
  schema.prisma        # Historical schema documentation only - not read at runtime
  migrations/           # Historical SQL migrations - not applied via Prisma anymore
  seed.js               # Seed script entry point (raw mysql2, no Prisma dependency)
  seeders/              # Per-domain seeders (roles, users, geography, questionnaires, etc.)
src/
  index.js              # Express app entrypoint (CORS, cookies, JSON body parsing, routing)
  config/
    db.js                # mysql2 connection pool
  controllers/           # Request handlers, one per domain (Auth, Student, Family, Quesioner, ...)
  middelware/            # verifyToken (JWT auth), roleBased (RBAC), validate (Joi)
  routes/                # Express routers, one per domain, aggregated in Routes.js
  validators/            # Joi validation schemas
  helpers/
    ResponseHelper.js     # Consistent success/error response envelopes
```

## API Overview

All routes are mounted under `/api` (see `src/routes/Routes.js`). Route groups, by prefix:

| Prefix | Domain |
| --- | --- |
| `/api/auth` | Registration (parent/institution), login, logout |
| `/api/token` | Access token refresh |
| `/api/users` | User management |
| `/api/province`, `/api/city` | Geography |
| `/api/institutions`, `/api/institutionType` | Institutions |
| `/api/categories` | Categories |
| `/api/quesioners`, `/api/questions`, `/api/question` | Health questionnaires |
| `/api/response` | Questionnaire responses (parent and institution) |
| `/api/teachers`, `/api/classes` | School staffing and classes |
| `/api/families` | Family and family member records |
| `/api/jobs`, `/api/job-types` | Occupation reference data |
| `/api/students` | Student records |
| `/api/recommendation`, `/api/interventions` | Healthcare recommendations and interventions |
| `/api/statistics` | Role-based dashboard summaries (admin/parent/school/healthcare) |
| `/api/partners` | Institution partnerships |
| `/api/staffs` | Staff management |
| `/api/notifications` | Notifications |
| `/api/imt` | BMI/IMT calculation |

Most write and per-user endpoints require a valid JWT access token (`Authorization: Bearer <token>`) via the `verifyToken` middleware; some are additionally restricted to specific roles via `roleBased`.

## Prisma to mysql2 Migration

This project was originally built on Prisma ORM, but Prisma's query engine repeatedly crashed under the previous constrained hosting environment (`PANIC: timer has gone away`) and exhausted its resource limits during engine-binary downloads and connection handling.

The entire backend has since been migrated off Prisma to raw parameterized `mysql2` queries against a shared connection pool (`src/config/db.js`):

- Every controller and middleware file in `src/` uses `pool.query`/`pool.getConnection` directly - there is no remaining runtime import of `@prisma/client` anywhere in `src/`.
- The 12 database seed scripts under `prisma/seeders/` (run via `node prisma/seed.js`) were converted the same way.
- The `prisma` and `@prisma/client` npm packages have been removed from `package.json` entirely.
- `prisma/schema.prisma` and `prisma/migrations/` are kept in the repo purely as historical documentation of the data model (table/column names, relations, enums) - nothing at runtime reads them. Any future schema change is applied as a hand-authored `.sql` migration alongside the corresponding raw-query changes in the affected controller(s), since there is no more Prisma Migrate workflow.
- Test coverage (Vitest, mocking the `mysql2` pool) was added alongside every conversion, since the backend previously had no automated tests.
- Two pre-existing bugs that always caused their endpoints to return HTTP 500 (an invalid Prisma relation include, and a `ReferenceError` from a stale variable name) were fixed as part of the migration; every other pre-existing quirk and bug in the original code was preserved exactly, since replicating current production behavior - not "cleaning it up" - was the goal.
