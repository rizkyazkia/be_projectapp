const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "APP_ACCESS_TOKEN_SECRET",
  "APP_REFRESH_TOKEN_SECRET",
];

function isPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateEnv(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !isPresent(env[name]));

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

export default validateEnv;
