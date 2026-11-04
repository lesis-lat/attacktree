import type { ReactNode } from 'react';

/** Small YAML colorizer for read-only code blocks (the editor uses CodeMirror). */
function value(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // split off a trailing comment that is not inside quotes
  let quote: string | null = null;
  let cut = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
      // a quote opens a string only where a scalar starts, not inside a plain value ("Attacker's")
    } else if ((c === "'" || c === '"') && /(^|[\s[{,])$/.test(text.slice(0, i))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      cut = i;
      break;
    }
  }
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const comment = cut >= 0 ? text.slice(cut) : '';
  const trimmed = body.trim();
  if (trimmed) {
    const lead = body.slice(0, body.indexOf(trimmed));
    const tail = body.slice(body.indexOf(trimmed) + trimmed.length);
    let cls = 'y-plain';
    if (/^(['"]).*\1$/.test(trimmed)) cls = 'y-string';
    else if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(trimmed)) cls = 'y-atom';
    else if (/^\[.*\]$/.test(trimmed)) cls = 'y-atom';
    out.push(lead, <span key={`${key}v`} className={cls}>{trimmed}</span>, tail);
  } else {
    out.push(body);
  }
  if (comment) out.push(<span key={`${key}c`} className="y-comment">{comment}</span>);
  return out;
}

export function highlightYaml(code: string): ReactNode {
  return code.split('\n').map((line, i) => {
    const m = line.match(/^(\s*)(- )?(?:([\w$<>.-]+|'[^']*'|"[^"]*")(:)(?=\s|$))?(.*)$/);
    if (!m) return <span key={i}>{line + '\n'}</span>;
    const [, indent, dash, key, colon, rest] = m;
    return (
      <span key={i}>
        {indent}
        {dash && <span className="y-punct">{dash}</span>}
        {key && <span className="y-key">{key}</span>}
        {colon && <span className="y-punct">{colon}</span>}
        {value(rest, String(i))}
        {'\n'}
      </span>
    );
  });
}
