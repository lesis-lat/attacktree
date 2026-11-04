import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { copyText, renderSvg } from '../export/exporters';
import { computeLayout } from '../layout/layout';
import { fontsReady } from '../layout/measure';
import { withPins } from '../layout/pins';
import { visibleIds } from '../model/analysis';
import { parseTree } from '../model/parse';
import { encodeShare } from '../model/share';
import { highlightYaml } from './highlight';

/** A YAML snippet next to the diagram the real layout engine draws for it. */
export function Example({ source, theme }: { source: string; theme: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [href, setHref] = useState('/');
  const [copied, setCopied] = useState(false);
  const prefix = `ex${useId().replace(/[^a-z0-9]/gi, '')}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fontsReady();
      const tree = parseTree(source);
      const base = await computeLayout(tree, visibleIds(tree));
      const layout = withPins(base, tree, tree.positions);
      const { svg } = await renderSvg(tree, layout, null, { embedFont: false, showTitle: false, idPrefix: prefix, credit: false });
      if (!cancelled) setSvg(svg);
    })().catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
  }, [source, theme, prefix]);

  useEffect(() => {
    encodeShare(source).then((hash) => setHref(`/${hash}`));
  }, [source]);

  const title = source.match(/^title:\s*(.+)$/m)?.[1];

  return (
    <figure className="example">
      <div className="example-diagram" aria-label={title ? `Diagram: ${title}` : 'Diagram'}>
        {svg ? <div className="example-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="example-loading" />}
      </div>
      <div className="example-code">
        <pre>
          <code>{highlightYaml(source.trimEnd())}</code>
        </pre>
        <button
          type="button"
          className="code-copy"
          title="Copy YAML"
          onClick={async () => {
            if (await copyText(source)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <figcaption>
        {title && <span className="example-title">{title}</span>}
        <a className="example-open" href={href} target="_blank" rel="noopener">
          Open in the editor <ArrowUpRight size={14} />
        </a>
      </figcaption>
    </figure>
  );
}
