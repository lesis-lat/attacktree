import { ArrowRight, Menu as MenuIcon, Moon, Sun, X } from 'lucide-react';
import { marked, type Token, type Tokens } from 'marked';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import { cx } from '../ui/cx';
import { ByLesis, LesisLogo, lesisHref } from '../ui/Lesis';
import { Logo } from '../ui/Logo';
import { useTheme } from '../ui/theme';
import { Example } from './Example';
import rawGuide from './guide.md?raw';
import { highlightYaml } from './highlight';

// guide.md links to site files as "/file"; the site may live under a subpath (GitHub Pages).
const guide = rawGuide.replace(/\]\(\//g, `](${import.meta.env.BASE_URL}`);

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>|`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const GROUPS: Array<[string, string[]]> = [
  ['Start', ['introduction', 'quick-start']],
  ['Modeling', ['concepts', 'modeling-patterns', 'building-a-tree-a-method']],
  ['Reference', ['the-yaml-format', 'the-canvas', 'the-editor', 'keyboard-shortcuts']],
  ['More', ['saving-sharing-and-exporting', 'using-attacktree-with-ai', 'coming-from-deciduous', 'faq']],
];

interface Heading {
  id: string;
  text: string;
  depth: number;
}

function inline(text: string): { __html: string } {
  return { __html: marked.parseInline(text, { async: false }) };
}

function renderTokens(tokens: Token[], theme: string): ReactNode[] {
  return tokens.map((token, i) => {
    if (token.type === 'heading') {
      const h = token as Tokens.Heading;
      const id = slug(h.text);
      if (h.depth === 1) return <h1 key={i} dangerouslySetInnerHTML={inline(h.text)} />;
      const Tag = h.depth === 2 ? 'h2' : 'h3';
      return (
        <Tag key={i} id={id}>
          <a className="anchor" href={`#${id}`} aria-hidden tabIndex={-1}>
            #
          </a>
          <span dangerouslySetInnerHTML={inline(h.text)} />
        </Tag>
      );
    }
    if (token.type === 'code') {
      const c = token as Tokens.Code;
      if (/^ya?ml\b.*\bexample\b/.test(c.lang ?? '')) return <Example key={i} source={c.text + '\n'} theme={theme} />;
      return (
        <pre key={i} className="code">
          <code>{/^ya?ml/.test(c.lang ?? '') ? highlightYaml(c.text) : c.text}</code>
        </pre>
      );
    }
    if (token.type === 'space') return null;
    return <div key={i} className="md" dangerouslySetInnerHTML={{ __html: marked.parser([token], { async: false }) }} />;
  });
}

function useActiveHeading(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current: string | null = ids[0] ?? null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < 140) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [ids]);
  return active;
}

