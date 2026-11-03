import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AppView,
  ConflictPolicy,
  DirectoryKind,
  DirectoryView,
  Filters,
  LogEntry,
  PhotoView,
  PreferencesPayload,
  ScanProgress,
  TaskProgress,
  UpdateView,
} from "./types";
import { EMPTY_FILTERS } from "./types";

type PayloadHandler<T> = (payload: T) => void;
type PreviewHandler = (payload: unknown) => void;

const previewParameter =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("preview")
    : null;
const previewScenario = previewParameter ?? "";

function tauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const isPreviewMode =
  import.meta.env.DEV && previewParameter !== null && !tauriRuntime();

const previewHandlers = new Map<string, Set<PreviewHandler>>();

function emitPreview(event: string, payload: unknown): void {
  for (const handler of previewHandlers.get(event) ?? []) handler(payload);
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (tauriRuntime()) return invoke<T>(name, args);
  if (isPreviewMode) return previewCommand(name, args ?? {}) as Promise<T>;
  throw new Error("此功能需要在桌面应用中使用。");
}

async function subscribe<T>(event: string, handler: PayloadHandler<T>): Promise<UnlistenFn> {
  if (tauriRuntime()) {
    return listen<T>(event, (message) => handler(message.payload));
  }
  if (isPreviewMode) {
    const wrapped: PreviewHandler = (payload) => handler(payload as T);
    const handlers = previewHandlers.get(event) ?? new Set<PreviewHandler>();
    handlers.add(wrapped);
    previewHandlers.set(event, handlers);
    return async () => {
      handlers.delete(wrapped);
    };
  }
  return async () => undefined;
}

export function getAppState(): Promise<AppView> {
  return command("get_app_state");
}

export function setDirectoryPath(kind: DirectoryKind, path: string): Promise<AppView> {
  return command("set_directory", { kind, path });
}

export function selectRecent(kind: DirectoryKind, token: string): Promise<AppView> {
  return command("select_recent", { kind, token });
}

export function autoDetectInput(): Promise<AppView> {
  return command("auto_detect_input");
}

export function savePreferences(payload: PreferencesPayload): Promise<AppView> {
  return command("save_preferences", payload as unknown as Record<string, unknown>);
}

export function scanPhotos(): Promise<string> {
  return command("scan_photos");
}

export function cancelScan(): Promise<void> {
  return command("cancel_scan");
}

export function listPhotos(): Promise<PhotoView[]> {
  return command("list_photos");
}

export function getThumbnail(id: string): Promise<string | null> {
  return command("get_thumbnail", { id });
}

export function startDecryption(ids: string[]): Promise<string> {
  return command("start_decryption", { ids });
}

export function cancelDecryption(): Promise<void> {
  return command("cancel_decryption");
}

export function getLogs(): Promise<LogEntry[]> {
  return command("get_logs");
}

export function openLogsDirectory(): Promise<void> {
  return command("open_logs_directory");
}

export function openOutputDirectory(): Promise<void> {
  return command("open_output_directory");
}

export function exportLogsTo(path: string): Promise<void> {
  return command("export_logs", { path });
}

export function exportFailuresTo(path: string): Promise<void> {
  return command("export_failures", { path });
}

export function recordFilterCounts(visible: number, selected: number): Promise<void> {
  return command("record_filter", { visible, selected });
}

export function checkForUpdate(): Promise<UpdateView> {
  return command("check_update");
}

export function installUpdate(): Promise<void> {
  return command("install_update");
}

export function restartApplication(): Promise<void> {
  return command("restart_app");
}

export function onScanProgress(handler: PayloadHandler<ScanProgress>): Promise<UnlistenFn> {
  return subscribe("scan-progress", handler);
}

export function onTaskProgress(handler: PayloadHandler<TaskProgress>): Promise<UnlistenFn> {
  return subscribe("task-progress", handler);
}

export function onAppLog(handler: PayloadHandler<LogEntry>): Promise<UnlistenFn> {
  return subscribe("app-log", handler);
}

