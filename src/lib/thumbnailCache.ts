import { getThumbnail } from "./api";

const MAX_CACHE_ENTRIES = 320;
export const THUMBNAIL_MAX_IN_FLIGHT = 4;
export const THUMBNAIL_MAX_QUEUED = 64;

interface ThumbnailRequest {
  id: string;
  generation: number;
  started: boolean;
  resolve: (value: string | null) => void;
  promise: Promise<string | null>;
}

export interface ThumbnailCacheState {
  cacheEntries: number;
  pending: number;
  queued: number;
  active: number;
  generation: number;
}

const cache = new Map<string, string | null>();
const pendingById = new Map<string, ThumbnailRequest>();
const queue: ThumbnailRequest[] = [];
let activeRequests = 0;
let generation = 0;

function trimCache(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function isSafeImageData(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

function pump(): void {
  while (activeRequests < THUMBNAIL_MAX_IN_FLIGHT && queue.length > 0) {
    const request = queue.shift();
    if (!request) return;
    request.started = true;
    activeRequests += 1;
    const requestGeneration = request.generation;
    getThumbnail(request.id)
      .then((data) => {
        const safe = isSafeImageData(data) ? data : null;
        if (requestGeneration === generation) {
          cache.set(request.id, safe);
          trimCache();
        }
        request.resolve(requestGeneration === generation ? safe : null);
      })
      .catch(() => {
        if (requestGeneration === generation) {
          // Cache the negative result so a failed thumbnail does not hammer the
          // native command every time a row scrolls back into view.
          cache.set(request.id, null);
          trimCache();
        }
        request.resolve(null);
      })
      .finally(() => {
        activeRequests -= 1;
        if (pendingById.get(request.id) === request) {
          pendingById.delete(request.id);
        }
        pump();
      });
  }
}

function dropQueued(request: ThumbnailRequest): void {
  const index = queue.indexOf(request);
  if (index >= 0) queue.splice(index, 1);
  if (pendingById.get(request.id) === request) {
    pendingById.delete(request.id);
  }
  request.resolve(null);
}

export function loadThumbnail(id: string): Promise<string | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  const pending = pendingById.get(id);
  if (pending) return pending.promise;

  if (queue.length >= THUMBNAIL_MAX_QUEUED) {
    const oldestQueued = queue[0];
    if (oldestQueued) dropQueued(oldestQueued);
  }

  let resolveRequest: (value: string | null) => void = () => undefined;
  const promise = new Promise<string | null>((resolve) => {
    resolveRequest = resolve;
  });
  const request: ThumbnailRequest = {
    id,
    generation,
    started: false,
    resolve: resolveRequest,
    promise,
  };
  pendingById.set(id, request);
  queue.push(request);
  pump();
  return promise;
}

/** Cancels a not-yet-started load when a virtual row leaves the viewport. */
export function releaseThumbnail(id: string): void {
  const request = pendingById.get(id);
  if (!request || request.started) return;
  dropQueued(request);
}

export function peekThumbnail(id: string): string | null | undefined {
  return cache.get(id);
}

export function clearThumbnailCache(): void {
  generation += 1;
  cache.clear();
  const requests = new Set<ThumbnailRequest>([...queue, ...pendingById.values()]);
  queue.length = 0;
  pendingById.clear();
  for (const request of requests) request.resolve(null);
}

export function thumbnailCacheState(): ThumbnailCacheState {
  return {
    cacheEntries: cache.size,
    pending: pendingById.size,
    queued: queue.length,
    active: activeRequests,
    generation,
  };
}
