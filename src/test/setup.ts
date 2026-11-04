/**
 * Test environment: jsdom plus the browser APIs it lacks and the app relies on.
 * Loaded for every test file (see `test.setupFiles` in vite.config.ts).
 */
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The full suite runs ~30 files in parallel; under that load 1s waits are too tight.
configure({ asyncUtilTimeout: 3000 });

if (typeof window !== 'undefined') {
  // React Flow measures its container and nodes.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? +scale : 1;
    }
  }
  globalThis.DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;

  // Theme detection.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  // jsdom has no layout; CodeMirror and React Flow ask for rectangles.
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }) as DOMRect;
  Range.prototype.getBoundingClientRect ??= rect;
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });
}
