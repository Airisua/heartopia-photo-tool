import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Download, FolderOpen, ScrollText, Terminal } from "lucide-react";
import type { LogEntry } from "../lib/types";
import { formatLogTime } from "../lib/format";
import { sanitizeUiText } from "../lib/privacy";

interface LogPanelProps {
  logs: LogEntry[];
  expanded: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onOpenDirectory: () => void;
  onExport: () => void;
}

export function LogPanel({
  logs,
  expanded,
  disabled = false,
  onToggle,
  onOpenDirectory,
  onExport,
}: LogPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const errors = logs.filter((entry) => entry.level === "error").length;

  useEffect(() => {
    if (!expanded || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [expanded, logs]);

  return (
    <section className={`activity-card log-panel ${expanded ? "is-expanded" : ""}`} aria-label="运行日志">
      <div className="panel-heading log-heading">
        <button
          type="button"
          className="log-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls="log-content"
        >
          <span className="panel-title">
            <span className="panel-title-icon">
              <Terminal size={15} />
            </span>
            <span>运行日志</span>
            {errors > 0 ? <span className="error-badge">{errors} 错误</span> : null}
          </span>
          {expanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        <div className="log-tools">
          <button
            type="button"
            className="icon-button subtle"
            onClick={onOpenDirectory}
            disabled={disabled}
            aria-label="打开日志目录"
            title="打开日志目录"
          >
            <FolderOpen size={15} />
          </button>
          <button
            type="button"
            className="icon-button subtle"
            onClick={onExport}
            disabled={disabled}
            aria-label="导出日志"
            title="导出日志"
          >
            <Download size={15} />
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="log-content" id="log-content" ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions">
          {logs.length === 0 ? (
            <div className="log-empty">
              <ScrollText size={18} />
              <span>暂无日志。扫描或解密后，运行记录会显示在这里。</span>
            </div>
          ) : (
            logs.map((entry, index) => (
              <div className={`log-line ${entry.level}`} key={`${entry.timestamp}-${index}`}>
                <time dateTime={entry.timestamp}>{formatLogTime(entry.timestamp)}</time>
                <span className="log-level" aria-hidden="true" />
                <span className="log-message">{sanitizeUiText(entry.message)}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="log-preview" aria-hidden="true">
          <span className="log-preview-dot" />
          {logs.at(-1) ? (
            <>
              <span>{formatLogTime(logs.at(-1)!.timestamp)}</span>
              <span>{sanitizeUiText(logs.at(-1)!.message)}</span>
            </>
          ) : (
            <span>等待运行记录</span>
          )}
        </div>
      )}
    </section>
  );
}
