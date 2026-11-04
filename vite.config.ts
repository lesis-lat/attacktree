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

export default defineConfig({
  base,
  plugins: [react(), docsForMachines()],
  server: { host: '0.0.0.0', port: 4100, strictPort: true },
  preview: { host: '0.0.0.0', port: 4100, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        docs: resolve(root, 'docs/index.html'),
      },
    },
  },
});
