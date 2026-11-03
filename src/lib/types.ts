export type DatePreset = "all" | "today" | "7d" | "30d" | "custom";
export type DirectoryKind = "input" | "output";
export type ConflictPolicy = "skip" | "rename";
export type PhotoStatus = "pending" | "success" | "failed" | "skipped" | "cancelled";
export type DateSource = "filetime" | "modified";
export type LogLevel = "info" | "warn" | "error";
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "upToDate"
  | "downloading"
  | "ready"
  | "error";

export interface DirectoryView {
  token: string;
  label: string;
}

export interface Filters {
  directory: string;
  extension: string;
  startDate: string;
  endDate: string;
  query: string;
  datePreset: DatePreset;
}

export interface AppView {
  version: string;
  input: DirectoryView | null;
  output: DirectoryView | null;
  recentInputs: DirectoryView[];
  recentOutputs: DirectoryView[];
  filters: Filters;
  conflictPolicy: ConflictPolicy;
  workers: number;
  autoCheckUpdates: boolean;
  keyAvailable: boolean;
}

export interface PhotoView {
  id: string;
  name: string;
  relativePath: string;
  directory: string;
  size: number;
  extension: string;
  date: string;
  timestampMs: number;
  dateSource: DateSource;
  status: PhotoStatus;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface ScanProgress {
  scanId: string;
  scanned: number;
  found: number;
  errors: number;
  complete: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

export interface TaskProgress {
  jobId: string;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
  done: boolean;
  elapsedMs: number;
  currentId?: string;
  currentStatus?: string;
  reason?: string;
}

export interface UpdateView {
  status: UpdateStatus;
  currentVersion: string;
  version?: string;
  notes?: string;
  downloaded: number;
  total: number | null;
  message?: string;
}

export interface PreferencesPayload {
  filters: Filters;
  conflictPolicy: ConflictPolicy;
  workers: number;
  autoCheckUpdates: boolean;
}

export const EMPTY_FILTERS: Filters = {
  directory: "",
  extension: "",
  startDate: "",
  endDate: "",
  query: "",
  datePreset: "all",
};

export const STATUS_LABEL: Record<PhotoStatus, string> = {
  pending: "待处理",
  success: "已完成",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};
