import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { KIND_LABEL } from '../model/types';
import { cx } from '../ui/cx';

const KINDS = ['reality', 'fact', 'attack', 'mitigation', 'goal'] as const;

function readOpen(): boolean {
  try {
    return localStorage.getItem('attacktree:legend') === 'open';
  } catch {
    return false;
  }
}

export function Legend() {
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem('attacktree:legend', open ? 'closed' : 'open');
    } catch {
      /* ignore */
    }
  };
  return (
    <div className={cx('legend', open && 'is-open')}>
      <button type="button" className="legend-toggle" onClick={toggle}>
        Legend {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {open && (
        <div className="legend-body">
          <ul className="legend-kinds">
            {KINDS.map((k) => (
              <li key={k} className={`kind-${k}`}>
                <span className="legend-swatch" />
                {KIND_LABEL[k]}
              </li>
            ))}
          </ul>
          <ul className="legend-edges">
            <li>
              <svg width="28" height="8" aria-hidden>
                <line x1="1" y1="4" x2="27" y2="4" className="legend-line" />
              </svg>
              Leads to
            </li>
            <li>
              <svg width="28" height="8" aria-hidden>
                <line x1="1" y1="4" x2="27" y2="4" className="legend-line is-backwards" />
              </svg>
              Forces the attacker back up
            </li>
            <li>
              <svg width="28" height="8" aria-hidden>
                <line x1="1" y1="4" x2="27" y2="4" className="legend-line is-unimplemented" />
              </svg>
              Not implemented yet
            </li>
            <li>
              <span className="edge-label is-tag legend-tag">#yolosec</span>
              No mitigation in place
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
