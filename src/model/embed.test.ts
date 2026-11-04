// @vitest-environment node
// jsdom's File has no text()/arrayBuffer(); Node's File is the one browsers have.
import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64, extractEmbedded, pngTrailer, readTreeFile, svgSourceComment } from './embed';

const SOURCE = "title: Ataque à cadeia de suprimentos ✓ 🔥\nattacks:\n- a: '#yolosec'\n";

describe('base64', () => {
  it.each(['', 'a', 'ab', 'abc', 'title: T\n', 'ação ✓ 🔥 日本語', '\u0000\u0001\u007f'])('round-trips %j', (text) => {
    expect(decodeBase64(encodeBase64(text))).toBe(text);
  });

  it('encodes UTF-8, not UTF-16', () => {
    expect(encodeBase64('é')).toBe('w6k=');
    expect(encodeBase64('title: T\n')).toBe(btoa('title: T\n'));
  });

  it('round-trips text larger than one chunk', () => {
    const big = 'ação ✓ '.repeat(20_000); // well over 0x8000 bytes
    const b64 = encodeBase64(big);
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decodeBase64(b64)).toBe(big);
  });

  it('throws on characters that are not base64', () => {
    expect(() => decodeBase64('not base64!')).toThrow();
    expect(() => decodeBase64('a')).toThrow();
  });

  it('replaces invalid UTF-8 rather than failing', () => {
    expect(decodeBase64(btoa('\xff\xfe'))).toBe('��');
  });
});

describe('extractEmbedded', () => {
  it('reads the SVG comment', () => {
    expect(svgSourceComment(SOURCE)).toBe(`<!-- attacktree:${encodeBase64(SOURCE)} -->`);
    expect(extractEmbedded(`<svg xmlns="http://www.w3.org/2000/svg"></svg>\n${svgSourceComment(SOURCE)}`)).toBe(SOURCE);
  });

  it('reads the PNG trailer', () => {
    expect(pngTrailer(SOURCE)).toBe(`\n// attacktree:${encodeBase64(SOURCE)}`);
    expect(extractEmbedded(`\x89PNG...IEND${pngTrailer(SOURCE)}`)).toBe(SOURCE);
  });

  it('reads the deciduous marker in both comment styles', () => {
    const b64 = btoa('title: legacy\n');
    expect(extractEmbedded(`digraph {}\n// deciduous:${b64}`)).toBe('title: legacy\n');
    expect(extractEmbedded(`<svg></svg><!-- deciduous:${b64} -->`)).toBe('title: legacy\n');
  });

  it('tolerates trailing whitespace', () => {
    expect(extractEmbedded(`<svg></svg>\n${svgSourceComment(SOURCE)}\n\r\n  `)).toBe(SOURCE);
  });

  it('only reads a marker at the very end', () => {
    expect(extractEmbedded(`${svgSourceComment(SOURCE)}\n<svg></svg>`)).toBeUndefined();
  });

  it('uses the last marker when there are several', () => {
    const old = svgSourceComment('title: old\n');
    expect(extractEmbedded(`${old}\n<svg></svg>\n${svgSourceComment('title: new\n')}`)).toBe('title: new\n');
  });

  it('ignores other markers and plain text', () => {
    expect(extractEmbedded('')).toBeUndefined();
    expect(extractEmbedded('title: T\n')).toBeUndefined();
    expect(extractEmbedded(`// other:${btoa('x')}`)).toBeUndefined();
    expect(extractEmbedded(`//attacktree:${btoa('x')}`)).toBeUndefined();
  });

  it('returns undefined for a marker with broken base64', () => {
    expect(extractEmbedded('// attacktree:abcde')).toBeUndefined();
    expect(extractEmbedded('// attacktree:ab==c')).toBeUndefined();
  });
});

describe('readTreeFile', () => {
  const file = (parts: BlobPart[], name: string, type = '') => new File(parts, name, { type });

  it('reads .yaml and .yml files as text', async () => {
    expect(await readTreeFile(file([SOURCE], 'tree.yaml'))).toBe(SOURCE);
    expect(await readTreeFile(file([SOURCE], 'TREE.YML'))).toBe(SOURCE);
  });

  it('trusts a YAML media type whatever the name', async () => {
    expect(await readTreeFile(file([SOURCE], 'tree', 'application/x-yaml'))).toBe(SOURCE);
    expect(await readTreeFile(file([SOURCE], 'tree.txt', 'text/yaml'))).toBe(SOURCE);
  });

  it('removes Markdown fences around the YAML', async () => {
    const reply = 'Here is your tree:\n\n```yaml\ntitle: T\n```\n\nEnjoy.';
    expect(await readTreeFile(file([reply], 'answer.yaml'))).toBe('title: T\n');
    expect(await readTreeFile(file([reply], 'answer.md'))).toBe('title: T\n');
  });

  it('does not strip the YAML of a file that merely has a BOM', async () => {
    const text = await readTreeFile(file(['﻿title: T\n'], 'bom.txt'));
    expect(text.replace(/^﻿/, '')).toBe('title: T\n');
  });

  it('reads the source embedded in an exported SVG', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>ação</text></svg>\n${svgSourceComment(SOURCE)}`;
    expect(await readTreeFile(file([svg], 'tree.svg', 'image/svg+xml'))).toBe(SOURCE);
  });

  it('reads the source appended to a binary PNG', async () => {
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 37 + 0x80) & 0xff;
    binary.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await readTreeFile(file([binary, pngTrailer(SOURCE)], 'tree.png', 'image/png'))).toBe(SOURCE);
  });

  it('reads a DOT file exported by deciduous', async () => {
    const dot = `digraph {\n  a -> b\n}\n// deciduous:${encodeBase64('title: legacy\n')}\n`;
    expect(await readTreeFile(file([dot], 'tree.dot'))).toBe('title: legacy\n');
  });

  it('finds the source at the end of a file larger than the window it scans', async () => {
    const padding = new Uint8Array(4_500_000).fill(0x41);
    expect(await readTreeFile(file([padding, pngTrailer(SOURCE)], 'huge.png'))).toBe(SOURCE);
  });

  it('says so when an image has no embedded tree', async () => {
    await expect(readTreeFile(file(['<svg></svg>'], 'Plain.SVG'))).rejects.toThrow('Plain.SVG does not contain an embedded tree');
    await expect(readTreeFile(file([new Uint8Array([0x89, 0x50])], 'photo.png'))).rejects.toThrow('photo.png does not contain an embedded tree');
    await expect(readTreeFile(file(['digraph {}'], 'g.dot'))).rejects.toThrow('g.dot does not contain an embedded tree');
  });

  it('says so when the embedded tree is damaged', async () => {
    await expect(readTreeFile(file(['<svg></svg><!-- attacktree:abcde -->'], 'bad.svg'))).rejects.toThrow(
      'bad.svg does not contain an embedded tree',
    );
  });

  it('reads other files as UTF-8 text, preferring an embedded source', async () => {
    expect(await readTreeFile(file(['title: ação\n'], 'tree.txt'))).toBe('title: ação\n');
    expect(await readTreeFile(file(['title: T\n'], 'no-extension'))).toBe('title: T\n');
    expect(await readTreeFile(file([`junk\n// attacktree:${encodeBase64(SOURCE)}`], 'export.bin'))).toBe(SOURCE);
  });

  it('reads an empty file as an empty tree', async () => {
    expect(await readTreeFile(file([], 'empty.yaml'))).toBe('');
    expect(await readTreeFile(file([], 'empty.txt'))).toBe('');
  });
});
