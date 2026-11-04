import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Legend } from './Legend';

const KEY = 'attacktree:legend';
const toggle = () => screen.getByRole('button', { name: /Legend/ });

describe('Legend', () => {
  it('starts closed', () => {
    const { container } = render(<Legend />);
    expect(container.firstChild).not.toHaveClass('is-open');
    expect(screen.queryByText('Leads to')).toBeNull();
  });

  it('opens and closes, and remembers the choice', async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<Legend />);
    await user.click(toggle());
    expect(container.firstChild).toHaveClass('is-open');
    expect(localStorage.getItem(KEY)).toBe('open');
    for (const kind of ['Reality', 'Fact', 'Attack', 'Mitigation', 'Goal']) expect(screen.getByText(kind)).toBeInTheDocument();
    expect(container.querySelector('.legend-kinds .kind-mitigation')).toHaveTextContent('Mitigation');
    for (const text of ['Leads to', 'Forces the attacker back up', 'Not implemented yet', '#yolosec', 'No mitigation in place']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(container.querySelector('.legend-line.is-backwards')).not.toBeNull();
    expect(container.querySelector('.legend-line.is-unimplemented')).not.toBeNull();

    unmount();
    const again = render(<Legend />);
    expect(again.container.firstChild).toHaveClass('is-open');
    await user.click(toggle());
    expect(again.container.firstChild).not.toHaveClass('is-open');
    expect(screen.queryByText('Leads to')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('closed');
  });

  it('works when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const user = userEvent.setup();
    const { container } = render(<Legend />);
    expect(container.firstChild).not.toHaveClass('is-open');
    await user.click(toggle());
    expect(container.firstChild).toHaveClass('is-open');
  });

  it('ignores values it did not write', () => {
    localStorage.setItem(KEY, 'true');
    const { container } = render(<Legend />);
    expect(container.firstChild).not.toHaveClass('is-open');
  });
});
