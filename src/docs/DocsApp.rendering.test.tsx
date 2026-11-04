import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/** A small guide that exercises every rendering rule; the real guide is covered in DocsApp.test.tsx. */
vi.mock('./guide.md?raw', () => ({
  default: [
    '# Title with `code`',
    '',
    'Hero text with a [site file](/file.txt) and [elsewhere](https://example.com/x).',
    '',
    '## Introduction',
    '',
    'Intro paragraph.',
    '',
    '### Sub `one`',
    '',
    '#### Deep dive',
    '',
    '```js',
    'const a = 1; // not: yaml',
    '```',
    '',
    '```',
    'key: no language',
    '```',
    '',
    '```yml',
    'short: ext',
    '```',
    '',
    '    indented: code block',
    '',
    '```yaml example',
    'title: Live',
    '```',
    '',
    '```yml example',
    'title: Also live',
    '```',
    '',
    '## Not in the nav',
    '',
    'Orphan.',
    '',
    '## FAQ',
    '',
    '### Question?',
    '',
  ].join('\n'),
}));

vi.mock('./Example', () => ({
  Example: ({ source }: { source: string }) => <figure className="example">{source}</figure>,
}));

const { DocsApp } = await import('./DocsApp');

describe('DocsApp rendering rules', () => {
  it('renders the h1 with inline Markdown and no anchor', () => {
    const { container } = render(<DocsApp />);
    const h1 = container.querySelector('h1')!;
    expect(h1.innerHTML).toBe('Title with <code>code</code>');
    expect(h1).not.toHaveAttribute('id');
    expect(h1.querySelector('a.anchor')).toBeNull();
  });

  it('slugs headings without backticks and renders their inline Markdown', () => {
    const { container } = render(<DocsApp />);
    const sub = container.querySelector('#sub-one')!;
    expect(sub.tagName).toBe('H3');
    expect(sub.querySelector('span')!.innerHTML).toBe('Sub <code>one</code>');
    expect(container.querySelector('#question')!.tagName).toBe('H3');
    expect(container.querySelector('#not-in-the-nav')!.tagName).toBe('H2');
  });

  it('renders headings deeper than h3 as h3', () => {
    const { container } = render(<DocsApp />);
    const deep = container.querySelector('#deep-dive')!;
    expect(deep.tagName).toBe('H3');
    expect(deep.querySelector('a.anchor')).toHaveAttribute('href', '#deep-dive');
  });

  it('highlights yaml and yml blocks only; other code stays plain text', () => {
    const { container } = render(<DocsApp />);
    const blocks = [...container.querySelectorAll('pre.code code')];
    expect(blocks.map((b) => [b.textContent, b.querySelector('.y-key')?.textContent ?? null])).toEqual([
      ['const a = 1; // not: yaml', null],
      ['key: no language', null],
      ['short: ext\n', 'short'],
      ['indented: code block', null],
    ]);
    expect(blocks[0].children).toHaveLength(0);
    expect(blocks[1].children).toHaveLength(0);
  });

  it('turns "yaml example" and "yml example" blocks into live examples', () => {
    const { container } = render(<DocsApp />);
    expect([...container.querySelectorAll('figure.example')].map((f) => f.textContent)).toEqual(['title: Live\n', 'title: Also live\n']);
  });

  it('keeps the hero to what comes before the first section', () => {
    const { container } = render(<DocsApp />);
    const hero = container.querySelector('.docs-hero')!;
    expect(hero.querySelector('h1')).not.toBeNull();
    expect(hero).toHaveTextContent('Hero text with a site file');
    expect(hero).not.toHaveTextContent('Intro paragraph');
    expect(hero.querySelector('a[href="/file.txt"]')).not.toBeNull();
    expect(hero.querySelector('a[href="https://example.com/x"]')).not.toBeNull();
  });

  it('lists only the known sections that exist, under their groups; empty groups keep their label', () => {
    render(<DocsApp />);
    const navEl = screen.getByRole('navigation', { name: 'Contents' });
    const groups = [...navEl.querySelectorAll('.docs-nav-group')].map((g) => [
      g.querySelector('.docs-nav-label')!.textContent,
      [...g.querySelectorAll('a:not(.is-sub)')].map((a) => a.textContent),
    ]);
    expect(groups).toEqual([
      ['Start', ['Introduction']],
      ['Modeling', []],
      ['Reference', []],
      ['More', ['FAQ']],
      ['For machines', ['llms.txt', 'llms-full.txt', 'JSON Schema']],
    ]);
    // jsdom puts every heading at the top, so the last section reads as active
    expect(within(navEl).getByText('FAQ')).toHaveClass('is-active');
    expect([...navEl.querySelectorAll('.is-sub')].map((a) => a.textContent)).toEqual(['Question?']);
  });

  it('lists subsections without backticks, up to the next section', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.id === 'introduction' ? 0 : 900;
      return { top } as DOMRect;
    });
    render(<DocsApp />);
    const navEl = screen.getByRole('navigation', { name: 'Contents' });
    expect([...navEl.querySelectorAll('.is-sub')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Sub one', '#sub-one'],
      ['Deep dive', '#deep-dive'],
    ]);
  });
});
