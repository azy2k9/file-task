export type ItemKind = "task" | "event";
export interface WorkspaceFileSummary {
  id: string;
  name: string;
  sourceType: "upload" | "link";
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
  isOccurrence: boolean;
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
