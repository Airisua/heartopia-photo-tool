import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownWideNarrow,
  FolderInput,
  FolderOpen,
  FolderOutput,
  Images,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import {
  autoDetectInput,
  cancelDecryption,
  cancelScan,
  checkForUpdate,
  exportFailuresTo,
  exportLogsTo,
  getAppState,
  getLogs,
  installUpdate,
  isPreviewMode,
  listPhotos,
  onAppLog,
  onScanProgress,
  onTaskProgress,
  onUpdateProgress,
  openLogsDirectory,
  openOutputDirectory,
  pickDirectory,
  pickSavePath,
  recordFilterCounts,
  restartApplication,
  savePreferences,
  scanPhotos,
  selectRecent,
  setDirectoryPath,
  startDecryption,
} from "./lib/api";
import type {
  AppView,
  DatePreset,
  DirectoryKind,
  Filters,
  LogEntry,
  PhotoStatus,
  PhotoView,
  ScanProgress,
  TaskProgress,
  UpdateView,
} from "./lib/types";
import { EMPTY_FILTERS } from "./lib/types";
import {
  filterPhotos,
  filterValidationMessage,
  localDateString,
  normalizeExtension,
  presetRange,
} from "./lib/filter";
import { formatBytes, percent } from "./lib/format";
import {
  invertIds,
  selectIds,
  selectionCounts,
  toggleSelection,
} from "./lib/selection";
import {
  safeDirectoryLabel,
  sanitizeSearchQuery,
  sanitizeUiText,
  userMessage,
} from "./lib/privacy";
import { clearThumbnailCache } from "./lib/thumbnailCache";
import { DirectoryCard } from "./components/DirectoryCard";
import { PreferencesControls } from "./components/PreferencesControls";
import { FilterBar } from "./components/FilterBar";
import { SelectionBar } from "./components/SelectionBar";
import { PhotoTable } from "./components/PhotoTable";
import { LibraryEmptyState } from "./components/LibraryEmptyState";
import { TaskPanel } from "./components/TaskPanel";
import { LogPanel } from "./components/LogPanel";
import { UpdateSheet } from "./components/UpdateSheet";
import { Toast, type Notice, type NoticeTone } from "./components/Toast";

type BootStatus = "loading" | "ready" | "error";

interface AppHeaderProps {
  version: string;
  update: UpdateView | null;
  disabled: boolean;
  onUpdateClick: () => void;
}

function updateButtonLabel(update: UpdateView | null): string {
  switch (update?.status) {
    case "checking":
      return "正在检查";
    case "available":
      return `可更新至 ${update.version ?? "新版本"}`;
    case "downloading":
      return update.total ? `下载中 ${percent(update.downloaded, update.total)}%` : "正在下载更新";
    case "ready":
      return "更新已就绪，待重启";
    case "upToDate":
      return "已是最新版本";
    case "error":
      return "更新检查失败";
    default:
      return "检查更新";
  }
}

