import { describe, expect, it } from 'vitest';
import { EXAMPLE_CICD } from '../model/examples';
import { parseTree } from '../model/parse';
import { aiPrompt, stripFences } from './prompt';

describe('aiPrompt', () => {
  it('ends with the current tree in a yaml fence, then the request heading', () => {
    const p = aiPrompt('title: T\nattacks:\n- a: A\n');
    expect(p.startsWith('You are helping me edit an attack tree')).toBe(true);
    expect(p.endsWith('CURRENT TREE\n```yaml\ntitle: T\nattacks:\n- a: A\n```\n\nMY REQUEST\n')).toBe(true);
  });

  it('trims trailing blank lines of the tree but keeps leading comments', () => {
    const p = aiPrompt('# header\ntitle: T\n\n\n   \n');
    expect(p).toContain('```yaml\n# header\ntitle: T\n```');
  });

  it('works for an empty tree', () => {
    expect(aiPrompt('')).toContain('CURRENT TREE\n```yaml\n\n```\n');
  });

  it('explains every section and flag of the format', () => {
    const p = aiPrompt(EXAMPLE_CICD);
    for (const word of ['title', 'facts', 'attacks', 'mitigations', 'goals', 'filter', 'positions', 'from', 'reality', 'backwards: true', 'implemented: false', "'#yolosec'"]) {
      expect(p).toContain(word);
    }
  });

  it('a reply that wraps the tree in a fence gives the tree back', () => {
    const reply = `Here is the updated tree:\n\n\`\`\`yaml\n${EXAMPLE_CICD}\`\`\`\n\nI added nothing.`;
    expect(stripFences(reply)).toBe(EXAMPLE_CICD);
    expect(parseTree(stripFences(reply)).diagnostics).toEqual([]);
  });
});

describe('stripFences', () => {
  it('leaves text without fences alone', () => {
    expect(stripFences('title: plain\n')).toBe('title: plain\n');
    expect(stripFences('')).toBe('');
    expect(stripFences('a ``code`` b')).toBe('a ``code`` b');
  });

  it('keeps the content of a single block, with or without a language', () => {
    expect(stripFences('```yaml\ntitle: T\n```')).toBe('title: T\n');
    expect(stripFences('```\ntitle: T\n```\n')).toBe('title: T\n');
    expect(stripFences('```yml title="tree.yml"\ntitle: T\n```')).toBe('title: T\n');
  });

  it('drops the prose around the block', () => {
    expect(stripFences('Sure! Here it is:\n\n```yaml\ntitle: T\n```\n\nLet me know.')).toBe('title: T\n');
  });

  it('picks the longest block when there are several', () => {
    const reply = 'Run:\n```sh\nnpm i\n```\nThen:\n```yaml\ntitle: T\nattacks:\n- a: A\n```\nOr in short:\n```yaml\ntitle: T\n```\n';
    expect(stripFences(reply)).toBe('title: T\nattacks:\n- a: A\n');
  });

  it('keeps CRLF line endings inside the block', () => {
    expect(stripFences('```yaml\r\ntitle: T\r\n```\r\n')).toBe('title: T\r\n');
  });

  it('handles empty blocks and longer fences', () => {
    expect(stripFences('```yaml\n```')).toBe('');
    expect(stripFences('````yaml\ntitle: T\n````')).toBe('title: T\n');
  });

  it('strips a lone opening or closing fence (a reply cut short, or pasted halfway)', () => {
    expect(stripFences('```yaml\ntitle: T\n')).toBe('title: T\n');
    expect(stripFences('```yaml')).toBe('');
    expect(stripFences('title: T\n```')).toBe('title: T\n');
    expect(stripFences('title: T\n```  \n')).toBe('title: T\n');
  });

  it('leaves triple backticks in the middle of a line alone when they open no block', () => {
    expect(stripFences('title: use ``` for code')).toBe('title: use ``` for code');
  });
});

describe('stripFences: only real fence lines count', () => {
  it('ignores backticks inside a sentence, so the prompt itself gives the tree back', () => {
    const tree = 'title: T\nattacks:\n- a: A\n';
    expect(stripFences(aiPrompt(tree))).toBe(tree);
    expect(stripFences('Wrap it in a ``` block:\n```yaml\ntitle: T\n```\n')).toBe('title: T\n');
  });

  it('keeps what follows the opening fence when a reply was cut short after some prose', () => {
    expect(stripFences('Sure, here it is:\n\n```yaml\ntitle: T\nattacks:\n- a: A\n')).toBe('title: T\nattacks:\n- a: A\n');
  });

  it('accepts fences indented by up to three spaces', () => {
    expect(stripFences('   ```yaml\ntitle: T\n   ```\n')).toBe('title: T\n');
  });
});
