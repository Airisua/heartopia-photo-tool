export type SelectionSet = ReadonlySet<string>;

export interface SelectionCounts {
  selected: number;
  visibleSelected: number;
  visibleTotal: number;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
}

export function toggleSelection(current: SelectionSet, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectIds(current: SelectionSet, ids: Iterable<string>): Set<string> {
  const next = new Set(current);
  for (const id of ids) next.add(id);
  return next;
}

export function invertIds(current: SelectionSet, ids: Iterable<string>): Set<string> {
  const next = new Set(current);
  for (const id of ids) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

export function selectionCounts(
  current: SelectionSet,
  visibleIds: Iterable<string>,
): SelectionCounts {
  let visibleTotal = 0;
  let visibleSelected = 0;
  for (const id of visibleIds) {
    visibleTotal += 1;
    if (current.has(id)) visibleSelected += 1;
  }
  return {
    selected: current.size,
    visibleSelected,
    visibleTotal,
    allVisibleSelected: visibleTotal > 0 && visibleSelected === visibleTotal,
    someVisibleSelected: visibleSelected > 0 && visibleSelected < visibleTotal,
  };
}
