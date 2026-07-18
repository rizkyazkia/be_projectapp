import { describe, it, expect } from "vitest";
import { validateEnv } from "../validateEnv.js";

function baseEnv() {
  return {
    DATABASE_URL: "mysql://testuser:testpass@localhost:3306/testdb",
    APP_ACCESS_TOKEN_SECRET: "access-secret",
    APP_REFRESH_TOKEN_SECRET: "refresh-secret",
  };
}

describe("validateEnv", () => {
  it("passes when all required env vars are present", () => {
    expect(() => validateEnv(baseEnv())).not.toThrow();
  });

  it("throws listing all missing env vars when multiple are missing", () => {
    const env = baseEnv();
    delete env.DATABASE_URL;
    delete env.APP_ACCESS_TOKEN_SECRET;

    expect(() => validateEnv(env)).toThrowError(
      "Missing required environment variables: DATABASE_URL, APP_ACCESS_TOKEN_SECRET"
    );
  });

  it("throws when a single env var is missing", () => {
    const env = baseEnv();
    delete env.APP_REFRESH_TOKEN_SECRET;

    expect(() => validateEnv(env)).toThrowError(
      "Missing required environment variables: APP_REFRESH_TOKEN_SECRET"
    );
  });

  it("treats an empty string value as missing", () => {
    const env = baseEnv();
    env.DATABASE_URL = "   ";

    expect(() => validateEnv(env)).toThrowError(
      "Missing required environment variables: DATABASE_URL"
    );
  });
});
