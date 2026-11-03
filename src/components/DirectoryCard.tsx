import { useId, useState, type FormEvent, type ReactNode } from "react";
import {
  ChevronDown,
  FolderOpen,
  History,
  Keyboard,
  LoaderCircle,
  LockKeyhole,
  PenLine,
  Sparkles,
} from "lucide-react";
import type { DirectoryView } from "../lib/types";
import { safeDirectoryLabel } from "../lib/privacy";

interface DirectoryCardProps {
  title: string;
  kind: "input" | "output";
  value: DirectoryView | null;
  recents: DirectoryView[];
  icon: ReactNode;
  pending?: boolean;
  disabled?: boolean;
  onPick: () => void;
  onRecent: (token: string) => void;
  onManual: (path: string) => Promise<boolean>;
  onAutoDetect?: () => void;
  onOpen?: () => void;
}

export function DirectoryCard({
  title,
  kind,
  value,
  recents,
  icon,
  pending = false,
  disabled = false,
  onPick,
  onRecent,
  onManual,
  onAutoDetect,
  onOpen,
}: DirectoryCardProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const manualId = useId();
  const noteId = useId();
  const isInput = kind === "input";
  const label = safeDirectoryLabel(value?.label);
  const busy = pending || manualSubmitting;
  const uniqueRecents = recents.filter(
    (item, index, array) =>
      item.token !== value?.token && array.findIndex((other) => other.token === item.token) === index,
  );

  async function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = manualPath.trim();
    if (!path || busy || disabled) return;
    setManualPath("");
    setManualSubmitting(true);
    try {
      const accepted = await onManual(path);
      if (accepted) setManualOpen(false);
    } finally {
      setManualSubmitting(false);
    }
  }

  return (
    <section className={`directory-card ${isInput ? "is-input" : "is-output"}`}>
      <div className="directory-head">
        <span className="directory-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="directory-heading">
          <span className="eyebrow">{title}</span>
          <span className={`permission-badge ${isInput ? "readonly" : "writable"}`}>
            {isInput ? <LockKeyhole size={11} /> : <PenLine size={11} />}
            {isInput ? "只读" : "可写"}
          </span>
        </div>
        {isInput && onAutoDetect ? (
          <button
            type="button"
            className="text-button auto-detect"
            onClick={onAutoDetect}
            disabled={disabled || busy}
            title="自动查找心动小镇的 ScreenCapture 目录"
          >
            <Sparkles size={13} />
            自动探测
          </button>
        ) : null}
      </div>

      <div className="directory-value-row">
        <div className={`directory-value ${value ? "" : "is-empty"}`} title={label}>
          <span className="directory-label">{label}</span>
          {value ? <span className="directory-state">已就绪</span> : <span className="directory-state">待设置</span>}
        </div>
        <div className="directory-value-actions">
          {uniqueRecents.length > 0 ? (
            <details className="recent-menu">
              <summary className="icon-button subtle" aria-label={`${title}最近使用`} title="最近使用">
                <History size={15} />
              </summary>
              <div className="recent-popover" role="menu">
                <span className="recent-title">最近使用</span>
                {uniqueRecents.slice(0, 6).map((item) => (
                  <button
                    key={item.token}
                    type="button"
                    role="menuitem"
                    className="recent-item"
                    disabled={disabled || busy}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      onRecent(item.token);
                    }}
                  >
                    <span>{safeDirectoryLabel(item.label)}</span>
                    <ChevronDown size={13} className="recent-arrow" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </details>
          ) : null}
          {!isInput && value && onOpen ? (
            <button
              type="button"
              className="icon-button subtle"
              aria-label="打开输出目录"
              title="打开输出目录"
              onClick={onOpen}
              disabled={disabled}
            >
              <FolderOpen size={16} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="directory-footer">
        <button
          type="button"
          className="button secondary compact"
          onClick={onPick}
          disabled={disabled || busy}
        >
          {pending ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}
          {pending ? "正在应用" : "选择目录"}
        </button>
        <button
          type="button"
          className="text-button"
          aria-expanded={manualOpen}
          aria-controls={manualId}
          onClick={() => {
            if (!busy) {
              setManualPath("");
              setManualOpen((open) => !open);
            }
          }}
          disabled={disabled || busy}
        >
          <Keyboard size={13} />
          {manualOpen ? "收起" : "手动填写"}
        </button>
        <span className="directory-hint">
          {isInput ? "原始图片不会被修改" : "结果另行保存，不覆盖原图"}
        </span>
      </div>

      {manualOpen ? (
        <form className="manual-path" onSubmit={submitManual}>
          <label className="sr-only" htmlFor={manualId}>
            手动输入{title}路径（输入内容已遮蔽）
          </label>
          <input
            id={manualId}
            data-testid={`${kind}-manual-path`}
            type="password"
            value={manualPath}
            onChange={(event) => setManualPath(event.target.value)}
            placeholder="粘贴完整目录路径（内容已遮蔽）"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={noteId}
          />
          <button type="submit" className="button primary compact" disabled={!manualPath.trim() || busy}>
            应用
          </button>
          <span id={noteId} className="manual-note">
            路径只用于本机校验，不显示也不写入日志
          </span>
        </form>
      ) : null}
    </section>
  );
}