export function DocsApp() {
  const theme = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const tokens = useMemo(() => marked.lexer(guide), []);

  const headings = useMemo<Heading[]>(
    () =>
      tokens
        .filter((t): t is Tokens.Heading => t.type === 'heading' && (t as Tokens.Heading).depth >= 2)
        .map((h) => ({ id: slug(h.text), text: h.text.replace(/`/g, ''), depth: h.depth })),
    [tokens],
  );
  const sectionIds = useMemo(() => headings.filter((h) => h.depth === 2).map((h) => h.id), [headings]);
  const active = useActiveHeading(sectionIds);

  // the hero is everything before the first section
  const found = tokens.findIndex((t) => t.type === 'heading' && (t as Tokens.Heading).depth === 2);
  const firstSection = found < 0 ? tokens.length : found;
  const hero = tokens.slice(0, firstSection);
  const body = tokens.slice(firstSection);

  useEffect(() => {
    let id = '';
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return; // a malformed link must not take the page down
    }
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  }, []);

  const sub = (id: string) => {
    const at = headings.findIndex((h) => h.id === id);
    const out: Heading[] = [];
    for (let i = at + 1; i < headings.length && headings[i].depth > 2; i++) out.push(headings[i]);
    return out;
  };
  const titleOf = (id: string) => headings.find((h) => h.id === id)?.text ?? id;
  const ThemeIcon = theme.resolved === 'dark' ? Sun : Moon;
  const themeLabel = theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <div className="docs">
      <header className="docs-topbar">
        <a className="docs-brand" href={`${import.meta.env.BASE_URL}docs/`}>
          <Logo />
          <span className="brand-name">attacktree</span>
          <span className="docs-pill">Docs</span>
        </a>
        <ByLesis medium="docs" />
        <div className="docs-topbar-actions">
          <button type="button" className="icon-button docs-nav-toggle" onClick={() => setNavOpen(!navOpen)} aria-label="Contents">
            {navOpen ? <X size={17} /> : <MenuIcon size={17} />}
          </button>
          <a className="button primary" href={import.meta.env.BASE_URL}>
            Open the editor <ArrowRight size={15} />
          </a>
          <button type="button" className="icon-button" onClick={theme.toggle} title={themeLabel} aria-label={themeLabel}>
            <ThemeIcon size={16} />
          </button>
        </div>
      </header>

      <div className="docs-layout">
        <nav className={cx('docs-nav', navOpen && 'is-open')} aria-label="Contents" onClick={() => setNavOpen(false)}>
          {GROUPS.map(([group, ids]) => (
            <div key={group} className="docs-nav-group">
              <div className="docs-nav-label">{group}</div>
              {ids
                .filter((id) => sectionIds.includes(id))
                .map((id) => (
                  <Fragment key={id}>
                    <a href={`#${id}`} className={cx('docs-nav-link', active === id && 'is-active')}>
                      {titleOf(id)}
                    </a>
                    {active === id &&
                      sub(id).map((h) => (
                        <a key={h.id} href={`#${h.id}`} className="docs-nav-link is-sub">
                          {h.text}
                        </a>
                      ))}
                  </Fragment>
                ))}
            </div>
          ))}
          <div className="docs-nav-group docs-nav-machine">
            <div className="docs-nav-label">For machines</div>
            <a className="docs-nav-link" href={`${import.meta.env.BASE_URL}llms.txt`}>
              llms.txt
            </a>
            <a className="docs-nav-link" href={`${import.meta.env.BASE_URL}llms-full.txt`}>
              llms-full.txt
            </a>
            <a className="docs-nav-link" href={`${import.meta.env.BASE_URL}attacktree.schema.json`}>
              JSON Schema
            </a>
          </div>
        </nav>

        <main className="docs-main">
          <article className="docs-prose">
            <div className="docs-hero">
              <div className="docs-eyebrow">attacktree · documentation</div>
              {renderTokens(hero, theme.resolved)}
              <a className="docs-built-by" href={lesisHref('docs')} target="_blank" rel="noopener">
                <span>Built by</span>
                <LesisLogo variant="horizontal" />
              </a>
            </div>
            {renderTokens(body, theme.resolved)}
          </article>

          <section className="lesis-card" aria-label="About LESIS">
            <a href={lesisHref('docs')} target="_blank" rel="noopener" className="lesis-card-logo">
              <LesisLogo variant="horizontal" />
            </a>
            <div className="lesis-card-text">
              <p>
                <strong>attacktree is built and maintained by LESIS</strong>, a security engineering team. LESIS does security
                assessments, security consultancy, due diligence and custom tools, delivered and tracked to closure.
              </p>
              <p>Want help modeling the threats to your own systems, or testing the mitigations in your tree?</p>
              <a className="button primary" href={lesisHref('docs')} target="_blank" rel="noopener">
                Talk to LESIS <ArrowRight size={15} />
              </a>
            </div>
          </section>

          <footer className="docs-footer">
            <span>
              attacktree by{' '}
              <a href={lesisHref('docs')} target="_blank" rel="noopener">
                LESIS
              </a>
            </span>
            <span>
              Inspired by{' '}
              <a href="https://www.deciduous.app/" target="_blank" rel="noopener">
                Deciduous
              </a>{' '}
              by Ryan Petrich and Kelly Shortridge
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
