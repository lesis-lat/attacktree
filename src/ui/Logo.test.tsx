import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Logo } from './Logo';

describe('Logo', () => {
  it('is a decorative 22px svg with three boxes and the connecting lines', () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveClass('logo');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '22');
    expect(svg).toHaveAttribute('height', '22');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect([...svg.querySelectorAll('rect')].map((r) => r.getAttribute('class'))).toEqual(['logo-a', 'logo-b', 'logo-c']);
    expect(svg.querySelector('path')).toHaveClass('logo-line');
  });
});
