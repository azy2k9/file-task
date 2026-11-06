import { database } from "./database";
import { nowMs } from "./clock";

export type CalendarSyncProvider = "google" | "apple";
export type CalendarSyncGeneration = { provider: CalendarSyncProvider; generation: number };
export type CalendarSyncConnection = {
  provider: CalendarSyncProvider;
  connection_scope_id: string;
  credential_generation_id: string;
};

const safeFailureMessage = "Calendar sync failed. Your changes remain saved in FileTasks and will be retried.";

/** Persist account-level retry intent so it remains after an Event is deleted. */
export function enqueueCalendarSync(userId: string) {
  const currentTime = nowMs();
  database().prepare(`INSERT INTO calendar_sync_state
      (user_id,provider,generation,state,attempts,next_attempt_at,last_attempt_at,last_error)
    SELECT user_id,provider,1,'pending',0,?,NULL,NULL FROM calendar_connections WHERE user_id=?
    ON CONFLICT(user_id,provider) DO UPDATE SET
      generation=calendar_sync_state.generation+1,
      state='pending',attempts=0,next_attempt_at=excluded.next_attempt_at,
      last_attempt_at=NULL,
      last_error=NULL,last_error_code=NULL`).run(currentTime,userId);
}

/** Ensure connected providers have retry rows and snapshot their generations before a sync pass. */
export function beginCalendarSync(userId: string, providers?: readonly CalendarSyncProvider[]): CalendarSyncGeneration[] {
  const db = database();
  const currentTime = nowMs();
  const filter = providers === undefined ? "" : ` AND provider IN (${providers.map(() => "?").join(",") || "NULL"})`;
  const stateFilter = providers === undefined ? "" : ` AND s.provider IN (${providers.map(() => "?").join(",") || "NULL"})`;
  const params = providers ?? [];
  db.prepare(`INSERT OR IGNORE INTO calendar_sync_state(user_id,provider,generation,state,attempts,next_attempt_at)
    SELECT user_id,provider,0,'pending',0,? FROM calendar_connections WHERE user_id=?${filter}`)
    .run(currentTime,userId,...params);
  return db.prepare(`SELECT s.provider,s.generation FROM calendar_sync_state s
    JOIN calendar_connections c ON c.user_id=s.user_id AND c.provider=s.provider
    WHERE s.user_id=?${stateFilter} ORDER BY s.provider`).all(userId,...params) as CalendarSyncGeneration[];
}

export function completeCalendarSync(userId: string, generation: CalendarSyncGeneration) {
  database().prepare(`UPDATE calendar_sync_state SET state='synced',next_attempt_at=NULL,last_error=NULL,last_error_code=NULL
    WHERE user_id=? AND provider=? AND generation=?`).run(userId,generation.provider,generation.generation);
}

export function recordCalendarSyncAuthorizationFailure(userId: string, connection: CalendarSyncConnection) {
  const providerName = connection.provider === "google" ? "Google" : "Apple";
  const error = `${providerName} Calendar denied a delete request. Reauthorize ${providerName} Calendar to retry cleanup; the Calendar copy identity is retained and retries continue automatically.`;
  const result = database().prepare(`INSERT INTO calendar_sync_authorization(user_id,provider,connection_scope_id,credential_generation_id,last_error,recorded_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND connection_scope_id=? AND credential_generation_id=?)
    ON CONFLICT(user_id,provider) DO UPDATE SET connection_scope_id=excluded.connection_scope_id,
      credential_generation_id=excluded.credential_generation_id,last_error=excluded.last_error,recorded_at=excluded.recorded_at
    WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND connection_scope_id=? AND credential_generation_id=?)`)
    .run(userId,connection.provider,connection.connection_scope_id,connection.credential_generation_id,error,nowMs(),
      userId,connection.provider,connection.connection_scope_id,connection.credential_generation_id,
      userId,connection.provider,connection.connection_scope_id,connection.credential_generation_id);
  return result.changes > 0;
}

