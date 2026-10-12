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
  createdAt: string;
  updatedAt: string;
}
export type ItemInput = Pick<WorkspaceItem, "kind" | "title" | "details" | "scheduledDate" | "scheduledTime">;