export function onUpdateProgress(handler: PayloadHandler<UpdateView>): Promise<UnlistenFn> {
  return subscribe("update-progress", handler);
}

export async function pickDirectory(): Promise<string | null> {
  if (tauriRuntime()) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择图片目录",
    });
    return typeof selected === "string" ? selected : null;
  }
  if (isPreviewMode) return "C:\\Preview\\心动小镇\\ScreenCapture";
  throw new Error("目录选择器需要在桌面应用中使用。");
}

export async function pickSavePath(
  defaultName: string,
  kind: "log" | "csv",
): Promise<string | null> {
  if (tauriRuntime()) {
    const filters =
      kind === "csv"
        ? [{ name: "CSV 表格", extensions: ["csv"] }]
        : [{ name: "日志文件", extensions: ["log", "txt"] }];
    return save({ defaultPath: defaultName, filters, title: kind === "csv" ? "导出失败清单" : "导出日志" });
  }
  if (isPreviewMode) return `C:\\Preview\\${defaultName}`;
  throw new Error("保存对话框需要在桌面应用中使用。");
}

/* ------------------------------------------------------------------ */
/* Development preview only. Never used by a packaged build.           */
/* ------------------------------------------------------------------ */

let previewPhotoCounter = 0;
let previewDirectoryCounter = 0;
let previewScanTimer: ReturnType<typeof setInterval> | null = null;
let previewTaskTimer: ReturnType<typeof setInterval> | null = null;
let previewCancelTimer: ReturnType<typeof setTimeout> | null = null;
let previewUpdateTimer: ReturnType<typeof setInterval> | null = null;

function previewDate(offsetDays: number, hour: number, minute: number): Date {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - offsetDays,
    hour,
    minute,
    (offsetDays * 7) % 60,
  );
}

function previewLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function createPreviewPhotos(count = 20001): PhotoView[] {
  const directories = ["Photo", "Photo", "Photo", "Photo", "Draw", "Limit", "NoBgPhoto", "Announcement"];
  return Array.from({ length: count }, (_, index) => {
    const directory = directories[index % directories.length];
    const date = previewDate(index % 48, 8 + (index % 12), (index * 7) % 60);
    const isPng = directory === "Draw" || directory === "NoBgPhoto";
    const extension = isPng ? "png" : "jpg";
    const width = isPng ? 256 : index % 3 === 0 ? 1280 : 1920;
    const height = isPng ? 256 : width === 1280 ? 720 : 1080;
    const id = `preview-${index.toString().padStart(5, "0")}`;
    const name =
      directory === "Limit"
        ? `normal+${900000 + index}+Other+${202600000000000000n + BigInt(index)}.png_${width}_${height}.${extension}`
        : directory === "Announcement"
          ? `announcement_${String(index).padStart(4, "0")}.${extension}`
        : `${202600000000000000n + BigInt(index * 907)}_${width}_${height}.${extension}`;
    return {
      id,
      name,
      relativePath: `${directory}/${name}`,
      directory,
      size: 180_000 + ((index * 48271) % 3_600_000),
      extension,
      date: previewLocalDate(date),
      timestampMs: date.getTime(),
      dateSource: index % 19 === 0 ? "modified" : "filetime",
      status: "pending",
    };
  });
}

let previewPhotos = createPreviewPhotos();
let previewLogs: LogEntry[] = [
  {
    timestamp: new Date(Date.now() - 70_000).toISOString(),
    level: "info",
    message: "已载入本地素材索引（预览数据）。",
  },
  {
    timestamp: new Date(Date.now() - 32_000).toISOString(),
    level: "info",
    message: "原始目录以只读方式访问，输出文件使用临时文件原子写入。",
  },
];