/** Clear only evidence belonging to the connection that completed recovery. */
export function clearCalendarSyncAuthorization(userId: string, connection: CalendarSyncConnection) {
  const result = database().prepare(`DELETE FROM calendar_sync_authorization WHERE user_id=? AND provider=? AND connection_scope_id=? AND credential_generation_id=?
    AND EXISTS (SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND connection_scope_id=? AND credential_generation_id=?)`)
    .run(userId,connection.provider,connection.connection_scope_id,connection.credential_generation_id,
      userId,connection.provider,connection.connection_scope_id,connection.credential_generation_id);
  return result.changes > 0;
}

export function failCalendarSync(userId: string, generation: CalendarSyncGeneration, reauthorizationRequired = false) {
  const db = database();
  const row = db.prepare(`SELECT s.attempts,a.last_error AS authorization_error FROM calendar_sync_state s
    LEFT JOIN calendar_connections c ON c.user_id=s.user_id AND c.provider=s.provider
    LEFT JOIN calendar_sync_authorization a ON a.user_id=s.user_id AND a.provider=s.provider
      AND a.connection_scope_id=c.connection_scope_id AND a.credential_generation_id=c.credential_generation_id
    WHERE s.user_id=? AND s.provider=? AND s.generation=?`)
    .get(userId,generation.provider,generation.generation) as { attempts: number; authorization_error: string | null } | undefined;
  if (!row) return;
  const attempts = row.attempts + 1;
  const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts - 1, 10)));
  const currentTime = nowMs();
  const preserveAuthorization = !reauthorizationRequired && Boolean(row.authorization_error);
  const lastError = reauthorizationRequired ? row.authorization_error ?? safeFailureMessage
    : preserveAuthorization ? row.authorization_error! : safeFailureMessage;
  const result = db.prepare(`UPDATE calendar_sync_state SET state='failed',attempts=?,next_attempt_at=?,last_attempt_at=?,last_error=?,last_error_code=?
    WHERE user_id=? AND provider=? AND generation=?`).run(
    attempts,currentTime+delayMs,currentTime,lastError,reauthorizationRequired || preserveAuthorization ? "authorization" : null,userId,generation.provider,generation.generation,
  );
  return result.changes > 0;
}

export function calendarSyncDeliveryStatus(userId: string) {
  const rows = database().prepare(`SELECT s.provider,s.state,s.attempts,s.next_attempt_at AS nextAttemptAt,
      s.last_attempt_at AS lastAttemptAt,
      COALESCE(a.last_error,CASE WHEN s.last_error_code='authorization' THEN ? ELSE s.last_error END) AS lastError,
      CASE WHEN a.user_id IS NOT NULL THEN 'authorization' ELSE NULL END AS lastErrorCode,
      EXISTS(SELECT 1 FROM calendar_connections c WHERE c.user_id=s.user_id AND c.provider=s.provider) AS connected
    FROM calendar_sync_state s LEFT JOIN calendar_connections c ON c.user_id=s.user_id AND c.provider=s.provider
    LEFT JOIN calendar_sync_authorization a ON a.user_id=s.user_id AND a.provider=s.provider
      AND a.connection_scope_id=c.connection_scope_id AND a.credential_generation_id=c.credential_generation_id
    WHERE s.user_id=? AND s.state IN ('pending','failed') ORDER BY s.provider`).all(safeFailureMessage,userId) as {
      provider: CalendarSyncProvider;
      state: "pending" | "failed";
      attempts: number;
      nextAttemptAt: number | null;
      lastAttemptAt: number | null;
      lastError: string | null;
      connected: number;
    }[];
  return rows.map((row) => ({
    provider: row.provider,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt == null ? null : new Date(row.nextAttemptAt).toISOString(),
    lastAttemptAt: row.lastAttemptAt == null ? null : new Date(row.lastAttemptAt).toISOString(),
    lastError: row.lastError,
    reauthorizationRequired: row.lastErrorCode === "authorization",
    connected: Boolean(row.connected),
  }));
}

export function dueCalendarSyncUsers(currentTime = nowMs()) {
  return database().prepare(`SELECT s.user_id AS userId,s.provider FROM calendar_sync_state s
    JOIN calendar_connections c ON c.user_id=s.user_id AND c.provider=s.provider
    WHERE s.state IN ('pending','failed') AND s.next_attempt_at<=? ORDER BY s.user_id,s.provider`).all(currentTime) as { userId: string; provider: CalendarSyncProvider }[];
}
