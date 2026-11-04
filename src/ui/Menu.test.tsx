import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmItem, Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';

function Harness(props: { onA?: () => void; onDelete?: () => void; align?: 'left' | 'right' }) {
  return (
    <div>
      <span>outside</span>
      <Menu label="File" title="File menu" className="ghost" align={props.align}>
        <MenuLabel>Section</MenuLabel>
        <MenuItem icon={<i data-testid="icon-a" />} hint="Ctrl+A" onSelect={props.onA ?? (() => {})}>
          Alpha
        </MenuItem>
        <MenuSeparator />
        <ConfirmItem icon={<i />} confirmText="Click again to delete" onConfirm={props.onDelete ?? (() => {})}>
          Delete
        </ConfirmItem>
      </Menu>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'File' });

describe('Menu', () => {
  it('is closed initially and the trigger advertises a menu', () => {
    render(<Harness />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('title', 'File menu');
    expect(trigger()).toHaveAttribute('type', 'button');
    expect(trigger().className).toBe('button ghost');
  });

  it('opens and closes by clicking the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger().className).toBe('button ghost is-open');
    await user.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens from the keyboard (Enter and Space on the trigger)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard(' ');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a pointer down outside, but not inside', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    fireEvent.pointerDown(screen.getByText('Section'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape, and ignores other keys', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.keyboard('a');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('removes its document listeners when it closes or unmounts', async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<Harness />);
    expect(add.mock.calls.filter(([t]) => t === 'pointerdown' || t === 'keydown')).toHaveLength(0);
    await user.click(trigger());
    const ours = add.mock.calls.filter(([t]) => t === 'pointerdown' || t === 'keydown');
    expect(ours.map(([t]) => t)).toEqual(['pointerdown', 'keydown']);
    await user.click(trigger());
    for (const [type, fn] of ours) expect(remove).toHaveBeenCalledWith(type, fn);

    await user.click(trigger());
    const again = add.mock.calls.filter(([t]) => t === 'pointerdown' || t === 'keydown').slice(2);
    unmount();
    for (const [type, fn] of again) expect(remove).toHaveBeenCalledWith(type, fn);
  });

  it('aligns left by default and right on request', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(trigger());
    expect(screen.getByRole('menu').className).toBe('menu');
    unmount();
    render(<Harness align="right" />);
    await user.click(trigger());
    expect(screen.getByRole('menu').className).toBe('menu align-right');
  });

  it('works without title or className', async () => {
    const user = userEvent.setup();
    render(
      <Menu label="Bare">
        <MenuItem onSelect={() => {}}>Only</MenuItem>
      </Menu>,
    );
    const button = screen.getByRole('button', { name: 'Bare' });
    expect(button.className).toBe('button');
    expect(button).not.toHaveAttribute('title');
    await user.click(button);
    expect(screen.getByRole('menuitem', { name: 'Only' })).toBeInTheDocument();
  });

  it('closes after a click anywhere inside the menu', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(screen.getByText('Section'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('MenuItem', () => {
  it('runs onSelect once and closes the menu', async () => {
    const user = userEvent.setup();
    const onA = vi.fn();
    render(<Harness onA={onA} />);
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: /Alpha/ }));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('can be chosen with the keyboard', async () => {
    const user = userEvent.setup();
    const onA = vi.fn();
    render(<Harness onA={onA} />);
    await user.click(trigger());
    screen.getByRole('menuitem', { name: /Alpha/ }).focus();
    await user.keyboard('{Enter}');
    expect(onA).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders icon, text and hint in order', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    const item = screen.getByRole('menuitem', { name: /Alpha/ });
    expect(item).toHaveAttribute('type', 'button');
    expect([...item.children].map((c) => c.className)).toEqual(['menu-icon', 'menu-text', 'menu-hint']);
    expect(item.querySelector('.menu-icon [data-testid="icon-a"]')).not.toBeNull();
    expect(item.querySelector('.menu-text')).toHaveTextContent('Alpha');
    expect(item.querySelector('.menu-hint')).toHaveTextContent('Ctrl+A');
  });

  it('omits the hint, and reflects active and danger in its classes', () => {
    const { rerender } = render(<MenuItem onSelect={() => {}}>Plain</MenuItem>);
    let item = screen.getByRole('menuitem');
    expect(item.className).toBe('menu-item');
    expect(item.querySelector('.menu-hint')).toBeNull();
    expect(item.querySelector('.menu-icon')).toBeEmptyDOMElement();
    rerender(
      <MenuItem onSelect={() => {}} active danger>
        Plain
      </MenuItem>,
    );
    item = screen.getByRole('menuitem');
    expect(item.className).toBe('menu-item is-active danger');
  });
});

describe('ConfirmItem', () => {
  it('needs a second click: the first arms it and keeps the menu open', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Harness onDelete={onDelete} />);
    await user.click(trigger());
    const item = screen.getByRole('menuitem', { name: /Delete/ });
    expect(item.className).toBe('menu-item danger');
    await user.click(item);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(item).toHaveTextContent('Click again to delete');
    expect(item.className).toBe('menu-item danger is-armed');
    await user.click(item);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('disarms when the pointer leaves', async () => {
    const onDelete = vi.fn();
    render(<ConfirmItem confirmText="Sure?" onConfirm={onDelete}>Delete</ConfirmItem>);
    const item = screen.getByRole('menuitem');
    fireEvent.click(item);
    expect(item).toHaveTextContent('Sure?');
    fireEvent.mouseLeave(item);
    expect(item).toHaveTextContent('Delete');
    expect(item.className).toBe('menu-item danger');
    fireEvent.click(item);
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(item);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('starts disarmed again when the menu is reopened', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Harness onDelete={onDelete} />);
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: /Delete/ }));
    await user.keyboard('{Escape}');
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('MenuSeparator and MenuLabel', () => {
  it('render their markup', () => {
    const { container } = render(
      <>
        <MenuSeparator />
        <MenuLabel>Recent</MenuLabel>
      </>,
    );
    expect(screen.getByRole('separator')).toHaveClass('menu-separator');
    expect(container.querySelector('.menu-label')).toHaveTextContent('Recent');
  });
});
