import { describe, expect, it } from 'vitest';
import { cx } from './cx';

describe('cx', () => {
  it('joins truthy class names with single spaces', () => {
    expect(cx('a', 'b', 'c')).toBe('a b c');
  });

  it('drops false, null, undefined and empty strings', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('returns an empty string when nothing is left', () => {
    expect(cx()).toBe('');
    expect(cx(false, null, undefined)).toBe('');
  });
});
