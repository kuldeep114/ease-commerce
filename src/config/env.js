import dotenv from 'dotenv';

// Values already present in the environment (real env vars, or `node --env-file`) always win;
// dotenv only fills the gaps. That keeps container/CI configuration authoritative over the
// committed .env file.
dotenv.config();

export function str(key, fallback) {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

export function required(key) {
  const value = str(key);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function num(key, fallback) {
  const value = str(key);
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got "${value}"`);
  }
  return parsed;
}

export function bool(key, fallback) {
  const value = str(key);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
