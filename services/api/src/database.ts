import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
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
      CREATE UNIQUE INDEX IF NOT EXISTS items_user_id_id ON items(user_id,id);
      CREATE TABLE IF NOT EXISTS item_series_definitions (
        user_id TEXT NOT NULL,
        series_root_id TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        scheduled_time TEXT,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        recurrence_json TEXT NOT NULL,
        reminders_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(user_id,series_root_id),
        FOREIGN KEY(user_id,series_root_id) REFERENCES items(user_id,id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS calendar_destination_limitations (
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        connection_scope_id TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY(user_id,item_id,provider,connection_scope_id),
        FOREIGN KEY(user_id,item_id) REFERENCES items(user_id,id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS google_creation_reservations (
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider = 'google'),
        connection_scope_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        ownership_token TEXT NOT NULL,
        attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1)),
        active_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,item_id,provider,connection_scope_id),
        FOREIGN KEY(user_id,item_id) REFERENCES items(user_id,id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS apple_creation_reservations (
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider = 'apple'),
        connection_scope_id TEXT NOT NULL,
        resource_uid TEXT NOT NULL,
        attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1)),
        active_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,item_id,provider,connection_scope_id),
        UNIQUE(user_id,provider,connection_scope_id,resource_uid),
        FOREIGN KEY(user_id,item_id) REFERENCES items(user_id,id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS calendar_creation_cleanup (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        connection_scope_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        ownership_token TEXT,
        uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
        pending_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,provider,connection_scope_id,item_id)
      );
      CREATE TABLE IF NOT EXISTS calendar_export_locks (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        connection_scope_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        fence INTEGER NOT NULL,
        lease_until INTEGER NOT NULL,
        PRIMARY KEY(user_id,provider,connection_scope_id)
      );
      CREATE INDEX IF NOT EXISTS calendar_export_locks_lease ON calendar_export_locks(lease_until);
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        task_reminders TEXT NOT NULL DEFAULT '[]', event_reminders TEXT NOT NULL DEFAULT '[]',
        push_enabled INTEGER NOT NULL DEFAULT 0, email_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS calendar_connections (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        account_label TEXT NOT NULL, access_token TEXT, refresh_token TEXT,
        calendar_url TEXT, connected_at TEXT NOT NULL, credential_generation_id TEXT NOT NULL,
        PRIMARY KEY(user_id, provider)
      );
      CREATE TABLE IF NOT EXISTS calendar_sync_state (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        generation INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('pending','failed','synced')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_attempt_at INTEGER,
        last_error TEXT,
        PRIMARY KEY(user_id,provider)
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
      CREATE TABLE IF NOT EXISTS calendar_import_metadata (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')),
        external_id TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        source_account_id TEXT NOT NULL,
        source_payload_json TEXT,
        source_ics TEXT,
        timing_json TEXT NOT NULL,
        baseline_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('supported','limited')),
        limitation_code TEXT,
        limitation_message TEXT,
        captured_at TEXT NOT NULL,
        PRIMARY KEY(user_id,provider,external_id),
        FOREIGN KEY(user_id,provider,external_id)
          REFERENCES calendar_imports(user_id,provider,external_id) ON DELETE CASCADE,
        CHECK(
          (provider='google' AND source_payload_json IS NOT NULL AND source_ics IS NULL)
          OR
          (provider='apple' AND source_payload_json IS NULL AND source_ics IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS google_inventory_pending (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        source_account_id TEXT NOT NULL,
        inventory_id TEXT NOT NULL,
        PRIMARY KEY(user_id,item_id)
      );
      CREATE INDEX IF NOT EXISTS calendar_import_metadata_item ON calendar_import_metadata(user_id,item_id);
      CREATE TABLE IF NOT EXISTS calendar_import_split_blocks (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, PRIMARY KEY(user_id,item_id,provider)
      );
      CREATE TABLE IF NOT EXISTS calendar_import_exclusions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google','apple')), external_id TEXT NOT NULL,
        PRIMARY KEY(user_id,provider,external_id)
      );
      CREATE TABLE IF NOT EXISTS calendar_oauth_transactions (
        state_hash TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, session_hash TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, reminder_index INTEGER NOT NULL,
        scheduled_at TEXT NOT NULL, title TEXT NOT NULL, read_at TEXT,
        UNIQUE(item_id,reminder_index,scheduled_at)
      );
      CREATE TABLE IF NOT EXISTS push_devices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('web','ios','android')),
        created_at TEXT NOT NULL, UNIQUE(user_id,provider_id)
      );
      CREATE TABLE IF NOT EXISTS push_cleanup_jobs (
        registration_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS push_cleanup_jobs_due ON push_cleanup_jobs(next_attempt_at);
      CREATE TABLE IF NOT EXISTS push_cleanup_completed (
        registration_id TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_operation_locks (
        registration_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS push_operation_locks_lease ON push_operation_locks(lease_until);
      CREATE TABLE IF NOT EXISTS reminder_deliveries (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        reminder_index INTEGER NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('email','push')),
        target_id TEXT NOT NULL DEFAULT '', scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        sent_at TEXT, last_error TEXT,
        UNIQUE(item_id,reminder_index,channel,target_id,scheduled_at)
      );
      CREATE TABLE IF NOT EXISTS occurrence_exclusions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        series_root_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        occurrence_date TEXT NOT NULL,
        PRIMARY KEY(series_root_id,occurrence_date)
      );
      CREATE INDEX IF NOT EXISTS items_owner ON items(user_id);
      CREATE INDEX IF NOT EXISTS reminder_deliveries_pending ON reminder_deliveries(status,next_attempt_at);
      CREATE INDEX IF NOT EXISTS calendar_sync_state_due ON calendar_sync_state(state,next_attempt_at);
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
      CREATE TABLE IF NOT EXISTS attachment_exclusions (
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK(scope IN ('occurrence','following')),
        PRIMARY KEY(file_id,item_id,scope)
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
    if (!itemColumns.has("occurrence_recurrence_json")) db.exec("ALTER TABLE items ADD COLUMN occurrence_recurrence_json TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS items_series ON items(series_root_id, occurrence_date)");
    // The root row is also the first Occurrence. Capture its original generation
    // template before occurrence-local edits can change the root row.
    db.exec(`INSERT OR IGNORE INTO item_series_definitions(user_id,series_root_id,scheduled_date,scheduled_time,title,details,recurrence_json,reminders_json)
      SELECT user_id,id,scheduled_date,scheduled_time,title,details,recurrence_json,reminders_json FROM items
      WHERE series_root_id=id AND recurrence_json IS NOT NULL AND scheduled_date IS NOT NULL`);
    const connectionColumns = new Set(db.prepare("PRAGMA table_info(calendar_connections)").all().map((column) => String(column.name)));
    if (!connectionColumns.has("expires_at")) db.exec("ALTER TABLE calendar_connections ADD COLUMN expires_at INTEGER");
    if (!connectionColumns.has("legacy_identity_eligible")) db.exec("ALTER TABLE calendar_connections ADD COLUMN legacy_identity_eligible INTEGER NOT NULL DEFAULT 0 CHECK(legacy_identity_eligible IN (0,1))");
    if (!connectionColumns.has("credential_generation_id")) db.exec("ALTER TABLE calendar_connections ADD COLUMN credential_generation_id TEXT NOT NULL DEFAULT ''");
    // Upgrade existing connections before any sync can use them. Empty values are not
    // authorization wildcards; each legacy connection receives its own generation.
    for (const row of db.prepare("SELECT user_id,provider FROM calendar_connections WHERE credential_generation_id='' OR credential_generation_id IS NULL").all()) {
      db.prepare("UPDATE calendar_connections SET credential_generation_id=? WHERE user_id=? AND provider=? AND (credential_generation_id='' OR credential_generation_id IS NULL)")
        .run(randomUUID(),row.user_id,row.provider);
    }
    for (const table of ["calendar_connections", "calendar_copies", "calendar_imports", "calendar_import_metadata", "calendar_import_exclusions", "google_inventory_pending"]) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
      if (!columns.has("connection_scope_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN connection_scope_id TEXT`);
    }
    // OAuth transactions are short-lived. Discard legacy state-only transactions so they cannot
    // be completed after upgrading to the browser-bound flow.
    db.exec("DROP TABLE IF EXISTS calendar_oauth_states");
    const copyColumns = new Set(db.prepare("PRAGMA table_info(calendar_copies)").all().map((column) => String(column.name)));
    if (!copyColumns.has("resource_uid")) db.exec("ALTER TABLE calendar_copies ADD COLUMN resource_uid TEXT");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table,column] of [["google_creation_reservations","attempted"],["apple_creation_reservations","attempted"],["calendar_creation_cleanup","uncertain"],
        ["google_creation_reservations","active_attempts"],["apple_creation_reservations","active_attempts"],["calendar_creation_cleanup","pending_attempts"]]) {
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => String(entry.name)));
        if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0${column === "attempted" || column === "uncertain" ? " CHECK("+column+" IN (0,1))" : ""}`);
      }
      // Older rows recorded only a boolean. Preserve that uncertainty across the
      // schema upgrade until a later provider reconciliation can resolve it.
      db.exec(`UPDATE google_creation_reservations SET active_attempts=MAX(active_attempts,attempted);
        UPDATE apple_creation_reservations SET active_attempts=MAX(active_attempts,attempted);
        UPDATE calendar_creation_cleanup SET pending_attempts=MAX(pending_attempts,uncertain)`);
      // Replace the deletion trigger in the same write transaction as the attempt
      // migration. No process can delete an Event between the snapshot and swap.
      db.exec("DROP TRIGGER IF EXISTS preserve_calendar_creation_before_item_delete");
      db.exec(`CREATE TRIGGER preserve_calendar_creation_before_item_delete
      BEFORE DELETE ON items BEGIN
        INSERT INTO calendar_creation_cleanup(user_id,provider,connection_scope_id,item_id,external_id,ownership_token,uncertain,pending_attempts)
          SELECT r.user_id,'google',r.connection_scope_id,r.item_id,r.event_id,r.ownership_token,CASE WHEN r.active_attempts>0 THEN 1 ELSE r.attempted END,r.active_attempts
          FROM google_creation_reservations r WHERE r.user_id=OLD.user_id AND r.item_id=OLD.id
        ON CONFLICT(user_id,provider,connection_scope_id,item_id) DO UPDATE SET
          external_id=excluded.external_id,ownership_token=excluded.ownership_token,uncertain=MAX(calendar_creation_cleanup.uncertain,excluded.uncertain),pending_attempts=MAX(calendar_creation_cleanup.pending_attempts,excluded.pending_attempts);
        INSERT INTO calendar_creation_cleanup(user_id,provider,connection_scope_id,item_id,external_id,ownership_token,uncertain,pending_attempts)
          SELECT r.user_id,'apple',r.connection_scope_id,r.item_id,r.resource_uid,NULL,CASE WHEN r.active_attempts>0 THEN 1 ELSE r.attempted END,r.active_attempts
          FROM apple_creation_reservations r WHERE r.user_id=OLD.user_id AND r.item_id=OLD.id
        ON CONFLICT(user_id,provider,connection_scope_id,item_id) DO UPDATE SET
          external_id=excluded.external_id,uncertain=MAX(calendar_creation_cleanup.uncertain,excluded.uncertain),pending_attempts=MAX(calendar_creation_cleanup.pending_attempts,excluded.pending_attempts);
      END`);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the trigger replacement error. */ }
      throw error;
    }
    const attachmentColumns = new Set(db.prepare("PRAGMA table_info(attachments)").all().map((column) => String(column.name)));
    if (!attachmentColumns.has("scope")) db.exec("ALTER TABLE attachments ADD COLUMN scope TEXT NOT NULL DEFAULT 'occurrence' CHECK(scope IN ('occurrence','series'))");
    globalDatabase.filetasksDatabase = db;
  }
  return globalDatabase.filetasksDatabase;
}
