import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FolderOpen } from "lucide-react";
import { DirectoryCard } from "./DirectoryCard";

describe("DirectoryCard privacy and manual entry", () => {
  it("masks manual paths and never renders the full directory", async () => {
    const fullPath =
      "C:\\Users\\ExampleUser\\AppData\\LocalLow\\xd\\心动小镇\\ScreenCapture";
    const onManual = vi.fn().mockResolvedValue(true);
    render(
      <DirectoryCard
        title="素材来源"
        kind="input"
        value={{ token: "safe-token", label: "ScreenCapture" }}
        recents={[]}
        icon={<FolderOpen size={18} />}
        onPick={vi.fn()}
        onRecent={vi.fn()}
        onManual={onManual}
      />,
    );

    expect(screen.getByText("ScreenCapture")).toBeInTheDocument();
    expect(screen.queryByText(fullPath)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "手动填写" }));
    const input = screen.getByTestId("input-manual-path");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: fullPath } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(onManual).toHaveBeenCalledWith(fullPath));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.queryByText(fullPath)).not.toBeInTheDocument();
  });

  it("sanitizes a malformed absolute label to a basename", () => {
    render(
      <DirectoryCard
        title="保存到"
        kind="output"
        value={{
          token: "out",
          label: "C:\\Users\\ExampleUser\\Pictures\\心动相册导出",
        }}
        recents={[]}
        icon={<FolderOpen size={18} />}
        onPick={vi.fn()}
        onRecent={vi.fn()}
        onManual={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(screen.getByText("心动相册导出")).toBeInTheDocument();
    expect(screen.queryByText("C:\\Users\\ExampleUser\\Pictures\\心动相册导出")).not.toBeInTheDocument();
  });
});
