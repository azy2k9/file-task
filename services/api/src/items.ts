export type ItemKind = "task" | "event";
export interface WorkspaceFileSummary {
  id: string;
  name: string;
  sourceType: "upload" | "link";
}
export interface CalendarSyncStatus {
  provider: "google" | "apple";
  state: "supported" | "limited";
  scheduleEdited: boolean;
  recurrenceEdited: boolean;
  limitationCode: string | null;
  limitation: string | null;
  location?: string;
}
export interface WorkspaceItem {
  id: string;
  kind: ItemKind;
  title: string;
  details: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  completed: boolean | null;
  files: WorkspaceFileSummary[];
  recurrence: RecurrenceRule | null;
  reminders: ReminderRule[];
  seriesId: string | null;
  occurrenceDate: string | null;
  isOccurrence: boolean;
  calendarSync: CalendarSyncStatus[];
  createdAt: string;
  updatedAt: string;
}
export type ReminderRule = { delivery: "notification" | "email"; amount: number; unit: "minutes" | "hours" | "days" | "weeks" | "months"; time: string };
export type RecurrenceRule = {
  interval: number; unit: "days" | "weeks" | "months" | "years"; weekdays?: number[];
  end: { type: "never" } | { type: "date"; date: string } | { type: "count"; count: number };
};
export type ItemInput = Pick<WorkspaceItem, "kind" | "title" | "details" | "scheduledDate" | "scheduledTime"> & {
  recurrence?: RecurrenceRule | null; reminders?: ReminderRule[]; scope?: "occurrence" | "following" | "series";
};

/** Compare recurrence patterns independently of weekday ordering in older import baselines. */
export function sameRecurrence(a: RecurrenceRule | null, b: RecurrenceRule | null) {
  const canonical = (rule: RecurrenceRule | null) => rule === null ? null : {
    interval:rule.interval, unit:rule.unit,
    ...(rule.weekdays ? {weekdays:[...new Set(rule.weekdays)].sort((x,y) => x-y)} : {}), end:rule.end,
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
