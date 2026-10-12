import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const globalDatabase = globalThis as typeof globalThis & { filetasksDatabase?: DatabaseSync };

export function database() {
  if (!globalDatabase.filetasksDatabase) {
    // This is a runtime data volume, not a source asset to include in Next's output tracing.
    const repositoryRoot = resolve(process.cwd(), "../..");
    const databasePath = process.env.FILETASKS_DATABASE_PATH || "data/filetasks.sqlite";
    const path = resolve(/* turbopackIgnore: true */ repositoryRoot, databasePath);
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
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('upload', 'link')),
        mime_type TEXT,
        size_bytes INTEGER,
        object_key TEXT UNIQUE,
        external_url TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'ready')),
        created_at TEXT NOT NULL,
        upload_expires_at INTEGER,
        CHECK(
          (source_type = 'upload' AND mime_type IS NOT NULL AND size_bytes IS NOT NULL
            AND object_key IS NOT NULL AND external_url IS NULL)
          OR
          (source_type = 'link' AND mime_type IS NULL AND size_bytes IS NULL
            AND object_key IS NULL AND external_url IS NOT NULL AND status = 'ready')
        )
      );
      CREATE INDEX IF NOT EXISTS files_owner ON files(user_id, status, created_at);
      CREATE TABLE IF NOT EXISTS attachments (
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(file_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS attachments_item ON attachments(item_id, file_id);
      CREATE TABLE IF NOT EXISTS login_attempts (
        email TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    globalDatabase.filetasksDatabase = db;
  }
  return globalDatabase.filetasksDatabase;
}