let previewState: AppView = {
  version: "0.1.0",
  input: { token: "preview-input", label: "ScreenCapture" },
  output: { token: "preview-output", label: "心动相册导出" },
  recentInputs: [
    { token: "preview-input", label: "ScreenCapture" },
    { token: "preview-backup", label: "心动小镇备份" },
  ],
  recentOutputs: [{ token: "preview-output", label: "心动相册导出" }],
  filters: { ...EMPTY_FILTERS },
  conflictPolicy: "skip",
  workers: 4,
  autoCheckUpdates: true,
  keyAvailable: previewScenario !== "permission",
};

let previewTaskTotal = 0;
let previewTaskCompleted = 0;
let previewTaskSucceeded = 0;
let previewTaskFailed = 0;
let previewTaskSkipped = 0;
let previewTaskIds: string[] = [];
let previewTaskJobId = "";

function previewLog(level: LogEntry["level"], message: string): void {
  const entry: LogEntry = { timestamp: new Date().toISOString(), level, message };
  previewLogs = [...previewLogs.slice(-299), entry];
  emitPreview("app-log", entry);
}

function previewCheck(): UpdateView {
  const result: UpdateView = {
    status: "available",
    currentVersion: previewState.version,
    version: "0.2.0",
    notes: "· 优化了万级素材列表的滚动与缩略图加载\n· 增加失败清单导出\n· 修复长路径输出时的冲突重命名",
    downloaded: 0,
    total: 42_800_000,
  };
  emitPreview("update-progress", result);
  return result;
}

function thumbnailFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="hsl(${hue} 24% 76%)"/><stop offset="1" stop-color="hsl(${(hue + 42) % 360} 30% 54%)"/></linearGradient></defs><rect width="120" height="90" fill="url(#g)"/><circle cx="${28 + (Math.abs(hash) % 55)}" cy="${28 + (Math.abs(hash >> 4) % 30)}" r="4" fill="rgba(255,255,255,.55)"/><path d="M0 70 L32 50 L55 65 L82 40 L120 68 V90 H0Z" fill="rgba(35,49,42,.22)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function previewScanCommand(): string {
  if (previewScanTimer) clearInterval(previewScanTimer);
  const scanId = `preview-scan-${++previewPhotoCounter}`;
  const started = Date.now();
  let scanned = 0;
  let found = 0;
  const finish = (cancelled: boolean) => {
    if (previewScanTimer) clearInterval(previewScanTimer);
    previewScanTimer = null;
    emitPreview("scan-progress", {
      scanId,
      scanned,
      found,
      errors: 0,
      complete: true,
      cancelled,
      elapsedMs: Date.now() - started,
    } satisfies ScanProgress);
    previewLog("info", cancelled ? "扫描已取消，保留已发现的结果。" : `扫描完成，共发现 ${found} 个图片文件。`);
  };
  previewScanTimer = setInterval(() => {
    scanned += 920;
    found = Math.min(previewPhotos.length, Math.round((scanned / previewPhotos.length) * previewPhotos.length));
    if (scanned >= previewPhotos.length) {
      scanned = previewPhotos.length;
      found = previewPhotos.length;
      finish(false);
      return;
    }
    emitPreview("scan-progress", {
      scanId,
      scanned,
      found,
      errors: 0,
      complete: false,
      cancelled: false,
      elapsedMs: Date.now() - started,
    } satisfies ScanProgress);
  }, 90);
  emitPreview("scan-progress", {
    scanId,
    scanned: 0,
    found: 0,
    errors: 0,
    complete: false,
    cancelled: false,
    elapsedMs: 0,
  } satisfies ScanProgress);
  previewLog("info", "开始扫描本地素材目录（预览数据）。");
  return scanId;
}

function previewCancelScan(): void {
  if (!previewScanTimer) return;
  clearInterval(previewScanTimer);
  previewScanTimer = null;
  emitPreview("scan-progress", {
    scanId: `preview-scan-${previewPhotoCounter}`,
    scanned: Math.min(previewPhotos.length, 12_340),
    found: Math.min(previewPhotos.length, 12_340),
    errors: 0,
    complete: true,
    cancelled: true,
    elapsedMs: 600,
  } satisfies ScanProgress);
  previewLog("warn", "扫描任务已由用户取消。");
}

