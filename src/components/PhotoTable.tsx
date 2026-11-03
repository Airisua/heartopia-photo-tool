import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Image as ImageIcon,
  LoaderCircle,
  SkipForward,
} from "lucide-react";
import type { PhotoStatus, PhotoView } from "../lib/types";
import { STATUS_LABEL } from "../lib/types";
import { formatBytes, formatPhotoTime } from "../lib/format";
import { safeFileName, safeRelativePath } from "../lib/privacy";
import { loadThumbnail, peekThumbnail, releaseThumbnail } from "../lib/thumbnailCache";

interface PhotoTableProps {
  photos: PhotoView[];
  selected: ReadonlySet<string>;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  resetKey: string;
  busy?: boolean;
  emptyState?: ReactNode;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

function StatusGlyph({ status }: { status: PhotoStatus }) {
  if (status === "success") return <Check size={12} />;
  if (status === "failed") return <AlertTriangle size={12} />;
  if (status === "skipped") return <SkipForward size={12} />;
  if (status === "pending") return <CircleDashed size={12} />;
  return <CircleDashed size={12} />;
}

function PhotoThumb({ id, name }: { id: string; name: string }) {
  const initial = peekThumbnail(id);
  const [src, setSrc] = useState<string | null>(initial ?? null);
  const [loading, setLoading] = useState(initial === undefined);

  useEffect(() => {
    let active = true;
    const cached = peekThumbnail(id);
    if (cached !== undefined) {
      setSrc(cached);
      setLoading(false);
      return () => {
        active = false;
        releaseThumbnail(id);
      };
    }
    setLoading(true);
    loadThumbnail(id)
      .then((result) => {
        if (active) setSrc(result);
      })
      .catch(() => {
        if (active) setSrc(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      releaseThumbnail(id);
    };
  }, [id]);

  return (
    <span className={`photo-thumb ${loading ? "is-loading" : ""}`} aria-hidden="true">
      {src ? (
        <img src={src} alt="" loading="lazy" draggable={false} />
      ) : loading ? (
        <span className="thumb-skeleton" />
      ) : (
        <ImageIcon size={18} />
      )}
      <span className="thumb-corner" aria-hidden="true">
        {formatExtension(name)}
      </span>
    </span>
  );
}

function formatExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toUpperCase().slice(0, 4) : "IMG";
}

export function PhotoTable({
  photos,
  selected,
  allVisibleSelected,
  someVisibleSelected,
  resetKey,
  busy = false,
  emptyState = null,
  onToggle,
  onToggleAll,
}: PhotoTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const domId = useId().replace(/:/g, "");
  const rowId = (index: number) => `photo-grid-${domId}-row-${index + 1}`;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  const rowVirtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 7,
    getItemKey: (index) => photos[index]?.id ?? index,
    initialRect: { width: 960, height: 470 },
  });

  useEffect(() => {
    setActiveIndex(0);
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
    rowVirtualizer.scrollToOffset(0);
  }, [resetKey]);

