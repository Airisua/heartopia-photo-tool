import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskPanel } from "./TaskPanel";
import type { TaskProgress } from "../lib/types";

const baseTask: TaskProgress = {
  jobId: "job-1",
  total: 200,
  completed: 20,
  succeeded: 19,
  failed: 1,
  skipped: 0,
  cancelled: false,
  done: false,
  elapsedMs: 900,
};

function renderPanel(task: TaskProgress, cancelRequested = false) {
  return render(
    <TaskPanel
      scan={null}
      task={task}
      cancelRequested={cancelRequested}
      photosCount={200}
      selectedCount={200}
      busy
      onCancelScan={vi.fn()}
      onCancelTask={vi.fn()}
      onExportFailures={vi.fn()}
    />,
  );
}

describe("TaskPanel cancellation boundary", () => {
  it("keeps the task active and cancellation disabled until done", () => {
    const { rerender } = renderPanel(baseTask);
    expect(screen.getByRole("button", { name: "取消任务" })).toBeEnabled();

    rerender(
      <TaskPanel
        scan={null}
        task={{ ...baseTask, cancelled: true }}
        cancelRequested
        photosCount={200}
        selectedCount={200}
        busy
        onCancelScan={vi.fn()}
        onCancelTask={vi.fn()}
        onExportFailures={vi.fn()}
      />,
    );
    expect(screen.getByText(/正在结束当前文件/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在取消" })).toBeDisabled();
  });

  it("shows a cancelled result only after the final done snapshot", () => {
    renderPanel({ ...baseTask, cancelled: true, done: true });
    expect(screen.getByText("任务已取消")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /取消/ })).not.toBeInTheDocument();
  });
});
