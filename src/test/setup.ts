import "@testing-library/jest-dom/vitest";

class ResizeObserverMock {
  observe() {
    return undefined;
  }

  unobserve() {
    return undefined;
  }

  disconnect() {
    return undefined;
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverMock,
});

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get() {
    return this.classList?.contains("photo-scroll") ? 470 : 0;
  },
});

Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get() {
    return this.classList?.contains("photo-scroll") ? 960 : 0;
  },
});

Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    if (this.classList?.contains("photo-scroll")) {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 960,
        height: 470,
        right: 960,
        bottom: 470,
        toJSON: () => ({}),
      };
    }
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width: 0,
      height: 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    };
  },
});

Object.defineProperty(Element.prototype, "scrollTo", {
  configurable: true,
  value: () => undefined,
});

Object.defineProperty(window, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
});
