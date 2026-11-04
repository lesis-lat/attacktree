import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ByLesis, LESIS_URL, LesisLogo, lesisHref } from './Lesis';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('lesisHref', () => {
  it.each(['app', 'docs', 'export'] as const)('tags the %s medium', (medium) => {
    const url = new URL(lesisHref(medium));
    expect(url.origin + url.pathname).toBe('https://lesis.lat/');
    expect([...url.searchParams]).toEqual([
      ['utm_source', 'attacktree'],
      ['utm_medium', medium],
    ]);
  });

  it('starts from the LESIS site', () => {
    expect(LESIS_URL).toBe('https://lesis.lat/');
    expect(lesisHref('app').startsWith(LESIS_URL)).toBe(true);
  });
});

describe('LesisLogo', () => {
  it.each(['horizontal', 'symbol'] as const)('shows the official %s files: black on light, white on dark', (variant) => {
    const { container } = render(<LesisLogo variant={variant} className="extra" />);
    const wrap = container.firstElementChild!;
    expect(wrap.tagName).toBe('SPAN');
    expect(wrap.className).toBe(`lesis-logo lesis-${variant} extra`);
    const [light, dark] = wrap.querySelectorAll('img');
    expect(light).toHaveClass('on-light');
    expect(light).toHaveAttribute('src', `/brand/lesis-${variant}-black.png`);
    expect(light).toHaveAttribute('alt', 'LESIS');
    expect(dark).toHaveClass('on-dark');
    expect(dark).toHaveAttribute('src', `/brand/lesis-${variant}-white.png`);
    expect(dark).toHaveAttribute('alt', 'LESIS');
    expect(wrap.querySelectorAll('img')).toHaveLength(2);
  });

  it('has no stray class when none is given', () => {
    const { container } = render(<LesisLogo variant="symbol" />);
    expect(container.firstElementChild!.className).toBe('lesis-logo lesis-symbol');
  });

  it('serves the logo files from under the base path', () => {
    vi.stubEnv('BASE_URL', '/attacktree/');
    const { container } = render(<LesisLogo variant="horizontal" />);
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      '/attacktree/brand/lesis-horizontal-black.png',
      '/attacktree/brand/lesis-horizontal-white.png',
    ]);
  });
});

describe('ByLesis', () => {
  it.each(['app', 'docs'] as const)('links to LESIS with the %s medium in a new tab', (medium) => {
    render(<ByLesis medium={medium} className="here" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', lesisHref(medium));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
    expect(link).toHaveAttribute('title', 'attacktree is built by LESIS');
    expect(link.className).toBe('by-lesis here');
    expect(link.querySelector('.by-lesis-by')).toHaveTextContent('by');
    expect(link.querySelector('.lesis-logo.lesis-horizontal')).not.toBeNull();
  });

  it('has no stray class when none is given', () => {
    render(<ByLesis medium="app" />);
    expect(screen.getByRole('link').className).toBe('by-lesis');
  });
});
