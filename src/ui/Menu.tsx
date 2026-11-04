import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from './cx';

interface MenuProps {
  label: ReactNode;
  title?: string;
  className?: string;
  align?: 'left' | 'right';
  children: ReactNode;
}

export function Menu({ label, title, className, align = 'left', children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu-root" ref={root}>
      <button
        type="button"
        className={cx('button', className, open && 'is-open')}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div className={cx('menu', align === 'right' && 'align-right')} role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

interface ItemProps {
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  active?: boolean;
  danger?: boolean;
  onSelect(): void;
}

export function MenuItem({ icon, children, hint, active, danger, onSelect }: ItemProps) {
  return (
    <button type="button" role="menuitem" className={cx('menu-item', active && 'is-active', danger && 'danger')} onClick={onSelect}>
      <span className="menu-icon">{icon}</span>
      <span className="menu-text">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}

/** Destructive item: the first click arms it, the second one runs it. */
export function ConfirmItem({ icon, children, confirmText, onConfirm }: { icon?: ReactNode; children: ReactNode; confirmText: string; onConfirm(): void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      className={cx('menu-item danger', armed && 'is-armed')}
      onClick={(e) => {
        if (!armed) {
          e.stopPropagation();
          setArmed(true);
          return;
        }
        onConfirm();
      }}
      onMouseLeave={() => setArmed(false)}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-text">{armed ? confirmText : children}</span>
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>;
}
