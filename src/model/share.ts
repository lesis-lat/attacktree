/** Share links carry the whole tree in the URL hash, compressed. No server involved. */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeShare(source: string): Promise<string> {
  const packed = await pipe(new TextEncoder().encode(source), new CompressionStream('deflate-raw'));
  return `#tree=${toBase64Url(packed)}`;
}

/** Same ceiling as files read back from exports. A link is untrusted input: a few KB can inflate to gigabytes. */
export const MAX_SHARED_BYTES = 4_000_000;

export class ShareTooLargeError extends Error {
  constructor() {
    super('This share link is too large to open');
    this.name = 'ShareTooLargeError';
  }
}

/** inflates chunk by chunk and stops at the limit, so a decompression bomb never reaches memory */
async function inflateCapped(bytes: Uint8Array<ArrayBuffer>, limit: number): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // stop inflating; a failure to cancel changes nothing, the link is refused either way
      await Promise.allSettled([reader.cancel()]);
      throw new ShareTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function decodeShare(hash: string): Promise<string | null> {
  const match = hash.match(/^#tree=([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const bytes = await inflateCapped(fromBase64Url(match[1]), MAX_SHARED_BYTES);
  return new TextDecoder().decode(bytes);
}
