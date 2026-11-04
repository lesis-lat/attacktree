import type { TreeNode } from '../model/types';

/** Keep in sync with .tree-node in styles.css — the canvas renders exactly these lines. */
export const FONT_FAMILY = '"IBM Plex Sans Variable", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';
export const NODE_FONT = `500 13px ${FONT_FAMILY}`;
/** .tree-node.kind-reality is bold */
export const REALITY_FONT = `600 13px ${FONT_FAMILY}`;
export const EDGE_LABEL_FONT = `600 11px ${FONT_FAMILY}`;

export const METRICS = {
  maxText: 184,
  padX: 14,
  padTop: 10,
  tag: 12,
  gap: 6,
  line: 18,
  padBottom: 12,
  minWidth: 128,
  realityPadX: 18,
  realityPadY: 9,
  labelMax: 150,
  labelLine: 14,
  labelPadX: 7,
  labelPadY: 3,
} as const;

export interface Box {
  width: number;
  height: number;
  lines: string[];
}

let ctx: CanvasRenderingContext2D | null = null;

export function textWidth(text: string, font: string): number {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

export function wrap(text: string, max: number, font: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font) <= max) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      // a single word wider than the box: break it, between code points (never inside an emoji's surrogate pair)
      let chars = Array.from(word);
      while (textWidth(line, font) > max && chars.length > 1) {
        let cut = chars.length - 1;
        while (cut > 1 && textWidth(chars.slice(0, cut).join(''), font) > max) cut--;
        lines.push(chars.slice(0, cut).join(''));
        chars = chars.slice(cut);
        line = chars.join('');
      }
    }
    lines.push(line);
  }
  return lines;
}

const widest = (lines: string[], font: string) => Math.max(0, ...lines.map((l) => textWidth(l, font)));

export function measureNode(node: TreeNode): Box {
  const m = METRICS;
  const font = node.kind === 'reality' ? REALITY_FONT : NODE_FONT;
  const lines = wrap(node.label, m.maxText, font);
  const text = widest(lines, font) + 2;
  if (node.kind === 'reality') {
    return {
      width: Math.ceil(Math.max(96, text + m.realityPadX * 2)),
      height: m.realityPadY * 2 + lines.length * m.line,
      lines,
    };
  }
  return {
    width: Math.ceil(Math.max(m.minWidth, text + m.padX * 2)),
    height: m.padTop + m.tag + m.gap + lines.length * m.line + m.padBottom,
    lines,
  };
}

export function measureEdgeLabel(label: string): Box {
  const m = METRICS;
  const lines = wrap(label, m.labelMax, EDGE_LABEL_FONT);
  return {
    width: Math.ceil(widest(lines, EDGE_LABEL_FONT) + 2 + m.labelPadX * 2),
    height: lines.length * m.labelLine + m.labelPadY * 2,
    lines,
  };
}

export async function fontsReady(): Promise<void> {
  try {
    await Promise.all([document.fonts.load(NODE_FONT), document.fonts.load(EDGE_LABEL_FONT)]);
  } catch {
    /* measuring with the fallback font is still fine */
  }
}
