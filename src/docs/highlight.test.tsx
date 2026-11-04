import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { highlightYaml } from './highlight';

/** Each line as a list of [class, text] pieces; '' marks unstyled text. */
function tokens(code: string): Array<Array<[string, string]>> {
  const { container } = render(<code>{highlightYaml(code)}</code>);
  const lines = [...container.querySelector('code')!.children];
  return lines.map((line) =>
    [...line.childNodes]
      .map((n): [string, string] => [n.nodeType === Node.TEXT_NODE ? '' : (n as Element).className, n.textContent ?? ''])
      .filter(([, text]) => text !== ''),
  );
}

function text(code: string): string {
  const { container } = render(<code>{highlightYaml(code)}</code>);
  return container.textContent!;
}

describe('highlightYaml', () => {
  it('keeps the text exactly, one span per line, each ending in a newline', () => {
    const src = "title: Demo\nattacks:\n- a: Attack # note\n  from:\n  - reality: '#yolosec'\n\n# done";
    expect(text(src)).toBe(src + '\n');
    const { container } = render(<code>{highlightYaml(src)}</code>);
    const lines = [...container.querySelector('code')!.children];
    expect(lines).toHaveLength(7);
    for (const l of lines) {
      expect(l.tagName).toBe('SPAN');
      expect(l.textContent!.endsWith('\n')).toBe(true);
    }
  });

  it('colors a key, its colon and a plain value', () => {
    expect(tokens('title: Shipping a bad release')).toEqual([
      [
        ['y-key', 'title'],
        ['y-punct', ':'],
        ['', ' '],
        ['y-plain', 'Shipping a bad release'],
        ['', '\n'],
      ],
    ]);
  });

  it('colors list dashes, with and without a key', () => {
    expect(tokens('- phish: Phish an admin\n  - reality')).toEqual([
      [
        ['y-punct', '- '],
        ['y-key', 'phish'],
        ['y-punct', ':'],
        ['', ' '],
        ['y-plain', 'Phish an admin'],
        ['', '\n'],
      ],
      [
        ['', '  '],
        ['y-punct', '- '],
        ['y-plain', 'reality'],
        ['', '\n'],
      ],
    ]);
  });

  it('a key with nothing after it', () => {
    expect(tokens('attacks:')).toEqual([
      [
        ['y-key', 'attacks'],
        ['y-punct', ':'],
        ['', '\n'],
      ],
    ]);
  });

  it('whole-line comments, indented or not', () => {
    expect(tokens('# Where nodes were dragged\n  # inner')).toEqual([
      [
        ['y-comment', '# Where nodes were dragged'],
        ['', '\n'],
      ],
      [
        ['', '  '],
        ['y-comment', '# inner'],
        ['', '\n'],
      ],
    ]);
  });

  it('splits off a trailing comment after a value or a bare key', () => {
    expect(tokens('- reality                    # plain connection')).toEqual([
      [
        ['y-punct', '- '],
        ['y-plain', 'reality'],
        ['', '                    '],
        ['y-comment', '# plain connection'],
        ['', '\n'],
      ],
    ]);
    expect(tokens('- code_review:   # a map')).toEqual([
      [
        ['y-punct', '- '],
        ['y-key', 'code_review'],
        ['y-punct', ':'],
        ['', '   '],
        ['y-comment', '# a map'],
        ['', '\n'],
      ],
    ]);
  });

  it('a # inside quotes is part of the string, not a comment', () => {
    expect(tokens("- leaked_keys: '#yolosec'    # connection with a label")).toEqual([
      [
        ['y-punct', '- '],
        ['y-key', 'leaked_keys'],
        ['y-punct', ':'],
        ['', ' '],
        ['y-string', "'#yolosec'"],
        ['', '    '],
        ['y-comment', '# connection with a label'],
        ['', '\n'],
      ],
    ]);
    expect(tokens('a: "x # y"')).toEqual([
      [
        ['y-key', 'a'],
        ['y-punct', ':'],
        ['', ' '],
        ['y-string', '"x # y"'],
        ['', '\n'],
      ],
    ]);
  });

  it('a # glued to a word is not a comment', () => {
    expect(tokens('a: C#sharp')).toEqual([
      [
        ['y-key', 'a'],
        ['y-punct', ':'],
        ['', ' '],
        ['y-plain', 'C#sharp'],
        ['', '\n'],
      ],
    ]);
  });

  it('an apostrophe inside a plain value does not hide the comment after it', () => {
    expect(tokens("- a: Attacker's laptop # note")).toEqual([
      [
        ['y-punct', '- '],
        ['y-key', 'a'],
        ['y-punct', ':'],
        ['', ' '],
        ['y-plain', "Attacker's laptop"],
        ['', ' '],
        ['y-comment', '# note'],
        ['', '\n'],
      ],
    ]);
  });

  it('an escaped quote does not end a double-quoted string', () => {
    expect(tokens('a: "say \\" # not a comment" # comment')).toEqual([
      [
        ['y-key', 'a'],
        ['y-punct', ':'],
        ['', ' '],
        ['y-string', '"say \\" # not a comment"'],
        ['', ' '],
        ['y-comment', '# comment'],
        ['', '\n'],
      ],
    ]);
  });

  it('quotes inside a flow list still protect a #, and the comment after the list is found', () => {
    expect(tokens("k: ['a #b', \"c\"] # note")).toEqual([
      [
        ['y-key', 'k'],
        ['y-punct', ':'],
        ['', ' '],
        ['y-atom', "['a #b', \"c\"]"],
        ['', ' '],
        ['y-comment', '# note'],
        ['', '\n'],
      ],
    ]);
  });

  it.each([
    ['true'],
    ['false'],
    ['null'],
    ['~'],
    ['42'],
    ['-7'],
    ['3.14'],
    ['[120, 40]'],
  ])('%s is an atom', (v) => {
    expect(tokens(`k: ${v}`)[0]).toContainEqual(['y-atom', v]);
  });

  it.each([['yes'], ['1.2.3'], ['truely'], ["'a' and 'b"]])('%s is not an atom', (v) => {
    expect(tokens(`k: ${v}`)[0].some(([c]) => c === 'y-atom')).toBe(false);
  });

  it('double-quoted and single-quoted values are strings', () => {
    expect(tokens('k: "two words"')[0]).toContainEqual(['y-string', '"two words"']);
    expect(tokens("k: 'it''s'")[0]).toContainEqual(['y-string', "'it''s'"]);
  });

  it('quoted keys and keys with dots, dollars and dashes', () => {
    expect(tokens("'my key': v")[0].slice(0, 2)).toEqual([
      ['y-key', "'my key'"],
      ['y-punct', ':'],
    ]);
    expect(tokens('"k2": v')[0][0]).toEqual(['y-key', '"k2"']);
    expect(tokens('$schema.x-y: v')[0][0]).toEqual(['y-key', '$schema.x-y']);
  });

  it('a colon not followed by space is not a key separator', () => {
    expect(tokens('- https://example.com')).toEqual([
      [
        ['y-punct', '- '],
        ['y-plain', 'https://example.com'],
        ['', '\n'],
      ],
    ]);
  });

  it('keeps surrounding whitespace around a value', () => {
    expect(tokens('k:   v   ')).toEqual([
      [
        ['y-key', 'k'],
        ['y-punct', ':'],
        ['', '   '],
        ['y-plain', 'v'],
        ['', '   '],
        ['', '\n'],
      ],
    ]);
  });

  it('empty and whitespace-only lines', () => {
    expect(tokens('\n   ')).toEqual([[['', '\n']], [['', '   '], ['', '\n']]]);
  });

  it('a line the pattern cannot read (a carriage return) is kept as plain text', () => {
    const { container } = render(<code>{highlightYaml('a: b\r\nc: d')}</code>);
    const [first, second] = container.querySelector('code')!.children;
    expect(first.children).toHaveLength(0);
    expect(first.textContent).toBe('a: b\r\n');
    expect(second.querySelector('.y-key')).toHaveTextContent('c');
  });
});
