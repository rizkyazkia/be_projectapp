import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import Routes from "./routes/Routes.js";

dotenv.config();

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
