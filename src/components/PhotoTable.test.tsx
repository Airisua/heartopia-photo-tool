import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhotoTable } from "./PhotoTable";
import { makePhoto, makePhotos } from "../test/fixtures";

vi.mock("../lib/thumbnailCache", () => ({
  peekThumbnail: vi.fn().mockReturnValue(null),
  loadThumbnail: vi.fn().mockResolvedValue(null),
  releaseThumbnail: vi.fn(),
}));

describe("PhotoTable virtualization and selection", () => {
  it("renders a bounded subset for 20001 rows", () => {
    const photos = makePhotos(20001);
    const { container } = render(
      <PhotoTable
        photos={photos}
        selected={new Set()}
        allVisibleSelected={false}
        someVisibleSelected={false}
        resetKey=""
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );

    expect(screen.getByRole("grid", { name: "图片列表" })).toHaveAttribute(
      "aria-rowcount",
      "19776",
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeLessThan(40);
    expect(checkboxes.length).toBeGreaterThan(1);
    expect(container.querySelectorAll(".photo-row").length).toBeLessThan(40);
    const accessibleNames = checkboxes
      .slice(1)
      .map((checkbox) => checkbox.getAttribute("aria-label"));
    expect(new Set(accessibleNames).size).toBe(accessibleNames.length);
    expect(accessibleNames[0]).toContain("第 1 行");
  });

  it("keeps checked state when the visible result is filtered", () => {
    const visible = makePhoto(1, { id: "kept" });
    const onToggle = vi.fn();
    const props = {
      selected: new Set(["kept"]),
      allVisibleSelected: true,
      someVisibleSelected: false,
      resetKey: "kept",
      onToggle,
      onToggleAll: vi.fn(),
    };
    const { rerender, container } = render(
      <PhotoTable photos={[visible, makePhoto(2)]} {...props} />,
    );
    const firstRowCheckbox = container.querySelector(
      '[data-photo-id="kept"] input[type="checkbox"]',
    );
    expect(firstRowCheckbox).not.toBeNull();
    fireEvent.click(firstRowCheckbox!);
    expect(onToggle).toHaveBeenCalled();

    rerender(<PhotoTable photos={[visible]} {...props} />);
    expect(
      container.querySelector('[data-photo-id="kept"] input[type="checkbox"]'),
    ).toBeChecked();
  });

  it("supports full-list keyboard navigation and reset scroll on filter change", () => {
    const photos = makePhotos(20001);
    const onToggle = vi.fn();
    const props = {
      photos,
      selected: new Set<string>(),
      allVisibleSelected: false,
      someVisibleSelected: false,
      onToggle,
      onToggleAll: vi.fn(),
    };
    const { container, rerender } = render(
      <PhotoTable {...props} resetKey="all" />,
    );
    const grid = screen.getByRole("grid", { name: "图片列表" });
    expect(grid).toHaveAttribute("tabindex", "0");
    expect(grid.getAttribute("aria-activedescendant")).toMatch(/-row-1$/);

    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.getAttribute("aria-activedescendant")).toMatch(/-row-20001$/);
    fireEvent.keyDown(grid, { key: "Home" });
    expect(grid.getAttribute("aria-activedescendant")).toMatch(/-row-1$/);
    fireEvent.keyDown(grid, { key: " " });
    expect(onToggle).toHaveBeenCalledWith("photo-0");

    const scroll = container.querySelector<HTMLElement>(".photo-scroll");
    expect(scroll).not.toBeNull();
    if (scroll instanceof HTMLElement) scroll.scrollTop = 320;
    rerender(<PhotoTable {...props} resetKey="filtered" />);
    expect(scroll?.scrollTop).toBe(0);
    expect(grid.getAttribute("aria-activedescendant")).toMatch(/-row-1$/);
  });
});
