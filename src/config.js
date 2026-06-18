import fs from "node:fs";
import path from "node:path";

export function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

export function getConfig() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  const appBaseUrl = process.env.APP_BASE_URL || `http://${host}:${port}`;

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    host,
    port,
    appBaseUrl
  };
}

export function validateConfig() {
  const { isProduction, appBaseUrl } = getConfig();
  const issues = [];

  if (isProduction) {
    if (!process.env.TOKEN_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY.length < 24) {
      issues.push("TOKEN_ENCRYPTION_KEY must be set to a long random secret");
    }
    if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
      issues.push("Supabase server credentials are required in production");
    }
    if (!process.env.APP_BASE_URL) {
      issues.push("APP_BASE_URL is required in production");
    }
    if (!appBaseUrl.startsWith("https://")) {
      issues.push("APP_BASE_URL must use https in production");
    }
    if (!process.env.OPENAI_API_KEY) {
      issues.push("OPENAI_API_KEY is required in production");
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      issues.push("Google OAuth credentials are required in production");
    }
  }

  if (issues.length) {
    throw new Error(`Configuration error: ${issues.join("; ")}`);
  }
}
