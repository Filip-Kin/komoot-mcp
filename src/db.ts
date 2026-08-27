/**
 * SQLite request log (Bun's built-in bun:sqlite).
 *
 * One row per JSON-RPC message that reaches the server. This is what lets a real
 * server-side failure be told apart from a client-side "an error occurred:
 * <request id>" where the Claude app severed the connection before we replied.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let db: Database | undefined;

export function initDb(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    who         TEXT,
    session_id  TEXT,
    method      TEXT,
    tool        TEXT,
    args        TEXT,
    ok          INTEGER,
    error       TEXT,
    duration_ms INTEGER
  );`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);");

  db.query("DELETE FROM requests WHERE ts < $cut").run({ $cut: Date.now() - REQUEST_TTL_MS });
  log(`db ready at ${config.dbPath}`);
}

export interface RequestLogRow {
  ts: number;
  who?: string;
  sessionId?: string;
  method?: string;
  tool?: string;
  args?: string;
  ok?: boolean;
  error?: string;
  durationMs?: number;
}

/** Record one MCP request. Never throws into the request path. */
export function logRequest(row: RequestLogRow): void {
  if (!db) return;
  try {
    db.query(
      `INSERT INTO requests (ts, who, session_id, method, tool, args, ok, error, duration_ms)
       VALUES ($ts, $who, $sid, $method, $tool, $args, $ok, $error, $dur)`,
    ).run({
      $ts: row.ts,
      $who: row.who ?? null,
      $sid: row.sessionId ?? null,
      $method: row.method ?? null,
      $tool: row.tool ?? null,
      $args: row.args ?? null,
      $ok: row.ok === undefined ? null : row.ok ? 1 : 0,
      $error: row.error ?? null,
      $dur: row.durationMs ?? null,
    });
  } catch (e) {
    log("request log insert failed:", String((e as Error).message));
  }
}
