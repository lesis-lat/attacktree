/**
 * Exports carry their YAML source in a trailing comment, so an image can be
 * opened again for editing. Reading also accepts files exported by deciduous,
 * which use the same layout with a "deciduous:" marker.
 */

import { stripFences } from '../ai/prompt';

const MARKER = 'attacktree';

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function svgSourceComment(source: string): string {
  return `<!-- ${MARKER}:${encodeBase64(source)} -->`;
}

export function pngTrailer(source: string): string {
  return `\n// ${MARKER}:${encodeBase64(source)}`;
}

const EMBEDDED = /(?:\/\/|<!--) (?:attacktree|deciduous):([A-Za-z0-9+/]+=*)(?: -->)?\s*$/;

export function extractEmbedded(text: string): string | undefined {
  const match = text.match(EMBEDDED);
  if (!match) return undefined;
  try {
    return decodeBase64(match[1]);
  } catch {
    return undefined;
  }
}

/** Reads YAML from a .yaml/.yml file, or the source embedded in an exported SVG/PNG/DOT. */
export async function readTreeFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (/\.ya?ml$/.test(name) || file.type.includes('yaml')) return stripFences(await file.text());
  const buffer = await file.arrayBuffer();
  // the source sits at the very end; base64 is ASCII so latin1 decoding is safe
  const tail = new TextDecoder('latin1').decode(new Uint8Array(buffer).subarray(Math.max(0, buffer.byteLength - 4_000_000)));
  const source = extractEmbedded(tail);
  if (source !== undefined) return source;
  if (/\.(svg|png|dot)$/.test(name)) throw new Error(`${file.name} does not contain an embedded tree`);
  return stripFences(new TextDecoder().decode(buffer));
}
