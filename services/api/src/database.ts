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
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        task_reminders TEXT NOT NULL DEFAULT '[]', event_reminders TEXT NOT NULL DEFAULT '[]',
        push_enabled INTEGER NOT NULL DEFAULT 0, email_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS calendar_connections (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        account_label TEXT NOT NULL, access_token TEXT, refresh_token TEXT,
        calendar_url TEXT, connected_at TEXT NOT NULL,
        PRIMARY KEY(user_id, provider)
      );
      CREATE TABLE IF NOT EXISTS calendar_copies (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        item_id TEXT NOT NULL, external_id TEXT NOT NULL,
        PRIMARY KEY(user_id,provider,item_id), UNIQUE(user_id,provider,external_id)
      );
      CREATE TABLE IF NOT EXISTS calendar_imports (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        external_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id,provider,external_id), UNIQUE(user_id,provider,item_id)
      );
      CREATE TABLE IF NOT EXISTS calendar_import_exclusions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')), external_id TEXT NOT NULL,
        PRIMARY KEY(user_id,provider,external_id)
      );
      CREATE TABLE IF NOT EXISTS calendar_oauth_states (
        state TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, reminder_index INTEGER NOT NULL,
        scheduled_at TEXT NOT NULL, title TEXT NOT NULL, read_at TEXT,
        UNIQUE(item_id,reminder_index,scheduled_at)
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
      CREATE TABLE IF NOT EXISTS following_attachments (
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(file_id,item_id)
      );
      CREATE INDEX IF NOT EXISTS attachments_item ON attachments(item_id, file_id);
      CREATE TABLE IF NOT EXISTS login_attempts (
        email TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    const itemColumns = new Set(db.prepare("PRAGMA table_info(items)").all().map((column) => String(column.name)));
    if (!itemColumns.has("recurrence_json")) db.exec("ALTER TABLE items ADD COLUMN recurrence_json TEXT");
    if (!itemColumns.has("reminders_json")) db.exec("ALTER TABLE items ADD COLUMN reminders_json TEXT NOT NULL DEFAULT '[]'");
    if (!itemColumns.has("series_root_id")) db.exec("ALTER TABLE items ADD COLUMN series_root_id TEXT REFERENCES items(id) ON DELETE CASCADE");
    if (!itemColumns.has("occurrence_date")) db.exec("ALTER TABLE items ADD COLUMN occurrence_date TEXT");
    if (!itemColumns.has("uses_reminder_default")) db.exec("ALTER TABLE items ADD COLUMN uses_reminder_default INTEGER NOT NULL DEFAULT 1");
    db.exec("CREATE INDEX IF NOT EXISTS items_series ON items(series_root_id, occurrence_date)");
    const connectionColumns = new Set(db.prepare("PRAGMA table_info(calendar_connections)").all().map((column) => String(column.name)));
    if (!connectionColumns.has("expires_at")) db.exec("ALTER TABLE calendar_connections ADD COLUMN expires_at INTEGER");
    const attachmentColumns = new Set(db.prepare("PRAGMA table_info(attachments)").all().map((column) => String(column.name)));
    if (!attachmentColumns.has("scope")) db.exec("ALTER TABLE attachments ADD COLUMN scope TEXT NOT NULL DEFAULT 'occurrence' CHECK(scope IN ('occurrence','series'))");
    globalDatabase.filetasksDatabase = db;
  }
  return globalDatabase.filetasksDatabase;
}
