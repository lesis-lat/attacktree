import { createStore, del, get, set, values } from 'idb-keyval';

export interface TreeDoc {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

const store = createStore('attacktree', 'docs');
const LAST_OPEN = 'attacktree:last-open';

// crypto.randomUUID only exists in secure contexts, and the app is often served over plain http on a LAN.
export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function listDocs(): Promise<TreeDoc[]> {
  const all = await values<TreeDoc>(store);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const loadDoc = (id: string) => get<TreeDoc>(id, store);
export const saveDoc = (doc: TreeDoc) => set(doc.id, doc, store);
export const deleteDoc = (id: string) => del(id, store);

export function createDoc(text: string, title: string): TreeDoc {
  const now = Date.now();
  return { id: newId(), title, text, createdAt: now, updatedAt: now };
}

export function rememberLastOpen(id: string) {
  try {
    localStorage.setItem(LAST_OPEN, id);
  } catch {
    /* private mode */
  }
}

export function lastOpen(): string | null {
  try {
    return localStorage.getItem(LAST_OPEN);
  } catch {
    return null;
  }
}
