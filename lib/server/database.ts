import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const globalDatabase = globalThis as typeof globalThis & { filetasksDatabase?: DatabaseSync };

export function database() {
  if (!globalDatabase.filetasksDatabase) {
    // This is a runtime data volume, not a source asset to include in Next's output tracing.
    const path = resolve(/* turbopackIgnore: true */ process.env.FILETASKS_DATABASE_PATH || "data/filetasks.sqlite");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('task', 'event')), title TEXT NOT NULL,
        details TEXT NOT NULL, scheduled_date TEXT, scheduled_time TEXT,
        completed INTEGER CHECK(completed IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK((kind = 'task' AND completed IS NOT NULL) OR (kind = 'event' AND completed IS NULL))
      );
      CREATE INDEX IF NOT EXISTS items_owner ON items(user_id);
      CREATE TABLE IF NOT EXISTS login_attempts (
        email TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    globalDatabase.filetasksDatabase = db;
  }
  return globalDatabase.filetasksDatabase;
}
