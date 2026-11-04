import { CircleAlert, CircleCheck } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { cx } from './cx';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = next.current++;
    setToasts((all) => [...all.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), tone === 'error' ? 5200 : 3200);
  }, []);
  return { toasts, push };
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.tone === 'error' && 'is-error')}>
          {t.tone === 'error' ? <CircleAlert size={15} /> : <CircleCheck size={15} />}
          {t.message}
        </div>
      ))}
    </div>
  );
}
