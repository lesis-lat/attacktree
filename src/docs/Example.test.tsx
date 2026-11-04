/// <reference types="node" />
import { Blob as NodeBlob } from 'node:buffer';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as exporters from '../export/exporters';
import { decodeShare } from '../model/share';
import * as share from '../model/share';
import { Example } from './Example';

// The real layout engine, in-process instead of in a worker.
vi.mock('elkjs/lib/elk-api.js', async () => ({ default: (await import('elkjs/lib/elk.bundled.js')).default }));
// no worker url: elk.bundled then uses its built-in fake worker
vi.mock('elkjs/lib/elk-worker.min.js?url', () => ({ default: undefined }));
vi.mock('../export/exporters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/exporters')>();
  return { ...actual, renderSvg: vi.fn(actual.renderSvg), copyText: vi.fn(actual.copyText) };
});
vi.mock('../layout/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../layout/layout')>();
  return {
    ...actual,
    computeLayout: vi.fn((...args: Parameters<typeof actual.computeLayout>) => {
      const p = actual.computeLayout(...args);
      inFlight.add(p);
      return p;
    }),
  };
});
vi.mock('../model/share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model/share')>();
  return { ...actual, encodeShare: vi.fn(actual.encodeShare) };
});

const SOURCE = `title: Phishing in short
attacks:
- phish: Phish a maintainer
  from:
  - reality
mitigations:
- mfa: Hardware keys
  from:
  - phish
goals:
- release: Ship a malicious release
  from:
  - phish
`;

/** Layouts started by a test; it waits for them so their renders never leak into the next test. */
const inFlight = vi.hoisted(() => new Set<Promise<unknown>>());
const tick = () => new Promise((r) => setTimeout(r, 0));

const renderSvg = vi.mocked(exporters.renderSvg);
const copyText = vi.mocked(exporters.copyText);
const encodeShare = vi.mocked(share.encodeShare);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const openLink = () => screen.getByRole('link', { name: /Open in the editor/ });

