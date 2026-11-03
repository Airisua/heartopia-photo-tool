import { Check, RefreshCw, ShieldAlert, SlidersHorizontal } from "lucide-react";
import type { ConflictPolicy } from "../lib/types";

interface PreferencesControlsProps {
  conflictPolicy: ConflictPolicy;
  workers: number;
  autoCheckUpdates: boolean;
  keyAvailable: boolean;
  disabled?: boolean;
  onConflictChange: (policy: ConflictPolicy) => void;
  onWorkersChange: (workers: number) => void;
  onAutoCheckChange: (enabled: boolean) => void;
}

export function PreferencesControls({
  conflictPolicy,
  workers,
  autoCheckUpdates,
  keyAvailable,
  disabled = false,
  onConflictChange,
  onWorkersChange,
  onAutoCheckChange,
}: PreferencesControlsProps) {
  return (
    <section className="preferences-card" aria-label="任务规则">
      <div className="preferences-title">
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>任务规则</span>
      </div>
      <div className="preferences-grid">
        <label className="preference-field">
          <span>重名文件</span>
          <select
            value={conflictPolicy}
            onChange={(event) => onConflictChange(event.target.value as ConflictPolicy)}
            disabled={disabled}
          >
            <option value="skip">跳过</option>
            <option value="rename">自动重命名</option>
          </select>
        </label>
        <label className="preference-field">
          <span>并发数</span>
          <select
            value={workers}
            onChange={(event) => onWorkersChange(Number(event.target.value))}
            disabled={disabled}
          >
            {Array.from({ length: 8 }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={`preference-check ${disabled ? "is-disabled" : ""}`}>
        <input
          type="checkbox"
          checked={autoCheckUpdates}
          onChange={(event) => onAutoCheckChange(event.target.checked)}
          disabled={disabled}
        />
        <span className="fake-check" aria-hidden="true">
          <Check size={11} />
        </span>
        <RefreshCw size={12} aria-hidden="true" />
        <span>启动时检查更新</span>
      </label>
      {keyAvailable ? (
        <span className="key-state ready">
          <span className="key-dot" aria-hidden="true" />
          解密组件已就绪
        </span>
      ) : (
        <span className="key-state missing">
          <ShieldAlert size={12} />
          解密密钥未配置，仅可浏览
        </span>
      )}
    </section>
  );
}
