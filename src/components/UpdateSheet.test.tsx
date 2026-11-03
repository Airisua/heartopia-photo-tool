import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateSheet } from "./UpdateSheet";
import type { UpdateView } from "../lib/types";

const available: UpdateView = {
  status: "available",
  currentVersion: "0.1.0",
  version: "0.2.0",
  notes: "· 稳定性改进",
  downloaded: 0,
  total: 42_000_000,
};

describe("UpdateSheet", () => {
  it("uses prepare wording and traps/restores keyboard focus", async () => {
    const onClose = vi.fn();
    const onInstall = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">打开更新</button>
        <UpdateSheet
          open={false}
          update={available}
          onClose={onClose}
          onCheck={vi.fn()}
          onInstall={onInstall}
          onRestart={vi.fn()}
        />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "打开更新" });
    trigger.focus();
    expect(trigger).toHaveFocus();

    rerender(
      <>
        <button type="button">打开更新</button>
        <UpdateSheet
          open
          update={available}
          onClose={onClose}
          onCheck={vi.fn()}
          onInstall={onInstall}
          onRestart={vi.fn()}
        />
      </>,
    );
    const close = screen.getByRole("button", { name: "关闭更新面板" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(screen.getByRole("button", { name: "下载并准备更新" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下载并安装" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "下载并准备更新" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();

    rerender(
      <>
        <button type="button">打开更新</button>
        <UpdateSheet
          open={false}
          update={available}
          onClose={onClose}
          onCheck={vi.fn()}
          onInstall={onInstall}
          onRestart={vi.fn()}
        />
      </>,
    );
    expect(trigger).toHaveFocus();
  });

  it("describes ready as downloaded and verified, not installed", () => {
    render(
      <UpdateSheet
        open
        update={{ ...available, status: "ready", downloaded: 42_000_000 }}
        onClose={vi.fn()}
        onCheck={vi.fn()}
        onInstall={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByText(/重启后自动安装/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重启并完成更新" })).toBeInTheDocument();
  });
});
