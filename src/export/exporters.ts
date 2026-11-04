import monoLatin from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2?url';
import sansLatin from '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2?url';
import type { Layout } from '../layout/layout';
import { FONT_FAMILY, METRICS, tagWidth, textWidth } from '../layout/measure';
import { badgeOf, defenseGaps } from '../model/analysis';
import { pngTrailer, svgSourceComment } from '../model/embed';
import { isGhost, KIND_LABEL, type Tree } from '../model/types';

const TITLE_SPACE = 52;
const TITLE_FONT = `650 17px ${FONT_FAMILY}`;
const TITLE_MARGIN = 24;

// code points XML 1.0 does not allow: one of them makes the whole file unreadable
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/gu;

function esc(text: string): string {
  return text
    .replace(NOT_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || '#888';
}

function dataUrl(url: string): Promise<string> {
  return fetch(url)
    .then((r) => r.blob())
    .then(
      (blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        }),
    );
}

let fontCss: Promise<string> | null = null;
function embeddedFont(): Promise<string> {
  fontCss ??= Promise.all([dataUrl(sansLatin), dataUrl(monoLatin)])
    .then(
      ([sans, mono]) =>
        `@font-face{font-family:"IBM Plex Sans Variable";font-weight:100 700;src:url(${sans}) format("woff2");}` +
        `@font-face{font-family:"IBM Plex Mono";font-weight:600;src:url(${mono}) format("woff2");}`,
    )
    .catch(() => '');
  return fontCss;
}

const logos = new Map<string, Promise<string>>();
function logoData(theme: 'light' | 'dark'): Promise<string> {
  const file = `${import.meta.env.BASE_URL}brand/lesis-horizontal-${theme === 'dark' ? 'white' : 'black'}.png`;
  if (!logos.has(file)) logos.set(file, dataUrl(file).catch(() => ''));
  return logos.get(file)!;
}

export interface SvgOptions {
  /** inline the IBM Plex fonts so the file looks the same anywhere (exports) */
  embedFont?: boolean;
  showTitle?: boolean;
  /** keeps marker ids unique when several diagrams share one page */
  idPrefix?: string;
  /** small "attacktree by LESIS" line at the bottom */
  credit?: boolean;
}

const CREDIT_SPACE = 46;
/** the credit line and the logo, with margins: a narrower tree is widened so they are not cut off */
const CREDIT_WIDTH = 290;
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

