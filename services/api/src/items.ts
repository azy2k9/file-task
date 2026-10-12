export type ItemKind = "task" | "event";
export interface WorkspaceItem {
  id: string;
  kind: ItemKind;
  title: string;
  details: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  completed: boolean | null;
  createdAt: string;
  updatedAt: string;
}
export type ItemInput = Pick<WorkspaceItem, "kind" | "title" | "details" | "scheduledDate" | "scheduledTime">;
