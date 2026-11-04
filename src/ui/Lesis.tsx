import { cx } from './cx';

export const LESIS_URL = 'https://lesis.lat/';

/** Every link to LESIS says where it came from, so the channel can be measured. */
export function lesisHref(medium: 'app' | 'docs' | 'export'): string {
  return `${LESIS_URL}?utm_source=attacktree&utm_medium=${medium}`;
}

/** Official assets only, never recolored: black on light backgrounds, white on dark. */
export function LesisLogo({ variant, className }: { variant: 'horizontal' | 'symbol'; className?: string }) {
  return (
    <span className={cx('lesis-logo', `lesis-${variant}`, className)}>
      <img className="on-light" src={`${import.meta.env.BASE_URL}brand/lesis-${variant}-black.png`} alt="LESIS" />
      <img className="on-dark" src={`${import.meta.env.BASE_URL}brand/lesis-${variant}-white.png`} alt="LESIS" />
    </span>
  );
}

export function ByLesis({ medium, className }: { medium: 'app' | 'docs'; className?: string }) {
  return (
    <a className={cx('by-lesis', className)} href={lesisHref(medium)} target="_blank" rel="noopener" title="attacktree is built by LESIS">
      <span className="by-lesis-by">by</span>
      <LesisLogo variant="horizontal" />
    </a>
  );
}
