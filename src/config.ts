/**
 * Central configuration, read once from the environment.
 *
 * Like home-bridge-mcp, this is deliberately a single origin that is BOTH the
 * OAuth 2.1 authorization server AND the protected resource (the MCP endpoint),
 * so issuer == resource origin and the metadata stays simple.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

// Runtime state (secret.key, oauth-state.json, sqlite) lives OUTSIDE the
// ncdata-synced source tree in prod (KOMOOT_MCP_DATA_DIR) so the Nextcloud
// desktop client never syncs a live-mutating DB or replicates secrets.
const DATA_DIR = env("KOMOOT_MCP_DATA_DIR", join(HERE, "..", "data"));

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** HS256 secret for our own access tokens. Persisted so restarts don't invalidate tokens. */
function loadTokenSecret(): string {
  const fromEnv = env("KOMOOT_MCP_TOKEN_SECRET");
  if (fromEnv) return fromEnv;
  const keyFile = join(DATA_DIR, "secret.key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  mkdirSync(DATA_DIR, { recursive: true });
  const generated = randomBytes(48).toString("base64url");
  writeFileSync(keyFile, generated + "\n", { mode: 0o600 });
  return generated;
}

const PUBLIC_URL = stripTrailingSlash(env("KOMOOT_MCP_PUBLIC_URL", "http://127.0.0.1:7692"));
const MCP_PATH = "/" + env("KOMOOT_MCP_PATH", "/mcp").replace(/^\/+/, "");

export const config = {
  dataDir: DATA_DIR,

  // Public identity
  publicUrl: PUBLIC_URL,
  mcpPath: MCP_PATH,
  /** RFC 8707 canonical resource identifier this server binds tokens to. */
  resource: PUBLIC_URL + MCP_PATH,

  // Listening
  port: Number(env("PORT", "7692")),
  host: env("HOST", "127.0.0.1"),
  allowedHosts: env("KOMOOT_MCP_ALLOWED_HOSTS")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  // Upstream Authelia OIDC (its own confidential client — register "komootmcp").
  authelia: {
    issuer: stripTrailingSlash(env("AUTHELIA_ISSUER", "https://auth.filipkin.com")),
    clientId: env("AUTHELIA_CLIENT_ID", "komootmcp"),
    clientSecret: env("AUTHELIA_CLIENT_SECRET"),
    redirectUri: PUBLIC_URL + "/oauth/authelia/callback",
  },
  requiredGroup: env("KOMOOT_MCP_REQUIRED_GROUP", "admins"),

  // Our own tokens
  tokenSecret: loadTokenSecret(),
  tokenTtl: Number(env("KOMOOT_MCP_TOKEN_TTL", "3600")),

  // SQLite request log (Bun bun:sqlite) — same debugging value as the bridge.
  dbPath: env("KOMOOT_MCP_DB_PATH", join(DATA_DIR, "komoot-mcp.db")),

  // Komoot account (reverse-engineered mobile API). Email + password only;
  // SSO logins cannot mint a token.
  komoot: {
    email: env("KOMOOT_EMAIL"),
    password: env("KOMOOT_PASSWORD"),
    /** Default centre for "near me" when no place/coords are given. */
    homeLat: env("KOMOOT_HOME_LAT") ? Number(env("KOMOOT_HOME_LAT")) : undefined,
    homeLng: env("KOMOOT_HOME_LNG") ? Number(env("KOMOOT_HOME_LNG")) : undefined,
    homeLabel: env("KOMOOT_HOME_LABEL", "your saved home location"),
  },

  // Dev escape hatch
  devNoAuth: env("KOMOOT_MCP_DEV_NO_AUTH") === "1",
} as const;

export type Config = typeof config;
