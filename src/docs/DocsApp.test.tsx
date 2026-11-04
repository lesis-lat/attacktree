import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lesisHref } from '../ui/Lesis';
import rawGuide from './guide.md?raw';

// Diagrams are covered in Example.test.tsx; here only what the page hands them matters.
vi.mock('./Example', () => ({
  Example: vi.fn(({ source, theme }: { source: string; theme: string }) => (
    <figure className="example" data-theme={theme}>
      <pre data-testid="example-source">{source}</pre>
    </figure>
  )),
}));

const { DocsApp } = await import('./DocsApp');
const { Example } = await import('./Example');

/** requestAnimationFrame under the test's control. */
function frames() {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    queue.set(next, cb);
    return next++;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    queue.delete(id);
  });
  return {
    get pending() {
      return queue.size;
    },
    cancel,
    flush() {
      const cbs = [...queue.values()];
      queue.clear();
      act(() => {
        for (const cb of cbs) cb(0);
      });
    },
  };
}

/** Pretend the page is scrolled so that these section tops sit at these offsets from the viewport top. */
function scrollTo(tops: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.id in tops ? tops[this.id] : 10_000;
    return { x: 0, y: top, top, left: 0, right: 0, bottom: top, width: 0, height: 0, toJSON() {} } as DOMRect;
  });
}

const SECTIONS = [...rawGuide.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const nav = () => screen.getByRole('navigation', { name: 'Contents' });

let scrollIntoView: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  window.history.replaceState(null, '', '/');
  vi.unstubAllEnvs();
  vi.mocked(Example).mockClear();
});

