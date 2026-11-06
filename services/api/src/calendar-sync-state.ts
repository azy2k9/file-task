import { database } from "./database";
import { nowMs } from "./clock";

export type CalendarSyncProvider = "google" | "apple";
export type CalendarSyncGeneration = { provider: CalendarSyncProvider; generation: number };
export type DueCalendarSync = { userId: string; provider: CalendarSyncProvider; generation: number; nextAttemptAt: number; cleanup?: boolean };

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
export function beginCalendarSync(userId: string, providers?: readonly CalendarSyncProvider[], preserveAttempts = false): CalendarSyncGeneration[] {
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
    db.prepare(`UPDATE calendar_sync_state SET generation=generation+1,state='pending',next_attempt_at=?,
      attempts=CASE WHEN ? THEN attempts ELSE 0 END
      WHERE user_id=?${filter}`).run(currentTime,preserveAttempts ? 1 : 0,userId,...params);
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
  database().prepare(`UPDATE calendar_sync_state SET state='synced',attempts=0,next_attempt_at=NULL,last_attempt_at=NULL,last_error=NULL
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
  return database().prepare(`SELECT s.user_id AS userId,s.provider,s.generation,s.next_attempt_at AS nextAttemptAt,0 AS cleanup FROM calendar_sync_state s
      JOIN calendar_connections c ON c.user_id=s.user_id AND c.provider=s.provider
      WHERE s.state IN ('pending','failed') AND s.next_attempt_at<=?
    UNION
    SELECT s.user_id AS userId,s.provider,s.generation,cc.next_attempt_at AS nextAttemptAt,1 AS cleanup FROM calendar_creation_cleanup cc
      JOIN calendar_sync_state s ON s.user_id=cc.user_id AND s.provider=cc.provider
      JOIN calendar_connections c ON c.user_id=cc.user_id AND c.provider=cc.provider AND c.connection_scope_id=cc.connection_scope_id
      WHERE s.state='synced' AND cc.next_attempt_at<=?
    ORDER BY userId,provider`).all(currentTime,currentTime).map((row:any)=>({...row,cleanup:Boolean(row.cleanup)})) as DueCalendarSync[];
}

/** Claim only the exact due snapshot. A second worker or a newer manual sync wins atomically. */
export function claimDueCalendarSyncs(candidates: readonly DueCalendarSync[], currentTime = nowMs()) {
  const db=database();
  const claimed: {userId:string;generation:CalendarSyncGeneration}[]=[];
  db.exec("BEGIN IMMEDIATE");
  try {
    // Keep a recovery deadline on the claim itself. If the worker process exits
    // after claiming, another worker can reclaim this generation after the lease.
    const retryClaim=db.prepare(`UPDATE calendar_sync_state SET generation=generation+1,state='pending',next_attempt_at=?
      WHERE user_id=? AND provider=? AND generation=? AND next_attempt_at=? AND next_attempt_at<=?
        AND state IN ('pending','failed') RETURNING generation`);
    const cleanupClaim=db.prepare(`UPDATE calendar_sync_state SET generation=generation+1,state='pending',next_attempt_at=?
      WHERE user_id=? AND provider=? AND generation=? AND state='synced' AND EXISTS (
        SELECT 1 FROM calendar_creation_cleanup cc JOIN calendar_connections c
          ON c.user_id=cc.user_id AND c.provider=cc.provider AND c.connection_scope_id=cc.connection_scope_id
        WHERE cc.user_id=? AND cc.provider=? AND cc.next_attempt_at=? AND cc.next_attempt_at<=?) RETURNING generation`);
    for (const candidate of candidates) {
      const row=(candidate.cleanup
        ? cleanupClaim.get(currentTime+120_000,candidate.userId,candidate.provider,candidate.generation,candidate.userId,candidate.provider,candidate.nextAttemptAt,currentTime)
        : retryClaim.get(currentTime+120_000,candidate.userId,candidate.provider,candidate.generation,candidate.nextAttemptAt,currentTime)) as {generation:number}|undefined;
      if (row) claimed.push({userId:candidate.userId,generation:{provider:candidate.provider,generation:Number(row.generation)}});
    }
    db.exec("COMMIT");
    return claimed;
  } catch(error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}