function AppHeader({ version, update, disabled, onUpdateClick }: AppHeaderProps) {
  const status = update?.status ?? "idle";
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span className="brand-frame back" />
          <span className="brand-frame front" />
          <Images size={17} />
        </span>
        <span className="brand-copy">
          <span className="brand-name">心动相册</span>
          <span className="brand-sub">PHOTO DESK</span>
        </span>
      </div>
      <div className="header-tools">
        {isPreviewMode ? <span className="preview-chip">界面预览 · 合成数据</span> : null}
        <span className="offline-chip">
          <WifiOff size={13} />
          离线可用
        </span>
        <span className="privacy-chip">
          <ShieldCheck size={14} />
          本地只读处理
        </span>
        <button
          type="button"
          className={`update-trigger status-${status}`}
          onClick={onUpdateClick}
          disabled={disabled}
          aria-label={`当前版本 ${version}，${updateButtonLabel(update)}`}
        >
          <RefreshCw size={14} className={status === "checking" || status === "downloading" ? "spin" : ""} />
          <span className="update-copy">
            <strong>v{version}</strong>
            <small>{updateButtonLabel(update)}</small>
          </span>
          <span className="update-dot" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function BootScreen({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <main className="boot-screen">
      <div className={`boot-card ${error ? "is-error" : ""}`}>
        <span className="boot-mark" aria-hidden="true">
          <Images size={27} />
        </span>
        {error ? (
          <>
            <span className="eyebrow">启动未完成</span>
            <h1>无法载入本地工作台</h1>
            <p>{error}</p>
            <button type="button" className="button primary" onClick={onRetry}>
              <RefreshCw size={15} />
              重新载入
            </button>
          </>
        ) : (
          <>
            <span className="eyebrow">本地图片整理</span>
            <h1>正在准备解密工作台</h1>
            <p>读取本地设置并连接后台任务组件…</p>
            <span className="boot-progress" aria-hidden="true">
              <span />
            </span>
          </>
        )}
      </div>
    </main>
  );
}

const PHOTO_STATUSES = new Set<PhotoStatus>(["success", "failed", "skipped", "cancelled"]);

function normalizeLog(entry: LogEntry): LogEntry {
  return {
    timestamp: entry.timestamp,
    level: entry.level === "error" || entry.level === "warn" ? entry.level : "info",
    message: sanitizeUiText(entry.message),
  };
}

function appendUniqueLogs(current: LogEntry[], incoming: LogEntry[], limit = 300): LogEntry[] {
  const seen = new Set(current.map((entry) => `${entry.timestamp}|${entry.level}|${entry.message}`));
  const next = [...current];
  for (const entry of incoming) {
    const normalized = normalizeLog(entry);
    const key = `${normalized.timestamp}|${normalized.level}|${normalized.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(normalized);
  }
  return next.slice(-limit);
}

function sanitizeAppView(state: AppView): AppView {
  return {
    ...state,
    filters: {
      ...state.filters,
      query: sanitizeSearchQuery(state.filters.query),
      extension: normalizeExtension(state.filters.extension),
    },
  };
}

export default function App() {
  const [appState, setAppState] = useState<AppView | null>(null);
  const [bootStatus, setBootStatus] = useState<BootStatus>("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootNonce, setBootNonce] = useState(0);
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [task, setTask] = useState<TaskProgress | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [update, setUpdate] = useState<UpdateView | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingDirectory, setPendingDirectory] = useState<DirectoryKind | null>(null);

  const noticeSequence = useRef(0);
  const scanFinishedRef = useRef<string>("");
  const taskFinishedRef = useRef<string>("");
  const lastSavedPreferencesRef = useRef("");
  const preferenceSaveFailureNotified = useRef(false);

  const notify = useCallback((tone: NoticeTone, message: string) => {
    noticeSequence.current += 1;
    setNotice({
      id: noticeSequence.current,
      tone,
      message: sanitizeUiText(message),
    });
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const refreshLogs = useCallback(async () => {
    try {
      const next = await getLogs();
      setLogs((current) => appendUniqueLogs([], next.length ? next.slice(-300) : current));
    } catch {
      // Log retrieval is non-critical; existing in-memory entries remain visible.
    }
  }, []);

  const finishScan = useCallback(
    async (progress: ScanProgress) => {
      const key = `${progress.scanId}|${progress.complete}|${progress.cancelled}`;
      if (scanFinishedRef.current === key) return;
      scanFinishedRef.current = key;
      setScan(progress);
      try {
        const next = await listPhotos();
        setPhotos(next);
        const ids = new Set(next.map((photo) => photo.id));
        setSelected((current) => new Set([...current].filter((id) => ids.has(id))));
      } catch (error) {
        notify("error", `扫描完成，但读取素材索引失败：${userMessage(error)}`);
      }
      await refreshLogs();
      if (progress.cancelled) {
        notify("info", `扫描已取消，已发现 ${progress.found.toLocaleString("zh-CN")} 张图片。`);
      } else if (progress.errors > 0) {
        notify(
          "info",
          `扫描完成，共发现 ${progress.found.toLocaleString("zh-CN")} 张图片，${progress.errors} 项无法读取。`,
        );
      } else {
        notify("success", `扫描完成，共发现 ${progress.found.toLocaleString("zh-CN")} 张图片。`);
      }
    },
    [notify, refreshLogs],
  );

  const finishTask = useCallback(
    async (progress: TaskProgress) => {
      if (!progress.done) return;
      const key = `${progress.jobId}|${progress.done}|${progress.cancelled}`;
      if (taskFinishedRef.current === key) return;
      taskFinishedRef.current = key;
      setCancelRequested(false);
      setTask(progress);
      try {
        const next = await listPhotos();
        setPhotos(next);
        const ids = new Set(next.map((photo) => photo.id));
        setSelected((current) => new Set([...current].filter((id) => ids.has(id))));
      } catch {
        // Individual event statuses remain visible if refreshing the snapshot fails.
      }
      await refreshLogs();
      if (progress.cancelled) {
        notify("info", `解密任务已取消，已完成 ${progress.completed.toLocaleString("zh-CN")} 张。`);
      } else if (progress.failed > 0) {
        notify(
          "error",
          `解密完成：成功 ${progress.succeeded} 张，失败 ${progress.failed} 张。可导出失败清单。`,
        );
      } else {
        notify("success", `解密完成，成功处理 ${progress.succeeded.toLocaleString("zh-CN")} 张图片。`);
      }
    },
    [notify, refreshLogs],
  );

  useEffect(() => {
    let disposed = false;
    let unlisteners: Array<() => void> = [];
    let autoUpdateTimer: number | undefined;
    setBootStatus("loading");
    setBootError(null);
    setAppState(null);
    setPhotos([]);
    setSelected(new Set());
    setScan(null);
    setTask(null);
    setCancelRequested(false);
    setLogs([]);
    setUpdate(null);
    setUpdateOpen(false);
    setNotice(null);

    async function boot() {
      try {
        const subscriptions = await Promise.all([
          onScanProgress((progress) => {
            if (disposed) return;
            setScan(progress);
            if (progress.complete || progress.cancelled) void finishScan(progress);
          }),
          onTaskProgress((progress) => {
            if (disposed) return;
            setTask(progress);
            if (progress.cancelled && !progress.done) setCancelRequested(true);
            if (progress.currentId && progress.currentStatus && PHOTO_STATUSES.has(progress.currentStatus as PhotoStatus)) {
              const status = progress.currentStatus as PhotoStatus;
              setPhotos((current) =>
                current.map((photo) => (photo.id === progress.currentId ? { ...photo, status } : photo)),
              );
            }
            if (progress.done) void finishTask(progress);
          }),
          onAppLog((entry) => {
            if (disposed) return;
            setLogs((current) => appendUniqueLogs(current, [entry]));
          }),
          onUpdateProgress((nextUpdate) => {
            if (disposed) return;
            setUpdate(nextUpdate);
          }),
        ]);
        unlisteners = subscriptions;
        if (disposed) {
          unlisteners.forEach((unlisten) => unlisten());
          return;
        }

        const [nextState, initialLogs] = await Promise.all([
          getAppState(),
          getLogs().catch(() => [] as LogEntry[]),
        ]);
        if (disposed) return;
        setAppState(sanitizeAppView(nextState));
        setLogs(appendUniqueLogs([], initialLogs.slice(-300)));
        setUpdate({
          status: "idle",
          currentVersion: nextState.version,
          downloaded: 0,
          total: null,
        });
        // Compare against the persisted values so a legacy absolute search path
        // is replaced by its privacy-safe basename on the next auto-save.
        lastSavedPreferencesRef.current = JSON.stringify({
          filters: nextState.filters,
          conflictPolicy: nextState.conflictPolicy,
          workers: nextState.workers,
          autoCheckUpdates: nextState.autoCheckUpdates,
        });
        setBootStatus("ready");

        if (nextState.autoCheckUpdates) {
          autoUpdateTimer = window.setTimeout(async () => {
            try {
              const result = await checkForUpdate();
              if (!disposed) setUpdate(result);
            } catch {
              if (!disposed) {
                setUpdate((current) =>
                  current
                    ? {
                        ...current,
                        status: "error",
                        message: "自动检查未完成，可稍后手动重试。",
                      }
                    : current,
                );
              }
            }
          }, 900);
        }
      } catch (error) {
        if (disposed) return;
        setBootError(userMessage(error, "无法读取本地配置。"));
        setBootStatus("error");
      }
    }

    void boot();
    return () => {
      disposed = true;
      if (autoUpdateTimer !== undefined) window.clearTimeout(autoUpdateTimer);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [bootNonce, finishScan, finishTask]);

  const preferenceSignature = useMemo(() => {
    if (!appState) return "";
    return JSON.stringify({
      filters: appState.filters,
      conflictPolicy: appState.conflictPolicy,
      workers: appState.workers,
      autoCheckUpdates: appState.autoCheckUpdates,
    });
  }, [appState]);

  useEffect(() => {
    if (!appState || bootStatus !== "ready") return;
    if (lastSavedPreferencesRef.current === preferenceSignature) return;
    if (filterValidationMessage(appState.filters)) return;
    const timeout = window.setTimeout(() => {
      savePreferences({
        filters: appState.filters,
        conflictPolicy: appState.conflictPolicy,
        workers: appState.workers,
        autoCheckUpdates: appState.autoCheckUpdates,
      })
        .then(() => {
          lastSavedPreferencesRef.current = preferenceSignature;
          preferenceSaveFailureNotified.current = false;
        })
        .catch(() => {
          if (!preferenceSaveFailureNotified.current) {
            preferenceSaveFailureNotified.current = true;
            notify("error", "界面偏好暂时无法保存，本次设置仍然有效。");
          }
        });
    }, 550);
    return () => window.clearTimeout(timeout);
  }, [appState, bootStatus, notify, preferenceSignature]);

  const filtered = useMemo(
    () => filterPhotos(photos, appState?.filters ?? EMPTY_FILTERS),
    [photos, appState?.filters],
  );
  const filterViewKey = useMemo(
    () => JSON.stringify(appState?.filters ?? EMPTY_FILTERS),
    [appState?.filters],
  );

  const visibleIds = useMemo(() => filtered.map((photo) => photo.id), [filtered]);
  const counts = useMemo(() => selectionCounts(selected, visibleIds), [selected, visibleIds]);

  useEffect(() => {
    if (!appState || bootStatus !== "ready") return;
    const timeout = window.setTimeout(() => {
      recordFilterCounts(filtered.length, selected.size).catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [appState, bootStatus, filtered.length, selected.size]);

  const directories = useMemo(
    () => [...new Set(photos.map((photo) => photo.directory))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    [photos],
  );
  const extensions = useMemo(
    () =>
      [...new Set(photos.map((photo) => normalizeExtension(photo.extension)).filter(Boolean))].sort(),
    [photos],
  );
  const filteredBytes = useMemo(
    () => filtered.reduce((total, photo) => total + (Number.isFinite(photo.size) ? photo.size : 0), 0),
    [filtered],
  );

  const scanning = Boolean(scan && !scan.complete && !scan.cancelled);
  const tasking = Boolean(task && !task.done);
  const busy = scanning || tasking;
  const version = appState?.version ?? "0.1.0";

  const resetLibrary = useCallback(() => {
    setPhotos([]);
    setSelected(new Set());
    setScan(null);
    setTask(null);
    setCancelRequested(false);
    scanFinishedRef.current = "";
    taskFinishedRef.current = "";
    clearThumbnailCache();
  }, []);

  const applyDirectoryState = useCallback(
    (kind: DirectoryKind, next: AppView, message: string) => {
      const inputChanged = kind === "input" && appState?.input?.token !== next.input?.token;
      setAppState(sanitizeAppView(next));
      if (inputChanged) {
        resetLibrary();
        notify("info", "素材目录已更新。点击“扫描图片”建立新的索引。");
      } else {
        notify("success", message);
      }
    },
    [appState?.input?.token, notify, resetLibrary],
  );

  const handlePickDirectory = useCallback(
    async (kind: DirectoryKind) => {
      if (busy || pendingDirectory) return;
      setPendingDirectory(kind);
      try {
        const path = await pickDirectory();
        if (!path) return;
        const next = await setDirectoryPath(kind, path);
        applyDirectoryState(kind, next, kind === "input" ? "素材目录已设置。" : "输出目录已设置。");
      } catch (error) {
        notify("error", userMessage(error, "无法使用所选目录。"));
      } finally {
        setPendingDirectory(null);
      }
    },
    [applyDirectoryState, busy, notify, pendingDirectory],
  );

  const handleRecentDirectory = useCallback(
    async (kind: DirectoryKind, token: string) => {
      if (busy || pendingDirectory) return;
      setPendingDirectory(kind);
      try {
        const next = await selectRecent(kind, token);
        applyDirectoryState(kind, next, "已切换到最近使用的目录。");
      } catch (error) {
        notify("error", userMessage(error, "无法切换到该目录。"));
      } finally {
        setPendingDirectory(null);
      }
    },
    [applyDirectoryState, busy, notify, pendingDirectory],
  );

  const handleManualPath = useCallback(
    async (kind: DirectoryKind, path: string): Promise<boolean> => {
      if (busy || pendingDirectory) return false;
      setPendingDirectory(kind);
      try {
        const next = await setDirectoryPath(kind, path);
        applyDirectoryState(kind, next, kind === "input" ? "素材目录已设置。" : "输出目录已设置。");
        return true;
      } catch (error) {
        notify("error", userMessage(error, "该目录不可用。"));
        return false;
      } finally {
        setPendingDirectory(null);
      }
    },
    [applyDirectoryState, busy, notify, pendingDirectory],
  );

  const handleAutoDetect = useCallback(async () => {
    if (busy || pendingDirectory) return;
    setPendingDirectory("input");
    try {
      const next = await autoDetectInput();
      applyDirectoryState("input", next, "已自动定位图片目录。");
    } catch (error) {
      notify("error", userMessage(error, "没有找到默认的游戏图片目录，请手动选择。"));
    } finally {
      setPendingDirectory(null);
    }
  }, [applyDirectoryState, busy, notify, pendingDirectory]);

  const handleScan = useCallback(async () => {
    if (!appState?.input) {
      notify("info", "请先选择素材目录。");
      return;
    }
    if (busy) return;
    scanFinishedRef.current = "";
    taskFinishedRef.current = "";
    setTask(null);
    setCancelRequested(false);
    setSelected(new Set());
    clearThumbnailCache();
    const initial: ScanProgress = {
      scanId: "",
      scanned: 0,
      found: 0,
      errors: 0,
      complete: false,
      cancelled: false,
      elapsedMs: 0,
    };
    setScan(initial);
    try {
      const scanId = await scanPhotos();
      setScan((current) => (current && current.scanId ? current : { ...initial, scanId }));
    } catch (error) {
      setScan(null);
      notify("error", userMessage(error, "无法开始扫描。"));
    }
  }, [appState?.input, busy, notify]);

  const handleCancelScan = useCallback(async () => {
    try {
      await cancelScan();
    } catch (error) {
      notify("error", userMessage(error, "取消扫描失败。"));
    }
  }, [notify]);

  const handleDecrypt = useCallback(async () => {
    if (!appState || selected.size === 0 || busy) return;
    if (!appState.output) {
      notify("info", "请先设置输出目录。");
      return;
    }
    if (!appState.keyAvailable) {
      notify("error", "当前安装包未配置解密组件。");
      return;
    }
    const ids = [...selected];
    const selectedSet = new Set(ids);
    taskFinishedRef.current = "";
    const initial: TaskProgress = {
      jobId: "",
      total: ids.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      cancelled: false,
      done: false,
      elapsedMs: 0,
    };
    setPhotos((current) =>
      current.map((photo) =>
        selectedSet.has(photo.id) ? { ...photo, status: "pending" } : photo,
      ),
    );
    setTask(initial);
    setCancelRequested(false);
    try {
      const jobId = await startDecryption(ids);
      setTask((current) => (current && current.jobId ? current : { ...initial, jobId }));
    } catch (error) {
      setTask(null);
      notify("error", userMessage(error, "无法开始解密任务。"));
    }
  }, [appState, busy, notify, selected]);

  const handleCancelTask = useCallback(async () => {
    if (!task || task.done || task.cancelled) return;
    setCancelRequested(true);
    try {
      await cancelDecryption();
    } catch (error) {
      setCancelRequested(false);
      notify("error", userMessage(error, "取消任务失败。"));
    }
  }, [notify, task]);

  const handleTogglePhoto = useCallback((id: string) => {
    setSelected((current) => toggleSelection(current, id));
  }, []);

  const handleToggleAllVisible = useCallback(() => {
    if (busy) return;
    if (counts.allVisibleSelected) {
      const remove = new Set(visibleIds);
      setSelected((current) => new Set([...current].filter((id) => !remove.has(id))));
    } else {
      setSelected((current) => selectIds(current, visibleIds));
    }
  }, [busy, counts.allVisibleSelected, visibleIds]);

  const handleSelectVisible = useCallback(() => {
    if (busy) return;
    setSelected((current) => selectIds(current, visibleIds));
  }, [busy, visibleIds]);

  const handleSelectAll = useCallback(() => {
    if (busy) return;
    setSelected((current) => selectIds(current, photos.map((photo) => photo.id)));
  }, [busy, photos]);

  const handleInvertAll = useCallback(() => {
    if (busy) return;
    setSelected((current) => invertIds(current, photos.map((photo) => photo.id)));
  }, [busy, photos]);

  const handleInvertVisible = useCallback(() => {
    if (busy) return;
    setSelected((current) => invertIds(current, visibleIds));
  }, [busy, visibleIds]);

  const handleClearSelection = useCallback(() => {
    if (busy) return;
    setSelected(new Set());
  }, [busy]);

  const handleFiltersChange = useCallback((patch: Partial<Filters>) => {
    const safePatch =
      patch.query === undefined
        ? patch
        : { ...patch, query: sanitizeSearchQuery(patch.query) };
    setAppState((current) =>
      current ? { ...current, filters: { ...current.filters, ...safePatch } } : current,
    );
  }, []);

  const handleDatePreset = useCallback((preset: DatePreset) => {
    if (preset === "all") {
      handleFiltersChange({ datePreset: "all", startDate: "", endDate: "" });
      return;
    }
    if (preset === "custom") {
      handleFiltersChange({ datePreset: "custom" });
      return;
    }
    const range = presetRange(preset);
    handleFiltersChange({ datePreset: preset, ...range });
  }, [handleFiltersChange]);

  const handleResetFilters = useCallback(() => {
    handleFiltersChange({ ...EMPTY_FILTERS });
  }, [handleFiltersChange]);

  const handleConflictChange = useCallback((policy: AppView["conflictPolicy"]) => {
    setAppState((current) => (current ? { ...current, conflictPolicy: policy } : current));
  }, []);

  const handleWorkersChange = useCallback((workers: number) => {
    setAppState((current) =>
      current ? { ...current, workers: Math.min(8, Math.max(1, workers)) } : current,
    );
  }, []);

  const handleAutoCheckChange = useCallback((enabled: boolean) => {
    setAppState((current) => (current ? { ...current, autoCheckUpdates: enabled } : current));
  }, []);

  const handleOpenOutput = useCallback(async () => {
    if (!appState?.output) return;
    try {
      await openOutputDirectory();
    } catch (error) {
      notify("error", userMessage(error, "无法打开输出目录。"));
    }
  }, [appState?.output, notify]);

  const handleOpenLogsDirectory = useCallback(async () => {
    try {
      await openLogsDirectory();
    } catch (error) {
      notify("error", userMessage(error, "无法打开日志目录。"));
    }
  }, [notify]);

  const handleExportLogs = useCallback(async () => {
    try {
      const defaultName = `heartopia-photo-logs-${localDateString(new Date()).replaceAll("-", "")}.log`;
      const path = await pickSavePath(defaultName, "log");
      if (!path) return;
      await exportLogsTo(path);
      notify("success", "日志已导出。");
    } catch (error) {
      notify("error", userMessage(error, "日志导出失败。"));
    }
  }, [notify]);

  const handleExportFailures = useCallback(async () => {
    if (!task || task.failed <= 0) return;
    try {
      const defaultName = `heartopia-photo-failures-${localDateString(new Date()).replaceAll("-", "")}.csv`;
      const path = await pickSavePath(defaultName, "csv");
      if (!path) return;
      await exportFailuresTo(path);
      notify("success", "失败清单已导出。");
    } catch (error) {
      notify("error", userMessage(error, "失败清单导出失败。"));
    }
  }, [notify, task]);

  const handleCheckUpdate = useCallback(
    async (automatic = false) => {
      if (!appState) return;
      if (!automatic) {
        setUpdate((current) => ({
          status: "checking",
          currentVersion: current?.currentVersion ?? appState.version,
          downloaded: 0,
          total: null,
        }));
      }
      try {
        const result = await checkForUpdate();
        setUpdate(result);
        if (!automatic) setUpdateOpen(true);
      } catch (error) {
        const message = userMessage(error, "检查更新失败，请稍后重试。");
        setUpdate((current) => ({
          status: "error",
          currentVersion: current?.currentVersion ?? appState.version,
          downloaded: current?.downloaded ?? 0,
          total: current?.total ?? null,
          message,
        }));
        if (!automatic) {
          setUpdateOpen(true);
          notify("error", message);
        }
      }
    },
    [appState, notify],
  );

  const handleUpdateClick = useCallback(() => {
    const status = update?.status ?? "idle";
    if (status === "available" || status === "ready" || status === "downloading" || status === "checking" || status === "error") {
      setUpdateOpen(true);
      return;
    }
    void handleCheckUpdate(false);
  }, [handleCheckUpdate, update?.status]);

  const handleInstallUpdate = useCallback(async () => {
    setUpdate((current) =>
      current
        ? { ...current, status: "downloading", downloaded: 0, message: undefined }
        : current,
    );
    try {
      await installUpdate();
    } catch (error) {
      const message = userMessage(error, "更新下载或准备失败。");
      setUpdate((current) =>
        current ? { ...current, status: "error", message } : current,
      );
      notify("error", message);
    }
  }, [notify]);

  const handleRestart = useCallback(async () => {
    try {
      await restartApplication();
    } catch (error) {
      notify("error", userMessage(error, "无法重启应用，请手动关闭后重新打开。"));
    }
  }, [notify]);

  const decryptDisabledReason = !appState?.output
    ? "请先设置输出目录"
    : !appState.keyAvailable
      ? "解密密钥未配置"
      : busy
        ? "请等待当前任务结束"
        : null;

  const emptyState = useMemo(() => {
    if (!appState?.input) {
      return (
        <LibraryEmptyState
          variant="no-input"
          title="先接入素材目录"
          description="选择 ScreenCapture 根目录或 Photo、Draw 等子目录；也可以让工具自动探测。"
          actionLabel="选择素材目录"
          actionIcon={FolderInput}
          onAction={() => void handlePickDirectory("input")}
        />
      );
    }
    if (scanning && photos.length === 0) {
      return (
        <div className="library-empty scanning-preview" role="status">
          <span className="scan-orbit" aria-hidden="true">
            <ScanLine size={23} />
          </span>
          <div>
            <h3>正在读取素材目录</h3>
            <p>后台线程正在建立索引，界面保持可响应。可随时在下方取消扫描。</p>
          </div>
        </div>
      );
    }
    if (photos.length === 0 && scan?.complete && !scan.cancelled) {
      return (
        <LibraryEmptyState
          variant="no-match"
          title="目录中没有找到可处理的图片"
          description="支持 JPG、JPEG 和 PNG。请确认所选目录包含 ScreenCapture 素材。"
          actionLabel="重新扫描"
          actionIcon={ScanLine}
          onAction={() => void handleScan()}
        />
      );
    }
    if (photos.length === 0) {
      return (
        <LibraryEmptyState
          variant="not-scanned"
          title="素材目录已就绪"
          description="扫描后会在这里显示文件、拍摄时间、日期来源与处理状态。"
          actionLabel="扫描图片"
          actionIcon={ScanLine}
          onAction={() => void handleScan()}
        />
      );
    }
    return (
      <LibraryEmptyState
        variant="no-match"
        title="没有符合筛选条件的图片"
        description="调整目录、格式、日期范围或搜索关键词，已选择的项目不会因此丢失。"
        actionLabel="重置筛选"
        actionIcon={RefreshCw}
        onAction={handleResetFilters}
      />
    );
  }, [
    appState?.input,
    handlePickDirectory,
    handleResetFilters,
    handleScan,
    photos.length,
    scan?.cancelled,
    scan?.complete,
    scanning,
  ]);

  if (bootStatus !== "ready" || !appState) {
    return (
      <div className="app-shell">
        <AppHeader
          version={version}
          update={update}
          disabled
          onUpdateClick={() => undefined}
        />
        <BootScreen
          error={bootStatus === "error" ? bootError : null}
          onRetry={() => setBootNonce((value) => value + 1)}
        />
        <Toast notice={notice} onDismiss={dismissNotice} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <AppHeader
        version={version}
        update={update}
        disabled={false}
        onUpdateClick={handleUpdateClick}
      />

      <main className="workspace">
        <section className="setup-strip" aria-label="目录与任务设置">
          <DirectoryCard
            title="素材来源"
            kind="input"
            value={appState.input}
            recents={appState.recentInputs}
            icon={<FolderInput size={18} />}
            pending={pendingDirectory === "input"}
            disabled={busy}
            onPick={() => void handlePickDirectory("input")}
            onRecent={(token) => void handleRecentDirectory("input", token)}
            onManual={(path) => handleManualPath("input", path)}
            onAutoDetect={() => void handleAutoDetect()}
          />
          <DirectoryCard
            title="保存到"
            kind="output"
            value={appState.output}
            recents={appState.recentOutputs}
            icon={<FolderOutput size={18} />}
            pending={pendingDirectory === "output"}
            disabled={busy}
            onPick={() => void handlePickDirectory("output")}
            onRecent={(token) => void handleRecentDirectory("output", token)}
            onManual={(path) => handleManualPath("output", path)}
            onOpen={() => void handleOpenOutput()}
          />
          <PreferencesControls
            conflictPolicy={appState.conflictPolicy}
            workers={appState.workers}
            autoCheckUpdates={appState.autoCheckUpdates}
            keyAvailable={appState.keyAvailable}
            disabled={busy}
            onConflictChange={handleConflictChange}
            onWorkersChange={handleWorkersChange}
            onAutoCheckChange={handleAutoCheckChange}
          />
        </section>

        <section className="library-panel" aria-labelledby="library-title">
          <div className="library-head">
            <div className="library-title-group">
              <span className="eyebrow">素材工作区</span>
              <div className="library-title-line">
                <h1 id="library-title">图片库</h1>
                <span className="count-pill">
                  {filtered.length.toLocaleString("zh-CN")}
                  <span className="count-divider">/</span>
                  {photos.length.toLocaleString("zh-CN")}
                </span>
                {scanning ? <span className="live-pill">索引中</span> : null}
                {tasking ? (
                  <span className={`live-pill ${cancelRequested || task?.cancelled ? "" : "amber"}`}>
                    {cancelRequested || task?.cancelled ? "取消中" : "处理中"}
                  </span>
                ) : null}
              </div>
              <p className="library-subtitle">
                {photos.length > 0
                  ? `当前结果 ${formatBytes(filteredBytes)} · 原始文件只读`
                  : "选择目录后扫描，图片会按拍摄时间从新到旧排列。"}
              </p>
            </div>
            <div className="library-actions">
              <button
                type="button"
                className="button ghost compact open-output-button"
                onClick={() => void handleOpenOutput()}
                disabled={!appState.output}
              >
                <FolderOpen size={14} />
                打开输出目录
              </button>
              <button
                type="button"
                className="button secondary scan-button"
                onClick={() => void handleScan()}
                disabled={!appState.input || busy}
              >
                <ScanLine size={15} />
                {scanning ? "正在扫描" : "扫描图片"}
              </button>
            </div>
          </div>

          <FilterBar
            filters={appState.filters}
            directories={directories}
            extensions={extensions}
            onChange={handleFiltersChange}
            onPreset={handleDatePreset}
            onReset={handleResetFilters}
          />

          <SelectionBar
            selected={counts.selected}
            total={photos.length}
            visibleSelected={counts.visibleSelected}
            visibleTotal={counts.visibleTotal}
            busy={busy}
            decryptDisabledReason={decryptDisabledReason}
            onSelectAll={handleSelectAll}
            onInvertAll={handleInvertAll}
            onSelectVisible={handleSelectVisible}
            onInvertVisible={handleInvertVisible}
            onClear={handleClearSelection}
            onDecrypt={() => void handleDecrypt()}
          />

          <PhotoTable
            photos={filtered}
            resetKey={filterViewKey}
            selected={selected}
            allVisibleSelected={counts.allVisibleSelected}
            someVisibleSelected={counts.someVisibleSelected}
            busy={busy}
            emptyState={emptyState}
            onToggle={handleTogglePhoto}
            onToggleAll={handleToggleAllVisible}
          />

          <div className="library-footer">
            <span>
              <ArrowDownWideNarrow size={13} />
              按拍摄时间倒序
            </span>
            <span>日期优先取自文件名时间编号，缺失时回退修改时间</span>
          </div>
        </section>

        <div className="activity-grid">
          <TaskPanel
            scan={scan}
            task={task}
            cancelRequested={cancelRequested}
            photosCount={photos.length}
            selectedCount={selected.size}
            busy={busy}
            onCancelScan={() => void handleCancelScan()}
            onCancelTask={() => void handleCancelTask()}
            onExportFailures={() => void handleExportFailures()}
          />
          <LogPanel
            logs={logs}
            expanded={logsExpanded}
            onToggle={() => setLogsExpanded((value) => !value)}
            onOpenDirectory={() => void handleOpenLogsDirectory()}
            onExport={() => void handleExportLogs()}
          />
        </div>
      </main>

      <UpdateSheet
        open={updateOpen}
        update={update}
        onClose={() => setUpdateOpen(false)}
        onCheck={() => void handleCheckUpdate(false)}
        onInstall={() => void handleInstallUpdate()}
        onRestart={() => void handleRestart()}
      />
      <Toast notice={notice} onDismiss={dismissNotice} />
    </div>
  );
}
