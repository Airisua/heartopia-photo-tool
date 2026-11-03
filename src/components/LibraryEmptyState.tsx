import type { LucideIcon } from "lucide-react";
import { FolderSearch, ScanLine, SearchX } from "lucide-react";

interface LibraryEmptyStateProps {
  variant: "no-input" | "not-scanned" | "no-match";
  title: string;
  description: string;
  actionLabel?: string;
  actionIcon?: LucideIcon;
  onAction?: () => void;
}

const DEFAULT_ICON: Record<LibraryEmptyStateProps["variant"], LucideIcon> = {
  "no-input": FolderSearch,
  "not-scanned": ScanLine,
  "no-match": SearchX,
};

export function LibraryEmptyState({
  variant,
  title,
  description,
  actionLabel,
  actionIcon,
  onAction,
}: LibraryEmptyStateProps) {
  const Icon = actionIcon ?? DEFAULT_ICON[variant];
  return (
    <div className={`library-empty empty-${variant}`}>
      <span className="empty-illustration" aria-hidden="true">
        <span className="empty-photo-card back" />
        <span className="empty-photo-card front" />
        <Icon size={24} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {actionLabel && onAction ? (
        <button type="button" className="button secondary compact" onClick={onAction}>
          <Icon size={14} />
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
