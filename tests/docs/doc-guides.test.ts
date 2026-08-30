/** Documentation guides integration tests. */
import { after, before, describe, it } from 'fino:test/test';
import {
  createDocTestFixture,
  type DocTestFixture,
  removeDocTestFixture,
  type DocJsonOutput,
  TEST_DIR,
  ensureDir,
  exists,
  removeTree,
  runCli,
  runCliProcess,
} from './doc-test-helpers.ts';

describe('fino doc: guides', () => {
  let fixture!: DocTestFixture;
  let fs!: DocTestFixture['fs'];
  let appDir!: string;

  before(async () => {
    fixture = await createDocTestFixture();
    ({ fs, appDir } = fixture);
  });

  after(async () => {
    await removeDocTestFixture(fixture);
  });
  it('writes README-backed root html index and mirrors source paths', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli(
      [
        'doc',
        'build',
        './advanced.ts',
        './pkg/index.ts',
        './alpha/client.ts',
        './beta/client.ts',
        './internal-only.ts',
        '--format',
        'html',
        '--title',
        'Docs Site',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const index = await fs.readFile(docsDir + '/index.html');
    const docsCss = await fs.readFile(docsDir + '/docs.css');
    const docsJs = await fs.readFile(docsDir + '/docs.js');
    t.ok(index.includes('<title>Docs Site</title>'), 'root index has site title');
    t.ok(
      index.includes('<link rel="stylesheet" href="docs.css">'),
      'root index links shared docs css',
    );
    t.ok(
      index.includes('<script src="docs.js" defer data-docs-client-navigation><\/script>'),
      'root index links shared docs javascript',
    );
    t.equal(index.includes('<style>'), false, 'root index does not inline docs css');
    t.equal(
      index.includes("document.addEventListener('click'"),
      false,
      'root index does not inline docs javascript',
    );
    t.equal(
      index.includes('<nav class="docs-page-index"'),
      false,
      'root index does not render the API symbol index',
    );
    t.ok(index.includes('<h1>Fixture API</h1>'), 'root index renders project README');
    t.ok(
      index.includes('<img src="./logo.svg" alt="Fixture logo">'),
      'root index preserves README image URLs for copied docs assets',
    );
    t.ok(
      docsCss.includes('main img[src$=".svg"]{filter:invert(1) brightness(1.25)}'),
      'dark mode inverts copied SVG images such as logos',
    );
    t.equal(
      await fs.readFile(docsDir + '/logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Fixture logo</title></svg>\n',
      'doc build copies README image assets into docs output',
    );
    t.ok(
      index.includes('<a href="../guides/start.md">Project guide</a>'),
      'root index rewrites README links for generated output',
    );
    t.ok(
      index.includes('<li>It should render Markdown lists.</li>'),
      'root index renders README markdown blocks',
    );
    t.equal(
      index.includes('module-card'),
      false,
      'root index no longer renders a flat module card list',
    );
    t.ok(index.includes('<nav class="docs-sidebar"'), 'root index includes sidebar navigation');
    t.ok(
      docsJs.includes('showLoading()'),
      'docs javascript swaps the main content and page index while local pages load',
    );
    t.ok(
      docsJs.includes("document.addEventListener('click'"),
      'docs javascript intercepts normal local link clicks',
    );
    t.ok(
      docsJs.includes('fetch(url.href'),
      'docs javascript fetches local html pages without replacing the sidebar',
    );
    t.ok(
      docsCss.includes('docs-loading'),
      'docs css includes a loading state for client-side navigation',
    );
    t.ok(index.includes('href="advanced.html"'), 'sidebar links regular root modules');
    t.ok(index.includes('href="pkg.html"'), 'sidebar folds index modules into parent pages');
    t.equal(
      index.includes('href="pkg/index.html"'),
      false,
      'sidebar does not expose index module pages as index.html',
    );
    t.ok(
      index.includes('href="alpha/client.html"'),
      'sidebar links first same-basename module by source path',
    );
    t.ok(
      index.includes('href="beta/client.html"'),
      'sidebar links second same-basename module by source path',
    );
    t.equal(
      index.includes('internal-only.html'),
      false,
      'sidebar excludes file-level internal modules by default',
    );
    t.ok(
      !index.includes('<h1 id="module:index">index</h1>'),
      'root index is not an index module page',
    );
    t.equal(
      await exists(fs, docsDir + '/internal-only.html'),
      false,
      'build excludes file-level internal module pages by default',
    );
    t.equal(
      await exists(fs, docsDir + '/pkg/index.html'),
      false,
      'index module does not write a nested index.html page',
    );
    const indexModule = await fs.readFile(docsDir + '/pkg.html');
    t.ok(
      indexModule.includes('<title>Docs Site - pkg</title>'),
      'index module gets parent output page',
    );
    t.ok(
      indexModule.includes('<link rel="stylesheet" href="docs.css">'),
      'root module page links shared docs css',
    );
    t.ok(
      indexModule.includes('<script src="docs.js" defer data-docs-client-navigation><\/script>'),
      'root module page links shared docs javascript',
    );
    t.ok(indexModule.includes('Package index docs.'), 'index module page renders docs');
    t.ok(indexModule.includes('href="index.html"'), 'folded index module links back to root index');
    t.ok(
      indexModule.includes('href="alpha/client.html"'),
      'folded index module sidebar uses relative links to sibling folders',
    );
    const alphaClient = await fs.readFile(docsDir + '/alpha/client.html');
    const betaClient = await fs.readFile(docsDir + '/beta/client.html');
    t.ok(
      alphaClient.includes('<title>Docs Site - alpha/client</title>'),
      'first same-basename module writes mirrored page',
    );
    t.ok(
      alphaClient.includes('<link rel="stylesheet" href="../docs.css">'),
      'nested module page links shared docs css relatively',
    );
    t.ok(
      alphaClient.includes('<script src="../docs.js" defer data-docs-client-navigation><\/script>'),
      'nested module page links shared docs javascript relatively',
    );
    t.ok(
      betaClient.includes('<title>Docs Site - beta/client</title>'),
      'second same-basename module writes mirrored page',
    );
    t.ok(
      betaClient.includes('<a href="../alpha/client.html#alpha-client.Client">AlphaClient</a>'),
      'markdown source links resolve across mirrored paths',
    );
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    t.equal(
      json.modules.some((moduleDoc) => moduleDoc.name === 'internal-only'),
      false,
      'json excludes file-level internal modules by default',
    );
    const privateRun = await runCli(
      [
        'doc',
        'build',
        './internal-only.ts',
        '--format',
        'html',
        '--include-private',
        '--title',
        'Private Docs',
      ],
      appDir,
    );
    t.equal(privateRun.result.code, 0, 'private doc build exits successfully');
    t.equal(
      await exists(fs, docsDir + '/internal-only.html'),
      true,
      'include-private includes file-level internal module pages',
    );
    const internalHtml = await fs.readFile(docsDir + '/internal-only.html');
    t.ok(
      internalHtml.includes('Internal-only module docs.'),
      'include-private renders file-level internal module docs',
    );
  });
  it('uses the project package name as the default html title', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli(['doc', 'build', './advanced.ts', '--format', 'html'], appDir);
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const index = await fs.readFile(docsDir + '/index.html');
    const html = await fs.readFile(docsDir + '/advanced.html');
    t.ok(
      index.includes('<title>fixture-project</title>'),
      'root index uses inferred project title',
    );
    t.ok(
      index.includes('<p class="docs-sidebar-title"><a href="index.html">fixture-project</a></p>'),
      'sidebar home link uses inferred project title',
    );
    t.ok(
      html.includes('<title>fixture-project - advanced</title>'),
      'module page uses inferred project title',
    );
  });
  it('renders directory-discovered markdown guides as sidebar and search pages', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli(
      ['doc', 'build', '.', '--format', 'both', '--title', 'Guide Docs'],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/guides/start.html'), 'doc build reports guide html');
    t.ok(run.stdout.includes('/docs/guides/start.md'), 'doc build reports guide markdown');
    t.equal(
      await exists(fs, docsDir + '/README.html'),
      false,
      'root README is not duplicated as a guide page',
    );
    const index = await fs.readFile(docsDir + '/index.html');
    const docsCss = await fs.readFile(docsDir + '/docs.css');
    t.ok(index.includes('href="guides/start.html"'), 'root README links to generated guide pages');
    t.ok(
      index.includes('class="docs-sidebar-link docs-sidebar-link-api"'),
      'sidebar marks API reference links',
    );
    t.ok(
      index.includes('class="docs-sidebar-link docs-sidebar-link-guide"'),
      'sidebar marks guide links',
    );
    t.ok(
      index.includes('<p class="docs-sidebar-title"><a href="index.html">Guide Docs</a></p>'),
      'sidebar title links home using project title',
    );
    t.equal(
      index.includes('API Documentation'),
      false,
      'sidebar does not use generic API Documentation title',
    );
    t.ok(
      index.includes('<div class="docs-sidebar-directory">Docs</div>'),
      'sidebar renders a separate docs tree',
    );
    t.ok(
      index.includes('<div class="docs-sidebar-directory">API Reference</div>'),
      'sidebar renders a separate API reference tree',
    );
    t.ok(
      index.indexOf('<div class="docs-sidebar-directory">Docs</div>') <
        index.indexOf('<div class="docs-sidebar-directory">API Reference</div>'),
      'guide tree appears before API reference tree',
    );
    t.ok(index.includes('docs-sidebar-icon docs-sidebar-icon-api'), 'sidebar renders API icons');
    t.ok(
      index.includes('docs-sidebar-icon docs-sidebar-icon-guide'),
      'sidebar renders guide icons',
    );
    t.ok(docsCss.includes('opacity:.62'), 'sidebar icons use subdued opacity');
    t.equal(
      index.includes('.docs-sidebar-link-guide .docs-sidebar-icon{color:#8250df}'),
      false,
      'guide icons do not use a saturated accent color',
    );
    t.ok(index.includes('viewBox="0 0 24 24"'), 'sidebar uses a cleaner 24px guide icon shape');
    t.ok(
      index.indexOf('href="alpha/guide.html"') <
        index.indexOf('<div class="docs-sidebar-directory">API Reference</div>'),
      'sidebar separates guides from API pages',
    );
    t.ok(
      index.indexOf('href="guides/start.html"') < index.indexOf('href="guides/advanced.html"'),
      'sidebar sorts weighted guides by ascending weight',
    );
    t.ok(
      index.includes('href="docs/concepts/virtual.html"'),
      'sidebar uses virtual guide paths from frontmatter',
    );
    const guideHtml = await fs.readFile(docsDir + '/guides/start.html');
    t.ok(
      guideHtml.includes('<title>Guide Docs - Getting Started</title>'),
      'guide html uses markdown title',
    );
    t.ok(
      guideHtml.includes('<nav class="docs-page-index" aria-label="Page table of contents">'),
      'guide pages render a right-side table of contents',
    );
    t.ok(
      guideHtml.includes('<h2 id="Usage">Usage</h2>'),
      'guide markdown headings receive stable anchors',
    );
    t.ok(
      guideHtml.includes(
        '<li class="docs-page-index-heading docs-page-index-heading-2"><a href="#Usage">Usage</a></li>',
      ),
      'guide table of contents links to heading anchors',
    );
    t.ok(
      guideHtml.includes('<p class="muted">guides/start.md</p>'),
      'guide html shows source path',
    );
    t.equal(guideHtml.includes('weight: 10'), false, 'guide html strips frontmatter');
    t.ok(
      guideHtml.includes('<a href="advanced.html">advanced guide</a>'),
      'guide links resolve to other generated guides',
    );
    t.ok(
      guideHtml.includes('<a href="../advanced.html#advanced.open">advanced API</a>'),
      'guide links resolve to generated API anchors',
    );
    t.ok(
      guideHtml.includes('<span class="tok-keyword">import</span>'),
      'guide fenced code uses syntax highlighting',
    );
    t.ok(
      guideHtml.includes('<span class="tok-keyword">const</span> value'),
      'guide code highlighting preserves code text',
    );
    t.ok(
      guideHtml.includes('href="start.html" aria-current="page"'),
      'guide page marks current sidebar entry',
    );
    const advancedGuideHtml = await fs.readFile(docsDir + '/guides/advanced.html');
    t.ok(
      advancedGuideHtml.includes('<a href="../advanced.html#advanced.ResourceBox">ResourceBox</a>'),
      'sibling guide resolves API type links',
    );
    t.ok(
      advancedGuideHtml.includes('<a href="start.html">getting started</a>'),
      'sibling guide resolves guide links',
    );
    const virtualGuideHtml = await fs.readFile(docsDir + '/docs/concepts/virtual.html');
    t.ok(
      virtualGuideHtml.includes('<p class="muted">guides/virtual.md</p>'),
      'guide html shows source path even when output path is virtualized',
    );
    t.equal(
      virtualGuideHtml.includes('path: docs/concepts/virtual.md'),
      false,
      'virtual guide html strips path frontmatter',
    );
    const guideMarkdown = await fs.readFile(docsDir + '/guides/start.md');
    t.ok(guideMarkdown.includes('# Getting Started'), 'markdown output copies guide markdown');
    t.equal(
      guideMarkdown.includes('weight: 10'),
      false,
      'markdown output strips guide frontmatter',
    );
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const startGuide = json.guides?.find((guide) => guide.path === 'guides/start.md');
    t.ok(startGuide, 'json records guide metadata');
    t.equal(startGuide!.href, 'guides/start.html', 'json records guide output href');
    t.equal(startGuide!.weight, 10, 'json records guide weight');
    t.ok(startGuide!.summary.includes('Start with the'), 'json records guide summary');
    t.ok(startGuide!.text.includes('fixture users'), 'json records searchable guide text');
    t.equal(startGuide!.text.includes('weight: 10'), false, 'json guide text strips frontmatter');
    const virtualGuide = json.guides?.find((guide) => guide.path === 'guides/virtual.md');
    t.ok(virtualGuide, 'json records virtual guide metadata');
    t.equal(
      virtualGuide!.href,
      'docs/concepts/virtual.html',
      'json records virtual guide output href',
    );
    const found = await runCli(['doc', 'search', 'fixture users'], appDir);
    t.equal(found.result.code, 0, 'doc search exits successfully');
    t.ok(found.stdout.includes('guide:guides/start'), 'sqlite search finds guide pages');
    t.ok(found.stdout.includes('(guide)'), 'sqlite search reports guide kind');
    const sameStemDir = appDir + '/same-stem';
    await ensureDir(fs, sameStemDir);
    await fs.writeFile(
      sameStemDir + '/jobs.ts',
      `/**
 * Jobs API module.
 */
export function enqueue(): void {}
`,
    );
    await fs.writeFile(
      sameStemDir + '/jobs.md',
      '# Jobs Guide\n\nUse this guide before calling the API.\n',
    );
    await fs.writeFile(sameStemDir + '/notes.md', '# Notes\n\nUnrelated sibling guide.\n');
    const sameStemRun = await runCli(
      ['doc', 'build', './same-stem', '--format', 'both', '--title', 'Same Stem Docs'],
      appDir,
    );
    t.equal(
      sameStemRun.result.code,
      0,
      'doc build accepts sibling guide and API files with the same stem',
    );
    t.equal(sameStemRun.stderr, '', 'same-stem doc build does not report a collision');
    t.equal(
      await exists(fs, docsDir + '/jobs.md'),
      true,
      'same-stem module keeps the stem markdown output',
    );
    t.equal(
      await exists(fs, docsDir + '/jobs/index.md'),
      true,
      'same-stem guide is moved under a nested index markdown output',
    );
    t.equal(
      await exists(fs, docsDir + '/jobs.html'),
      true,
      'same-stem module keeps the stem html output',
    );
    t.equal(
      await exists(fs, docsDir + '/jobs/index.html'),
      true,
      'same-stem guide is moved under a nested index html output',
    );
    const sameStemIndex = await fs.readFile(docsDir + '/index.html');
    t.ok(sameStemIndex.includes('href="jobs/index.html"'), 'sidebar links the nested index guide');
    t.ok(
      sameStemIndex.includes('<span>Jobs Guide</span>'),
      'sidebar labels the nested index guide with its title',
    );
    t.equal(
      sameStemIndex.includes('docs-sidebar-directory">jobs<'),
      false,
      'sidebar promotes the index guide instead of a bare directory header',
    );
    const collisionDir = appDir + '/collision';
    await ensureDir(fs, collisionDir);
    await fs.writeFile(
      collisionDir + '/index.ts',
      `/** Collision module. */
export const collision = true;
`,
    );
    await fs.writeFile(appDir + '/collision.md', '# Collision Guide\n');
    const collisionRun = await runCli(
      ['doc', 'build', './collision/index.ts', './collision.md', '--format', 'html'],
      appDir,
    );
    t.notEqual(collisionRun.result.code, 0, 'doc build rejects guide and API output collisions');
    t.ok(
      collisionRun.stderr.includes('output path collision'),
      'collision failure explains the duplicated output path',
    );
  });
  it('renders separate docs and API reference trees for a shared source base', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const sectionDir = appDir + '/section';
    await ensureDir(fs, sectionDir + '/nested');
    await ensureDir(fs, sectionDir + '/net/http');
    await fs.writeFile(
      sectionDir + '/start.md',
      `---
weight: 10
---
# Start Here

Begin with this guide.
`,
    );
    await fs.writeFile(
      sectionDir + '/concepts.md',
      `---
weight: 20
---
# Concepts

Understand the ideas behind the API.
`,
    );
    await fs.writeFile(
      sectionDir + '/nested/api.ts',
      `/** Nested API. */
export function run(): void {}
`,
    );
    await fs.writeFile(
      sectionDir + '/net/http/guide.md',
      `---
weight: 30
---
# HTTP

Handle HTTP requests.
`,
    );
    await fs.writeFile(
      sectionDir + '/net/http/server.ts',
      `/** HTTP server API. */
export function serve(): void {}
`,
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './section/start.md',
        './section/concepts.md',
        './section/nested/api.ts',
        './section/net/http/guide.md',
        './section/net/http/server.ts',
        '--format',
        'html',
        '--title',
        'Section Docs',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const startHtml = await fs.readFile(docsDir + '/section/start.html');
    t.ok(
      startHtml.includes(
        '<p class="docs-sidebar-title"><a href="../index.html">Section Docs</a></p>',
      ),
      'sidebar title links home using project title',
    );
    t.ok(
      startHtml.includes('<div class="docs-sidebar-directory">Docs</div>'),
      'sidebar renders docs section',
    );
    t.ok(
      startHtml.includes('<div class="docs-sidebar-directory">API Reference</div>'),
      'sidebar renders API reference section',
    );
    t.equal(
      startHtml.includes('<div class="docs-sidebar-directory">section</div>'),
      false,
      'sidebar renames the shared input base instead of rendering it',
    );
    t.ok(startHtml.includes('href="start.html"'), 'sidebar keeps guide link valid in docs tree');
    t.ok(
      startHtml.includes('href="nested/api.html"'),
      'sidebar keeps nested API link valid in API reference tree',
    );
    t.ok(
      startHtml.indexOf('href="start.html"') < startHtml.indexOf('href="concepts.html"'),
      'docs tree still sorts guides by weight',
    );
    t.ok(
      startHtml.indexOf('<div class="docs-sidebar-directory">Docs</div>') <
        startHtml.indexOf('<div class="docs-sidebar-directory">API Reference</div>'),
      'docs tree appears before API reference tree',
    );
    t.ok(
      startHtml.includes('<div class="docs-sidebar-directory">nested</div>'),
      'API reference tree keeps directories below the renamed base',
    );
    t.ok(
      startHtml.includes('<div class="docs-sidebar-directory">net/http</div>'),
      'sidebar collapses empty intermediate directories',
    );
    t.equal(
      startHtml.includes('<div class="docs-sidebar-directory">net</div>'),
      false,
      'sidebar does not render empty parent directory separately',
    );
    t.equal(
      startHtml.includes('<div class="docs-sidebar-directory">http</div>'),
      false,
      'sidebar does not render empty child directory separately after collapse',
    );
    t.ok(
      startHtml.includes('href="net/http/guide.html"'),
      'collapsed docs directory keeps guide link valid',
    );
    t.ok(
      startHtml.includes('href="net/http/server.html"'),
      'collapsed API directory keeps module link valid',
    );
  });
  it('rejects invalid guide frontmatter', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const invalidDir = appDir + '/invalid-guides';
    await ensureDir(fs, invalidDir);
    await fs.writeFile(
      invalidDir + '/bad-yaml.md',
      `---
weight: [
---
# Bad YAML
`,
    );
    await fs.writeFile(
      invalidDir + '/bad-weight.md',
      `---
weight: first
---
# Bad Weight
`,
    );
    await fs.writeFile(
      invalidDir + '/bad-path.md',
      `---
path: ../escape.md
---
# Bad Path
`,
    );
    const yamlRun = await runCli(
      ['doc', 'build', './invalid-guides/bad-yaml.md', '--format', 'html'],
      appDir,
    );
    t.notEqual(yamlRun.result.code, 0, 'doc build rejects malformed guide frontmatter');
    t.ok(yamlRun.stderr.includes('bad-yaml.md'), 'malformed frontmatter error includes guide path');
    const weightRun = await runCli(
      ['doc', 'build', './invalid-guides/bad-weight.md', '--format', 'html'],
      appDir,
    );
    t.notEqual(weightRun.result.code, 0, 'doc build rejects non-numeric guide weight');
    t.ok(weightRun.stderr.includes('bad-weight.md'), 'invalid weight error includes guide path');
    const pathRun = await runCli(
      ['doc', 'build', './invalid-guides/bad-path.md', '--format', 'html'],
      appDir,
    );
    t.notEqual(pathRun.result.code, 0, 'doc build rejects unsafe virtual guide path');
    t.ok(pathRun.stderr.includes('bad-path.md'), 'invalid virtual path error includes guide path');
  });
  it('runs examples from documentation comments', async (t) => {
    const run = await runCliProcess(['doc', 'test', './examples.ts'], appDir);
    t.equal(run.result.code, 0, 'doc test exits successfully');
    t.equal(run.stderr, '', 'doc test writes no stderr');
    t.ok(run.stdout.includes('4 passed'), 'doc test runs non-ignored examples');
    t.ok(run.stdout.includes('1 ignored'), 'doc test reports ignored examples');
  });

  it('renders every page through a user-supplied theme component', async (t) => {
    const themeDir = TEST_DIR + '/theme-app';
    await ensureDir(fs, themeDir);
    await fs.writeFile(
      themeDir + '/widget.ts',
      `/**
 * Widget module.
 */
/** Spin the widget. */
export function spin(times: number): number {
return times;
}
`,
    );
    await fs.writeFile(
      themeDir + '/guide.md',
      `---
weight: 1
---
# Widget Guide

How to spin a widget.
`,
    );
    await fs.writeFile(
      themeDir + '/theme.ts',
      `import { h } from 'fino:ui';
import { rawHtml } from 'fino:ui/html';
import type { DocsPageProps } from 'fino:commands/doc/theme';

export default function Page(props: DocsPageProps) {
const { site, page, prepared } = props;
return h(
  'html',
  null,
  h('head', null, h('title', null, 'CUSTOM ' + page.title)),
  h(
    'body',
    { 'data-theme': 'custom', 'data-page-kind': page.kind },
    h('p', { class: 'site-title' }, site.title),
    h('p', { class: 'nav-count' }, String(site.nav.length)),
    h('p', { class: 'module-count' }, String(site.modules.length)),
    h(
      'p',
      { class: 'symbols' },
      page.kind === 'module' ? page.module.exports.map((item) => item.name).join(',') : '',
    ),
    h('article', null, rawHtml(prepared.contentHtml)),
  ),
);
}
`,
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './widget.ts',
        './guide.md',
        '--format',
        'html',
        '--title',
        'Widget API',
        '--theme',
        './theme.ts',
      ],
      themeDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully with a custom theme');
    t.equal(run.stderr, '', 'custom theme build writes no stderr');

    const docsDir = themeDir + '/docs';
    const modulePage = await fs.readFile(docsDir + '/widget.html');
    t.ok(modulePage.includes('data-theme="custom"'), 'module page comes from the custom theme');
    t.ok(modulePage.includes('<title>CUSTOM widget</title>'), 'theme controls the page title');
    t.ok(modulePage.includes('data-page-kind="module"'), 'theme receives the page kind');
    t.ok(
      modulePage.includes('<p class="site-title">Widget API</p>'),
      'theme receives the site title',
    );
    t.ok(
      modulePage.includes('<p class="symbols">spin</p>'),
      'theme receives structured module data, not only prepared HTML',
    );
    t.ok(modulePage.includes('Spin the widget.'), 'prepared content carries rendered doc prose');
    t.equal(
      modulePage.includes('docs-layout'),
      false,
      'the default layout is fully replaced, not wrapped',
    );

    const guidePage = await fs.readFile(docsDir + '/guide.html');
    t.ok(guidePage.includes('data-page-kind="guide"'), 'guide pages use the same theme');
    t.ok(guidePage.includes('How to spin a widget.'), 'guide prose reaches the theme');

    const indexPage = await fs.readFile(docsDir + '/index.html');
    t.ok(indexPage.includes('data-page-kind="index"'), 'the index page uses the same theme');
    t.ok(indexPage.includes('<p class="module-count">1</p>'), 'every page receives the whole site');
  });

  it('reports a failing theme instead of writing broken pages', async (t) => {
    const badDir = TEST_DIR + '/bad-theme-app';
    await ensureDir(fs, badDir);
    await fs.writeFile(badDir + '/widget.ts', '/** Widget. */\nexport const widget = 1;\n');
    await fs.writeFile(
      badDir + '/theme.ts',
      `export default function Page() {
throw new Error('theme exploded');
}
`,
    );
    const run = await runCli(
      ['doc', 'build', './widget.ts', '--format', 'html', '--theme', './theme.ts'],
      badDir,
    );
    t.ok(run.result.code !== 0, 'a failing theme fails the build');
    t.ok(run.stderr.includes('theme exploded'), 'the theme error reaches the operator');
    t.equal(
      await exists(fs, badDir + '/docs/widget.html'),
      false,
      'no page is written when the theme fails',
    );
  });
});
