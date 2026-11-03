import { CalendarDays, Search, SlidersHorizontal, X } from "lucide-react";
import type { DatePreset, Filters } from "../lib/types";
import { countActiveFilters, filterValidationMessage } from "../lib/filter";
import { safeRelativePath, sanitizeSearchQuery } from "../lib/privacy";

interface FilterBarProps {
  filters: Filters;
  directories: string[];
  extensions: string[];
  disabled?: boolean;
  onChange: (patch: Partial<Filters>) => void;
  onPreset: (preset: DatePreset) => void;
  onReset: () => void;
}

const PRESETS: Array<{ value: Exclude<DatePreset, "custom">; label: string }> = [
  { value: "all", label: "全部" },
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

function extensionLabel(extension: string): string {
  return extension.replace(/^\./, "").toUpperCase();
}

export function FilterBar({
  filters,
  directories,
  extensions,
  disabled = false,
  onChange,
  onPreset,
  onReset,
}: FilterBarProps) {
  const active = countActiveFilters(filters);
  const validation = filterValidationMessage(filters);

  return (
    <div className="filter-area">
      <div className="filter-bar" role="search" aria-label="照片筛选">
        <div className="filter-label">
          <SlidersHorizontal size={14} aria-hidden="true" />
          <span>筛选</span>
          {active > 0 ? <span className="filter-count">{active}</span> : null}
        </div>

        <label className="search-field">
          <span className="sr-only">搜索文件名或相对路径</span>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={filters.query}
            onChange={(event) => onChange({ query: event.target.value })}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              const safe = sanitizeSearchQuery(pasted);
              if (safe !== pasted) {
                event.preventDefault();
                onChange({ query: safe });
              }
            }}
            placeholder="搜索文件名或路径"
            disabled={disabled}
            spellCheck={false}
            maxLength={512}
            aria-describedby="photo-search-privacy"
            title="粘贴完整路径时只保留文件名"
          />
          {filters.query ? (
            <button
              type="button"
              className="search-clear"
              onClick={() => onChange({ query: "" })}
              aria-label="清除搜索"
              disabled={disabled}
            >
              <X size={13} />
            </button>
          ) : null}
        </label>
        <span id="photo-search-privacy" className="sr-only">
          搜索不会显示或保存完整本地路径；粘贴完整路径时仅保留文件名。
        </span>

        <label className="select-field">
          <span className="sr-only">按目录筛选</span>
          <select
            value={filters.directory}
            onChange={(event) => onChange({ directory: event.target.value })}
            disabled={disabled}
          >
            <option value="">全部目录</option>
            {directories.map((directory) => (
              <option key={directory} value={directory}>
                {safeRelativePath(directory)}
              </option>
            ))}
          </select>
        </label>

        <label className="select-field narrow">
          <span className="sr-only">按文件格式筛选</span>
          <select
            value={filters.extension}
            onChange={(event) => onChange({ extension: event.target.value })}
            disabled={disabled}
          >
            <option value="">全部格式</option>
            {extensions.map((extension) => (
              <option key={extension} value={extension}>
                {extensionLabel(extension)}
              </option>
            ))}
          </select>
        </label>

        <div className="date-presets" role="group" aria-label="快捷日期范围">
          <CalendarDays size={14} className="date-icon" aria-hidden="true" />
          {PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className="date-preset-button"
              aria-pressed={filters.datePreset === preset.value}
              onClick={() => onPreset(preset.value)}
              disabled={disabled}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className="date-preset-button"
            aria-pressed={filters.datePreset === "custom"}
            onClick={() => onPreset("custom")}
            disabled={disabled}
          >
            自定义
          </button>
        </div>

        <button type="button" className="button ghost compact reset-button" onClick={onReset} disabled={disabled || active === 0}>
          重置
        </button>
      </div>

      {filters.datePreset === "custom" ? (
        <div className="custom-date-row">
          <label>
            <span>起始日期</span>
            <input
              type="date"
              value={filters.startDate}
              max={filters.endDate || undefined}
              onChange={(event) => onChange({ startDate: event.target.value, datePreset: "custom" })}
              disabled={disabled}
            />
          </label>
          <span className="date-separator" aria-hidden="true">
            —
          </span>
          <label>
            <span>结束日期</span>
            <input
              type="date"
              value={filters.endDate}
              min={filters.startDate || undefined}
              onChange={(event) => onChange({ endDate: event.target.value, datePreset: "custom" })}
              disabled={disabled}
            />
          </label>
          {validation ? (
            <span className="filter-validation" role="alert">
              {validation}
            </span>
          ) : (
            <span className="custom-date-note">日期按本机时区计算，包含起止两天</span>
          )}
        </div>
      ) : validation ? (
        <div className="custom-date-row">
          <span className="filter-validation" role="alert">
            {validation}
          </span>
        </div>
      ) : null}
    </div>
  );
}
