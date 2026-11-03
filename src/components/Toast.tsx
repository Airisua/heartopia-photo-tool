import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

export type NoticeTone = "success" | "error" | "info";

export interface Notice {
  id: number;
  tone: NoticeTone;
  message: string;
}

interface ToastProps {
  notice: Notice | null;
  onDismiss: () => void;
}

export function Toast({ notice, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(onDismiss, notice.tone === "error" ? 7000 : 4500);
    return () => window.clearTimeout(timeout);
  }, [notice, onDismiss]);

  if (!notice) return null;
  const Icon = notice.tone === "success" ? CheckCircle2 : notice.tone === "error" ? AlertTriangle : Info;
  return (
    <div className={`toast ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} aria-live="polite">
      <Icon size={17} aria-hidden="true" />
      <span>{notice.message}</span>
      <button type="button" onClick={onDismiss} aria-label="关闭提示">
        <X size={14} />
      </button>
    </div>
  );
}
