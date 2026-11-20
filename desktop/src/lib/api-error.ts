export type ErrorCode = "conflict" | "not_found" | "already_exists" | "invalid_path" | "permission" | "unauthorized" | "csrf" | "network" | "storage" | "encoding" | "unsupported" | "operation_pending" | "too_large";
export class WorkspaceError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); this.name = "WorkspaceError"; }
}
export const isTransient = (error: unknown) => error instanceof WorkspaceError && ["network", "unauthorized", "csrf", "operation_pending"].includes(error.code);
