import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Layout, PlacedEdge, PlacedNode } from '../layout/layout';
import { METRICS } from '../layout/measure';
import { extractEmbedded, readTreeFile } from '../model/embed';
import { parseTree } from '../model/parse';
import type { Tree } from '../model/types';

type Exporters = typeof import('./exporters');

/** Vitest stubs CSS imports, so read the stylesheet from disk (node types are not part of the app build). */
async function readSource(path: string): Promise<string> {
  const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(p: URL, enc: 'utf8'): string };
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** jsdom's Blob has no arrayBuffer() */
function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** what readTreeFile needs from a File */
function asFile(name: string, bytes: Uint8Array): File {
  return { name, type: '', arrayBuffer: async () => bytes.buffer, text: async () => new TextDecoder().decode(bytes) } as unknown as File;
}

/** a fresh module: it caches the embedded font and the logo */
async function load(): Promise<Exporters> {
  vi.resetModules();
  return import('./exporters');
}

const SOURCE = `title: 'Tags <b> & "quotes" — ünïcødé ✓'
facts:
- leak: 'Keys in a <public> gist & "more"'
  from:
  - reality: '#yolosec'
attacks:
- login: Log in with the keys
  from:
  - leak: 'if <they> & "work"'
  - mfa:
    backwards: true
mitigations:
- mfa: MFA
  from:
  - login:
    implemented: false
goals:
- win: Win
  from:
  - login
  - phantom
`;

const node = (id: string, x: number, y: number, lines: string[], width = 140, height = 58): PlacedNode => ({ id, x, y, width, height, lines });
const label = (x: number, y: number, lines: string[]) => ({ x, y, width: 80, height: 20, lines });

/** a hand-made layout, so every coordinate in the SVG can be checked */
function fixture(): { tree: Tree; layout: Layout } {
  const tree = parseTree(SOURCE);
  const nodes = new Map<string, PlacedNode>([
    ['reality', node('reality', 100, 48, ['Reality'], 96, 36)],
    ['leak', node('leak', 80, 140, ['Keys in a <public> gist', '& "more"'], 180, 76)],
    ['login', node('login', 100, 280, ['Log in with the keys'])],
    ['mfa', node('mfa', 300, 400, ['MFA'])],
    ['win', node('win', 100, 520, ['Win'])],
    ['phantom', node('phantom', 300, 520, ['Phantom'])],
  ]);
  const edges = new Map<string, PlacedEdge>([
    ['leak:0', { id: 'leak:0', path: 'M148,84 L148,140', label: label(148, 110, ['#yolosec']) }],
    ['login:0', { id: 'login:0', path: 'M170,216 L170,280', label: label(170, 250, ['if <they> &', '"work"']) }],
    ['login:1', { id: 'login:1', path: 'M370,400 L170,338' }],
    ['mfa:0', { id: 'mfa:0', path: 'M170,338 L370,400' }],
    ['win:0', { id: 'win:0', path: 'M170,338 L170,520' }],
    ['win:1', { id: 'win:1', path: 'M370,578 L170,520' }],
  ]);
  return { tree, layout: { key: 'k', nodes, edges, bounds: { x: 0, y: 0, width: 488, height: 626 } } };
}

const parse = (svg: string) => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  expect(doc.documentElement.tagName).toBe('svg');
  return doc;
};
const texts = (doc: Document) => [...doc.querySelectorAll('text')].map((t) => t.textContent);

/** tokens resolve to "<name>" so the SVG shows which token each color came from */
function fakeTokens(empty: string[] = []) {
  const asked = new Set<string>();
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) => {
          asked.add(name);
          return empty.includes(name) ? '' : ` ${name.slice(2)} `;
        },
      }) as CSSStyleDeclaration,
  );
  return asked;
}

const FONT_DATA = 'data:font/woff2;base64,AAAA';
const LOGO_DATA = 'data:image/png;base64,iVBORw0KGgo=';

/** fetch for the font files and logos; dataUrl() reads them back with FileReader */
function fakeFetch(fail: (url: string) => boolean = () => false) {
  const fetch = vi.fn(async (url: string) => {
    if (fail(url)) throw new TypeError('Failed to fetch');
    const isFont = url.includes('woff2');
    return { blob: async () => new Blob([isFont ? 'font' : 'png'], { type: isFont ? 'font/woff2' : 'image/png' }) };
  });
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader, blob: Blob) {
    Object.defineProperty(this, 'result', { value: blob.type === 'image/png' ? LOGO_DATA : FONT_DATA, configurable: true });
    queueMicrotask(() => this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>));
  });
  return fetch;
}

