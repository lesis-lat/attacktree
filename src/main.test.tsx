import { act, waitFor } from '@testing-library/react';
import { createStore, values } from 'idb-keyval';
import { expect, it, vi } from 'vitest';
import { encodeShare } from './model/share';
import type { TreeDoc } from './store/docs';

vi.mock('elkjs/lib/elk-api.js', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  class TestELK extends ELK {
    constructor() {
      super();
    }
  }
  return { default: TestELK };
});
vi.mock('elkjs/lib/elk-worker.min.js?url', () => ({ default: 'elk-worker.js' }));

HTMLCanvasElement.prototype.getContext = function () {
  return { font: '', measureText: (t: string) => ({ width: t.length * 7 }) };
} as never;
// jsdom's Blob has no stream(); share links need it
Blob.prototype.stream ??= function (this: Blob) {
  const blob = this;
  return new ReadableStream({
    start(c) {
      const reader = new FileReader();
      reader.onload = () => {
        c.enqueue(new Uint8Array(reader.result as ArrayBuffer));
        c.close();
      };
      reader.readAsArrayBuffer(blob);
    },
  });
} as never;

vi.hoisted(() => {
  document.body.innerHTML = '<div id="root"></div>';
});

import './main';

const idb = createStore('attacktree', 'docs');

it('mounts the app in #root under StrictMode, starting up exactly once', async () => {
  const root = document.getElementById('root')!;
  await waitFor(() => expect(root.querySelector('.react-flow__node[data-id="malicious_release"]')).toBeTruthy(), { timeout: 4000 });
  expect(root.querySelector('.doc-title')).toHaveTextContent('Ship a malicious release through CI/CD');
  // StrictMode runs effects twice; the example must still be created once
  expect(await values<TreeDoc>(idb)).toHaveLength(1);

  // and only one hashchange listener survives: a share link is imported once
  const hash = await encodeShare('title: Shared\n\nattacks:\n- a: A\n  from:\n  - reality\n');
  act(() => {
    window.location.hash = hash;
  });
  await waitFor(() => expect(root.querySelector('.doc-title')).toHaveTextContent('Shared'));
  await new Promise((r) => setTimeout(r, 100));
  expect(await values<TreeDoc>(idb)).toHaveLength(2);
});
