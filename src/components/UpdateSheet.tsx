import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { UpdateView } from "../lib/types";
import { formatBytes, percent } from "../lib/format";
import { sanitizeUiText } from "../lib/privacy";

interface UpdateSheetProps {
  open: boolean;
  update: UpdateView | null;
  onClose: () => void;
  onCheck: () => void;
  onInstall: () => void;
  onRestart: () => void;
}

export function UpdateSheet({ open, update, onClose, onCheck, onInstall, onRestart }: UpdateSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const closeHandlerRef = useRef(onClose);
  closeHandlerRef.current = onClose;
  const status = update?.status ?? "idle";
  const progress = percent(update?.downloaded ?? 0, update?.total ?? 0);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeHandlerRef.current();
        return;
      }
      if (event.key !== "Tab" || !sheetRef.current) return;
      const focusable = [
        ...sheetRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={sheetRef}
        className="update-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        aria-describedby="update-description"
      >
        <button
          ref={closeRef}
          type="button"
          className="icon-button modal-close"
          onClick={onClose}
          aria-label="关闭更新面板"
        >
          <X size={17} />
        </button>

        <div className={`update-hero status-${status}`}>
          <span className="update-icon" aria-hidden="true">
            {status === "checking" || status === "downloading" ? (
              <LoaderCircle size={25} className="spin" />
            ) : status === "available" || status === "ready" ? (
              <Sparkles size={25} />
            ) : status === "upToDate" ? (
              <CheckCircle2 size={25} />
            ) : status === "error" ? (
              <AlertTriangle size={25} />
            ) : (
              <RefreshCw size={25} />
            )}
          </span>
          <div>
            <span className="eyebrow">桌面应用更新</span>
            <h2 id="update-title">
              {status === "available"
                ? `发现新版本 ${update?.version ?? ""}`
                : status === "downloading"
                  ? "正在下载并准备更新"
                  : status === "ready"
                    ? "更新已准备好"
                    : status === "upToDate"
                      ? "当前已是最新版本"
                      : status === "checking"
                        ? "正在检查更新"
                        : status === "error"
                          ? "更新暂时不可用"
                          : "应用更新"}
            </h2>
            <p id="update-description">
              {status === "available"
                ? `当前版本 ${update?.currentVersion ?? "—"}。下载并校验更新包后，可重启完成安装。`
                : status === "downloading"
                  ? "下载完成并通过签名校验后，会提示重启完成安装。"
                  : status === "ready"
                    ? "更新包已下载并通过签名校验。重启后自动安装，窗口会退出并重新打开，现有设置会保留。"
                    : status === "upToDate"
                      ? `已使用最新版本 ${update?.currentVersion ?? "—"}。`
                      : status === "error"
                        ? "检查或下载失败不会影响当前版本继续使用。"
                        : status === "checking"
                          ? "正在连接发布渠道，请稍候。"
                          : "可手动检查是否有新版本。"}
            </p>
          </div>
        </div>

        {update?.notes && (status === "available" || status === "downloading" || status === "ready") ? (
          <div className="release-notes">
            <span className="release-notes-title">更新说明</span>
            <p>{sanitizeUiText(update.notes)}</p>
          </div>
        ) : null}

        {status === "downloading" ? (
          <div className="update-progress">
            <div className="progress-copy">
              <span>下载并校验更新包</span>
              <strong>{update?.total ? `${progress}%` : "连接中"}</strong>
            </div>
            <div
              className={`progress-track ${update?.total ? "" : "indeterminate"}`}
              role="progressbar"
              aria-label="更新下载进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={update?.total ? progress : undefined}
            >
              <span style={update?.total ? { width: `${progress}%` } : undefined} />
            </div>
            <div className="progress-meta">
              <span>{formatBytes(update?.downloaded ?? 0)}</span>
              <span>{update?.total ? `共 ${formatBytes(update.total)}` : "正在获取大小"}</span>
            </div>
          </div>
        ) : null}

        {status === "error" && update?.message ? (
          <div className="update-error" role="alert">
            <AlertTriangle size={15} />
            <span>{sanitizeUiText(update.message)}</span>
          </div>
        ) : null}

        <div className="update-integrity">
          <ShieldCheck size={14} />
          <span>下载后校验签名；重启时才安装。失败不会替换当前版本。</span>
        </div>

        <div className="update-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            {status === "ready" ? "稍后重启" : "关闭"}
          </button>
          {status === "available" ? (
            <button type="button" className="button primary" onClick={onInstall}>
              <Download size={15} />
              下载并准备更新
            </button>
          ) : status === "ready" ? (
            <button type="button" className="button primary" onClick={onRestart}>
              <RotateCcw size={15} />
              重启并完成更新
            </button>
          ) : status === "error" || status === "idle" || status === "upToDate" ? (
            <button type="button" className="button primary" onClick={onCheck}>
              <RefreshCw size={15} />
              重新检查
            </button>
          ) : (
            <button type="button" className="button primary" disabled>
              <LoaderCircle size={15} className="spin" />
              {status === "checking" ? "检查中" : "准备更新中"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