/** jsdom has no object URLs */
function stubObjectUrls(url: string) {
  const create = vi.fn((_: Blob | MediaSource) => url);
  const revoke = vi.fn((_: string) => {});
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  onTestFinished(() => {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  });
  return { create, revoke };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete document.documentElement.dataset.theme;
});

describe('renderSvg', () => {
  let ex: Exporters;
  let fetch: ReturnType<typeof fakeFetch>;
  beforeEach(async () => {
    // jsdom has no 2D canvas: text is measured at 7px per character
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    fetch = fakeFetch();
    ex = await load();
  });

  it('produces a well-formed SVG of the right size', async () => {
    const { tree, layout } = fixture();
    const { svg, width, height } = await ex.renderSvg(tree, layout, SOURCE);
    expect(width).toBe(488);
    expect(height).toBe(626 + 52 + 46);
    const doc = parse(svg);
    const root = doc.documentElement;
    expect(root.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(root.getAttribute('width')).toBe(String(width));
    expect(root.getAttribute('height')).toBe(String(height));
    expect(root.getAttribute('viewBox')).toBe(`0 0 ${width} ${height}`);
  });

  it('rounds fractional bounds up', async () => {
    const { tree, layout } = fixture();
    layout.bounds = { x: 0, y: 0, width: 100.2, height: 50.1 };
    const { width, height } = await ex.renderSvg(tree, layout, null, { showTitle: false, credit: false });
    expect([width, height]).toEqual([101, 51]);
  });

  it('escapes every label, the title included', async () => {
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, SOURCE)).svg);
    const all = texts(doc);
    expect(all).toContain('Tags <b> & "quotes" — ünïcødé ✓');
    expect(all).toContain('Keys in a <public> gist');
    expect(all).toContain('& "more"');
    expect(all).toContain('if <they> &');
    expect(all).toContain('"work"');
    expect(doc.querySelector('b')).toBeNull();
    expect(doc.querySelector('public')).toBeNull();
  });

  it('stays well-formed with characters XML does not allow', async () => {
    const { tree, layout } = fixture();
    const bad = 'bell\u0007 nul\u0000 esc\u001b lone\uD800 ok😀';
    tree.title = bad;
    layout.nodes.get('login')!.lines = [bad];
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    expect(texts(doc).filter((t) => t === 'bell nul esc lone ok😀')).toHaveLength(2);
  });

  it('embeds the YAML source so the file can be opened again', async () => {
    const { tree, layout } = fixture();
    const source = `${SOURCE}# a comment with --> and <!-- inside\n`;
    const { svg } = await ex.renderSvg(tree, layout, source);
    expect(svg.trimEnd().endsWith('-->')).toBe(true);
    parse(svg);
    expect(extractEmbedded(svg)).toBe(source);
    const file = asFile('tree.svg', new TextEncoder().encode(svg));
    expect(await readTreeFile(file)).toBe(source);
    expect(parseTree(source).title).toBe(tree.title);
  });

  it('leaves the source out when there is none', async () => {
    const { tree, layout } = fixture();
    const { svg } = await ex.renderSvg(tree, layout, null);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(extractEmbedded(svg)).toBeUndefined();
  });

  it('draws the title above the tree, unless asked not to or there is none', async () => {
    const { tree, layout } = fixture();
    const titled = parse((await ex.renderSvg(tree, layout, null, { credit: false })).svg);
    const title = [...titled.querySelectorAll('text')].find((t) => t.textContent === tree.title)!;
    expect(title.getAttribute('x')).toBe(String(488 / 2));
    expect(title.getAttribute('y')).toBe('34');
    expect(title.getAttribute('text-anchor')).toBe('middle');
    expect(titled.querySelector('g')!.getAttribute('transform')).toBe('translate(0 52)');

    const plain = await ex.renderSvg(tree, layout, null, { showTitle: false, credit: false });
    expect(plain.height).toBe(626);
    const doc = parse(plain.svg);
    expect(texts(doc)).not.toContain(tree.title);
    expect(doc.querySelector('g')!.getAttribute('transform')).toBe('translate(0 0)');

    const untitled = await ex.renderSvg({ ...tree, title: '' }, layout, null, { credit: false });
    expect(untitled.height).toBe(626);
  });

  it('widens a narrow tree so the credit line is not cut off, keeping the tree centered', async () => {
    const { tree, layout } = fixture();
    layout.bounds = { x: 0, y: 0, width: 192, height: 132 };
    const { svg, width } = await ex.renderSvg({ ...tree, title: '' }, layout, null);
    const doc = parse(svg);
    const text = doc.querySelector('a text')!;
    // "MADE WITH ATTACKTREE BY": 23 monospace characters at 9.5px (0.6em) with 0.12em letter-spacing
    const textWidth = 23 * 9.5 * (0.6 + 0.12);
    expect(Number(text.getAttribute('x')) - textWidth).toBeGreaterThanOrEqual(16);
    expect(doc.querySelector('g')!.getAttribute('transform')).toBe(`translate(${(width - 192) / 2} 0)`);
    // without the credit, the image is as wide as the tree
    expect((await ex.renderSvg({ ...tree, title: '' }, layout, null, { credit: false })).width).toBe(192);
  });

  it('widens a narrow tree to fit its title', async () => {
    const { tree, layout } = fixture();
    layout.bounds = { x: 0, y: 0, width: 192, height: 132 };
    const title = 'A rather long title for such a small tree';
    const { svg, width } = await ex.renderSvg({ ...tree, title }, layout, null, { credit: false });
    // 7px per character without a canvas, plus a margin on each side
    expect(width).toBe(title.length * 7 + 48);
    const doc = parse(svg);
    expect(doc.querySelector('text')!.getAttribute('x')).toBe(String(width / 2));
    expect(doc.querySelector('g')!.getAttribute('transform')).toBe(`translate(${(width - 192) / 2} 52)`);
    // the title is measured in its own font
    const fonts: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      set font(f: string) {
        fonts.push(f);
      },
      measureText: (t: string) => ({ width: t.length * 10 }),
    } as unknown as CanvasRenderingContext2D);
    ex = await load();
    expect((await ex.renderSvg({ ...tree, title }, layout, null, { credit: false })).width).toBe(title.length * 10 + 48);
    expect(fonts.at(-1)).toMatch(/^650 17px /);
    // a hidden title takes no room
    expect((await ex.renderSvg({ ...tree, title }, layout, null, { credit: false, showTitle: false })).width).toBe(192);
  });

  it('shifts the drawing by the layout bounds (pinned nodes can go negative)', async () => {
    const { tree, layout } = fixture();
    layout.bounds = { x: -120, y: -30, width: 600, height: 700 };
    const { svg, width, height } = await ex.renderSvg(tree, layout, null, { credit: false });
    expect([width, height]).toEqual([600, 752]);
    expect(parse(svg).querySelector('g')!.getAttribute('transform')).toBe('translate(120 82)');
  });

  it('signs the export with the LESIS logo and a tagged link', async () => {
    const { tree, layout } = fixture();
    const { svg, width, height } = await ex.renderSvg(tree, layout, null);
    const doc = parse(svg);
    const a = doc.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://lesis.lat/?utm_source=attacktree&utm_medium=export');
    expect(a.querySelector('text')!.textContent).toBe('MADE WITH ATTACKTREE BY');
    const image = a.querySelector('image')!;
    expect(image.getAttribute('href')).toBe(LOGO_DATA);
    const logoW = Math.round((24 * 2092) / 703);
    expect(image.getAttribute('width')).toBe(String(logoW));
    expect(image.getAttribute('height')).toBe('24');
    expect(image.getAttribute('x')).toBe(String(width - 20 - logoW));
    expect(image.getAttribute('y')).toBe(String(height - 14 - 24));
    expect(fetch).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}brand/lesis-horizontal-black.png`);
  });

  it('uses the white logo on the dark theme, and fetches each logo once', async () => {
    const { tree, layout } = fixture();
    document.documentElement.dataset.theme = 'dark';
    await ex.renderSvg(tree, layout, null);
    await ex.renderSvg(tree, layout, null);
    const logos = fetch.mock.calls.map(([u]) => u).filter((u) => u.includes('brand/'));
    expect(logos).toEqual([`${import.meta.env.BASE_URL}brand/lesis-horizontal-white.png`]);
  });

  it('points at logo files that exist', () => {
    const files = import.meta.glob('/public/brand/*.png', { query: '?url', import: 'default', eager: true });
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['/public/brand/lesis-horizontal-black.png', '/public/brand/lesis-horizontal-white.png']),
    );
  });

  it('keeps the credit line when the logo cannot be loaded', async () => {
    fetch = fakeFetch((url) => url.endsWith('.png'));
    ex = await load();
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    expect(doc.querySelector('a text')!.textContent).toBe('MADE WITH ATTACKTREE BY');
    expect(doc.querySelector('image')).toBeNull();
  });

  it('can leave the credit out', async () => {
    const { tree, layout } = fixture();
    const { svg, height } = await ex.renderSvg(tree, layout, null, { credit: false });
    expect(height).toBe(626 + 52);
    expect(parse(svg).querySelector('a')).toBeNull();
    expect(fetch.mock.calls.some(([u]) => u.includes('brand/'))).toBe(false);
  });

  it('inlines the fonts once, and works without them', async () => {
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    const css = doc.querySelector('style')!.textContent!;
    expect(css).toContain(`@font-face{font-family:"IBM Plex Sans Variable";font-weight:100 700;src:url(${FONT_DATA}) format("woff2");}`);
    expect(css).toContain(`@font-face{font-family:"IBM Plex Mono";font-weight:600;src:url(${FONT_DATA}) format("woff2");}`);
    const fonts = fetch.mock.calls.map(([u]) => u).filter((u) => u.includes('woff2'));
    expect(fonts).toHaveLength(2);
    expect(fonts.some((u) => u.includes('ibm-plex-sans-latin-wght-normal'))).toBe(true);
    expect(fonts.some((u) => u.includes('ibm-plex-mono-latin-600-normal'))).toBe(true);
    await ex.renderSvg(tree, layout, null);
    expect(fetch.mock.calls.filter(([u]) => u.includes('woff2'))).toHaveLength(2);

    const without = parse((await ex.renderSvg(tree, layout, null, { embedFont: false })).svg);
    expect(without.querySelector('style')).toBeNull();
  });

  it('does not fetch the fonts when they are not embedded', async () => {
    const { tree, layout } = fixture();
    await ex.renderSvg(tree, layout, null, { embedFont: false, credit: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exports without fonts when they cannot be loaded', async () => {
    fakeFetch((url) => url.includes('woff2'));
    ex = await load();
    const { tree, layout } = fixture();
    expect(parse((await ex.renderSvg(tree, layout, null)).svg).querySelector('style')).toBeNull();
  });

  it('exports without fonts when a file cannot be read', async () => {
    fakeFetch();
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, 'error', { value: new DOMException('nope'), configurable: true });
      queueMicrotask(() => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>));
    });
    ex = await load();
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    expect(doc.querySelector('style')).toBeNull();
    expect(doc.querySelector('image')).toBeNull();
  });

  it('reads files with a real FileReader', async () => {
    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => new Blob(['abc'], { type: 'font/woff2' }) })),
    );
    ex = await load();
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, null, { credit: false })).svg);
    expect(doc.querySelector('style')!.textContent).toContain('src:url(data:font/woff2;base64,YWJj) format("woff2")');
  });

  it('gives markers unique ids per diagram', async () => {
    const { tree, layout } = fixture();
    const a = parse((await ex.renderSvg(tree, layout, null)).svg);
    const b = parse((await ex.renderSvg(tree, layout, null, { idPrefix: 'docs-3' })).svg);
    const ids = (d: Document) => [...d.querySelectorAll('marker')].map((m) => m.id);
    expect(ids(a)).toEqual(['at-a', 'at-b']);
    expect(ids(b)).toEqual(['docs-3-a', 'docs-3-b']);
    // every reference points at a marker of the same diagram
    for (const [d, prefix] of [[a, 'at'], [b, 'docs-3']] as const) {
      for (const p of d.querySelectorAll('path[marker-end]')) {
        expect(p.getAttribute('marker-end')).toMatch(new RegExp(`^url\\(#${prefix}-(a|b)\\)$`));
      }
    }
  });

  it('draws edges in their style: forward, backwards and planned', async () => {
    fakeTokens();
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    const edge = (id: string) => doc.querySelector(`path[d="${layout.edges.get(id)!.path}"]`)!;
    const forward = edge('win:0');
    expect(forward.getAttribute('stroke')).toBe('edge');
    expect(forward.getAttribute('stroke-width')).toBe('1.5');
    expect(forward.getAttribute('stroke-dasharray')).toBeNull();
    expect(forward.getAttribute('marker-end')).toBe('url(#at-a)');
    expect(forward.getAttribute('fill')).toBe('none');

    const back = edge('login:1');
    expect(back.getAttribute('stroke')).toBe('edge-backwards');
    expect(back.getAttribute('stroke-width')).toBe('2');
    expect(back.getAttribute('stroke-dasharray')).toBe('2 5');
    expect(back.getAttribute('stroke-linecap')).toBe('round');
    expect(back.getAttribute('marker-end')).toBe('url(#at-b)');

    const planned = edge('mfa:0');
    expect(planned.getAttribute('stroke')).toBe('edge');
    expect(planned.getAttribute('stroke-dasharray')).toBe('6 5');
    expect(planned.getAttribute('marker-end')).toBe('url(#at-a)');

    // markers in the matching colors
    expect(doc.querySelector('#at-a path')!.getAttribute('fill')).toBe('edge');
    expect(doc.querySelector('#at-b path')!.getAttribute('fill')).toBe('edge-backwards');
    expect(doc.querySelector('rect')!.getAttribute('fill')).toBe('canvas-bg');
  });

  it('draws edge labels centered on their spot, #tags as pills', async () => {
    fakeTokens();
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    const rects = [...doc.querySelectorAll('rect')];
    const tag = rects.find((r) => r.getAttribute('x') === String(148 - 40))!;
    expect(tag.getAttribute('y')).toBe(String(110 - 10));
    expect(tag.getAttribute('width')).toBe('80');
    expect(tag.getAttribute('height')).toBe('20');
    expect(tag.getAttribute('rx')).toBe('8');
    expect(tag.getAttribute('fill')).toBe('edge-tag-bg');
    expect(tag.getAttribute('stroke')).toBe('none');
    const tagText = [...doc.querySelectorAll('text')].find((t) => t.textContent === '#yolosec')!;
    expect(tagText.getAttribute('fill')).toBe('edge-tag-text');
    expect(tagText.getAttribute('x')).toBe('148');
    expect(tagText.getAttribute('y')).toBe(String(100 + METRICS.labelPadY + METRICS.labelLine / 2));

    const plain = rects.find((r) => r.getAttribute('x') === String(170 - 40))!;
    expect(plain.getAttribute('fill')).toBe('edge-label-bg');
    expect(plain.getAttribute('stroke')).toBe('border');
    const second = [...doc.querySelectorAll('text')].find((t) => t.textContent === '"work"')!;
    expect(second.getAttribute('fill')).toBe('text-2');
    expect(second.getAttribute('y')).toBe(String(240 + METRICS.labelPadY + METRICS.labelLine + METRICS.labelLine / 2));
  });

  it('caps the label corner radius at half its height', async () => {
    const { tree, layout } = fixture();
    layout.edges.get('leak:0')!.label!.height = 10;
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    const tag = [...doc.querySelectorAll('rect')].find((r) => r.getAttribute('x') === String(148 - 40))!;
    expect(tag.getAttribute('rx')).toBe('5');
  });

  it('draws nodes: reality as a pill, cards with their kind, ghosts dashed', async () => {
    fakeTokens();
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    const rectAt = (x: number, y: number) =>
      [...doc.querySelectorAll('rect')].find((r) => r.getAttribute('x') === String(x) && r.getAttribute('y') === String(y))!;

    const reality = rectAt(100, 48);
    expect(reality.getAttribute('rx')).toBe('18');
    expect(reality.getAttribute('fill')).toBe('reality-bg');
    expect(reality.getAttribute('stroke')).toBeNull();
    const rText = [...doc.querySelectorAll('text')].find((t) => t.textContent === 'Reality')!;
    expect(rText.getAttribute('x')).toBe(String(100 + 48));
    expect(rText.getAttribute('y')).toBe(String(48 + METRICS.realityPadY + METRICS.line / 2));
    expect(rText.getAttribute('fill')).toBe('reality-text');
    expect(rText.getAttribute('font-weight')).toBe('600');

    const login = rectAt(100.5, 280.5);
    expect(login.getAttribute('width')).toBe('139');
    expect(login.getAttribute('height')).toBe('57');
    expect(login.getAttribute('fill')).toBe('attack-bg');
    expect(login.getAttribute('stroke')).toBe('attack-border');
    expect(login.getAttribute('stroke-dasharray')).toBeNull();

    const all = texts(doc);
    for (const k of ['FACT', 'ATTACK', 'MITIGATION', 'GOAL', 'UNDECLARED']) expect(all).toContain(k);
    expect(all).not.toContain('REALITY');
    const tag = [...doc.querySelectorAll('text')].find((t) => t.textContent === 'ATTACK')!;
    expect(tag.getAttribute('fill')).toBe('attack-tag');
    expect(tag.getAttribute('x')).toBe(String(100 + METRICS.padX + 11));
    expect(tag.getAttribute('y')).toBe(String(280 + METRICS.padTop + METRICS.tag / 2));
    const dot = [...doc.querySelectorAll('circle')].find((c) => c.getAttribute('cy') === String(280 + METRICS.padTop + METRICS.tag / 2))!;
    expect(dot.getAttribute('fill')).toBe('attack-tag');

    // the fact's two lines
    const line2 = [...doc.querySelectorAll('text')].find((t) => t.textContent === '& "more"')!;
    expect(line2.getAttribute('x')).toBe(String(80 + METRICS.padX));
    expect(line2.getAttribute('y')).toBe(String(140 + METRICS.padTop + METRICS.tag + METRICS.gap + METRICS.line * 1.5));
    expect(line2.getAttribute('fill')).toBe('fact-text');

    const ghost = rectAt(300.5, 520.5);
    expect(ghost.getAttribute('fill')).toBe('ghost-bg');
    expect(ghost.getAttribute('stroke')).toBe('ghost-border');
    expect(ghost.getAttribute('stroke-dasharray')).toBe('4 3');
    expect([...doc.querySelectorAll('text')].find((t) => t.textContent === 'UNDECLARED')!.getAttribute('fill')).toBe('ghost-tag');
  });

  it('skips nodes and edges that are not in the layout (filtered out)', async () => {
    const { tree, layout } = fixture();
    layout.nodes.delete('mfa');
    layout.edges.delete('mfa:0');
    layout.edges.delete('login:1');
    layout.edges.delete('leak:0');
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    expect(texts(doc)).not.toContain('MFA');
    expect(texts(doc)).not.toContain('MITIGATION');
    expect(texts(doc)).not.toContain('#yolosec');
    expect(doc.querySelectorAll('path[marker-end]')).toHaveLength(3);
  });

  it('skips labels the layout has but the tree no longer has', async () => {
    const { tree, layout } = fixture();
    layout.edges.get('win:0')!.label = label(0, 0, ['stale']);
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    expect(texts(doc)).not.toContain('stale');
  });

  it('only asks for tokens the stylesheet defines, in both themes', async () => {
    const asked = fakeTokens();
    const { tree, layout } = fixture();
    await ex.renderSvg(tree, layout, null);
    const tokensCss = await readSource('../tokens.css');
    const [light, dark] = tokensCss.split(":root[data-theme='dark']");
    expect(dark).toBeDefined();
    const defined = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...asked].filter((n) => !defined(light).has(n));
    expect(missing).toEqual([]);
    // the dark theme overrides the colors the export uses
    const darkMissing = [...asked].filter((n) => !defined(dark).has(n));
    expect(darkMissing).toEqual([]);
    expect(asked.size).toBeGreaterThan(20);
  });

  it('falls back to grey for a token that is not set', async () => {
    fakeTokens(['--edge']);
    const { tree, layout } = fixture();
    const doc = parse((await ex.renderSvg(tree, layout, null)).svg);
    expect(doc.querySelector('#at-a path')!.getAttribute('fill')).toBe('#888');
    expect(doc.querySelector('#at-b path')!.getAttribute('fill')).toBe('edge-backwards');
  });
});