export async function renderSvg(
  tree: Tree,
  layout: Layout,
  source: string | null,
  { embedFont = true, showTitle = true, idPrefix = 'at', credit = true }: SvgOptions = {},
): Promise<{ svg: string; width: number; height: number }> {
  const m = METRICS;
  const { bounds } = layout;
  const withTitle = showTitle && !!tree.title;
  const offsetY = withTitle ? TITLE_SPACE : 0;
  const content = Math.ceil(bounds.width);
  const width = Math.max(
    content,
    credit ? CREDIT_WIDTH : 0,
    withTitle ? Math.ceil(textWidth(tree.title, TITLE_FONT)) + TITLE_MARGIN * 2 : 0,
  );
  // a widened image keeps the tree in the middle
  const offsetX = (width - content) / 2;
  const height = Math.ceil(bounds.height + offsetY + (credit ? CREDIT_SPACE : 0));
  const font = embedFont ? await embeddedFont() : '';
  const c = {
    bg: token('canvas-bg'),
    title: token('text'),
    edge: token('edge'),
    backwards: token('edge-backwards'),
    labelBg: token('edge-label-bg'),
    labelBorder: token('border'),
    labelText: token('text-2'),
    tagText: token('edge-tag-text'),
    tagBg: token('edge-tag-bg'),
    danger: token('danger'),
    onDanger: token('on-danger'),
  };
  const gaps = defenseGaps(tree);
  const kind = (k: string, part: string) => token(`${k}-${part}`);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'IBM Plex Sans Variable', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif">`,
  );
  if (font) out.push(`<style>${font}</style>`);
  out.push('<defs>');
  const arrow = `${idPrefix}-a`;
  const back = `${idPrefix}-b`;
  const open = `${idPrefix}-o`;
  for (const [id, color] of [
    [arrow, c.edge],
    [back, c.backwards],
    [open, c.danger],
  ]) {
    out.push(
      `<marker id="${id}" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0.5,1 L9.5,5 L0.5,9 Q2.5,5 0.5,1 z" fill="${color}"/></marker>`,
    );
  }
  out.push('</defs>');
  out.push(`<rect width="100%" height="100%" fill="${c.bg}"/>`);
  if (withTitle) {
    out.push(
      `<text x="${width / 2}" y="34" text-anchor="middle" font-size="17" font-weight="650" fill="${c.title}">${esc(tree.title)}</text>`,
    );
  }
  out.push(`<g transform="translate(${offsetX - bounds.x} ${offsetY - bounds.y})">`);

  for (const edge of tree.edges) {
    const placed = layout.edges.get(edge.id);
    if (!placed) continue;
    const dash = edge.backwards ? ' stroke-dasharray="2 5" stroke-linecap="round"' : !edge.implemented ? ' stroke-dasharray="6 5"' : '';
    // same priority as the canvas: backwards, then open path, then plain
    const isOpen = !edge.backwards && gaps.openEdges.has(edge.id);
    const color = edge.backwards ? c.backwards : isOpen ? c.danger : c.edge;
    const marker = edge.backwards ? back : isOpen ? open : arrow;
    out.push(
      `<path d="${placed.path}" fill="none" stroke="${color}" stroke-width="${edge.backwards || isOpen ? 2 : 1.5}"${dash} marker-end="url(#${marker})"/>`,
    );
  }
  for (const edge of tree.edges) {
    const label = layout.edges.get(edge.id)?.label;
    if (!label || !edge.label) continue;
    const tag = edge.label.startsWith('#');
    const x = label.x - label.width / 2;
    const y = label.y - label.height / 2;
    out.push(
      `<rect x="${x}" y="${y}" width="${label.width}" height="${label.height}" rx="${Math.min(8, label.height / 2)}" fill="${tag ? c.tagBg : c.labelBg}" stroke="${tag ? 'none' : c.labelBorder}"/>`,
    );
    label.lines.forEach((line, i) => {
      out.push(
        `<text x="${label.x}" y="${y + m.labelPadY + m.labelLine * i + m.labelLine / 2}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="600" fill="${tag ? c.tagText : c.labelText}">${esc(line)}</text>`,
      );
    });
  }

  for (const node of tree.nodes) {
    const p = layout.nodes.get(node.id);
    if (!p) continue;
    const k = isGhost(node) ? 'ghost' : node.kind;
    const fill = kind(k, 'bg');
    const stroke = kind(k, 'border');
    const text = kind(k, 'text');
    if (node.kind === 'reality') {
      out.push(`<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="${p.height / 2}" fill="${fill}"/>`);
      p.lines.forEach((line, i) => {
        out.push(
          `<text x="${p.x + p.width / 2}" y="${p.y + m.realityPadY + m.line * i + m.line / 2}" text-anchor="middle" dominant-baseline="central" font-size="13" font-weight="600" fill="${text}">${esc(line)}</text>`,
        );
      });
      continue;
    }
    const dashed = isGhost(node) ? ' stroke-dasharray="4 3"' : '';
    out.push(
      `<rect x="${p.x + 0.5}" y="${p.y + 0.5}" width="${p.width - 1}" height="${p.height - 1}" rx="10" fill="${fill}" stroke="${stroke}"${dashed}/>`,
    );
    const tagY = p.y + m.padTop + m.tag / 2;
    out.push(`<circle cx="${p.x + m.padX + 3}" cy="${tagY}" r="3" fill="${kind(k, 'tag')}"/>`);
    out.push(
      `<text x="${p.x + m.padX + 11}" y="${tagY}" dominant-baseline="central" font-family="${MONO}" font-size="9" font-weight="600" letter-spacing="0.09em" fill="${kind(k, 'tag')}">${esc((isGhost(node) ? 'Undeclared' : KIND_LABEL[node.kind]).toUpperCase())}</text>`,
    );
    const badge = badgeOf(node.id, gaps);
    if (badge) {
      const w = tagWidth(badge.label) + m.badgePadX * 2;
      const bx = p.x + p.width - m.padX - w;
      out.push(`<rect x="${bx}" y="${tagY - m.tag / 2}" width="${w}" height="${m.tag}" rx="${m.tag / 2}" fill="${c.danger}"/>`);
      out.push(
        `<text x="${bx + w / 2}" y="${tagY}" text-anchor="middle" dominant-baseline="central" font-family="${MONO}" font-size="9" font-weight="600" letter-spacing="0.09em" fill="${c.onDanger}">${esc(badge.label.toUpperCase())}</text>`,
      );
    }
    const top = p.y + m.padTop + m.tag + m.gap;
    p.lines.forEach((line, i) => {
      out.push(
        `<text x="${p.x + m.padX}" y="${top + m.line * i + m.line / 2}" dominant-baseline="central" font-size="13" font-weight="500" fill="${text}">${esc(line)}</text>`,
      );
    });
  }

  out.push('</g>');
  if (credit) {
    // official LESIS horizontal logo (2092x703), in the version made for this background
    const dark = document.documentElement.dataset.theme === 'dark';
    const logo = await logoData(dark ? 'dark' : 'light');
    const logoH = 24;
    const logoW = Math.round((logoH * 2092) / 703);
    const x = width - 20 - logoW;
    const y = height - 14 - logoH;
    out.push(`<a href="https://lesis.lat/?utm_source=attacktree&amp;utm_medium=export">`);
    out.push(
      `<text x="${x - 10}" y="${y + logoH / 2}" text-anchor="end" dominant-baseline="central" font-family="${MONO}" font-size="9.5" font-weight="600" letter-spacing="0.12em" fill="${token('text-3')}">MADE WITH ATTACKTREE BY</text>`,
    );
    if (logo) out.push(`<image href="${logo}" x="${x}" y="${y}" width="${logoW}" height="${logoH}"/>`);
    out.push('</a>');
  }
  out.push('</svg>');
  const svg = out.join('\n');
  return { svg: source === null ? svg : `${svg}\n${svgSourceComment(source)}`, width, height };
}

/** a little under what browsers accept (Safari: 16.7 megapixels; everyone: 16384px a side), so big trees still export */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 16_000;

export async function renderPng(svg: string, width: number, height: number, requested = 2): Promise<Blob> {
  const scale = Math.min(requested, Math.sqrt(MAX_PIXELS / (width * height)), MAX_SIDE / width, MAX_SIDE / height);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode PNG'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function pngWithSource(png: Blob, source: string): Blob {
  return new Blob([png, pngTrailer(source)], { type: 'image/png' });
}

export function download(filename: string, data: Blob | string, type = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileBase(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return base || 'attack-tree';
}

/** navigator.clipboard needs a secure context; LAN http does not have one. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
