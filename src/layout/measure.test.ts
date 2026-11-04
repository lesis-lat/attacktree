import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../model/types';

type Measure = typeof import('./measure');

/** a fresh copy of the module: it caches the canvas context */
async function load(): Promise<Measure> {
  vi.resetModules();
  return import('./measure');
}

const node = (kind: TreeNode['kind'], label: string): TreeNode => ({ id: 'n', kind, label, declared: true });

/** a 2D context whose text is `per` px per UTF-16 unit; bold text (600) is 10% wider */
function fakeContext(per = 10) {
  const fonts: string[] = [];
  const ctx = {
    font: '',
    measureText(text: string) {
      fonts.push(this.font);
      return { width: text.length * per * (this.font.startsWith('600') ? 1.1 : 1) };
    },
  };
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return { fonts, spy };
}

describe('without a 2D canvas', () => {
  let m: Measure;
  beforeEach(async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    m = await load();
  });

  it('estimates 7px per character', () => {
    expect(m.wrap('hello world', 77, m.NODE_FONT)).toEqual(['hello world']);
    expect(m.wrap('hello world', 76, m.NODE_FONT)).toEqual(['hello', 'world']);
    expect(m.measureEdgeLabel('#yolosec')).toEqual({ width: Math.ceil(8 * 7 + 2 + 14), height: 14 + 6, lines: ['#yolosec'] });
  });

  it('keeps trying to get a context, and uses one once it shows up', () => {
    // 9 * 7 = 63 > 62: too wide for the fallback
    expect(m.wrap('aaaa bbbb', 62, m.NODE_FONT)).toEqual(['aaaa', 'bbbb']);
    expect(m.wrap('aaaa bbbb', 63, m.NODE_FONT)).toEqual(['aaaa bbbb']);
    fakeContext(1);
    expect(m.wrap('aaaa bbbb', 9, m.NODE_FONT)).toEqual(['aaaa bbbb']);
  });
});