describe('renderPng', () => {
  let ex: Exporters;
  let urls: ReturnType<typeof stubObjectUrls>;
  beforeEach(async () => {
    ex = await load();
    urls = stubObjectUrls('blob:svg');
  });
  const created = () => urls.create.mock.calls.map(([b]) => b as Blob);

  function fakeImage(decode: () => Promise<void> = async () => {}) {
    const images: Array<{ src: string; decoding: string }> = [];
    class FakeImage {
      src = '';
      decoding = '';
      constructor() {
        images.push(this);
      }
      decode = decode;
    }
    vi.stubGlobal('Image', FakeImage);
    return images;
  }

  function fakeCanvas(blob: Blob | null) {
    const ctx = { scale: vi.fn(), drawImage: vi.fn() };
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return ctx as unknown as CanvasRenderingContext2D;
    });
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((cb: BlobCallback) => queueMicrotask(() => cb(blob)));
    return { ctx, canvases, toBlob };
  }

  it('draws the SVG on a scaled canvas and encodes a PNG', async () => {
    const images = fakeImage();
    const png = new Blob(['png'], { type: 'image/png' });
    const { ctx, canvases, toBlob } = fakeCanvas(png);
    const out = await ex.renderPng('<svg/>', 100.4, 50, 2);
    expect(out).toBe(png);
    expect(created()).toHaveLength(1);
    expect(created()[0].type).toBe('image/svg+xml');
    expect(new TextDecoder().decode(await bytesOf(created()[0]))).toBe('<svg/>');
    expect(images).toHaveLength(1);
    expect(images[0].src).toBe('blob:svg');
    expect(images[0].decoding).toBe('async');
    expect([canvases[0].width, canvases[0].height]).toEqual([201, 100]);
    expect(ctx.scale).toHaveBeenCalledWith(2, 2);
    expect(ctx.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 100.4, 50);
    expect(toBlob.mock.calls[0][1]).toBe('image/png');
    expect(urls.revoke).toHaveBeenCalledWith('blob:svg');
  });

  it('defaults to twice the size', async () => {
    fakeImage();
    const { canvases, ctx } = fakeCanvas(new Blob(['png']));
    await ex.renderPng('<svg/>', 10, 20);
    expect([canvases[0].width, canvases[0].height]).toEqual([20, 40]);
    expect(ctx.scale).toHaveBeenCalledWith(2, 2);
  });

  it('scales big trees down to what every browser can encode', async () => {
    fakeImage();
    const { canvases, ctx } = fakeCanvas(new Blob(['png']));
    // Safari refuses canvases over 16.7 megapixels, every browser over 16384px on a side
    await ex.renderPng('<svg/>', 4000, 3000, 2);
    const [w, h] = [canvases[0].width, canvases[0].height];
    expect(w * h).toBeLessThanOrEqual(16_777_216);
    expect(w / h).toBeCloseTo(4 / 3, 2);
    const s = ctx.scale.mock.calls[0][0] as number;
    expect(s).toBeLessThan(2);
    expect(ctx.scale).toHaveBeenCalledWith(s, s);
    expect(w).toBe(Math.ceil(4000 * s));
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 4000, 3000);

    await ex.renderPng('<svg/>', 12000, 300, 2);
    expect(canvases[1].width).toBeLessThanOrEqual(16_384);
    expect(canvases[1].width * canvases[1].height).toBeLessThanOrEqual(16_777_216);
  });

  it('fails when the browser cannot encode, and still frees the URL', async () => {
    fakeImage();
    fakeCanvas(null);
    await expect(ex.renderPng('<svg/>', 10, 10)).rejects.toThrow('Could not encode PNG');
    expect(urls.revoke).toHaveBeenCalledWith('blob:svg');
  });

  it('fails when the SVG cannot be decoded, and still frees the URL', async () => {
    fakeImage(() => Promise.reject(new Error('EncodingError')));
    const { ctx } = fakeCanvas(new Blob(['png']));
    await expect(ex.renderPng('<svg', 10, 10)).rejects.toThrow('EncodingError');
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(urls.revoke).toHaveBeenCalledWith('blob:svg');
  });
});

