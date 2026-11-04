import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Toast, Toasts, useToasts } from './Toasts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useToasts', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useToasts());
    expect(result.current.toasts).toEqual([]);
  });

  it('adds an info toast by default and dismisses it after 3.2s', () => {
    const { result } = renderHook(() => useToasts());
    act(() => result.current.push('Saved'));
    expect(result.current.toasts).toEqual([{ id: 1, message: 'Saved', tone: 'info' }]);
    act(() => vi.advanceTimersByTime(3199));
    expect(result.current.toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.toasts).toEqual([]);
  });

  it('keeps errors on screen longer (5.2s)', () => {
    const { result } = renderHook(() => useToasts());
    act(() => result.current.push('Broken', 'error'));
    expect(result.current.toasts).toEqual([{ id: 1, message: 'Broken', tone: 'error' }]);
    act(() => vi.advanceTimersByTime(5199));
    expect(result.current.toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.toasts).toEqual([]);
  });

  it('gives every toast its own id and dismisses each one on its own timer', () => {
    const { result } = renderHook(() => useToasts());
    act(() => result.current.push('a'));
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.push('b', 'error'));
    expect(result.current.toasts.map((t) => t.id)).toEqual([1, 2]);
    act(() => vi.advanceTimersByTime(2200)); // a expires at 3200
    expect(result.current.toasts.map((t) => t.message)).toEqual(['b']);
    act(() => vi.advanceTimersByTime(5200 - 2200 - 1));
    expect(result.current.toasts.map((t) => t.message)).toEqual(['b']);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.toasts).toEqual([]);
  });

  it('shows at most three at a time, dropping the oldest', () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      for (const m of ['1', '2', '3', '4', '5']) result.current.push(m);
    });
    expect(result.current.toasts.map((t) => t.message)).toEqual(['3', '4', '5']);
    expect(result.current.toasts.map((t) => t.id)).toEqual([3, 4, 5]);
    act(() => vi.advanceTimersByTime(3200));
    expect(result.current.toasts).toEqual([]);
  });

  it('push is stable across renders', () => {
    const { result, rerender } = renderHook(() => useToasts());
    const first = result.current.push;
    act(() => result.current.push('x'));
    rerender();
    expect(result.current.push).toBe(first);
  });
});

describe('Toasts', () => {
  it('renders a polite live region with one element per toast', () => {
    const toasts: Toast[] = [
      { id: 1, message: 'Saved', tone: 'info' },
      { id: 2, message: 'Broken link', tone: 'error' },
    ];
    const { container } = render(<Toasts toasts={toasts} />);
    const region = container.querySelector('.toasts')!;
    expect(region).toHaveAttribute('aria-live', 'polite');
    const items = region.querySelectorAll('.toast');
    expect(items).toHaveLength(2);
    expect(items[0].className).toBe('toast');
    expect(items[0]).toHaveTextContent('Saved');
    expect(items[0].querySelector('svg')).toHaveClass('lucide-circle-check');
    expect(items[1].className).toBe('toast is-error');
    expect(items[1]).toHaveTextContent('Broken link');
    expect(items[1].querySelector('svg')).toHaveClass('lucide-circle-alert');
  });

  it('renders an empty region with no toasts', () => {
    const { container } = render(<Toasts toasts={[]} />);
    expect(container.querySelector('.toasts')).toBeEmptyDOMElement();
  });

  it('works end to end with the hook', () => {
    function App() {
      const { toasts, push } = useToasts();
      return (
        <>
          <button onClick={() => push('Copied')}>go</button>
          <Toasts toasts={toasts} />
        </>
      );
    }
    render(<App />);
    act(() => screen.getByText('go').click());
    expect(screen.getByText('Copied')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3200));
    expect(screen.queryByText('Copied')).toBeNull();
  });
});