beforeEach(() => {
  // jsdom's Blob has no stream(); share links need it
  vi.stubGlobal('Blob', NodeBlob);
  // jsdom has no canvas; measuring falls back to an estimate
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(async () => {
  await tick();
  await Promise.allSettled([...inFlight]);
  await tick();
  inFlight.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  renderSvg.mockReset();
  copyText.mockReset();
  encodeShare.mockReset();
});

describe('Example', () => {
  it('shows the highlighted YAML without the trailing newline', () => {
    const { container } = render(<Example source={SOURCE} theme="light" />);
    const code = container.querySelector('.example-code pre code')!;
    expect(code.textContent).toBe(SOURCE.trimEnd() + '\n');
    expect(code.querySelector('.y-key')).toHaveTextContent('title');
    expect([...code.querySelectorAll('.y-key')].map((k) => k.textContent)).toEqual([
      'title',
      'attacks',
      'phish',
      'from',
      'mitigations',
      'mfa',
      'from',
      'goals',
      'release',
      'from',
    ]);
  });

  it('captions the diagram with the title', () => {
    const { container } = render(<Example source={SOURCE} theme="light" />);
    expect(container.querySelector('.example-diagram')).toHaveAttribute('aria-label', 'Diagram: Phishing in short');
    expect(container.querySelector('figcaption .example-title')).toHaveTextContent('Phishing in short');
  });

  it('has a plain label and no caption title when the tree has no title', () => {
    const { container } = render(<Example source={'attacks:\n- a: A\n'} theme="light" />);
    expect(container.querySelector('.example-diagram')).toHaveAttribute('aria-label', 'Diagram');
    expect(container.querySelector('.example-title')).toBeNull();
  });

  it('shows a placeholder, then the diagram drawn by the real layout engine', async () => {
    const { container } = render(<Example source={SOURCE} theme="light" />);
    expect(container.querySelector('.example-loading')).not.toBeNull();
    await waitFor(() => expect(container.querySelector('.example-svg svg')).not.toBeNull(), { timeout: 5000 });
    expect(container.querySelector('.example-loading')).toBeNull();
    const svg = container.querySelector('.example-svg svg')!;
    const text = svg.textContent!;
    for (const label of ['Reality', 'Phish a maintainer', 'Hardware keys', 'Ship a malicious release']) expect(text).toContain(label);
    // no title, font or credit inside the docs diagram: the page already has them
    expect(text).not.toContain('Phishing in short');
    expect(svg.innerHTML).not.toContain('@font-face');
    expect(renderSvg).toHaveBeenCalledTimes(1);
    const [tree, layout, source, opts] = renderSvg.mock.calls[0];
    expect(tree.title).toBe('Phishing in short');
    expect(layout.nodes.size).toBe(4);
    expect(source).toBeNull();
    expect(opts).toMatchObject({ embedFont: false, showTitle: false, credit: false });
    expect(opts!.idPrefix).toMatch(/^ex[a-z0-9]+$/i);
  });

  it('gives each diagram its own id prefix, so markers of two diagrams on one page never collide', async () => {
    const { container } = render(
      <>
        <Example source={SOURCE} theme="light" />
        <Example source={SOURCE} theme="light" />
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll('.example-svg svg')).toHaveLength(2), { timeout: 5000 });
    const prefixes = renderSvg.mock.calls.map((c) => c[3]!.idPrefix);
    expect(new Set(prefixes).size).toBe(2);
    const ids = [...container.querySelectorAll('.example-svg [id]')].map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('draws again when the theme changes', async () => {
    const { container, rerender } = render(<Example source={SOURCE} theme="light" />);
    await waitFor(() => expect(container.querySelector('.example-svg svg')).not.toBeNull(), { timeout: 5000 });
    rerender(<Example source={SOURCE} theme="dark" />);
    await waitFor(() => expect(renderSvg).toHaveBeenCalledTimes(2), { timeout: 5000 });
  });

  it('honors pinned positions from the YAML', async () => {
    const src = SOURCE + 'positions:\n  phish: [400, 300]\n';
    const { container } = render(<Example source={src} theme="light" />);
    await waitFor(() => expect(container.querySelector('.example-svg svg')).not.toBeNull(), { timeout: 5000 });
    const layout = renderSvg.mock.calls[0][1];
    const phish = layout.nodes.get('phish')!;
    expect([phish.x, phish.y]).toEqual([400, 300]);
  });

  it('keeps only the latest diagram when the source changes before the first one finishes', async () => {
    const first = deferred<{ svg: string; width: number; height: number }>();
    renderSvg.mockImplementationOnce(() => first.promise);
    renderSvg.mockImplementationOnce(async () => ({ svg: '<svg data-v="second"></svg>', width: 1, height: 1 }));
    const { container, rerender } = render(<Example source={SOURCE} theme="light" />);
    await waitFor(() => expect(renderSvg).toHaveBeenCalledTimes(1), { timeout: 5000 });
    rerender(<Example source={SOURCE.replace('Hardware keys', 'Passkeys')} theme="light" />);
    await waitFor(() => expect(container.querySelector('svg[data-v="second"]')).not.toBeNull(), { timeout: 5000 });
    await act(async () => first.resolve({ svg: '<svg data-v="first"></svg>', width: 1, height: 1 }));
    expect(container.querySelector('svg[data-v="first"]')).toBeNull();
    expect(container.querySelector('svg[data-v="second"]')).not.toBeNull();
  });

  it('logs a failed render and keeps the placeholder', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('layout failed');
    renderSvg.mockImplementationOnce(async () => {
      throw boom;
    });
    const { container } = render(<Example source={SOURCE} theme="light" />);
    await waitFor(() => expect(error).toHaveBeenCalledWith(boom), { timeout: 5000 });
    expect(container.querySelector('.example-loading')).not.toBeNull();
  });

  it('does not update after unmounting', async () => {
    const error = vi.spyOn(console, 'error');
    const pending = deferred<{ svg: string; width: number; height: number }>();
    renderSvg.mockImplementationOnce(() => pending.promise);
    const { unmount } = render(<Example source={SOURCE} theme="light" />);
    await waitFor(() => expect(renderSvg).toHaveBeenCalledTimes(1), { timeout: 5000 });
    unmount();
    await act(async () => pending.resolve({ svg: '<svg></svg>', width: 1, height: 1 }));
    expect(error).not.toHaveBeenCalled();
  });
});

describe('Example: open in the editor', () => {
  it('links to the editor with the whole tree in a share link that decodes back to the source', async () => {
    render(<Example source={SOURCE} theme="light" />);
    expect(openLink()).toHaveAttribute('target', '_blank');
    expect(openLink()).toHaveAttribute('rel', 'noopener');
    await waitFor(() => expect(openLink().getAttribute('href')).toMatch(/^\/#tree=[A-Za-z0-9_-]+$/));
    const href = openLink().getAttribute('href')!;
    expect(await decodeShare(href.slice(href.indexOf('#')))).toBe(SOURCE);
  });

  it('points at the editor under the base path the site is served from', async () => {
    vi.stubEnv('BASE_URL', '/attacktree/');
    render(<Example source={SOURCE} theme="light" />);
    await waitFor(() => expect(openLink().getAttribute('href')).toMatch(/^\/attacktree\/#tree=[A-Za-z0-9_-]+$/));
  });

  it('starts at the editor itself until the link is ready', () => {
    vi.stubEnv('BASE_URL', '/attacktree/');
    encodeShare.mockImplementationOnce(() => new Promise(() => {}));
    render(<Example source={SOURCE} theme="light" />);
    expect(openLink()).toHaveAttribute('href', '/attacktree/');
  });

  it('a slow link for an older source never replaces the link for the current one', async () => {
    const slow = deferred<string>();
    encodeShare.mockImplementationOnce(() => slow.promise);
    encodeShare.mockImplementationOnce(async () => '#tree=new');
    const { rerender } = render(<Example source={SOURCE} theme="light" />);
    rerender(<Example source={SOURCE + '# edited\n'} theme="light" />);
    await waitFor(() => expect(openLink()).toHaveAttribute('href', '/#tree=new'));
    await act(async () => slow.resolve('#tree=old'));
    expect(openLink()).toHaveAttribute('href', '/#tree=new');
  });
});

describe('Example: copy', () => {
  it('copies the YAML and confirms with a check mark for a moment', async () => {
    copyText.mockResolvedValueOnce(true);
    const { container } = render(<Example source={SOURCE} theme="light" />);
    const button = container.querySelector('button.code-copy')!;
    expect(button).toHaveAttribute('title', 'Copy YAML');
    expect(button.querySelector('svg')).toHaveClass('lucide-copy');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await act(async () => {
        fireEvent.click(button);
      });
      expect(copyText).toHaveBeenCalledWith(SOURCE);
      expect(button.querySelector('svg')).toHaveClass('lucide-check');
      act(() => vi.advanceTimersByTime(1399));
      expect(button.querySelector('svg')).toHaveClass('lucide-check');
      act(() => vi.advanceTimersByTime(1));
      expect(button.querySelector('svg')).toHaveClass('lucide-copy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no confirmation when copying fails', async () => {
    // jsdom has neither the clipboard API nor execCommand: the real copyText reports failure
    const { container } = render(<Example source={SOURCE} theme="light" />);
    const button = container.querySelector('button.code-copy')!;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(copyText).toHaveBeenCalledWith(SOURCE);
    await expect(copyText.mock.results[0].value).resolves.toBe(false);
    expect(button.querySelector('svg')).toHaveClass('lucide-copy');
  });
});