function previewStartTask(ids: string[]): string {
  if (previewTaskTimer) clearInterval(previewTaskTimer);
  if (previewCancelTimer) clearTimeout(previewCancelTimer);
  previewTaskTimer = null;
  previewCancelTimer = null;
  previewTaskIds = ids;
  previewTaskJobId = `preview-job-${Date.now()}`;
  previewTaskTotal = ids.length;
  previewTaskCompleted = 0;
  previewTaskSucceeded = 0;
  previewTaskFailed = 0;
  previewTaskSkipped = 0;
  const started = Date.now();
  const idSet = new Set(ids);
  previewPhotos = previewPhotos.map((photo) =>
    idSet.has(photo.id) ? { ...photo, status: "pending" } : photo,
  );
  const emit = (currentId?: string, currentStatus?: string) =>
    emitPreview("task-progress", {
      jobId: previewTaskJobId,
      total: previewTaskTotal,
      completed: previewTaskCompleted,
      succeeded: previewTaskSucceeded,
      failed: previewTaskFailed,
      skipped: previewTaskSkipped,
      cancelled: false,
      done: false,
      elapsedMs: Date.now() - started,
      currentId,
      currentStatus,
    } satisfies TaskProgress);
  emit();
  previewTaskTimer = setInterval(() => {
    const batch = Math.min(4, previewTaskTotal - previewTaskCompleted);
    for (let step = 0; step < batch; step += 1) {
      const id = previewTaskIds[previewTaskCompleted];
      const failed = previewTaskCompleted % 137 === 42;
      previewPhotos = previewPhotos.map((photo) =>
        photo.id === id ? { ...photo, status: failed ? "failed" : "success" } : photo,
      );
      previewTaskCompleted += 1;
      if (failed) previewTaskFailed += 1;
      else previewTaskSucceeded += 1;
      emit(id, failed ? "failed" : "success");
    }
    if (previewTaskCompleted >= previewTaskTotal) {
      if (previewTaskTimer) clearInterval(previewTaskTimer);
      previewTaskTimer = null;
      emitPreview("task-progress", {
        jobId: previewTaskJobId,
        total: previewTaskTotal,
        completed: previewTaskCompleted,
        succeeded: previewTaskSucceeded,
        failed: previewTaskFailed,
        skipped: previewTaskSkipped,
        cancelled: false,
        done: true,
        elapsedMs: Date.now() - started,
      } satisfies TaskProgress);
      previewLog(
        previewTaskFailed > 0 ? "warn" : "info",
        `批量解密完成：成功 ${previewTaskSucceeded}，失败 ${previewTaskFailed}。`,
      );
    }
  }, 160);
  previewLog("info", `开始批量解密 ${ids.length} 张图片。`);
  return previewTaskJobId;
}

function previewCancelTask(): void {
  if (previewTaskTimer) clearInterval(previewTaskTimer);
  previewTaskTimer = null;
  emitPreview("task-progress", {
    jobId: previewTaskJobId,
    total: previewTaskTotal,
    completed: previewTaskCompleted,
    succeeded: previewTaskSucceeded,
    failed: previewTaskFailed,
    skipped: previewTaskSkipped,
    cancelled: true,
    done: false,
    elapsedMs: 0,
  } satisfies TaskProgress);
  previewLog("warn", "已请求取消，正在结束当前文件并等待最终快照。");
  if (previewCancelTimer) clearTimeout(previewCancelTimer);
  previewCancelTimer = setTimeout(() => {
    previewCancelTimer = null;
    emitPreview("task-progress", {
      jobId: previewTaskJobId,
      total: previewTaskTotal,
      completed: previewTaskCompleted,
      succeeded: previewTaskSucceeded,
      failed: previewTaskFailed,
      skipped: previewTaskSkipped,
      cancelled: true,
      done: true,
      elapsedMs: 850,
    } satisfies TaskProgress);
    previewLog("warn", `批量解密已取消，完成 ${previewTaskCompleted} 张后停止。`);
  }, 500);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || "已选目录";
}