describe('DocsApp: the guide', () => {
  it('renders the guide title as the only h1, inside the hero', () => {
    const { container } = render(<DocsApp />);
    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('attacktree documentation');
    expect(h1s[0].closest('.docs-hero')).not.toBeNull();
    // the hero ends before the first section
    const hero = container.querySelector('.docs-hero')!;
    expect(hero.querySelector('h2')).toBeNull();
    expect(hero.textContent).toContain('browser-based editor');
  });

  it('renders every section as an h2 with a slug id and a # anchor', () => {
    const { container } = render(<DocsApp />);
    const h2s = [...container.querySelectorAll('article h2')];
    expect(h2s.map((h) => h.querySelector('span')!.textContent)).toEqual(SECTIONS);
    const ids = h2s.map((h) => h.id);
    expect(ids).toEqual([
      'introduction',
      'quick-start',
      'concepts',
      'the-yaml-format',
      'modeling-patterns',
      'building-a-tree-a-method',
      'the-canvas',
      'the-editor',
      'saving-sharing-and-exporting',
      'using-attacktree-with-ai',
      'coming-from-deciduous',
      'keyboard-shortcuts',
      'faq',
    ]);
    for (const h of h2s) {
      const a = h.querySelector('a.anchor')!;
      expect(a).toHaveAttribute('href', `#${h.id}`);
      expect(a).toHaveAttribute('aria-hidden', 'true');
      expect(a).toHaveAttribute('tabindex', '-1');
      expect(a).toHaveTextContent('#');
    }
  });

  it('gives every heading a unique id, h3s included', () => {
    const { container } = render(<DocsApp />);
    const ids = [...container.querySelectorAll('article h2, article h3')].map((h) => h.id);
    expect(ids.length).toBe(SECTIONS.length + [...rawGuide.matchAll(/^### /gm)].length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('diagnostics');
    expect(ids).toContain('yolosec-nothing-in-the-way');
  });

  it('renders inline Markdown inside headings', () => {
    const { container } = render(<DocsApp />);
    // "## Using attacktree with AI" etc. are plain; code spans in prose become <code>
    expect(container.querySelector('#the-editor')!.nextElementSibling!.innerHTML).toContain('source of truth');
    expect(container.querySelector('article .md code')).not.toBeNull();
  });

  it('renders tables, lists and links from the guide as HTML', () => {
    const { container } = render(<DocsApp />);
    const prose = container.querySelector('article')!;
    expect(prose.querySelectorAll('.md table').length).toBeGreaterThan(3);
    expect(prose.querySelectorAll('.md ol, .md ul').length).toBeGreaterThan(3);
    const shortcuts = [...prose.querySelectorAll('.md table')].find((t) => t.textContent!.includes('Open autocomplete'))!;
    expect(shortcuts.textContent).toContain('Ctrl + Space');
    expect(prose.querySelector('a[href="https://www.deciduous.app/"]')).not.toBeNull();
  });

  it('hands every "yaml example" block to a live diagram, with a trailing newline and the current theme', () => {
    render(<DocsApp />);
    const fences = [...rawGuide.matchAll(/^```yaml example\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
    expect(fences).toHaveLength(5);
    const sources = screen.getAllByTestId('example-source').map((e) => e.textContent);
    expect(sources).toEqual(fences);
    for (const s of sources) expect(s!.endsWith('\n')).toBe(true);
    for (const f of document.querySelectorAll('figure.example')) expect(f).toHaveAttribute('data-theme', 'light');
  });

  it('highlights the other YAML blocks without turning them into diagrams', () => {
    const { container } = render(<DocsApp />);
    const blocks = [...container.querySelectorAll('pre.code')];
    const plainFences = [...rawGuide.matchAll(/^```yaml\n/gm)];
    expect(blocks).toHaveLength(plainFences.length);
    const nodes = blocks.find((b) => b.textContent!.includes('phish_admin: Phish an administrator'))!;
    expect(nodes.querySelector('code .y-key')).toHaveTextContent('attacks');
    expect(nodes.textContent).toBe('attacks:\n- phish_admin: Phish an administrator\n  from:\n  - reality\n');
    const schema = blocks.find((b) => b.textContent!.includes('yaml-language-server'))!;
    expect(schema.querySelector('.y-comment')).toHaveTextContent('# yaml-language-server: $schema=https://<this-site>/attacktree.schema.json');
  });

  it('links to site files from the guide relative to the site root', () => {
    const { container } = render(<DocsApp />);
    const prose = container.querySelector('article')!;
    expect(prose.querySelector('a[href="/llms.txt"]')).not.toBeNull();
    expect(prose.querySelector('a[href="/llms-full.txt"]')).not.toBeNull();
    expect(prose.querySelectorAll('a[href="/attacktree.schema.json"]').length).toBe(2);
  });
});

describe('DocsApp: under a base path (GitHub Pages)', () => {
  it('points every site link at the base path', async () => {
    vi.stubEnv('BASE_URL', '/attacktree/');
    vi.resetModules();
    const { DocsApp: Fresh } = await import('./DocsApp');
    const { container } = render(<Fresh />);
    const prose = container.querySelector('article')!;
    expect(prose.querySelector('a[href="/attacktree/llms.txt"]')).not.toBeNull();
    expect(prose.querySelector('a[href="/attacktree/llms-full.txt"]')).not.toBeNull();
    expect(prose.querySelectorAll('a[href="/attacktree/attacktree.schema.json"]').length).toBe(2);
    expect(prose.querySelector('a[href^="/llms"]')).toBeNull();
    // external links are untouched
    expect(prose.querySelector('a[href="https://www.deciduous.app/"]')).not.toBeNull();

    const machine = within(nav()).getByText('For machines').parentElement!;
    expect([...machine.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/attacktree/llms.txt',
      '/attacktree/llms-full.txt',
      '/attacktree/attacktree.schema.json',
    ]);
    expect(container.querySelector('a.docs-brand')).toHaveAttribute('href', '/attacktree/docs/');
    expect(screen.getByRole('link', { name: /Open the editor/ })).toHaveAttribute('href', '/attacktree/');
    for (const img of container.querySelectorAll('.lesis-logo img')) expect(img.getAttribute('src')).toMatch(/^\/attacktree\/brand\//);
  });
});

describe('DocsApp: chrome', () => {
  it('has the brand, the editor link and LESIS links tagged as docs traffic', () => {
    const { container } = render(<DocsApp />);
    const brand = container.querySelector('a.docs-brand')!;
    expect(brand).toHaveAttribute('href', '/docs/');
    expect(brand.querySelector('svg.logo')).not.toBeNull();
    expect(brand).toHaveTextContent('attacktreeDocs');
    expect(screen.getByRole('link', { name: /Open the editor/ })).toHaveAttribute('href', '/');
    const lesis = [...container.querySelectorAll('a[href*="lesis.lat"]')].filter((a) => !a.closest('article .md'));
    expect(lesis.length).toBe(5);
    for (const a of lesis) {
      expect(a).toHaveAttribute('href', lesisHref('docs'));
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener');
    }
    expect(screen.getByRole('region', { name: 'About LESIS' })).toHaveTextContent('attacktree is built and maintained by LESIS');
    expect(container.querySelector('.docs-footer')).toHaveTextContent('Inspired by Deciduous by Ryan Petrich and Kelly Shortridge');
  });

  it('toggles the theme and passes it to the diagrams', async () => {
    const user = userEvent.setup();
    render(<DocsApp />);
    const toDark = screen.getByRole('button', { name: 'Switch to dark theme' });
    expect(toDark).toHaveAttribute('title', 'Switch to dark theme');
    expect(toDark.querySelector('svg')).toHaveClass('lucide-moon');
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.click(toDark);
    const toLight = screen.getByRole('button', { name: 'Switch to light theme' });
    expect(toLight.querySelector('svg')).toHaveClass('lucide-sun');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('attacktree:theme')).toBe('dark');
    for (const f of document.querySelectorAll('figure.example')) expect(f).toHaveAttribute('data-theme', 'dark');
    await user.click(toLight);
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('DocsApp: navigation', () => {
  it('groups every section under Start, Modeling, Reference and More, in order, then the machine files', () => {
    render(<DocsApp />);
    const groups = [...nav().querySelectorAll('.docs-nav-group')];
    const read = (g: Element) => [g.querySelector('.docs-nav-label')!.textContent, [...g.querySelectorAll('a')].map((a) => a.textContent)];
    expect(groups.map(read)).toEqual([
      ['Start', ['Introduction', 'Quick start']],
      ['Modeling', ['Concepts', 'Modeling patterns', 'Building a tree: a method']],
      ['Reference', ['The YAML format', 'The canvas', 'The editor', 'Keyboard shortcuts']],
      ['More', ['Saving, sharing and exporting', 'Using attacktree with AI', 'Coming from Deciduous', 'FAQ']],
      ['For machines', ['llms.txt', 'llms-full.txt', 'JSON Schema']],
    ]);
    const links = [...nav().querySelectorAll('a.docs-nav-link:not(.is-sub)')].slice(0, -3);
    expect(links).toHaveLength(SECTIONS.length);
    for (const a of links) expect(document.getElementById(a.getAttribute('href')!.slice(1))).not.toBeNull();
    const machine = groups[4].querySelectorAll('a');
    expect([...machine].map((a) => a.getAttribute('href'))).toEqual(['/llms.txt', '/llms-full.txt', '/attacktree.schema.json']);
  });

  it('the Contents button opens and closes the nav, and picking an entry closes it', async () => {
    const user = userEvent.setup();
    render(<DocsApp />);
    const toggle = screen.getByRole('button', { name: 'Contents' });
    expect(nav()).not.toHaveClass('is-open');
    expect(toggle.querySelector('svg')).toHaveClass('lucide-menu');
    await user.click(toggle);
    expect(nav()).toHaveClass('is-open');
    expect(toggle.querySelector('svg')).toHaveClass('lucide-x');
    await user.click(toggle);
    expect(nav()).not.toHaveClass('is-open');
    await user.click(toggle);
    fireEvent.click(within(nav()).getByText('The editor'));
    expect(nav()).not.toHaveClass('is-open');
  });

  it('marks the section being read and lists its subsections', () => {
    const raf = frames();
    scrollTo({ introduction: -900, 'quick-start': -400, concepts: 600 });
    render(<DocsApp />);
    const active = () => [...nav().querySelectorAll('.docs-nav-link.is-active')].map((a) => a.textContent);
    const subs = () => [...nav().querySelectorAll('.docs-nav-link.is-sub')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(active()).toEqual(['Quick start']);
    expect(subs()).toEqual([]);

    scrollTo({ introduction: -2000, 'quick-start': -1500, concepts: -1000, 'the-yaml-format': 100 });
    fireEvent.scroll(window);
    fireEvent.scroll(window);
    expect(raf.pending).toBe(1); // one update per frame
    raf.flush();
    expect(active()).toEqual(['The YAML format']);
    expect(subs()).toEqual([
      ['Nodes', '#nodes'],
      ['Connections', '#connections'],
      ['Filter', '#filter'],
      ['Positions', '#positions'],
      ['Schema', '#schema'],
    ]);
    // the subsection links sit right under their section
    const yaml = within(nav()).getByText('The YAML format');
    expect(yaml.nextElementSibling).toHaveTextContent('Nodes');

    // the next scroll schedules a new frame
    scrollTo({ introduction: -2000, 'the-editor': 50, 'the-canvas': -300 });
    fireEvent.scroll(window);
    expect(raf.pending).toBe(1);
    raf.flush();
    expect(active()).toEqual(['The editor']);
    expect(subs()).toEqual([['Diagnostics', '#diagnostics']]);
  });

  it('marks the first section while the page is still at the hero', () => {
    frames();
    scrollTo({ introduction: 500 });
    render(<DocsApp />);
    expect([...nav().querySelectorAll('.is-active')].map((a) => a.textContent)).toEqual(['Introduction']);
    expect(nav().querySelectorAll('.is-sub')).toHaveLength(1); // "Where the idea comes from"
  });

  it('stops following the scroll on unmount, cancelling a pending frame', () => {
    const raf = frames();
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<DocsApp />);
    fireEvent.scroll(window);
    expect(raf.pending).toBe(1);
    unmount();
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(raf.cancel).toHaveBeenCalledWith(1);
    expect(raf.pending).toBe(0);
  });
});

describe('DocsApp: opening a link to a section', () => {
  it('scrolls to the section named in the hash once the page is drawn', () => {
    const raf = frames();
    window.history.replaceState(null, '', '/docs/#the-editor');
    render(<DocsApp />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    raf.flush();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('the-editor'));
  });

  it('decodes an encoded hash', () => {
    const raf = frames();
    window.history.replaceState(null, '', '/docs/#%66aq');
    render(<DocsApp />);
    raf.flush();
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('faq'));
  });

  it('ignores a hash that names no section', () => {
    const raf = frames();
    window.history.replaceState(null, '', '/docs/#nothing-here');
    render(<DocsApp />);
    raf.flush();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does nothing without a hash', () => {
    const raf = frames();
    render(<DocsApp />);
    expect(raf.pending).toBe(0);
  });

  it('survives a malformed hash instead of blanking the page', () => {
    frames();
    window.history.replaceState(null, '', '/docs/#%E0%A4%A');
    expect(() => render(<DocsApp />)).not.toThrow();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('attacktree documentation');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
