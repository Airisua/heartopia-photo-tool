import { CheckCheck, Eraser, ListChecks, LockKeyhole, Unlock } from "lucide-react";

interface SelectionBarProps {
  selected: number;
  total: number;
  visibleSelected: number;
  visibleTotal: number;
  busy?: boolean;
  decryptDisabledReason?: string | null;
  onSelectAll: () => void;
  onInvertAll: () => void;
  onSelectVisible: () => void;
  onInvertVisible: () => void;
  onClear: () => void;
  onDecrypt: () => void;
}

export function SelectionBar({
  selected,
  total,
  visibleSelected,
  visibleTotal,
  busy = false,
  decryptDisabledReason = null,
  onSelectAll,
  onInvertAll,
  onSelectVisible,
  onInvertVisible,
  onClear,
  onDecrypt,
}: SelectionBarProps) {
  const hiddenSelected = Math.max(0, selected - visibleSelected);
  return (
    <div className="selection-bar">
      <div className="selection-summary" aria-live="polite">
        <span className="selection-number">{selected.toLocaleString("zh-CN")}</span>
        <span>张已选择</span>
        <span className="selection-divider" aria-hidden="true" />
        <span className="selection-visible">
          当前结果 {visibleTotal.toLocaleString("zh-CN")} 张
          {hiddenSelected > 0 ? ` · 另有 ${hiddenSelected.toLocaleString("zh-CN")} 张不在筛选内` : ""}
        </span>
      </div>
      <div className="selection-actions">
        <button
          type="button"
          className="button ghost compact"
          onClick={onSelectAll}
          disabled={busy || total === 0 || selected === total}
          title="选择当前已扫描的全部图片"
        >
          <ListChecks size={14} />
          全选全部
        </button>
        <button
          type="button"
          className="button ghost compact"
          onClick={onInvertAll}
          disabled={busy || total === 0}
          title="对当前已扫描的全部图片执行反选"
        >
          <CheckCheck size={14} />
          反选全部
        </button>
        <button
          type="button"
          className="button ghost compact"
          onClick={onSelectVisible}
          disabled={busy || visibleTotal === 0 || visibleSelected === visibleTotal}
          title="选择当前筛选结果"
        >
          <ListChecks size={14} />
          全选结果
        </button>
        <button
          type="button"
          className="button ghost compact"
          onClick={onInvertVisible}
          disabled={busy || visibleTotal === 0}
        >
          <CheckCheck size={14} />
          反选
        </button>
        <button
          type="button"
          className="button ghost compact"
          onClick={onClear}
          disabled={busy || selected === 0}
        >
          <Eraser size={14} />
          清空
        </button>
      </div>
      <div className="selection-cta">
        {decryptDisabledReason ? (
          <span className="action-reason">
            <LockKeyhole size={12} />
            {decryptDisabledReason}
          </span>
        ) : (
          <span className="selection-tip">仅写入输出目录，原图保持不变</span>
        )}
        <button
          type="button"
          className="button primary decrypt-button"
          onClick={onDecrypt}
          disabled={busy || selected === 0 || Boolean(decryptDisabledReason)}
          aria-label={`开始解密，将处理 ${selected.toLocaleString("zh-CN")} 张图片`}
        >
          <Unlock size={15} />
          {busy ? "任务处理中" : `解密 ${selected.toLocaleString("zh-CN")} 张`}
        </button>
      </div>
    </div>
  );
}