describe('pngWithSource', () => {
  it('appends the source after the image data', async () => {
    const ex = await load();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
    const png = new Blob([bytes], { type: 'image/png' });
    const out = ex.pngWithSource(png, SOURCE);
    expect(out.type).toBe('image/png');
    const buf = await bytesOf(out);
    expect([...buf.subarray(0, bytes.length)]).toEqual([...bytes]);
    const tail = new TextDecoder('latin1').decode(buf.subarray(bytes.length));
    expect(tail.startsWith('\n// attacktree:')).toBe(true);
    expect(extractEmbedded(tail)).toBe(SOURCE);
    expect(await readTreeFile(asFile('tree.png', buf))).toBe(SOURCE);
  });
});

describe('download', () => {
  let ex: Exporters;
  let urls: ReturnType<typeof stubObjectUrls>;
  beforeEach(async () => {
    ex = await load();
    vi.useFakeTimers();
    urls = stubObjectUrls('blob:file');
  });

  it('clicks a temporary link to the data, then frees it', () => {
    const clicked: Array<{ href: string; download: string; attached: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
    });
    ex.download('tree.yaml', 'title: x\n', 'text/yaml');
    expect(clicked).toEqual([{ href: 'blob:file', download: 'tree.yaml', attached: true }]);
    expect(document.querySelector('a')).toBeNull();
    const blob = urls.create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/yaml');
    // the browser needs a moment to start the download
    vi.advanceTimersByTime(999);
    expect(urls.revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(urls.revoke).toHaveBeenCalledWith('blob:file');
  });

  it('passes blobs through and defaults text to a binary type', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const png = new Blob(['png'], { type: 'image/png' });
    ex.download('tree.png', png);
    expect(urls.create.mock.calls[0][0]).toBe(png);
    ex.download('tree.bin', 'data');
    const blob = urls.create.mock.calls[1][0] as Blob;
    expect(blob.type).toBe('application/octet-stream');
  });
});

