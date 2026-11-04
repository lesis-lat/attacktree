// @vitest-environment node
// Blob.stream(), CompressionStream and Response working together, as in browsers; jsdom's Blob has no stream().
import { describe, expect, it } from 'vitest';
import { EXAMPLE_CICD } from './examples';
import { decodeShare, encodeShare, MAX_SHARED_BYTES, ShareTooLargeError } from './share';

/** a deterministic, poorly compressible text */
function noise(length: number): string {
  let seed = 42;
  let out = '';
  for (let i = 0; i < length; i++) {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    out += String.fromCharCode(0x20 + ((seed >>> 0) % 0x5f));
  }
  return out;
}

describe('share links', () => {
  it.each([
    ['the bundled example', EXAMPLE_CICD],
    ['unicode', 'title: Ataque à cadeia ✓ 🔥 日本語\nattacks:\n- a: "Ação"\n'],
    ['an empty tree', ''],
    ['a single character', 'x'],
    ['CRLF and control characters', 'title: T\r\n\t# \u0000 \u001f\r\n'],
  ])('round-trips %s', async (_, source) => {
    const hash = await encodeShare(source);
    expect(hash).toMatch(/^#tree=[A-Za-z0-9_-]+$/);
    expect(await decodeShare(hash)).toBe(source);
  });

  it('round-trips a large tree whose base64 spans several chunks', async () => {
    const source = `title: big\n# ${noise(300_000)}\n`;
    const hash = await encodeShare(source);
    expect(hash.length).toBeGreaterThan(0x8000);
    expect(await decodeShare(hash)).toBe(source);
  });

  it('compresses repetitive trees', async () => {
    const source = EXAMPLE_CICD.repeat(20);
    expect((await encodeShare(source)).length).toBeLessThan(source.length / 10);
  });

  it('uses URL-safe base64 without padding', async () => {
    // enough varied bytes that "+", "/" and padding would show up in plain base64
    for (const n of [1, 2, 3, 50, 51, 52, 1000]) {
      const hash = await encodeShare(noise(n));
      expect(hash.slice('#tree='.length)).not.toMatch(/[+/=]/);
      expect(await decodeShare(hash)).toBe(noise(n));
    }
  });

  it.each(['', '#', '#tree=', '#tree', '#other=abc', 'tree=abc', '#tree=abc&x=1', '#tree=a+b', '#tree=a/b', '#tree=ab==', ' #tree=abc', '#tree=abc\n'])(
    'ignores hashes that are not share links: %j',
    async (hash) => {
      expect(await decodeShare(hash)).toBeNull();
    },
  );

  it('rejects a damaged link instead of returning garbage', async () => {
    const hash = await encodeShare(EXAMPLE_CICD);
    // cut in the middle of the compressed stream
    await expect(decodeShare(hash.slice(0, Math.floor(hash.length / 2)))).rejects.toThrow();
    // not deflate data at all
    await expect(decodeShare('#tree=AAAAAAAAAAAAAAAA')).rejects.toThrow();
    await expect(decodeShare('#tree=_____________')).rejects.toThrow();
  });

  it('opens a tree exactly at the size limit', async () => {
    const source = 'a'.repeat(MAX_SHARED_BYTES);
    expect(await decodeShare(await encodeShare(source))).toBe(source);
  });

  it('refuses a tree one byte over the size limit', async () => {
    const hash = await encodeShare('a'.repeat(MAX_SHARED_BYTES + 1));
    await expect(decodeShare(hash)).rejects.toBeInstanceOf(ShareTooLargeError);
  });

  it('refuses a decompression bomb: a short link that expands to far more than any tree', async () => {
    const hash = await encodeShare('\n'.repeat(50_000_000));
    // about 50 KB of link for 50 MB of text
    expect(hash.length).toBeLessThan(100_000);
    await expect(decodeShare(hash)).rejects.toThrow('This share link is too large to open');
  });

  it('counts the limit in bytes, not characters', async () => {
    // "é" is two bytes in UTF-8
    const hash = await encodeShare('é'.repeat(MAX_SHARED_BYTES / 2 + 1));
    await expect(decodeShare(hash)).rejects.toBeInstanceOf(ShareTooLargeError);
  });

  it('rejects base64 of an impossible length', async () => {
    // 4n + 1 characters cannot be base64
    await expect(decodeShare('#tree=abcde')).rejects.toThrow();
  });
});