function previewSetDirectory(kind: DirectoryKind, path: string): AppView {
  const view: DirectoryView = {
    token: `preview-${kind}-${++previewDirectoryCounter}`,
    label: basename(path),
  };
  if (kind === "input") {
    previewState = {
      ...previewState,
      input: view,
      recentInputs: [view, ...previewState.recentInputs].slice(0, 6),
    };
  } else {
    previewState = {
      ...previewState,
      output: view,
      recentOutputs: [view, ...previewState.recentOutputs].slice(0, 6),
    };
  }
  return previewState;
}

async function previewCommand(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_app_state":
      if (previewScenario === "error") {
        throw new Error("配置文件暂时不可访问，请检查本机权限后重试。");
      }
      if (previewScenario === "loading") {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      return previewState;
    case "set_directory":
      return previewSetDirectory(args.kind as DirectoryKind, String(args.path ?? ""));
    case "select_recent": {
      const kind = args.kind as DirectoryKind;
      const token = String(args.token ?? "");
      const list = kind === "input" ? previewState.recentInputs : previewState.recentOutputs;
      const selected = list.find((item) => item.token === token);
      if (!selected) throw new Error("最近使用的目录已失效。");
      previewState =
        kind === "input"
          ? { ...previewState, input: selected, recentInputs: [selected, ...list.filter((x) => x.token !== token)] }
          : { ...previewState, output: selected, recentOutputs: [selected, ...list.filter((x) => x.token !== token)] };
      return previewState;
    }
    case "auto_detect_input":
      return previewSetDirectory("input", "C:\\Preview\\心动小镇\\ScreenCapture");
    case "save_preferences": {
      previewState = {
        ...previewState,
        filters: args.filters as Filters,
        conflictPolicy: args.conflictPolicy as ConflictPolicy,
        workers: Math.max(1, Math.min(8, Number(args.workers) || 4)),
        autoCheckUpdates: Boolean(args.autoCheckUpdates),
      };
      return previewState;
    }
    case "scan_photos":
      return previewScanCommand();
    case "cancel_scan":
      previewCancelScan();
      return null;
    case "list_photos":
      return previewPhotos;
    case "get_thumbnail":
      return thumbnailFor(String(args.id ?? ""));
    case "start_decryption":
      return previewStartTask((args.ids as string[]) ?? []);
    case "cancel_decryption":
      previewCancelTask();
      return null;
    case "get_logs":
      return previewLogs;
    case "open_logs_directory":
    case "open_output_directory":
      return null;
    case "export_logs":
      previewLog("info", "日志已导出。");
      return null;
    case "export_failures":
      previewLog("info", "失败清单已导出。");
      return null;
    case "record_filter":
      return null;
    case "check_update":
      return previewCheck();
    case "install_update": {
      if (previewUpdateTimer) clearInterval(previewUpdateTimer);
      let downloaded = 0;
      const total = 42_800_000;
      previewUpdateTimer = setInterval(() => {
        downloaded = Math.min(total, downloaded + 4_600_000);
        const done = downloaded >= total;
        emitPreview("update-progress", {
          status: done ? "ready" : "downloading",
          currentVersion: previewState.version,
          version: "0.2.0",
          notes: "· 优化了万级素材列表的滚动与缩略图加载\n· 增加失败清单导出\n· 修复长路径输出时的冲突重命名",
          downloaded,
          total,
        } satisfies UpdateView);
        if (done && previewUpdateTimer) {
          clearInterval(previewUpdateTimer);
          previewUpdateTimer = null;
        }
      }, 220);
      return null;
    }
    case "restart_app":
      return null;
    default:
      throw new Error("预览环境暂不支持该操作。");
  }
}