  useEffect(() => {
    if (photos.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((current) => Math.min(current, photos.length - 1));
  }, [photos.length]);

  const safeActiveIndex =
    photos.length === 0 ? 0 : Math.min(activeIndex, photos.length - 1);

  const moveActive = useCallback(
    (next: number) => {
      if (photos.length === 0) return;
      const bounded = Math.max(0, Math.min(next, photos.length - 1));
      setActiveIndex(bounded);
      rowVirtualizer.scrollToIndex(bounded, { align: "auto" });
      gridRef.current?.focus({ preventScroll: true });
    },
    [photos.length, rowVirtualizer],
  );

  const handleGridKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (photos.length === 0) return;
      const target = event.target as HTMLElement;
      const rowCheckbox =
        target instanceof HTMLInputElement &&
        target.type === "checkbox" &&
        !target.closest(".photo-grid-header");
      if (event.key === " " && target instanceof HTMLInputElement) {
        // Native checkbox activation handles Space for both header and row boxes.
        return;
      }

      const fromHeader = Boolean(target.closest(".photo-grid-header"));
      const base = fromHeader ? -1 : safeActiveIndex;
      const pageSize = Math.max(
        1,
        Math.floor((scrollRef.current?.clientHeight ?? 420) / 60) - 1,
      );
      let next: number | null = null;
      switch (event.key) {
        case "ArrowDown":
          next = base + 1;
          break;
        case "ArrowUp":
          next = Math.max(0, base - 1);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = photos.length - 1;
          break;
        case "PageDown":
          next = base + pageSize;
          break;
        case "PageUp":
          next = base - pageSize;
          break;
        case " ": {
          if (busy) return;
          const photo = photos[safeActiveIndex];
          if (!photo) return;
          event.preventDefault();
          onToggle(photo.id);
          return;
        }
        default:
          return;
      }

      event.preventDefault();
      if (rowCheckbox) gridRef.current?.focus({ preventScroll: true });
      moveActive(next);
    },
    [busy, moveActive, onToggle, photos, safeActiveIndex],
  );

  return (
    <div
      className="photo-table"
      role="grid"
      aria-label="图片列表"
      aria-description="使用上下方向键浏览全部图片，Home 和 End 跳到首尾，Page Up 和 Page Down 翻页，空格选择当前行。"
      aria-rowcount={photos.length + 1}
      aria-colcount={6}
      aria-multiselectable="true"
      aria-activedescendant={photos.length > 0 ? rowId(safeActiveIndex) : undefined}
      tabIndex={photos.length > 0 ? 0 : -1}
      ref={gridRef}
      onKeyDown={handleGridKeyDown}
    >
      <div className="photo-grid photo-grid-header" role="row" aria-rowindex={1}>
        <div className="check-cell" role="columnheader">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allVisibleSelected}
            onChange={onToggleAll}
            disabled={busy || photos.length === 0}
            aria-label="选择当前筛选结果中的全部照片"
          />
        </div>
        <div role="columnheader">文件</div>
        <div role="columnheader">拍摄时间</div>
        <div role="columnheader">大小</div>
        <div role="columnheader">日期来源</div>
        <div role="columnheader">状态</div>
      </div>

      {photos.length === 0 ? (
        <div className="photo-table-empty">{emptyState}</div>
      ) : (
        <div className="photo-scroll" ref={scrollRef}>
          <div className="photo-virtual" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const photo = photos[virtualRow.index];
              if (!photo) return null;
              const checked = selected.has(photo.id);
              const active = virtualRow.index === safeActiveIndex;
              return (
                <div
                  key={photo.id}
                  id={rowId(virtualRow.index)}
                  className={`photo-grid photo-row ${checked ? "is-selected" : ""} ${active ? "is-active" : ""} status-${photo.status}`}
                  role="row"
                  aria-rowindex={virtualRow.index + 2}
                  aria-selected={checked}
                  data-photo-id={photo.id}
                  data-row-index={virtualRow.index}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div className="check-cell" role="gridcell">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(photo.id)}
                      onFocus={() => setActiveIndex(virtualRow.index)}
                      tabIndex={-1}
                      disabled={busy}
                      aria-label={`第 ${virtualRow.index + 1} 行，选择 ${safeFileName(photo.name)}（${safeRelativePath(photo.relativePath)}）`}
                    />
                  </div>
                  <div className="file-cell" role="gridcell">
                    <PhotoThumb id={photo.id} name={photo.name} />
                    <span className="file-copy">
                      <span className="file-name" title={safeFileName(photo.name)}>
                        {safeFileName(photo.name)}
                      </span>
                      <span className="file-path" title={safeRelativePath(photo.relativePath)}>
                        {safeRelativePath(photo.relativePath)}
                      </span>
                    </span>
                  </div>
                  <div className="time-cell" role="gridcell">
                    <span>{formatPhotoTime(photo.timestampMs, photo.date)}</span>
                    <span className="mobile-size">{formatBytes(photo.size)}</span>
                  </div>
                  <div className="size-cell" role="gridcell">
                    {formatBytes(photo.size)}
                  </div>
                  <div className="source-cell" role="gridcell">
                    <span className={`source-badge ${photo.dateSource}`}>
                      {photo.dateSource === "filetime" ? "文件名时间" : "修改时间"}
                    </span>
                  </div>
                  <div className="status-cell" role="gridcell">
                    <span className={`status-chip ${photo.status}`}>
                      {photo.status === "pending" && busy ? (
                        <LoaderCircle size={12} className="spin" />
                      ) : (
                        <StatusGlyph status={photo.status} />
                      )}
                      {STATUS_LABEL[photo.status]}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
