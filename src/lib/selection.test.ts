import { describe, expect, it } from "vitest";
import { invertIds, selectIds, selectionCounts, toggleSelection } from "./selection";

describe("selection model", () => {
  it("toggles individual ids without mutating the original set", () => {
    const original = new Set(["a"]);
    const added = toggleSelection(original, "b");
    expect([...original]).toEqual(["a"]);
    expect([...added]).toEqual(["a", "b"]);
    expect([...toggleSelection(added, "a")]).toEqual(["b"]);
  });

  it("selects and inverts only visible ids while preserving hidden selection", () => {
    const selected = new Set(["outside", "a", "b"]);
    expect([...selectIds(selected, ["b", "c"])]).toEqual(["outside", "a", "b", "c"]);
    expect([...invertIds(selected, ["a", "b", "c"])]).toEqual(["outside", "c"]);
  });

  it("keeps selection when the visible result changes", () => {
    const selected = new Set(["kept", "hidden"]);
    const firstView = selectionCounts(selected, ["kept", "hidden"]);
    expect(firstView.selected).toBe(2);
    expect(firstView.allVisibleSelected).toBe(true);

    const secondView = selectionCounts(selected, ["kept"]);
    expect(secondView.selected).toBe(2);
    expect(secondView.visibleSelected).toBe(1);
    expect(secondView.allVisibleSelected).toBe(true);
    expect(selected.has("hidden")).toBe(true);
  });

  it("calculates partial and empty states", () => {
    const partial = selectionCounts(new Set(["a"]), ["a", "b"]);
    expect(partial).toMatchObject({
      visibleSelected: 1,
      visibleTotal: 2,
      allVisibleSelected: false,
      someVisibleSelected: true,
    });
    const empty = selectionCounts(new Set(), []);
    expect(empty.allVisibleSelected).toBe(false);
    expect(empty.someVisibleSelected).toBe(false);
  });
});
