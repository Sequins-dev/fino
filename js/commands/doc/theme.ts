/**
 * fino:commands/doc/theme — the page component contract for `fino doc`.
 *
 * Every page `fino doc build` emits is produced by a component. This module
 * defines the props that component receives and ships the default one, so
 * replacing the look of a documentation site means writing a component rather
 * than patching the generator.
 *
 * A theme is an ordinary module whose default export is a `fino:ui` component
 * taking `DocsPageProps`. It renders in an isolated realm, so its props are
 * plain JSON and its output is a portable tree: a theme cannot reach the
 * generator's filesystem, its parser, or its process.
 *
 * Each page arrives twice over. `page` carries the structured record — the
 * parsed `ModuleDoc`, `GuideDoc`, or index data — for a theme that wants to lay
 * out symbols itself. `prepared` carries the same content already rendered to
 * HTML, because Markdown, cross-reference resolution, and syntax highlighting
 * need the parser and cannot happen inside the realm. Use `prepared` for the
 * prose and `page` for the structure, or ignore either one.
 *
 * ```ts no_run
 * import { h } from 'fino:ui';
 * import { rawHtml } from 'fino:ui/html';
 * import type { DocsPageProps } from 'fino:commands/doc/theme';
 *
 * export default function Page(props: DocsPageProps) {
 *   return h('html', null,
 *     h('head', null, h('title', null, props.page.title)),
 *     h('body', null, rawHtml(props.prepared.contentHtml)),
 *   );
 * }
 * ```
 */
import { Fragment, h, type VNode } from 'fino:ui';
import { rawHtml } from 'fino:ui/html';
import type {
  ApiDoc,
  GuideDoc,
  HtmlExport,
  HtmlGroup,
  HtmlGuide,
  HtmlMember,
  HtmlModule,
  ModuleDoc,
} from '../doc.ts';

export type { ApiDoc, GuideDoc, HtmlExport, HtmlGroup, HtmlGuide, HtmlMember, HtmlModule, ModuleDoc };

/**
 * One entry in the documentation navigation tree.
 *
 * Directory nodes carry children and no `href`. Leaf nodes carry an `href`
 * relative to the site root, which `relativeHref()` rewrites for the page being
 * rendered.
 */
export interface DocsNavNode {
  /** Display label for this entry. */
  label: string;
  /** Site-root-relative target, absent for grouping nodes. */
  href?: string;
  /** Which collection this entry belongs to. */
  kind?: 'api' | 'guide';
  /** Nested entries, empty for leaves. */
  children: DocsNavNode[];
}

/** Site-wide data shared by every page. */
export interface DocsSite {
  /** Site title, inferred from `package.json` or `Cargo.toml` unless overridden. */
  title: string;
  /** Navigation tree covering every guide and module. */
  nav: DocsNavNode[];
  /** Site-root-relative stylesheet path written by the generator. */
  cssHref: string;
  /** Site-root-relative client script path written by the generator. */
  scriptHref: string;
  /** Every documented module, in output order. */
  modules: ModuleDoc[];
  /** Every authored guide, in output order. */
  guides: GuideDoc[];
}

/** An API reference page for one module. */
export interface DocsModulePage {
  kind: 'module';
  /** Site-root-relative output path for this page. */
  href: string;
  /** Page title, without the site title. */
  title: string;
  /** Parsed module record, identical to its `api.json` entry. */
  module: ModuleDoc;
}

/** A page for one authored Markdown guide. */
export interface DocsGuidePage {
  kind: 'guide';
  href: string;
  title: string;
  /** Parsed guide record, including its original Markdown in `text`. */
  guide: GuideDoc;
}

/** The site landing page, built from the project README. */
export interface DocsIndexPage {
  kind: 'index';
  href: string;
  title: string;
}

/** The page currently being rendered. */
export type DocsPage = DocsModulePage | DocsGuidePage | DocsIndexPage;

/**
 * Content the generator rendered ahead of the theme.
 *
 * Markdown, cross-reference links, and syntax highlighting need the doc parser,
 * which does not exist inside the rendering realm. These are trusted HTML
 * strings from the generator; pass them to `rawHtml()`.
 */
export interface DocsPrepared {
  /** Complete page body: symbol sections, guide prose, or the rendered README. */
  contentHtml: string;
  /** In-page table of contents, or an empty string when the page has none. */
  pageIndexHtml: string;
  /** Structured module content, present only for module pages. */
  module?: HtmlModule;
  /** Structured guide content, present only for guide pages. */
  guide?: HtmlGuide;
}

/** Props passed to a documentation page component. */
export interface DocsPageProps {
  /** Data shared by every page in the site. */
  site: DocsSite;
  /** The page being rendered. */
  page: DocsPage;
  /** Generator-rendered HTML for this page. */
  prepared: DocsPrepared;
}

/**
 * Rewrite a site-root-relative href for the page currently being rendered.
 *
 * Navigation and asset paths arrive relative to the site root so one navigation
 * tree serves every page. Absolute URLs and fragments pass through unchanged.
 *
 * ```ts no_run
 * import { relativeHref } from 'fino:commands/doc/theme';
 *
 * const href = relativeHref('net/http.html', 'index.html');
 * ```
 */