describe('with a 2D canvas', () => {
  let m: Measure;
  let fonts: string[];
  let spy: ReturnType<typeof fakeContext>['spy'];
  beforeEach(async () => {
    ({ fonts, spy } = fakeContext());
    m = await load();
  });

  it('measures with the canvas fonts and creates the context only once', () => {
    m.wrap('one two', 1000, m.NODE_FONT);
    m.wrap('three', 1000, m.EDGE_LABEL_FONT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('2d');
    expect(new Set(fonts)).toEqual(new Set([m.NODE_FONT, m.EDGE_LABEL_FONT]));
    expect(m.NODE_FONT).toMatch(/^500 13px "IBM Plex Sans Variable"/);
    expect(m.EDGE_LABEL_FONT).toMatch(/^600 11px "IBM Plex Sans Variable"/);
  });

  describe('wrap', () => {
    it('fills lines word by word up to the width', () => {
      // 10px per character
      expect(m.wrap('aa bb cc dd', 50, '')).toEqual(['aa bb', 'cc dd']);
      expect(m.wrap('aa bb cc dd', 49, '')).toEqual(['aa', 'bb', 'cc', 'dd']);
      expect(m.wrap('aa bb cc dd', 110, '')).toEqual(['aa bb cc dd']);
    });

    it('collapses runs of whitespace and trims the ends', () => {
      expect(m.wrap('  aa \t  bb  ', 1000, '')).toEqual(['aa bb']);
    });

    it('keeps explicit line breaks, including empty lines', () => {
      expect(m.wrap('first\nsecond line', 1000, '')).toEqual(['first', 'second line']);
      expect(m.wrap('a\n\nb', 1000, '')).toEqual(['a', '', 'b']);
      expect(m.wrap('aa bb\ncc', 20, '')).toEqual(['aa', 'bb', 'cc']);
    });

    it('returns one empty line for an empty label', () => {
      expect(m.wrap('', 100, '')).toEqual(['']);
      expect(m.wrap('   ', 100, '')).toEqual(['']);
    });

    it('breaks a word wider than the box into pieces that fit', () => {
      const url = 'https://example.com/a/very/long/path/without/spaces';
      const lines = m.wrap(url, 100, '');
      expect(lines.join('')).toBe(url);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(10);
      expect(lines.slice(0, -1).every((l) => l.length === 10)).toBe(true);
    });

    it('carries on after a broken word', () => {
      expect(m.wrap('abcdefgh ij kl', 50, '')).toEqual(['abcde', 'fgh', 'ij kl']);
      // the tail of the broken word shares a line with what follows
      expect(m.wrap('abcdefg hi', 50, '')).toEqual(['abcde', 'fg hi']);
      expect(m.wrap('xx abcdefg', 50, '')).toEqual(['xx', 'abcde', 'fg']);
    });

    it('gives up at one character per line when even that does not fit', () => {
      expect(m.wrap('abc', 5, '')).toEqual(['a', 'b', 'c']);
    });

    it('never splits a character made of two UTF-16 units', () => {
      const word = `a${'😀'.repeat(15)}`;
      const lines = m.wrap(word, 184, '');
      expect(lines.join('')).toBe(word);
      expect(lines.length).toBeGreaterThan(1);
      for (const l of lines) {
        expect(l).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(l.length * 10).toBeLessThanOrEqual(184);
      }
    });
  });

  describe('measureNode', () => {
    it('sizes a card: tag line, text lines and padding', () => {
      const box = m.measureNode(node('attack', 'Phish an engineer'));
      expect(box.lines).toEqual(['Phish an engineer']);
      expect(box.width).toBe(Math.ceil(17 * 10 + 2 + 28));
      expect(box.height).toBe(10 + 12 + 6 + 18 + 12);
    });

    it('wraps at the text width and grows by one line height per line', () => {
      const label = 'word '.repeat(20).trim();
      const box = m.measureNode(node('fact', label));
      expect(box.lines.length).toBeGreaterThan(1);
      for (const l of box.lines) expect(l.length * 10).toBeLessThanOrEqual(m.METRICS.maxText);
      expect(box.height).toBe(10 + 12 + 6 + 18 * box.lines.length + 12);
      expect(box.width).toBe(Math.ceil(Math.max(...box.lines.map((l) => l.length * 10)) + 2 + 28));
    });

    it('has a minimum width', () => {
      expect(m.measureNode(node('goal', 'x')).width).toBe(128);
      expect(m.measureNode(node('mitigation', '')).width).toBe(128);
      expect(m.measureNode(node('mitigation', '')).height).toBe(10 + 12 + 6 + 18 + 12);
    });

    it('sizes reality as a pill without a tag, measured in its bold font', () => {
      const box = m.measureNode(node('reality', 'The world'));
      // the canvas and the export draw reality at weight 600
      expect(fonts.at(-1)).toMatch(/^600 13px /);
      expect(box.width).toBe(Math.ceil(9 * 10 * 1.1 + 2 + 36));
      expect(box.height).toBe(9 * 2 + 18);
      expect(m.measureNode(node('reality', 'R')).width).toBe(96);
      expect(m.measureNode(node('reality', 'a\nb')).height).toBe(18 + 36);
    });
  });

  describe('measureEdgeLabel', () => {
    it('sizes a label with its padding', () => {
      const box = m.measureEdgeLabel('#yolosec');
      expect(fonts.at(-1)).toBe(m.EDGE_LABEL_FONT);
      expect(box).toEqual({ width: Math.ceil(8 * 11 + 2 + 14), height: 14 + 6, lines: ['#yolosec'] });
    });

    it('wraps long labels at 150px', () => {
      const box = m.measureEdgeLabel('only when the attacker already has a foothold');
      expect(box.lines.length).toBeGreaterThan(1);
      for (const l of box.lines) expect(l.length * 11).toBeLessThanOrEqual(150);
      expect(box.height).toBe(14 * box.lines.length + 6);
    });
  });
});

describe('fontsReady', () => {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts');
  afterEach(() => {
    if (original) Object.defineProperty(document, 'fonts', original);
    else delete (document as { fonts?: unknown }).fonts;
  });
  const setFonts = (fonts: unknown) => Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });

  it('waits for both fonts', async () => {
    const m = await load();
    let done = false;
    const resolvers: Array<() => void> = [];
    const load_ = vi.fn(() => new Promise<void>((r) => resolvers.push(r)));
    setFonts({ load: load_ });
    const ready = m.fontsReady().then(() => {
      done = true;
    });
    expect(load_.mock.calls).toEqual([[m.NODE_FONT], [m.EDGE_LABEL_FONT]]);
    resolvers[0]();
    await Promise.resolve();
    expect(done).toBe(false);
    resolvers[1]();
    await ready;
    expect(done).toBe(true);
  });

  it('resolves when a font fails to load', async () => {
    const m = await load();
    setFonts({ load: () => Promise.reject(new Error('offline')) });
    await expect(m.fontsReady()).resolves.toBeUndefined();
  });

  it('resolves without the Font Loading API', async () => {
    const m = await load();
    setFonts(undefined);
    await expect(m.fontsReady()).resolves.toBeUndefined();
  });
});
