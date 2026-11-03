import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Download,
  FolderCheck,
  LoaderCircle,
  ScanSearch,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { ScanProgress, TaskProgress } from "../lib/types";
import { formatDuration, percent } from "../lib/format";
import { sanitizeUiText } from "../lib/privacy";

interface TaskPanelProps {
  scan: ScanProgress | null;
  task: TaskProgress | null;
  cancelRequested?: boolean;
  photosCount: number;
  selectedCount: number;
  busy: boolean;
  onCancelScan: () => void;
  onCancelTask: () => void;
  onExportFailures: () => void;
}

function isScanActive(scan: ScanProgress | null): scan is ScanProgress {
  return Boolean(scan && !scan.complete && !scan.cancelled);
}

function isTaskActive(task: TaskProgress | null): task is TaskProgress {
  return Boolean(task && !task.done);
}

export function TaskPanel({
  scan,
  task,
  cancelRequested = false,
  photosCount,
  selectedCount,
  busy,
  onCancelScan,
  onCancelTask,
  onExportFailures,
}: TaskPanelProps) {
  const activeScan = isScanActive(scan) ? scan : null;
  const activeTask = isTaskActive(task) ? task : null;
  const scanning = activeScan !== null;
  const tasking = activeTask !== null;
  const cancelling = Boolean(activeTask && (cancelRequested || activeTask.cancelled));
  const rawTaskPercent = task ? percent(task.completed, task.total) : 0;
  const taskPercent =
    task && task.completed > 0 && rawTaskPercent === 0 ? 1 : rawTaskPercent;
  const taskPercentLabel =
    task && task.completed > 0 && rawTaskPercent === 0 ? "<1%" : `${rawTaskPercent}%`;

  return (
    <section className={`activity-card task-panel ${scanning || tasking ? "is-active" : ""}`} aria-label="处理进度">
      <div className="panel-heading">
        <div className="panel-title">
          <span className="panel-title-icon">
            {scanning ? <ScanSearch size={15} /> : tasking ? <LoaderCircle size={15} className="spin" /> : <FolderCheck size={15} />}
          </span>
          <span>处理进度</span>
          {scanning ? <span className="live-pill">扫描中</span> : null}
          {tasking ? (
            <span className={`live-pill ${cancelling ? "" : "amber"}`}>
              {cancelling ? "取消中" : "解密中"}
            </span>
          ) : null}
        </div>
        {scanning ? (
          <button type="button" className="button ghost compact danger" onClick={onCancelScan}>
            <CircleStop size={14} />
            取消扫描
          </button>
        ) : tasking ? (
          <button
            type="button"
            className="button ghost compact danger"
            onClick={onCancelTask}
            disabled={cancelling}
          >
            <CircleStop size={14} />
            {cancelling ? "正在取消" : "取消任务"}
          </button>
        ) : (
          <span className="panel-idle">
            <ShieldCheck size={13} />
            后台任务就绪
          </span>
        )}
      </div>

      <div className="task-body" aria-live="polite">
        {activeScan ? (
          <div className="progress-block">
            <div className="progress-copy">
              <span>
                正在建立素材索引
                <span className="progress-sub">已检查 {activeScan.scanned.toLocaleString("zh-CN")} 项</span>
              </span>
              <strong>{activeScan.found.toLocaleString("zh-CN")} 张</strong>
            </div>
            <div className="progress-track indeterminate" role="progressbar" aria-label="正在扫描图片" aria-valuetext={`已发现 ${activeScan.found} 张图片`}>
              <span />
            </div>
            <div className="progress-meta">
              <span>发现 {activeScan.found.toLocaleString("zh-CN")} 张图片</span>
              <span>{activeScan.errors > 0 ? `${activeScan.errors} 项无法读取` : "未发现读取错误"}</span>
              <span>{formatDuration(activeScan.elapsedMs)}</span>
            </div>
          </div>
        ) : activeTask ? (
          <div className="progress-block">
            <div className="progress-copy">
              <span>
                {cancelling ? "正在结束当前文件" : "正在解密图片"}
                <span className="progress-sub">
                  {activeTask.completed.toLocaleString("zh-CN")} / {activeTask.total.toLocaleString("zh-CN")}
                </span>
              </span>
              <strong>{taskPercentLabel}</strong>
            </div>
            <div
              className="progress-track amber"
              role="progressbar"
              aria-label="批量解密进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={taskPercent}
            >
              <span style={{ width: `${taskPercent}%` }} />
            </div>
            <div className="progress-meta">
              <span className="success-text">{activeTask.succeeded} 成功</span>
              <span className={activeTask.failed > 0 ? "error-text" : ""}>{activeTask.failed} 失败</span>
              <span>{activeTask.skipped} 跳过</span>
              <span>{formatDuration(activeTask.elapsedMs)}</span>
            </div>
          </div>
        ) : task ? (
          <div className="result-block">
            <div className={`result-symbol ${task.failed > 0 ? "warn" : "ok"}`}>
              {task.cancelled ? <XCircle size={22} /> : task.failed > 0 ? <AlertTriangle size={22} /> : <CheckCircle2 size={22} />}
            </div>
            <div className="result-copy">
              <strong>{task.cancelled ? "任务已取消" : task.failed > 0 ? "解密完成，部分文件失败" : "全部解密完成"}</strong>
              <span>
                成功 {task.succeeded} · 失败 {task.failed} · 跳过 {task.skipped} · 用时 {formatDuration(task.elapsedMs)}
              </span>
              {task.reason ? <span className="result-reason">{sanitizeUiText(task.reason)}</span> : null}
            </div>
            {task.failed > 0 ? (
              <button type="button" className="button secondary compact" onClick={onExportFailures}>
                <Download size={14} />
                导出失败清单
              </button>
            ) : null}
          </div>
        ) : scan ? (
          <div className="result-block">
            <div className={`result-symbol ${scan.cancelled || scan.errors > 0 ? "warn" : "ok"}`}>
              {scan.cancelled ? <XCircle size={22} /> : <CheckCircle2 size={22} />}
            </div>
            <div className="result-copy">
              <strong>{scan.cancelled ? "扫描已取消" : "素材索引已就绪"}</strong>
              <span>
                共发现 {scan.found.toLocaleString("zh-CN")} 张图片
                {scan.errors > 0 ? `，${scan.errors} 项读取失败` : ""} · 用时 {formatDuration(scan.elapsedMs)}
              </span>
            </div>
          </div>
        ) : (
          <div className="idle-summary">
            <div>
              <span className="idle-kicker">当前素材</span>
              <strong>{photosCount.toLocaleString("zh-CN")} 张</strong>
            </div>
            <div className="idle-divider" aria-hidden="true" />
            <div>
              <span className="idle-kicker">已选择</span>
              <strong>{selectedCount.toLocaleString("zh-CN")} 张</strong>
            </div>
            <p>
              {busy
                ? "任务正在后台运行，界面仍可浏览筛选。"
                : photosCount > 0
                  ? "挑选图片后开始解密；每个文件独立处理，单个失败不会中断整批任务。"
                  : "扫描素材目录后，可在这里查看进度与失败清单。"}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
