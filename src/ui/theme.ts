import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'attacktree:theme';

const systemTheme = (): Theme => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** The theme the user picked, or null to follow the system (older versions also stored "system"). */
function readChoice(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Shared by the editor and the docs. Starts from the system theme; the button
 * toggles between light and dark, and that choice is remembered per browser.
 */
export function useTheme() {
  const [choice, setChoice] = useState<Theme | null>(readChoice);
  const [system, setSystem] = useState<Theme>(systemTheme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const resolved: Theme = choice ?? system;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  const toggle = () => {
    const next: Theme = resolved === 'dark' ? 'light' : 'dark';
    setChoice(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode */
    }
  };
  return { resolved, toggle };
}
