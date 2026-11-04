import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./guide.md?raw', () => ({
  default: '# Only a title\n\nFirst paragraph.\n\nLast paragraph.\n',
}));
vi.mock('./Example', () => ({ Example: () => null }));

const { DocsApp } = await import('./DocsApp');

describe('DocsApp with a guide that has no sections', () => {
  it('keeps everything in the hero, in order, and has no active entry', () => {
    const { container } = render(<DocsApp />);
    const hero = container.querySelector('.docs-hero')!;
    expect(hero.querySelector('h1')).toHaveTextContent('Only a title');
    expect([...hero.querySelectorAll('.md')].map((p) => p.textContent!.trim())).toEqual(['First paragraph.', 'Last paragraph.']);
    // nothing is rendered after the hero
    expect(hero.nextElementSibling).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Contents' });
    expect(nav.querySelectorAll('.is-active')).toHaveLength(0);
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['llms.txt', 'llms-full.txt', 'JSON Schema']);
  });
});
