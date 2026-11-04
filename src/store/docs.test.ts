import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDoc, deleteDoc, lastOpen, listDocs, loadDoc, newId, rememberLastOpen, saveDoc, type TreeDoc } from './docs';

const doc = (id: string, updatedAt: number, title = id): TreeDoc => ({ id, title, text: `title: ${title}\n`, createdAt: 1, updatedAt });

beforeEach(async () => {
  for (const d of await listDocs()) await deleteDoc(d.id);
});

describe('ids', () => {
  it('are short lowercase base36 strings that start with the time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const id = newId();
    expect(id).toMatch(/^[0-9a-z]+$/);
    expect(id.startsWith((1_700_000_000_000).toString(36))).toBe(true);
    expect(id.length).toBeLessThanOrEqual(8 + 8);
  });

  it('do not collide, even within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const ids = new Set(Array.from({ length: 2000 }, newId));
    expect(ids.size).toBe(2000);
  });

  it('work without crypto.randomUUID (plain http)', () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('not a secure context');
    });
    expect(newId()).toMatch(/^[0-9a-z]+$/);
  });
});

describe('createDoc', () => {
  it('stamps creation and update with the same time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123_456);
    const d = createDoc('title: T\n', 'T');
    expect(d).toEqual({ id: expect.stringMatching(/^[0-9a-z]+$/), title: 'T', text: 'title: T\n', createdAt: 123_456, updatedAt: 123_456 });
  });

  it('gives each document its own id', () => {
    expect(createDoc('', 'a').id).not.toBe(createDoc('', 'a').id);
  });
});

describe('IndexedDB store', () => {
  it('saves and loads a document as it was', async () => {
    const d = { ...doc('one', 5), text: 'title: Ação ✓\n# comment\n' };
    await saveDoc(d);
    expect(await loadDoc('one')).toEqual(d);
  });

  it('loads nothing for an unknown id', async () => {
    expect(await loadDoc('missing')).toBeUndefined();
  });

  it('overwrites a document saved under the same id', async () => {
    await saveDoc(doc('one', 5, 'first'));
    await saveDoc(doc('one', 6, 'second'));
    expect(await listDocs()).toEqual([doc('one', 6, 'second')]);
  });

  it('lists documents, most recently updated first', async () => {
    await saveDoc(doc('old', 100));
    await saveDoc(doc('newest', 300));
    await saveDoc(doc('middle', 200));
    expect((await listDocs()).map((d) => d.id)).toEqual(['newest', 'middle', 'old']);
  });

  it('lists nothing when empty', async () => {
    expect(await listDocs()).toEqual([]);
  });

  it('deletes a document, and deleting twice is harmless', async () => {
    await saveDoc(doc('a', 1));
    await saveDoc(doc('b', 2));
    await deleteDoc('a');
    await deleteDoc('a');
    expect((await listDocs()).map((d) => d.id)).toEqual(['b']);
    expect(await loadDoc('a')).toBeUndefined();
  });
});

describe('last open document', () => {
  it('is remembered in localStorage', () => {
    expect(lastOpen()).toBeNull();
    rememberLastOpen('abc');
    expect(lastOpen()).toBe('abc');
    expect(localStorage.getItem('attacktree:last-open')).toBe('abc');
    rememberLastOpen('def');
    expect(lastOpen()).toBe('def');
  });

  it('is forgotten quietly when localStorage throws (private mode, blocked storage)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(() => rememberLastOpen('abc')).not.toThrow();
    expect(lastOpen()).toBeNull();
  });
});
