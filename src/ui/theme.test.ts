import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from './theme';

const KEY = 'attacktree:theme';
const QUERY = '(prefers-color-scheme: dark)';

/** A controllable prefers-color-scheme media query. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mq = {
    get matches() {
      return dark;
    },
    media: QUERY,
    addEventListener: vi.fn((type: string, fn: (e: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (e: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(fn);
    }),
  };
  const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => {
    expect(q).toBe(QUERY);
    return mq as unknown as MediaQueryList;
  });
  return {
    mq,
    matchMedia,
    listeners,
    set(next: boolean) {
      dark = next;
      act(() => {
        for (const fn of [...listeners]) fn({ matches: next } as MediaQueryListEvent);
      });
    },
  };
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('useTheme', () => {
  it('starts from a light system theme when nothing is stored', () => {
    fakeSystem(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('starts from a dark system theme when nothing is stored', () => {
    fakeSystem(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it.each(['light', 'dark'] as const)('a stored "%s" wins over the system', (stored) => {
    fakeSystem(stored === 'light');
    localStorage.setItem(KEY, stored);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe(stored);
    expect(document.documentElement.dataset.theme).toBe(stored);
  });

  it.each(['system', 'blue', ''])('a stored %j means follow the system', (stored) => {
    fakeSystem(true);
    localStorage.setItem(KEY, stored);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('dark');
  });

  it('toggle flips light and dark, persists the choice and updates the document', () => {
    fakeSystem(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.resolved).toBe('dark');
    expect(localStorage.getItem(KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    act(() => result.current.toggle());
    expect(result.current.resolved).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('the remembered choice survives a reload', () => {
    fakeSystem(false);
    const first = renderHook(() => useTheme());
    act(() => first.result.current.toggle());
    first.unmount();
    const second = renderHook(() => useTheme());
    expect(second.result.current.resolved).toBe('dark');
  });

  it('follows live system changes until the user picks, then ignores them', () => {
    const system = fakeSystem(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('light');
    system.set(true);
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    system.set(false);
    expect(result.current.resolved).toBe('light');

    act(() => result.current.toggle()); // user picks dark
    expect(result.current.resolved).toBe('dark');
    system.set(true);
    system.set(false);
    expect(result.current.resolved).toBe('dark');
  });

  it('toggling flips what is shown, including a theme that came from the system', () => {
    const system = fakeSystem(false);
    const { result } = renderHook(() => useTheme());
    system.set(true);
    act(() => result.current.toggle());
    expect(result.current.resolved).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('light');
  });

  it('stops listening to the system on unmount', () => {
    const system = fakeSystem(false);
    const { unmount } = renderHook(() => useTheme());
    expect(system.listeners.size).toBe(1);
    const added = system.mq.addEventListener.mock.calls[0][1];
    unmount();
    expect(system.listeners.size).toBe(0);
    expect(system.mq.removeEventListener).toHaveBeenCalledWith('change', added);
  });

  it('tolerates storage that throws (private mode)', () => {
    fakeSystem(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('dark');
    expect(() => act(() => result.current.toggle())).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(KEY, 'light');
    expect(result.current.resolved).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
