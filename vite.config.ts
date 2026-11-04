/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { marked } from 'marked';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const GUIDE = resolve(root, 'src/docs/guide.md');

// GitHub Pages serves the project under /<repo>/; the deploy workflow sets BASE_PATH.
const base = process.env.BASE_PATH ?? '/';

/**
 * One Markdown file feeds the docs page, /llms-full.txt for language models,
 * and a static HTML copy inside /docs/ for readers that don't run JavaScript.
 */
function docsForMachines(): Plugin {
  // guide.md links to site files as "/file"; point them at wherever the site lives
  const guide = () => readFileSync(GUIDE, 'utf8').replace(/\]\(\//g, `](${base}`);
  return {
    name: 'attacktree-docs',
    configureServer(server) {
      server.watcher.add(GUIDE);
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `${base}llms-full.txt`) return next();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(guide());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'llms-full.txt', source: guide() });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.path.startsWith('/docs')) return html;
        const body = marked.parse(guide(), { async: false });
        return html.replace('<div id="root"></div>', `<div id="root"><main class="docs-static">${body}</main></div>`);
      },
    },
  };
}

/**
 * Everything the site loads comes from its own origin, and no script is inline or
 * evaluated, so an injected <script> or event handler would never run.
 * - style 'unsafe-inline': CodeMirror and React Flow set styles at runtime.
 * - img/font data: and blob:: exports inline the fonts and logo, and the PNG is drawn from a blob.
 * Build only: the dev server injects inline scripts for hot reload.
 * Pages cannot send headers, so frame-ancestors (ignored in a <meta>) is not set here.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'attacktree-csp',
    apply: 'build',
    // right after the charset, before any script
    transformIndexHtml: (html) => {
      const charset = '<meta charset="UTF-8" />';
      if (!html.includes(charset)) throw new Error('attacktree-csp: no <meta charset> to put the policy after');
      return html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), docsForMachines(), contentSecurityPolicy()],
  server: { host: '0.0.0.0', port: 4100, strictPort: true },
  preview: { host: '0.0.0.0', port: 4100, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 98 },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        docs: resolve(root, 'docs/index.html'),
      },
    },
  },
});
