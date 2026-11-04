import { act, waitFor } from '@testing-library/react';
import { isValidElement, type ReactElement, StrictMode } from 'react';
import type { Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => [] as Array<{ container: Element; root: Root; render: ReturnType<typeof vi.fn> }>);

vi.mock('./DocsApp', () => ({ DocsApp: () => <p>the docs app</p> }));
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  return {
    ...actual,
    createRoot: (container: Element) => {
      const root = actual.createRoot(container);
      const render = vi.fn(root.render.bind(root));
      root.render = render;
      roots.push({ container, root, render });
      return root;
    },
  };
});

describe('docs entry point', () => {
  it('mounts DocsApp in StrictMode into #root', async () => {
    const container = document.createElement('div');
    container.id = 'root';
    document.body.appendChild(container);
    const { DocsApp } = await import('./DocsApp');
    await import('./main');

    expect(roots).toHaveLength(1);
    expect(roots[0].container).toBe(container);
    expect(roots[0].render).toHaveBeenCalledTimes(1);
    const tree = roots[0].render.mock.calls[0][0] as ReactElement<{ children: ReactElement }>;
    expect(tree.type).toBe(StrictMode);
    expect(isValidElement(tree.props.children)).toBe(true);
    expect(tree.props.children.type).toBe(DocsApp);
    await waitFor(() => expect(container).toHaveTextContent('the docs app'));

    act(() => roots[0].root.unmount());
    container.remove();
  });
});