export function relativeHref(fromHref: string, toHref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(toHref) || toHref.startsWith('#')) return toHref;
  const fromParts = fromHref.split('/').filter(Boolean);
  const toParts = toHref.split('/').filter(Boolean);
  fromParts.pop();
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  const joined = [...fromParts.map(() => '..'), ...toParts].join('/');
  if (joined !== '') return joined;
  const slash = toHref.lastIndexOf('/');
  return slash < 0 ? toHref : toHref.slice(slash + 1);
}

const GUIDE_ICON =
  '<svg class="docs-sidebar-icon docs-sidebar-icon-guide" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 8h2"/><path d="M6 12h2"/><path d="M16 8h2"/><path d="M16 12h2"/></svg>';
const API_ICON =
  '<svg class="docs-sidebar-icon docs-sidebar-icon-api" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>';

function navItems(nodes: DocsNavNode[], currentHref: string): VNode | null {
  if (nodes.length === 0) return null;
  return h(
    'ul',
    null,
    nodes.map((node) => navItem(node, currentHref)),
  );
}

function navItem(node: DocsNavNode, currentHref: string): VNode {
  const children = navItems(node.children, currentHref);
  if (node.href === undefined)
    return h('li', null, h('div', { class: 'docs-sidebar-directory' }, node.label), children);
  return h(
    'li',
    null,
    h(
      'a',
      {
        class: `docs-sidebar-link docs-sidebar-link-${node.kind ?? 'api'}`,
        href: relativeHref(currentHref, node.href),
        'aria-current': node.href === currentHref ? 'page' : undefined,
      },
      rawHtml(node.kind === 'guide' ? GUIDE_ICON : API_ICON),
      h('span', null, node.label),
    ),
    children,
  );
}

/**
 * Render the default documentation sidebar.
 *
 * Exported so a theme that wants its own chrome can keep the standard
 * navigation, or wrap it.
 */
export function Sidebar(props: { site: DocsSite; currentHref: string }): VNode {
  return h(
    'nav',
    { class: 'docs-sidebar', 'aria-label': 'Documentation navigation' },
    h(
      'p',
      { class: 'docs-sidebar-title' },
      h('a', { href: relativeHref(props.currentHref, 'index.html') }, props.site.title),
    ),
    navItems(props.site.nav, props.currentHref),
  );
}

/**
 * Render the standard body of one module reference page.
 *
 * The generator uses this to build `DocsPrepared.contentHtml` for module pages,
 * so a theme that wants custom chrome around the standard symbol layout renders
 * exactly what the default theme does.
 *
 * ```ts no_run
 * import { h } from 'fino:ui';
 * import { ModuleBody } from 'fino:commands/doc/theme';
 *
 * const body = h('article', null, h(ModuleBody, { module: prepared.module! }));
 * ```
 */
export function ModuleBody(props: { module: HtmlModule }): VNode {
  const module = props.module;
  return h(
    Fragment,
    null,
    h('h1', { id: module.id }, module.name),
    h('p', { class: 'muted' }, module.path),
    rawHtml(module.docHtml),
    module.hasGroups ? null : h('p', { class: 'muted' }, 'No exported declarations found.'),
    module.groups.map((group: HtmlGroup<HtmlExport>) =>
      h(
        Fragment,
        null,
        h('h2', null, group.title),
        group.items.map((item) =>
          h(
            'section',
            { class: 'docs-symbol', id: item.id },
            h('h3', null, rawHtml(item.titleHtml)),
            rawHtml(item.overloadsHtml),
            rawHtml(item.docHtml),
            item.memberGroups.map((memberGroup: HtmlGroup<HtmlMember>) =>
              h(
                Fragment,
                null,
                h('h4', null, memberGroup.title),
                memberGroup.items.map((member) =>
                  h(
                    'section',
                    { class: 'member', id: member.id },
                    h('h5', null, rawHtml(member.titleHtml)),
                    rawHtml(member.overloadsHtml),
                    rawHtml(member.docHtml),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Render the standard body of one guide page.
 *
 * The generator uses this for `DocsPrepared.contentHtml` on guide pages.
 */
export function GuideBody(props: { guide: HtmlGuide }): VNode {
  return h(
    Fragment,
    null,
    h('h1', { id: props.guide.id }, props.guide.title),
    h('p', { class: 'muted' }, props.guide.path),
    rawHtml(props.guide.html),
  );
}

/**
 * The documentation page component used when no `--theme` is given.
 *
 * It renders the standard three-column layout: navigation, page body, and an
 * in-page table of contents when the page has one.
 */
export default function DocsPageComponent(props: DocsPageProps): VNode {
  const { site, page, prepared } = props;
  const hasPageIndex = prepared.pageIndexHtml !== '';
  return h(
    'html',
    null,
    h(
      'head',
      null,
      h('meta', { charset: 'utf-8' }),
      h('title', null, page.kind === 'index' ? site.title : `${site.title} - ${page.title}`),
      h('link', { rel: 'stylesheet', href: relativeHref(page.href, site.cssHref) }),
    ),
    h(
      'body',
      null,
      h(
        'div',
        { class: `docs-layout${hasPageIndex ? ' docs-layout-api' : ''}` },
        h(Sidebar, { site, currentHref: page.href }),
        hasPageIndex ? rawHtml(prepared.pageIndexHtml) : null,
        h('main', null, rawHtml(prepared.contentHtml)),
      ),
      h('script', {
        src: relativeHref(page.href, site.scriptHref),
        defer: true,
        'data-docs-client-navigation': true,
      }),
    ),
  );
}