describe('fileBase', () => {
  let ex: Exporters;
  beforeEach(async () => {
    ex = await load();
  });

  it('turns a title into a safe file name', () => {
    expect(ex.fileBase('CI/CD pipeline: supply chain')).toBe('ci-cd-pipeline-supply-chain');
    expect(ex.fileBase('Ação & Reação — Über <Test>')).toBe('acao-reacao-uber-test');
    expect(ex.fileBase('  ...Leading and trailing!!  ')).toBe('leading-and-trailing');
    expect(ex.fileBase('../../etc/passwd')).toBe('etc-passwd');
    expect(ex.fileBase('ﬁle №1')).toBe('file-no1');
  });

  it('falls back when nothing is left', () => {
    expect(ex.fileBase('')).toBe('attack-tree');
    expect(ex.fileBase('日本語のツリー')).toBe('attack-tree');
    expect(ex.fileBase('!!!')).toBe('attack-tree');
  });

  it('keeps names short without a dangling dash', () => {
    const long = ex.fileBase('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    // the 60th character is a separator
    const edge = ex.fileBase(`${'a'.repeat(59)} b`);
    expect(edge).toBe('a'.repeat(59));
    expect(ex.fileBase('x'.repeat(80))).toBe('x'.repeat(60));
  });
});

describe('copyText', () => {
  let ex: Exporters;
  const setSecure = (v: boolean) => Object.defineProperty(window, 'isSecureContext', { value: v, configurable: true });
  const setClipboard = (c: unknown) => Object.defineProperty(navigator, 'clipboard', { value: c, configurable: true });
  const setExec = (fn: unknown) => Object.defineProperty(document, 'execCommand', { value: fn, configurable: true, writable: true });
  beforeEach(async () => {
    ex = await load();
  });
  afterEach(() => {
    delete (window as { isSecureContext?: boolean }).isSecureContext;
    delete (navigator as { clipboard?: unknown }).clipboard;
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it('uses the clipboard API in a secure context', async () => {
    setSecure(true);
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    const exec = vi.fn(() => true);
    setExec(exec);
    expect(await ex.copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to a hidden textarea on plain http', async () => {
    setSecure(false);
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    let seen: { value: string; readOnly: boolean; selected: boolean; hidden: boolean } | null = null;
    setExec(
      vi.fn((cmd: string) => {
        expect(cmd).toBe('copy');
        const area = document.querySelector('textarea')!;
        seen = {
          value: area.value,
          readOnly: area.hasAttribute('readonly'),
          selected: area.selectionStart === 0 && area.selectionEnd === area.value.length,
          hidden: area.style.position === 'fixed' && area.style.opacity === '0',
        };
        return true;
      }),
    );
    expect(await ex.copyText('a link')).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(seen).toEqual({ value: 'a link', readOnly: true, selected: true, hidden: true });
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when there is no clipboard API', async () => {
    setSecure(true);
    setClipboard(undefined);
    setExec(vi.fn(() => true));
    expect(await ex.copyText('x')).toBe(true);
  });

  it('falls back when the clipboard API refuses', async () => {
    setSecure(true);
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))) });
    const exec = vi.fn(() => true);
    setExec(exec);
    expect(await ex.copyText('x')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('reports failure when nothing can copy', async () => {
    setSecure(false);
    setExec(vi.fn(() => false));
    expect(await ex.copyText('x')).toBe(false);
    setExec(
      vi.fn(() => {
        throw new Error('not supported');
      }),
    );
    expect(await ex.copyText('x')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
