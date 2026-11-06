import { database } from "./database";
import { nowMs } from "./clock";

export type CalendarSyncProvider = "google" | "apple";
export type CalendarSyncGeneration = { provider: CalendarSyncProvider; generation: number };

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
      last_attempt_at=NULL,last_error=NULL`).run(currentTime,userId);
}

/** Advance connected-provider generations before a sync pass so stale workers cannot settle newer delivery. */
export function beginCalendarSync(userId: string, providers?: readonly CalendarSyncProvider[]): CalendarSyncGeneration[] {
  const db = database();
  const currentTime = nowMs();
  const filter = providers === undefined ? "" : ` AND provider IN (${providers.map(() => "?").join(",") || "NULL"})`;
  const stateFilter = providers === undefined ? "" : ` AND s.provider IN (${providers.map(() => "?").join(",") || "NULL"})`;
  const params = providers ?? [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO calendar_sync_state(user_id,provider,generation,state,attempts,next_attempt_at)
      SELECT user_id,provider,0,'pending',0,? FROM calendar_connections WHERE user_id=?${filter}`)
      .run(currentTime,userId,...params);
    db.prepare(`UPDATE calendar_sync_state SET generation=generation+1,state='pending',attempts=0,next_attempt_at=?,last_attempt_at=NULL,last_error=NULL
      WHERE user_id=?${filter}`).run(currentTime,userId,...params);
    const generations = db.prepare(`SELECT s.provider,s.generation FROM calendar_sync_state s
      JOIN calendar_connections c ON c.user_id=s.user_id AND c.provider=s.provider
      WHERE s.user_id=?${stateFilter} ORDER BY s.provider`).all(userId,...params) as CalendarSyncGeneration[];
    db.exec("COMMIT");
    return generations;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the generation error. */ }
    throw error;
  }
}

export function completeCalendarSync(userId: string, generation: CalendarSyncGeneration) {
  database().prepare(`UPDATE calendar_sync_state SET state='synced',next_attempt_at=NULL,last_error=NULL
    WHERE user_id=? AND provider=? AND generation=?`).run(userId,generation.provider,generation.generation);
}

export function failCalendarSync(userId: string, generation: CalendarSyncGeneration) {
  const db = database();
  const row = db.prepare(`SELECT attempts FROM calendar_sync_state WHERE user_id=? AND provider=? AND generation=?`)
    .get(userId,generation.provider,generation.generation) as { attempts: number } | undefined;
  if (!row) return;
  const attempts = row.attempts + 1;
  const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts - 1, 10)));
  const currentTime = nowMs();
  db.prepare(`UPDATE calendar_sync_state SET state='failed',attempts=?,next_attempt_at=?,last_attempt_at=?,last_error=?
    WHERE user_id=? AND provider=? AND generation=?`).run(
    attempts,currentTime+delayMs,currentTime,safeFailureMessage,userId,generation.provider,generation.generation,
  );
}

export function calendarSyncDeliveryStatus(userId: string) {
  const rows = database().prepare(`SELECT s.provider,s.state,s.attempts,s.next_attempt_at AS nextAttemptAt,
      s.last_attempt_at AS lastAttemptAt,s.last_error AS lastError,
      EXISTS(SELECT 1 FROM calendar_connections c WHERE c.user_id=s.user_id AND c.provider=s.provider) AS connected
    FROM calendar_sync_state s WHERE s.user_id=? AND s.state IN ('pending','failed') ORDER BY s.provider`).all(userId) as {
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
    connected: Boolean(row.connected),
  }));
}

export function dueCalendarSyncUsers(currentTime = nowMs()) {
  return database().prepare(`SELECT s.user_id AS userId,s.provider FROM calendar_sync_state s
    JOIN calendar_connections c ON c.user_id=s.user_id AND c.provider=s.provider
    WHERE s.state IN ('pending','failed') AND s.next_attempt_at<=? ORDER BY s.user_id,s.provider`).all(currentTime) as { userId: string; provider: CalendarSyncProvider }[];
}
