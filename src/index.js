import dotenv from "dotenv";

dotenv.config();

import { validateEnv } from "./config/validateEnv.js";

validateEnv();

// Routes.js transitively imports controllers/config/db.js, which reads
// process.env.DATABASE_URL at module-evaluation time. Static imports are
// hoisted and evaluated before the statements above, so Routes must be
// imported dynamically here — after validateEnv() has run — otherwise a
// missing/invalid env var surfaces as a cryptic mysql2 error instead of
// the clear validateEnv() message.
const { default: Routes } = await import("./routes/Routes.js");

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

const app = express();
app.disable("x-powered-by");

const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.options(/.*/, cors(corsOptions));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json());

app.get("/api/healthcheck", (req, res) => {
  res.json({ status: "ok" });
});

// Routing
app.use(Routes);

const PORT = process.env.PORT || process.env.API_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
