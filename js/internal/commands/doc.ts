/**
 * internal:commands/doc - API documentation command.
 *
 * Builds the `fino doc` command tree and contains the source parser, Markdown
 * and HTML renderers, search database generation, and doc-test runner used by
 * that command. The builder reads commented source modules, extracts module and
 * symbol JSDoc, resolves supported re-exports, writes generated documentation
 * under `docs/`, and can execute runnable fenced examples from comments.
 *
 * Use this module from the root CLI command table. Application code should not
 * call the helper functions directly because they assume Fino command context,
 * runtime filesystem APIs, and documentation output conventions.
 *
 * ## Example
 *
 * ```ts no_run
 * import { createDocCommand } from 'internal:commands/doc';
 *
 * const doc = createDocCommand();
 * await doc.parse([
 *   'build',
 *   '--format',
 *   'markdown',
 *   'js/internal/stream.ts',
 * ]);
 * ```
 *
 * @internal
 */

import { DiskFileSystem } from '../../file/fs.ts';
import { Task, type TaskContext } from '../../task.ts';
import { cwd } from '../../process.ts';
import { renderMarkdown, renderMarkdownInline, type MarkdownOptions } from '../../format/markdown.ts';
import { escapeHtml, render as renderTemplate } from '../../template.ts';
import { format as formatTypeScript, parse as parseTypeScript, type ParseComment, type ParseResult } from '../../format/typescript.ts';
import { parse as parseYaml } from '../../format/yaml.ts';
import { Scanner } from '../../parsing/scanner.ts';
import * as sqlite from '../../database/sqlite.ts';

const fs = new DiskFileSystem();
const DOCS_DIR_NAME = 'docs';
const API_JSON_NAME = 'api.json';
const DOCS_DB_NAME = 'docs.db';
const SIGNATURE_WRAP_COLUMN = 100;

interface DocTag {
  name: string;
  value: string;
}

interface DocBlockItem {
  kind: string;
  text?: string;
  lang?: string;
  meta?: string;
  code?: string;
  hiddenCode?: string;
  name?: string;
  description?: string;
}

interface DocBlock {
  text: string;
  tags: DocTag[];
  blocks?: DocBlockItem[];
}

interface Location {
  line: number;
  column: number;
}

interface DocMember {
  id?: string;
  name: string;
  kind: string;
  signature: string;
  signatures?: string[];
  aliases?: string[];
  reExport?: ReExportDoc;
  doc: DocBlock;
  location: Location;
}

interface DocExport extends DocMember {
  members: DocMember[];
}

interface ReExportDoc {
  mode: 'inline' | 'link';
  sourceModule: string;
  sourceName: string;
  sourceId?: string;
}

interface ReExportSpec {
  source: string;
  exportedName: string;
  sourceName: string;
  namespace?: boolean;
  all?: boolean;
}

interface ModuleDoc {
  id?: string;
  path: string;
  name: string;
  sourceModule?: string;
  doc: DocBlock;
  exports: DocExport[];
}

interface GuideDoc {
  id: string;
  path: string;
  href: string;
  title: string;
  summary: string;
  text: string;
  weight?: number;
}

interface ParsedModuleDoc extends ModuleDoc {
  internal: boolean;
  reExports: ReExportSpec[];
  reExportsResolved?: boolean;
}

interface ApiDoc {
  schemaVersion?: number;
  modules: ModuleDoc[];
  guides?: GuideDoc[];
}

interface FlatSymbol {
  module: ModuleDoc;
  export: DocExport;
  member?: DocMember;
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  signature: string;
  signatures: string[];
  doc: DocBlock;
  location: Location;
}

interface HtmlDocBlock {
  html: string;
}

interface HtmlRenderContext {
  api: ApiDoc;
  module: ModuleDoc;
  currentHref: string;
}

interface HighlightContext extends HtmlRenderContext {
  linkIdentifiers?: boolean;
}

interface SourceAssetRef {
  sourcePath: string;
  outputPath: string;
}

interface SourceLinkResolverOptions {
  assets?: Map<string, SourceAssetRef>;
}

interface HtmlMember {
  id: string;
  name: string;
  kind: string;
  titleHtml: string;
  overloadsHtml: string;
  docHtml: string;
}

interface HtmlExport extends HtmlMember {
  memberGroups: HtmlGroup<HtmlMember>[];
  hasMemberGroups: boolean;
}

interface HtmlGroup<T> {
  title: string;
  items: T[];
}

interface HtmlModule {
  name: string;
  id: string;
  title: string;
  path: string;
  href: string;
  exportCount: number;
  summary: string;
  summaryHtml: string;
  docHtml: string;
  symbolIndexHtml: string;
  hasSymbolIndex: boolean;
  groups: HtmlGroup<HtmlExport>[];
  hasGroups: boolean;
}

interface HtmlGuide {
  id: string;
  title: string;
  path: string;
  href: string;
  html: string;
}

interface DocsDatabase {
  exec(sql: string): Promise<void>;
  prepare(sql: string): {
    run(...params: unknown[]): Promise<unknown>;
    all(...params: unknown[]): Promise<Array<Record<string, unknown>>>;
    finalize(): void;
  };
  close(): Promise<void>;
}

type DocFileKind = 'source' | 'guide';

interface CachedDocFile {
  path: string;
  kind: DocFileKind;
  includePrivate: boolean;
  mtimeMs: number;
  size: number;
  json: string;
}

interface CurrentDocFile {
  path: string;
  file: string;
  kind: DocFileKind;
  mtimeMs: number;
  size: number;
}

interface DocCacheOptions {
  shouldParseChanged?: (file: CurrentDocFile) => Promise<boolean>;
}

type AstNode = Record<string, any>;

interface HighlightSpan {
  start: number;
  end: number;
  kind: string;
  text: string;
}

const stringOffsetCache = new Map<string, number[]>();

const DOCS_INDEX_SCHEMA = `
  CREATE TABLE modules (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, source_module TEXT);
  CREATE TABLE guides (id TEXT PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL, href TEXT NOT NULL, summary TEXT NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE symbols (id TEXT PRIMARY KEY, module_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, doc TEXT NOT NULL, location_line INTEGER, location_column INTEGER);
  CREATE TABLE aliases (symbol_id TEXT NOT NULL, alias TEXT NOT NULL);
  CREATE TABLE doc_blocks (symbol_id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, lang TEXT, meta TEXT, code TEXT, name TEXT, description TEXT);
  CREATE VIRTUAL TABLE docs_fts USING fts5(id UNINDEXED, name, kind, signature, doc);
`;

const DOCS_INDEX_SCHEMA_STATEMENTS = DOCS_INDEX_SCHEMA
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

const DOCS_CACHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS doc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS doc_files (path TEXT NOT NULL, kind TEXT NOT NULL, include_private INTEGER NOT NULL, mtime_ms REAL NOT NULL, size INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (path, kind, include_private));
  CREATE TABLE IF NOT EXISTS doc_outputs (path TEXT PRIMARY KEY);
`;

const DOCS_CACHE_SCHEMA_STATEMENTS = DOCS_CACHE_SCHEMA
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

const DOCS_CSS = `:root{color-scheme:light dark;--border:#d0d7de;--muted:#57606a;--text:#1f2328;--link:#0969da;--bg:#ffffff;--sidebar:#f6f8fa;--code-bg:#f6f8fa;--tok-keyword:#cf222e;--tok-string:#0a3069;--tok-number:#0550ae;--tok-comment:#6e7781;--tok-regexp:#8250df;--tok-type:#953800}@media(prefers-color-scheme:dark){:root{--border:#30363d;--muted:#8b949e;--text:#e6edf3;--link:#58a6ff;--bg:#0d1117;--sidebar:#161b22;--code-bg:#161b22;--tok-keyword:#ff7b72;--tok-string:#a5d6ff;--tok-number:#79c0ff;--tok-comment:#8b949e;--tok-regexp:#d2a8ff;--tok-type:#ffa657}}*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;line-height:1.5;color:var(--text);background:var(--bg);overflow:hidden}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}.docs-layout{display:grid;grid-template-columns:280px minmax(0,1fr);height:100vh}.docs-layout-api{grid-template-columns:280px minmax(0,1fr) 240px}.docs-sidebar{grid-column:1;grid-row:1;background:var(--sidebar);border-right:1px solid var(--border);padding:24px 18px;overflow:auto}.docs-sidebar-title{font-weight:700;margin:0 0 12px}.docs-sidebar ul{list-style:none;margin:0;padding-left:14px}.docs-sidebar>ul{padding-left:0}.docs-sidebar li{margin:4px 0}.docs-sidebar-directory{font-size:.85rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:12px}.docs-sidebar-link{display:inline-flex;align-items:center;gap:6px;padding:2px 0}.docs-sidebar-icon{width:14px;height:14px;flex:0 0 14px;color:var(--muted);opacity:.62}.docs-sidebar a[aria-current="page"]{font-weight:700;color:var(--text)}main{display:block;max-width:980px;width:100%;height:100vh;overflow:auto;padding:40px 48px 72px;grid-column:2;grid-row:1}.docs-page-index{border-left:1px solid var(--border);padding:40px 18px 72px;overflow:auto;position:sticky;top:0;height:100vh;grid-column:3;grid-row:1}.docs-page-index-title{font-size:.85rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px}.docs-page-index ul{list-style:none;margin:0;padding-left:14px}.docs-page-index>ul{padding-left:0}.docs-page-index li{margin:4px 0}.docs-page-index a{display:inline-block;padding:2px 0}.docs-page-index-members{font-size:.92rem}h2{margin:44px 0 20px}p{margin:0 0 12px}pre{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:12px;margin:10px 0 18px;overflow:auto}code{font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap}.tok-keyword{color:var(--tok-keyword)}.tok-string{color:var(--tok-string)}.tok-number{color:var(--tok-number)}.tok-comment{color:var(--tok-comment)}.tok-regexp{color:var(--tok-regexp)}.tok-type{color:var(--tok-type)}.tag{color:var(--muted)}.muted{color:var(--muted)}main>p.muted{margin:0 0 16px}.docs-symbol{margin:0 0 72px}.docs-symbol>h3{margin:0 0 8px}.docs-symbol>h3+p,.member>h5+p{margin-top:0}.docs-symbol>h3+pre,.member>h5+pre{margin-top:0}.docs-symbol>:last-child,.member>:last-child{margin-bottom:0}.docs-symbol>h4{margin:34px 0 14px}.member{border-left:3px solid var(--border);padding-left:14px;margin:22px 0 42px}.member>h5{margin:0 0 8px}@media(max-width:760px){body{overflow:auto}.docs-layout,.docs-layout-api{display:block;height:auto}.docs-sidebar{border-right:0;border-bottom:1px solid var(--border);max-height:45vh}.docs-sidebar,.docs-page-index,main{height:auto}.docs-page-index{border-left:0;border-bottom:1px solid var(--border);padding:18px 20px;position:static;max-height:none}main{padding:28px 20px 48px;overflow:visible}.docs-symbol{margin-bottom:56px}.member{margin:18px 0 34px}}`;

const HTML_PAGE_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>{{title}}</title>
<style>{{{css}}}</style>
</head>
<body>
<div class="docs-layout{{#hasPageIndex}} docs-layout-api{{/hasPageIndex}}">
{{{sidebarHtml}}}
{{{pageIndexHtml}}}
<main>
{{{contentHtml}}}
</main>
</div>
</body>
</html>
`;

const MODULE_PAGE_TEMPLATE = `<h1 id="{{id}}">{{name}}</h1>
<p class="muted">{{path}}</p>
{{{docHtml}}}
{{^hasGroups}}<p class="muted">No exported declarations found.</p>{{/hasGroups}}
{{#groups}}
<h2>{{title}}</h2>
{{#items}}
<section class="docs-symbol" id="{{id}}">
<h3>{{{titleHtml}}}</h3>
{{{overloadsHtml}}}
{{{docHtml}}}
{{#memberGroups}}
<h4>{{title}}</h4>
{{#items}}
<section class="member" id="{{id}}">
<h5>{{{titleHtml}}}</h5>
{{{overloadsHtml}}}
{{{docHtml}}}
</section>
{{/items}}
{{/memberGroups}}
</section>
{{/items}}
{{/groups}}
`;

const GUIDE_PAGE_TEMPLATE = `<h1 id="{{id}}">{{title}}</h1>
<p class="muted">{{path}}</p>
{{{html}}}
`;

const INDEX_PAGE_TEMPLATE = `{{{readmeHtml}}}
`;

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

function joinPath(base: string, child: string): string {
  if (child.startsWith('/')) return child;
  return base.replace(/\/$/, '') + '/' + child;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.entry(path)).isDirectory();
  } catch (_) {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  if (path === '.' || path === '/' || path.length === 0) return;
  if (await exists(path)) return;
  const parent = dirname(path);
  if (parent !== path) await ensureDir(parent);
  await fs.mkdir(path);
}

async function removeTree(path: string): Promise<void> {
  if (!(await exists(path))) return;
  const entry = await fs.entry(path);
  if (entry.isDirectory()) {
    const dir = await fs.dir(path);
    for (const child of await dir.entries()) await removeTree(child.path.toString());
    await fs.rmdir(path);
    return;
  }
  await fs.unlink(path);
}

function docsDir(): string {
  return joinPath(cwd(), DOCS_DIR_NAME);
}

function apiJsonPath(): string {
  return joinPath(docsDir(), API_JSON_NAME);
}

function docsDbPath(): string {
  return joinPath(docsDir(), DOCS_DB_NAME);
}

function normalizePath(path: string): string {
  if (path.startsWith('/')) return path;
  if (path.startsWith('./') || path.startsWith('../')) return joinPath(cwd(), path);
  return path;
}

function normalizeModuleSpecifier(path: string): string {
  if (path.startsWith('file://')) return path;
  if (path.startsWith('/')) return `file://${path}`;
  if (path.startsWith('./') || path.startsWith('../')) return `file://${cwd()}/${path}`;
  if (path.includes(':')) return path;
  return `file://${cwd()}/./${path}`;
}

async function expandInput(arg: string): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const absolute = normalizePath(arg);
  const dir = !isGlob && await isDirectory(absolute);
  if (!isGlob && !dir) return [arg];

  const patterns = dir
    ? ['**/*.ts', '**/*.ts', '**/*.js', '**/*.mjs'].map((pattern) => joinPath(absolute, pattern))
    : [arg];
  const files: string[] = [];
  for (const pattern of patterns) {
    for await (const entry of fs.glob(pattern, { cwd: cwd(), onlyFiles: true })) {
      files.push(entry.path.toString());
    }
  }
  return [...new Set(files)].sort();
}

async function expandInputs(rawFiles: unknown): Promise<string[]> {
  const files = Array.isArray(rawFiles) ? rawFiles.map(String) : [];
  const out: string[] = [];
  for (const file of files) out.push(...await expandInput(file));
  return [...new Set(out)].sort();
}

interface DocInputs {
  sourceFiles: string[];
  guideFiles: string[];
}

async function expandDocInput(arg: string): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const absolute = normalizePath(arg);
  const dir = !isGlob && await isDirectory(absolute);
  if (!isGlob && !dir) return [arg];

  const patterns = dir
    ? ['**/*.ts', '**/*.ts', '**/*.js', '**/*.mjs', '**/*.md'].map((pattern) => joinPath(absolute, pattern))
    : [arg];
  const files: string[] = [];
  for (const pattern of patterns) {
    for await (const entry of fs.glob(pattern, { cwd: cwd(), onlyFiles: true })) {
      files.push(entry.path.toString());
    }
  }
  return [...new Set(files)].sort();
}

async function expandDocInputs(rawFiles: unknown): Promise<DocInputs> {
  const files = Array.isArray(rawFiles) ? rawFiles.map(String) : [];
  const expanded: string[] = [];
  for (const file of files) expanded.push(...await expandDocInput(file));
  return splitDocInputs([...new Set(expanded)].sort());
}

function splitDocInputs(files: string[]): DocInputs {
  const sourceFiles: string[] = [];
  const guideFiles: string[] = [];
  for (const file of files) {
    const path = normalizeDocPath(file);
    if (isDocsOutputPath(path)) continue;
    if (isMarkdownPath(path)) {
      if (!isRootReadmePath(path)) guideFiles.push(file);
    } else if (isSourcePath(path)) {
      sourceFiles.push(file);
    }
  }
  return { sourceFiles, guideFiles };
}

function isDocsOutputPath(path: string): boolean {
  return path === DOCS_DIR_NAME || path.startsWith(`${DOCS_DIR_NAME}/`) || path.includes(`/${DOCS_DIR_NAME}/`);
}

function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

function isRootReadmePath(path: string): boolean {
  return path.replace(/\\/g, '/') === 'README.md';
}

function isSourcePath(path: string): boolean {
  return /\.(m?ts|m?js)$/i.test(path);
}

function signaturesOf(item: { signature: string; signatures?: string[] }): string[] {
  if (Array.isArray(item.signatures) && item.signatures.length > 0) return item.signatures;
  return item.signature ? [item.signature] : [];
}

async function extractModuleFromSource(path: string, includePrivate: boolean): Promise<ParsedModuleDoc> {
  const source = String(await fs.readFile(path));
  const parsed = parseTypeScript(source, { filename: path, tokens: true });
  if (!parsed.ok) {
    throw new Error(`failed to parse ${path}:\n${parsed.errors.map((error) => error.message).join('\n')}`);
  }
  const comments = parsed.comments;
  const body = Array.isArray(parsed.ast?.body) ? parsed.ast.body as AstNode[] : [];
  const locals = collectLocalBindings(body, comments, source, includePrivate);
  const exports: DocExport[] = [];
  const reExports: ReExportSpec[] = [];

  for (const statement of body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source?.value) reExports.push(...collectReExportSpecs(statement));
      else collectNamedExport(exports, statement, comments, locals, source, includePrivate);
    } else if (statement.type === 'ExportAllDeclaration') {
      reExports.push(...collectReExportSpecs(statement));
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const item = collectDeclarationExport(statement.declaration, statement, comments, source, includePrivate, 'default');
      if (item) exports.push(item);
    }
  }

  const moduleName = basename(path).replace(/\.(m?ts|m?js)$/i, '') || 'module';
  const moduleDocBlock = firstJsdocBefore(comments, body[0]?.start ?? Number.MAX_SAFE_INTEGER, source) ?? emptyDoc();
  const moduleDoc: ParsedModuleDoc = {
    id: `module:${moduleName}`,
    path: projectRelativePath(path),
    name: moduleName,
    sourceModule: moduleName,
    doc: moduleDocBlock,
    exports,
    internal: hasDocTag(moduleDocBlock, 'internal'),
    reExports,
  };
  groupOverloads(moduleDoc.exports);
  assignDocIds(moduleDoc);
  return moduleDoc;
}

function collectLocalBindings(body: AstNode[], comments: ParseComment[], source: string, includePrivate: boolean): Map<string, DocExport> {
  const locals = new Map<string, DocExport>();
  for (const statement of body) {
    const declarations = localDeclarations(statement, comments, source, includePrivate);
    for (const item of declarations) locals.set(item.name, item);
  }
  return locals;
}

function localDeclarations(statement: AstNode, comments: ParseComment[], source: string, includePrivate: boolean): DocExport[] {
  const out: DocExport[] = [];
  if (statement.type === 'FunctionDeclaration' || statement.type === 'TSDeclareFunction' || statement.type === 'ClassDeclaration' || statement.type === 'TSInterfaceDeclaration' || statement.type === 'TSTypeAliasDeclaration' || statement.type === 'TSEnumDeclaration') {
    const item = collectDeclarationExport(statement, statement, comments, source, includePrivate);
    if (item) out.push(item);
  } else if (statement.type === 'VariableDeclaration') {
    out.push(...collectVariableExports(statement, statement, comments, source, false, includePrivate));
  }
  return out;
}

function collectNamedExport(exports: DocExport[], statement: AstNode, comments: ParseComment[], locals: Map<string, DocExport>, source: string, includePrivate: boolean): void {
  if (statement.declaration) {
    if (statement.declaration.type === 'VariableDeclaration') {
      exports.push(...collectVariableExports(statement.declaration, statement, comments, source, true, includePrivate, locals));
      return;
    }
    const item = collectDeclarationExport(statement.declaration, statement, comments, source, includePrivate);
    if (item) exports.push(item);
    return;
  }

  for (const specifier of statement.specifiers ?? []) {
    const localName = specifier.local?.name;
    const exportedName = specifier.exported?.name ?? specifier.exported?.value ?? localName;
    const local = localName ? locals.get(localName) : undefined;
    if (!local || !exportedName) continue;
    const item = cloneExport(local);
    item.name = exportedName;
    exports.push(item);
  }
}

function collectReExportSpecs(statement: AstNode): ReExportSpec[] {
  const source = String(statement.source?.value ?? '');
  if (!source) return [];

  if (statement.type === 'ExportAllDeclaration') {
    const exportedName = statement.exported?.name ?? statement.exported?.value;
    if (exportedName) return [{ source, exportedName, sourceName: '*', namespace: true }];
    return [{ source, exportedName: '*', sourceName: '*', all: true }];
  }

  const out: ReExportSpec[] = [];
  for (const specifier of statement.specifiers ?? []) {
    if (specifier.type === 'ExportNamespaceSpecifier') {
      const exportedName = specifier.exported?.name ?? specifier.exported?.value;
      if (exportedName) out.push({ source, exportedName, sourceName: '*', namespace: true });
      continue;
    }
    const sourceName = specifier.local?.name ?? specifier.local?.value;
    const exportedName = specifier.exported?.name ?? specifier.exported?.value ?? sourceName;
    if (!sourceName || !exportedName) continue;
    out.push({ source, exportedName, sourceName });
  }
  return out;
}

function collectDeclarationExport(declaration: AstNode | undefined, owner: AstNode, comments: ParseComment[], source: string, includePrivate: boolean, forcedName?: string): DocExport | undefined {
  if (!declaration) return undefined;
  const name = forcedName ?? declaration.id?.name;
  if (!name) return undefined;
  const doc = docForNode(comments, owner, declaration, source);
  if (!includePrivate && hasDocTag(doc, 'internal')) return undefined;
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction') {
    return exportDoc(name, 'function', functionSignature(owner, declaration, source), doc, locationFor(source, owner.start ?? declaration.start), [], declaration.type === 'TSDeclareFunction');
  }
  if (declaration.type === 'ClassDeclaration') {
    return exportDoc(name, 'class', classSignature(owner, declaration, source), doc, locationFor(source, owner.start ?? declaration.start), classMembers(declaration, comments, source, includePrivate));
  }
  if (declaration.type === 'TSInterfaceDeclaration') {
    return exportDoc(name, 'interface', interfaceSignature(owner, declaration, source), doc, locationFor(source, owner.start ?? declaration.start), interfaceMembers(declaration, comments, source, includePrivate));
  }
  if (declaration.type === 'TSTypeAliasDeclaration') {
    return exportDoc(name, 'type', statementSignature(owner, declaration, source), doc, locationFor(source, owner.start ?? declaration.start));
  }
  if (declaration.type === 'TSEnumDeclaration') {
    return exportDoc(name, 'enum', enumSignature(owner, declaration, source), doc, locationFor(source, owner.start ?? declaration.start));
  }
  return undefined;
}

function collectVariableExports(declaration: AstNode, owner: AstNode, comments: ParseComment[], source: string, exported: boolean, includePrivate: boolean, locals: Map<string, DocExport> = new Map()): DocExport[] {
  const out: DocExport[] = [];
  const kind = declaration.kind ?? 'const';
  for (const declarator of declaration.declarations ?? []) {
    const name = bindingName(declarator.id);
    if (!name) continue;
    const doc = docForNode(comments, owner, declarator, source);
    if (!includePrivate && hasDocTag(doc, 'internal')) continue;
    const start = exported ? owner.start : declaration.start;
    const end = declarator.id?.typeAnnotation?.end ?? declarator.init?.start ?? declarator.id?.end ?? declarator.end;
    const prefix = `${kind} `;
    const body = sourceSlice(source, declarator.id?.start ?? declarator.start, end).trim().replace(/=$/, '').trim();
    const members = objectMembers(declarator.init, comments, source, locals);
    out.push(exportDoc(name, kind, cleanSignature(prefix + body), doc, locationFor(source, owner.start ?? declaration.start), members));
  }
  return out;
}

function objectMembers(node: AstNode | undefined, comments: ParseComment[], source: string, locals: Map<string, DocExport>, prefix = ''): DocMember[] {
  if (!node || node.type !== 'ObjectExpression') return [];
  const members: DocMember[] = [];
  for (const property of node.properties ?? []) {
    if (!property || property.type === 'SpreadElement') continue;
    const name = propertyName(property.key);
    if (!name || name === '__proto__') continue;
    const memberName = prefix ? `${prefix}.${name}` : name;
    const doc = docForNode(comments, property, property, source);
    if (hasDocTag(doc, 'internal')) continue;
    const value = property.value;
    const kind = objectMemberKind(property, value);
    members.push({
      id: '',
      name: memberName,
      kind,
      signature: objectMemberSignature(property, value, source),
      signatures: [],
      aliases: [],
      doc,
      location: locationFor(source, property.start),
    });
    if (value?.type === 'ObjectExpression') {
      members.push(...objectMembers(value, comments, source, locals, memberName));
    } else if (value?.type === 'Identifier') {
      const local = locals.get(value.name);
      if (local) {
        for (const child of local.members) {
          members.push({
            ...child,
            id: '',
            name: `${memberName}.${child.name}`,
            signatures: [...(child.signatures ?? [])],
            aliases: [...(child.aliases ?? [])],
            doc: cloneDoc(child.doc),
          });
        }
      }
    }
  }
  return members;
}

function objectMemberKind(property: AstNode, value: AstNode | undefined): string {
  if (property.kind === 'get') return 'getter';
  if (property.kind === 'set') return 'setter';
  if (property.method || value?.type === 'FunctionExpression' || value?.type === 'ArrowFunctionExpression') return 'method';
  return 'property';
}

function objectMemberSignature(property: AstNode, value: AstNode | undefined, source: string): string {
  if (property.method || property.kind === 'get' || property.kind === 'set') {
    const end = value?.body?.start ?? property.end;
    return cleanSignature(sourceSlice(source, property.start, end));
  }
  const keyStart = property.key?.start ?? property.start;
  const end = property.key?.end ?? value?.start ?? property.end;
  return cleanSignature(sourceSlice(source, keyStart, end).replace(/:$/, ''));
}

function exportDoc(name: string, kind: string, signature: string, doc: DocBlock, location: Location, members: DocMember[] = [], overload = false): DocExport {
  return { id: '', name, kind, signature, signatures: signature ? [signature] : [], aliases: [], doc, members, location, overload } as DocExport & { overload: boolean };
}

function cloneExport(item: DocExport): DocExport {
  return {
    ...item,
    signatures: [...(item.signatures ?? [])],
    aliases: [...(item.aliases ?? [])],
    reExport: item.reExport ? { ...item.reExport } : undefined,
    doc: cloneDoc(item.doc),
    members: item.members.map((member) => ({
      ...member,
      signatures: [...(member.signatures ?? [])],
      aliases: [...(member.aliases ?? [])],
      reExport: member.reExport ? { ...member.reExport } : undefined,
      doc: cloneDoc(member.doc),
    })),
  };
}

function cloneDoc(doc: DocBlock): DocBlock {
  return {
    text: doc.text,
    tags: doc.tags.map((tag) => ({ ...tag })),
    blocks: (doc.blocks ?? []).map((block) => ({ ...block })),
  };
}

function functionSignature(owner: AstNode, declaration: AstNode, source: string): string {
  const end = declaration.body?.start ?? declaration.end ?? owner.end;
  return cleanSignature(sourceSlice(source, owner.start ?? declaration.start, end));
}

function classSignature(owner: AstNode, declaration: AstNode, source: string): string {
  return headerSignature(owner.start ?? declaration.start, declaration.end ?? owner.end, source);
}

function interfaceSignature(owner: AstNode, declaration: AstNode, source: string): string {
  return headerSignature(owner.start ?? declaration.start, declaration.end ?? owner.end, source);
}

function interfaceMembers(declaration: AstNode, comments: ParseComment[], source: string, includePrivate: boolean): DocMember[] {
  const members: DocMember[] = [];
  for (const item of declaration.body?.body ?? []) {
    const doc = docForNode(comments, item, item, source);
    if (!includePrivate && hasDocTag(doc, 'internal')) continue;
    const name = propertyName(item.key);
    if (!name) continue;
    members.push({
      id: '',
      name,
      kind: item.type === 'TSMethodSignature' ? 'method' : item.readonly ? 'readonly-property' : 'property',
      signature: interfaceMemberSignature(item, source),
      signatures: [],
      aliases: [],
      doc,
      location: locationFor(source, item.start),
    });
  }
  return members;
}

function classMembers(declaration: AstNode, comments: ParseComment[], source: string, includePrivate: boolean): DocMember[] {
  const members: DocMember[] = [];
  for (const item of declaration.body?.body ?? []) {
    const doc = docForNode(comments, item, item, source);
    if (!includePrivate && (isPrivateMember(item) || hasDocTag(doc, 'internal'))) continue;
    const name = propertyName(item.key);
    if (!name) continue;
    const kind = classMemberKind(item);
    members.push({
      id: '',
      name,
      kind,
      signature: classMemberSignature(item, source),
      signatures: [],
      aliases: [],
      doc,
      location: locationFor(source, item.start),
    });
  }
  return members;
}

function classMemberKind(item: AstNode): string {
  if (item.type === 'PropertyDefinition' || item.type === 'AccessorProperty') {
    if (item.static && item.readonly) return 'static-readonly-property';
    if (item.static) return 'static-property';
    if (item.readonly) return 'readonly-property';
    return 'property';
  }
  if (item.kind === 'constructor') return 'constructor';
  if (item.kind === 'get') return 'getter';
  if (item.kind === 'set') return 'setter';
  if (item.static) return 'static-method';
  return 'method';
}

function classMemberSignature(item: AstNode, source: string): string {
  if (item.type === 'PropertyDefinition' || item.type === 'AccessorProperty') {
    const end = item.typeAnnotation?.end ?? item.value?.start ?? item.end;
    return cleanSignature(sourceSlice(source, item.start, end).trim().replace(/=$/, '').trim());
  }
  const end = item.value?.body?.start ?? item.end;
  return cleanSignature(sourceSlice(source, item.start, end));
}

function interfaceMemberSignature(item: AstNode, source: string): string {
  const prefix = item.readonly ? 'readonly ' : '';
  const start = item.key?.start ?? item.start;
  return cleanSignature(prefix + sourceSlice(source, start, item.end));
}

function headerSignature(start: number, endLimit: number, source: string): string {
  const startIndex = stringIndexForByteOffset(source, start);
  const endLimitIndex = stringIndexForByteOffset(source, endLimit);
  const open = source.indexOf('{', startIndex);
  const end = open >= 0 && open < endLimitIndex ? open + 1 : endLimitIndex;
  return cleanSignature(source.slice(startIndex, end));
}

function statementSignature(owner: AstNode, declaration: AstNode, source: string): string {
  const start = owner.start ?? declaration.start;
  const startIndex = stringIndexForByteOffset(source, start);
  const end = findStatementEnd(source, startIndex);
  const fallbackEnd = stringIndexForByteOffset(source, declaration.end ?? owner.end);
  return cleanSignature(source.slice(startIndex, end >= 0 ? end : fallbackEnd));
}

function enumSignature(owner: AstNode, declaration: AstNode, source: string): string {
  const start = owner.start ?? declaration.start;
  const end = declaration.end ?? owner.end;
  return cleanSignature(sourceSlice(source, start, end));
}

function findStatementEnd(source: string, startIndex: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = startIndex; index < source.length; index++) {
    const ch = source[index]!;
    const next = source[index + 1] ?? '';
    if (ch === '"' || ch === "'" || ch === '`') {
      index = skipQuoted(source, index, ch);
      continue;
    }
    if (ch === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd >= 0 ? lineEnd : source.length;
      continue;
    }
    if (ch === '/' && next === '*') {
      const blockEnd = source.indexOf('*/', index + 2);
      index = blockEnd >= 0 ? blockEnd + 1 : source.length;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{') brace++;
    else if (ch === '}' && brace > 0) brace--;
    else if (ch === ';' && paren === 0 && bracket === 0 && brace === 0) return index + 1;
  }
  return -1;
}

function skipQuoted(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index++) {
    const ch = source[index]!;
    if (ch === '\\') {
      index++;
      continue;
    }
    if (ch === quote) return index;
  }
  return source.length;
}

function isPrivateMember(item: AstNode): boolean {
  return item.accessibility === 'private' || item.key?.type === 'PrivateIdentifier';
}

function propertyName(key: AstNode | undefined): string {
  if (!key) return '';
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  if (typeof key.name === 'string') return key.name;
  if (typeof key.value === 'string') return key.value;
  return '';
}

function bindingName(pattern: AstNode | undefined): string | undefined {
  return pattern?.type === 'Identifier' ? pattern.name : undefined;
}

function docForNode(comments: ParseComment[], owner: AstNode, declaration: AstNode, source: string): DocBlock {
  return docForSpan(comments, owner.start, source)
    ?? docForSpan(comments, declaration.start, source)
    ?? emptyDoc();
}

function firstJsdocBefore(comments: ParseComment[], end: number, source: string): DocBlock | undefined {
  const comment = comments.find((item) => item.jsdoc && item.leading && item.start < end);
  return comment ? parseDocComment(comment, source) : undefined;
}

function docForSpan(comments: ParseComment[], start: number | undefined, source: string): DocBlock | undefined {
  if (start === undefined) return undefined;
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index]!;
    if (comment.jsdoc && comment.leading && comment.attachedTo === start) return parseDocComment(comment, source);
  }
  return undefined;
}

function parseDocComment(comment: ParseComment, _source: string): DocBlock {
  const lines = docCommentLines(comment.text);
  const textLines: string[] = [];
  const tags: DocTag[] = [];
  const freeLines: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith('@')) {
      const tag = parseDocTag(line);
      if (tag) tags.push(tag);
      continue;
    }
    const visibleLine = stripInlineDirective(line);
    if (visibleLine.trim() === '' && line.trim() !== '') continue;
    textLines.push(visibleLine);
    freeLines.push(visibleLine);
  }

  return {
    text: trimJoinLines(textLines),
    tags,
    blocks: blocksForFreeText(freeLines),
  };
}

function scannerLines(text: string): string[] {
  const scanner = new Scanner(text, { encoding: 'utf-8', format: 'doc' });
  const lines: string[] = [];
  while (!scanner.done) {
    const start = scanner.mark();
    scanner.eatUntil((code) => code === 0x0A || code === 0x0D);
    lines.push(scanner.text(start));
    if (scanner.match('\r\n')) continue;
    if (scanner.eatChar('\n') || scanner.eatChar('\r')) continue;
  }
  return lines;
}

function docCommentLines(text: string): string[] {
  return scannerLines(text).map((rawLine) => {
    const scanner = new Scanner(rawLine, { encoding: 'utf-8', format: 'doc' });
    scanner.skipWhitespace();
    if (scanner.eatChar('*')) {
      if (scanner.peekCode() === 0x20) scanner.eat();
    }
    const start = scanner.mark();
    scanner.eatWhile(() => true);
    return scanner.text(start);
  });
}

function parseDocTag(line: string): DocTag | undefined {
  const scanner = new Scanner(line, { encoding: 'utf-8', format: 'doc' });
  if (!scanner.eatChar('@')) return undefined;
  const name = scanner.eatWhile((code) => code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D);
  scanner.skipWhitespace();
  const valueStart = scanner.mark();
  scanner.eatWhile(() => true);
  return name ? { name, value: scanner.text(valueStart) } : undefined;
}

function stripInlineDirective(line: string): string {
  const scanner = new Scanner(line, { encoding: 'utf-8', format: 'doc' });
  let outEnd = scanner.mark();
  while (!scanner.done) {
    if ((scanner.peekCode() === 0x20 || scanner.peekCode() === 0x09) && scanner.peek(2).endsWith('@')) {
      const beforeDirective = scanner.mark();
      scanner.eat();
      if (scanner.eatChar('@')) {
        const name = scanner.eatWhile((code) => code >= 0x61 && code <= 0x7A);
        if (name === 'param' || name === 'return' || name === 'returns' || name === 'throws' || name === 'example' || name === 'see' || name === 'deprecated') {
          return scanner.text({ offset: 0, line: 1, column: 1 }, beforeDirective).trimEnd();
        }
      }
      scanner.restore(beforeDirective);
    }
    scanner.eat();
    outEnd = scanner.mark();
  }
  return scanner.text({ offset: 0, line: 1, column: 1 }, outEnd).trimEnd();
}

function emptyDoc(): DocBlock {
  return { text: '', tags: [], blocks: [] };
}

function blocksForFreeText(lines: string[]): DocBlockItem[] {
  const blocks: DocBlockItem[] = [];
  let paragraph: string[] = [];
  let index = 0;
  const pushParagraph = () => {
    const text = trimJoinLines(paragraph);
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index]!;
    const fence = line.trimStart().startsWith('```') ? line.trimStart().slice(3) : null;
    if (fence !== null) {
      pushParagraph();
      const { lang, meta } = parseFenceInfo(fence);
      index++;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index]!.trimStart().startsWith('```')) {
        codeLines.push(lines[index]!);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push(codeBlock(lang, meta, codeLines));
      continue;
    }
    if (line.trim() === '') pushParagraph();
    else paragraph.push(line);
    index++;
  }
  pushParagraph();
  return blocks;
}

function parseFenceInfo(fence: string): { lang: string; meta: string } {
  const scanner = new Scanner(fence, { encoding: 'utf-8', format: 'doc' });
  scanner.skipWhitespace();
  const lang = scanner.eatWhile((code) => code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D);
  scanner.skipWhitespace();
  const metaStart = scanner.mark();
  scanner.eatWhile(() => true);
  return { lang, meta: scanner.text(metaStart).trim() };
}

function codeBlock(lang: string, meta: string, rawLines: string[]): DocBlockItem {
  const lines = dedentLines(rawLines);
  const visible: string[] = [];
  const runnable: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# ')) runnable.push(line.slice(2));
    else {
      visible.push(line);
      runnable.push(line);
    }
  }
  return { kind: 'code', lang, meta, code: trimJoinLines(visible), hiddenCode: trimJoinLines(runnable) };
}

function dedentLines(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim() !== '').map((line) => {
    let width = 0;
    for (const ch of line) {
      if (ch === ' ') width++;
      else if (ch === '\t') width += 2;
      else break;
    }
    return width;
  });
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return indent > 0 ? lines.map((line) => removeIndent(line, indent)) : lines;
}

function removeIndent(line: string, indent: number): string {
  let remaining = indent;
  let index = 0;
  while (index < line.length && remaining > 0) {
    const ch = line[index]!;
    const width = ch === '\t' ? 2 : ch === ' ' ? 1 : 0;
    if (width === 0 || width > remaining) break;
    remaining -= width;
    index++;
  }
  return line.slice(index);
}

function trimJoinLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

function groupOverloads(exports: DocExport[]): void {
  const grouped: Array<DocExport & { overload?: boolean }> = [];
  for (const item of exports as Array<DocExport & { overload?: boolean }>) {
    if (item.kind === 'function') {
      const existing = grouped.find((candidate) => candidate.kind === 'function' && candidate.name === item.name);
      if (existing) {
        if (item.overload) existing.signatures!.push(item.signature);
        else if ((existing.signatures?.length ?? 0) === 0) {
          existing.signature = item.signature;
          existing.signatures = [item.signature];
          if (!existing.doc.text && existing.doc.tags.length === 0) existing.doc = item.doc;
        } else if (!existing.doc.text && existing.doc.tags.length === 0) {
          existing.doc = item.doc;
        }
        continue;
      }
      if (item.overload) item.signatures = [item.signature];
    }
    grouped.push(item);
  }
  for (const item of grouped) delete item.overload;
  exports.splice(0, exports.length, ...grouped);
}

function assignDocIds(moduleDoc: ModuleDoc): void {
  const exportCounts = new Map<string, number>();
  for (const item of moduleDoc.exports) {
    const exportBase = `${moduleDoc.name}.${item.name}`;
    const exportCount = exportCounts.get(exportBase) ?? 0;
    item.id = exportCount === 0 ? exportBase : exportCount === 1 ? `${exportBase}:${item.kind}` : `${exportBase}:${item.kind}-${exportCount}`;
    exportCounts.set(exportBase, exportCount + 1);
    if ((!item.signatures || item.signatures.length === 0) && item.signature) item.signatures = [item.signature];
    const memberCounts = new Map<string, number>();
    for (const member of item.members) {
      const base = `${item.id}.${member.name}`;
      const count = memberCounts.get(base) ?? 0;
      member.id = count === 0 ? base : count === 1 ? `${base}:${member.kind}` : `${base}:${member.kind}-${count}`;
      memberCounts.set(base, count + 1);
      if ((!member.signatures || member.signatures.length === 0) && member.signature) member.signatures = [member.signature];
    }
  }
}

function hasDocTag(doc: DocBlock, name: string): boolean {
  return doc.tags.some((tag) => tag.name === name);
}

function sourceSlice(source: string, start: number, end: number): string {
  return source.slice(stringIndexForByteOffset(source, start), stringIndexForByteOffset(source, end));
}

function cleanSignature(value: string): string {
  const signature = compactSignature(stripSignatureComments(value)
    .replace(/^export\s+default\s+/, '')
    .replace(/^export\s+/, '')
    .replace(/;+\s*$/, ''));
  return formatDocSignature(signature);
}

function compactSignature(value: string): string {
  return value.trim()
    .replace(/\n/g, ' ')
    .split(/\s+/)
    .join(' ');
}

function formatDocSignature(signature: string): string {
  const formatted = formatCompleteSignature(signature)
    ?? formatOpenDeclarationSignature(signature)
    ?? formatObjectMemberSignature(signature)
    ?? formatClassMemberSignature(signature)
    ?? signature;
  return wrapLongSignature(formatted);
}

function formatCompleteSignature(signature: string): string | undefined {
  const source = needsAmbientSignature(signature) ? `declare ${signature};` : `${signature};`;
  const code = formattedTypeScript(source, 'dts');
  if (!code) return undefined;
  const cleaned = stripDeclarePrefix(trimTrailingSemicolons(code));
  return cleaned || undefined;
}

function formatOpenDeclarationSignature(signature: string): string | undefined {
  if (!signature.endsWith('{')) return undefined;
  const code = formattedTypeScript(`${signature}\n}`, 'ts');
  if (!code?.endsWith('\n}')) return undefined;
  return code.slice(0, -2).trimEnd();
}

function formatObjectMemberSignature(signature: string): string | undefined {
  const code = formattedTypeScript(`type __DocSignature = {\n${signature};\n};`, 'dts');
  if (!code) return undefined;
  return extractFormattedBody(code, 'type __DocSignature = {', '\n};');
}

function formatClassMemberSignature(signature: string): string | undefined {
  const code = formattedTypeScript(`declare class __DocSignature {\n${signature};\n}`, 'dts');
  if (!code) return undefined;
  return extractFormattedBody(code, 'declare class __DocSignature {', '\n}');
}

function formattedTypeScript(source: string, sourceType: 'ts' | 'dts'): string | undefined {
  const result = formatTypeScript(source, { sourceType });
  if (!result.ok || !result.code) return undefined;
  return result.code.trim();
}

function needsAmbientSignature(signature: string): boolean {
  return /^(?:async\s+)?function\b/.test(signature) || /^(?:const|let|var)\s+\w/.test(signature);
}

function stripDeclarePrefix(signature: string): string {
  return signature.replace(/^declare\s+/, '');
}

function trimTrailingSemicolons(signature: string): string {
  return signature.replace(/;+\s*$/, '');
}

function extractFormattedBody(code: string, prefix: string, suffix: string): string | undefined {
  if (!code.startsWith(prefix) || !code.endsWith(suffix)) return undefined;
  const body = dedentText(code.slice(prefix.length, code.length - suffix.length)).trim();
  return body ? trimTrailingSemicolons(body) : undefined;
}

function dedentText(value: string): string {
  const lines = value.replace(/^\n/, '').replace(/\n$/, '').split('\n');
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return indent > 0 ? lines.map((line) => line.slice(Math.min(indent, line.length))).join('\n') : lines.join('\n');
}

function wrapLongSignature(signature: string): string {
  if (signature.includes('\n') || signature.length <= SIGNATURE_WRAP_COLUMN) return signature;
  if (!/[{},();]/.test(signature)) return signature;

  const lines: string[] = [];
  let current = '';
  let indent = 0;
  let parenDepth = 0;
  let angleDepth = 0;

  const append = (text: string) => {
    current += text;
  };
  const newline = (nextIndent = indent) => {
    const line = current.trimEnd();
    if (line.length > 0) lines.push('  '.repeat(Math.max(0, nextIndent)) + line.trimStart());
    current = '';
  };

  for (let index = 0; index < signature.length; index++) {
    const ch = signature[index]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipQuoted(signature, index, ch);
      append(signature.slice(index, end + 1));
      index = end;
      continue;
    }

    if (ch === '<') {
      angleDepth++;
      append(ch);
      continue;
    }
    if (ch === '>' && angleDepth > 0) {
      angleDepth--;
      append(ch);
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      append(ch);
      newline(indent);
      indent++;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      if (current.trim().length > 0) newline(indent);
      indent = Math.max(0, indent - 1);
      append(ch);
      continue;
    }
    if (ch === '{') {
      append(ch);
      newline(indent);
      indent++;
      continue;
    }
    if (ch === '}') {
      if (current.trim().length > 0) newline(indent);
      indent = Math.max(0, indent - 1);
      append(ch);
      continue;
    }
    if (ch === ';') {
      append(ch);
      newline(indent);
      continue;
    }
    if (ch === ',' && angleDepth === 0 && (parenDepth > 0 || indent > 0)) {
      append(ch);
      newline(indent);
      continue;
    }
    append(ch);
  }
  if (current.trim().length > 0) newline(indent);
  return lines.join('\n');
}

function stripSignatureComments(source: string): string {
  let out = '';
  for (let index = 0; index < source.length; index++) {
    const ch = source[index]!;
    const next = source[index + 1] ?? '';
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipQuoted(source, index, ch);
      out += source.slice(index, end + 1);
      index = end;
      continue;
    }
    if (ch === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd >= 0 ? lineEnd - 1 : source.length;
      continue;
    }
    if (ch === '/' && next === '*') {
      const blockEnd = source.indexOf('*/', index + 2);
      index = blockEnd >= 0 ? blockEnd + 1 : source.length;
      continue;
    }
    out += ch;
  }
  return out;
}

function locationFor(source: string, offset: number): Location {
  const sourceIndex = stringIndexForByteOffset(source, offset);
  let line = 1;
  let column = 1;
  for (let index = 0; index < sourceIndex; index++) {
    if (source.charCodeAt(index) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function stringIndexForByteOffset(source: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const map = byteToStringOffsetMap(source);
  if (byteOffset >= map.length) return source.length;
  const exact = map[byteOffset];
  if (exact !== undefined) return exact;
  for (let index = byteOffset - 1; index >= 0; index--) {
    if (map[index] !== undefined) return map[index]!;
  }
  return 0;
}

function byteToStringOffsetMap(source: string): number[] {
  let map = stringOffsetCache.get(source);
  if (map) return map;
  map = [];
  let byteOffset = 0;
  for (let index = 0; index < source.length;) {
    map[byteOffset] = index;
    const codePoint = source.codePointAt(index)!;
    index += codePoint > 0xFFFF ? 2 : 1;
    byteOffset += utf8ByteLengthForCodePoint(codePoint);
  }
  map[byteOffset] = source.length;
  stringOffsetCache.set(source, map);
  return map;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    index += codePoint > 0xFFFF ? 2 : 1;
    bytes += utf8ByteLengthForCodePoint(codePoint);
  }
  return bytes;
}

function utf8ByteLengthForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7F) return 1;
  if (codePoint <= 0x7FF) return 2;
  if (codePoint <= 0xFFFF) return 3;
  return 4;
}

function renderDocBlock(doc: DocBlock): string[] {
  const lines: string[] = [];
  const blocks = doc.blocks ?? [];
  if (blocks.length === 0) {
    if (doc.text.length > 0) lines.push(doc.text);
    return lines;
  }

  for (const block of blocks) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    if (block.kind === 'paragraph' && block.text) {
      lines.push(block.text);
    } else if (block.kind === 'code') {
      lines.push('```' + (block.lang ?? ''));
      lines.push(block.code ?? '');
      lines.push('```');
    } else if (block.kind === 'example') {
      const lang = block.lang || 'ts';
      lines.push('```' + lang + (block.meta ? ' ' + block.meta : ''));
      lines.push(block.code ?? '');
      lines.push('```');
    } else if (block.kind === 'param') {
      lines.push(block.name ? `Parameter \`${block.name}\`: ${block.description ?? ''}`.trimEnd() : `Parameter: ${block.description ?? ''}`.trimEnd());
    } else if (block.kind === 'returns') {
      lines.push(block.description ? `Returns: ${block.description}` : 'Returns.');
    } else if (block.kind === 'throws') {
      lines.push(block.description ? `Throws: ${block.description}` : 'Throws.');
    } else if (block.description) {
      lines.push(block.description);
    }
  }
  return lines;
}

function renderSignatureBlock(item: { signature: string; signatures?: string[] }): string[] {
  const signatures = signaturesOf(item);
  return ['```ts', ...signatures, '```'];
}

function renderMember(member: DocMember): string {
  const lines = [`### ${member.name}`, '', ...renderSignatureBlock(member)];
  const docLines = renderDocBlock(member.doc);
  if (docLines.length > 0) lines.push('', ...docLines);
  return lines.join('\n');
}

function renderExport(item: DocExport): string {
  const lines = [`## ${item.name}`, '', ...renderSignatureBlock(item)];
  const reExportLines = renderReExportMarkdown(item);
  if (reExportLines.length > 0) lines.push('', ...reExportLines);
  const docLines = renderDocBlock(item.doc);
  if (docLines.length > 0) lines.push('', ...docLines);
  for (const member of item.members) lines.push('', renderMember(member));
  return lines.join('\n');
}

function renderReExportMarkdown(item: DocExport): string[] {
  if (item.reExport?.mode !== 'link') return [];
  const target = item.reExport.sourceId ?? `${item.reExport.sourceModule}.${item.reExport.sourceName}`;
  return [`Re-exported from \`${target}\`.`];
}

function renderModule(moduleDoc: ModuleDoc): string {
  const lines = [`# ${moduleDoc.name}`];
  const moduleLines = renderDocBlock(moduleDoc.doc);
  if (moduleLines.length > 0) lines.push('', ...moduleLines);
  for (const item of moduleDoc.exports) lines.push('', renderExport(item));
  return lines.join('\n') + '\n';
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, '-');
}

function renderDocHtml(doc: DocBlock, ctx: HtmlRenderContext, headingOffset: number): string {
  const markdownOptions: MarkdownOptions = {
    headingOffset,
    references: collectMarkdownReferences(doc),
    resolveLink: buildLinkResolver(ctx.api, ctx.module),
    renderCode: (code, lang) => renderCodeHtml(lang, code, ctx),
  };
  const blocks = doc.blocks ?? [];
  if (blocks.length === 0) {
    return renderDocBlock(doc).map((line) => {
      if (line.startsWith('@')) return `<p class="tag">${renderMarkdownInline(line, markdownOptions)}</p>`;
      if (line.trim() === '') return '';
      return renderMarkdown(line, markdownOptions);
    }).filter(Boolean).join('\n');
  }

  return blocks.map((block) => {
    if (block.kind === 'paragraph' && block.text) return renderMarkdown(block.text, markdownOptions);
    if (block.kind === 'code') return renderCodeHtml(block.lang ?? '', block.code ?? '');
    if (block.kind === 'param') {
      const name = block.name ? ` <code>${escapeHtml(block.name)}</code>` : '';
      return `<p class="tag">Parameter${name}: ${renderMarkdownInline(block.description ?? '', markdownOptions)}</p>`;
    }
    if (block.kind === 'returns') return `<p class="tag">Returns: ${renderMarkdownInline(block.description ?? '', markdownOptions)}</p>`;
    if (block.kind === 'throws') return `<p class="tag">Throws: ${renderMarkdownInline(block.description ?? '', markdownOptions)}</p>`;
    if (block.description) return `<p class="tag">${renderMarkdownInline(block.description, markdownOptions)}</p>`;
    return '';
  }).filter(Boolean).join('\n');
}

function collectMarkdownReferences(doc: DocBlock): Record<string, string> {
  const references: Record<string, string> = {};
  const collect = (text: string) => {
    for (const match of text.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)(?:\s+.*)?$/gm)) {
      references[match[1]!.trim().replace(/\s+/g, ' ').toLowerCase()] = match[2]!;
    }
  };
  collect(doc.text ?? '');
  for (const block of doc.blocks ?? []) {
    if (block.text) collect(block.text);
    if (block.description) collect(block.description);
  }
  return references;
}

function renderModuleHtml(api: ApiDoc, moduleDoc: ModuleDoc, title: string): string {
  const htmlModule = toHtmlModule(api, moduleDoc);
  const contentHtml = renderTemplate(MODULE_PAGE_TEMPLATE, htmlModule);
  return renderTemplate(HTML_PAGE_TEMPLATE, {
    title: `${title} - ${moduleDoc.name}`,
    css: DOCS_CSS,
    hasPageIndex: htmlModule.hasSymbolIndex,
    sidebarHtml: renderSidebarHtml(api, htmlModule.href, title),
    pageIndexHtml: htmlModule.symbolIndexHtml,
    contentHtml,
  });
}

function renderGuideHtml(api: ApiDoc, guide: GuideDoc, title: string): string {
  const htmlGuide = toHtmlGuide(api, guide);
  const contentHtml = renderTemplate(GUIDE_PAGE_TEMPLATE, htmlGuide);
  return renderTemplate(HTML_PAGE_TEMPLATE, {
    title: `${title} - ${guide.title}`,
    css: DOCS_CSS,
    hasPageIndex: false,
    sidebarHtml: renderSidebarHtml(api, guide.href, title),
    pageIndexHtml: '',
    contentHtml,
  });
}

async function renderIndexHtml(api: ApiDoc, title: string): Promise<string> {
  const contentHtml = renderTemplate(INDEX_PAGE_TEMPLATE, {
    readmeHtml: await renderReadmeHtml(api),
  });
  return renderTemplate(HTML_PAGE_TEMPLATE, {
    title,
    css: DOCS_CSS,
    hasPageIndex: false,
    sidebarHtml: renderSidebarHtml(api, 'index.html', title),
    pageIndexHtml: '',
    contentHtml,
  });
}

function toHtmlModule(api: ApiDoc, moduleDoc: ModuleDoc): HtmlModule {
  const href = moduleHref(moduleDoc);
  const ctx = { api, module: moduleDoc, currentHref: href };
  const exports = moduleDoc.exports.map((item) => toHtmlExport(item, ctx));
  const summary = firstSummary(moduleDoc.doc);
  const groups = groupHtmlItems(exports);
  const symbolIndexHtml = renderSymbolIndexHtml(moduleDoc);
  return {
    name: moduleDoc.name,
    id: slug(moduleDoc.id ?? moduleDoc.name),
    title: moduleDoc.name,
    path: projectRelativePath(moduleDoc.path),
    href,
    exportCount: moduleDoc.exports.length,
    summary,
    summaryHtml: renderMarkdownInline(summary, { resolveLink: buildLinkResolver(api, moduleDoc) }),
    docHtml: renderDocHtml(moduleDoc.doc, ctx, 1),
    symbolIndexHtml,
    hasSymbolIndex: symbolIndexHtml.length > 0,
    groups,
    hasGroups: groups.length > 0,
  };
}

function toHtmlGuide(api: ApiDoc, guide: GuideDoc): HtmlGuide {
  return {
    id: slug(guide.id),
    title: guide.title,
    path: projectRelativePath(guide.path),
    href: guide.href,
    html: renderMarkdown(stripFirstHeading(guide.text), {
      headingOffset: 0,
      resolveLink: buildSourceLinkResolver(api, guide.path, guide.href),
      renderCode: (code, lang) => renderCodeHtml(lang, code),
    }),
  };
}

function renderSymbolIndexHtml(moduleDoc: ModuleDoc): string {
  if (moduleDoc.exports.length === 0) return '';
  const items = moduleDoc.exports.map((item) => {
    const href = `#${escapeHtml(slug(item.id ?? item.name))}`;
    const members = item.members.length === 0
      ? ''
      : `<ul class="docs-page-index-members">${item.members.map((member) => {
          const memberHref = `#${escapeHtml(slug(member.id ?? member.name))}`;
          return `<li><a href="${memberHref}">${escapeHtml(member.name)}</a></li>`;
        }).join('')}</ul>`;
    return `<li><a href="${href}">${escapeHtml(item.name)}</a>${members}</li>`;
  }).join('');
  return `<nav class="docs-page-index" aria-label="Page symbol index"><p class="docs-page-index-title">On This Page</p><ul>${items}</ul></nav>`;
}

function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^\s*#\s+.+(?:\r?\n|$)/, '');
}

async function renderReadmeHtml(api: ApiDoc): Promise<string> {
  const readmePath = `${cwd().replace(/\/+$/, '')}/README.md`;
  if (!(await exists(readmePath))) return '<h1>API Documentation</h1>\n<p class="muted">No README.md found.</p>';
  const assets = new Map<string, SourceAssetRef>();
  const html = renderMarkdown(await fs.readFile(readmePath), {
    headingOffset: 0,
    resolveLink: buildSourceLinkResolver(api, 'README.md', 'index.html', undefined, { assets }),
    renderCode: (code, lang) => renderCodeHtml(lang, code),
  });
  await copySourceAssets(assets);
  return html;
}

function projectRelativePath(path: string): string {
  let value = path.startsWith('file://') ? path.slice('file://'.length) : path;
  value = value.replace(/\/\.\//g, '/');
  if (value.startsWith('./')) value = value.slice(2);
  const root = cwd().replace(/\/+$/, '');
  if (value === root) return '.';
  if (value.startsWith(root + '/')) return value.slice(root.length + 1);
  return value;
}

function normalizeDocPath(path: string): string {
  return projectRelativePath(path)
    .replace(/\\/g, '/')
    .replace(/\/\.\//g, '/')
    .replace(/^\.\//, '');
}

function moduleHref(moduleDoc: ModuleDoc): string {
  const path = foldedModulePath(moduleDoc.path);
  return `${path || moduleDoc.name}.html`;
}

function foldedModulePath(path: string): string {
  const withoutExtension = normalizeDocPath(path).replace(/\.(m?ts|m?js)$/i, '');
  return withoutExtension.replace(/\/index$/i, '');
}

function symbolAnchor(symbol: FlatSymbol): string {
  return slug(symbol.id);
}

function symbolHref(symbol: FlatSymbol, fromHref = 'index.html'): string {
  return `${relativeHref(fromHref, moduleHref(symbol.module))}#${symbolAnchor(symbol)}`;
}

function findSymbolInModule(api: ApiDoc, moduleDoc: ModuleDoc, fragment: string): FlatSymbol | undefined {
  const normalized = decodeURIComponent(fragment).replace(/^#/, '');
  const symbols = flatten(api).filter((symbol) => symbol.module === moduleDoc);
  return symbols.find((symbol) => symbol.id === normalized)
    ?? symbols.find((symbol) => symbol.name === normalized)
    ?? symbols.find((symbol) => symbol.qualifiedName === `${moduleDoc.name}.${normalized}`)
    ?? symbols.find((symbol) => symbol.qualifiedName.endsWith(`.${normalized}`))
    ?? symbols.find((symbol) => symbol.id.endsWith(`.${normalized}`));
}

function resolveSourceModule(api: ApiDoc, fromModule: ModuleDoc, hrefPath: string): ModuleDoc | undefined {
  const currentDir = dirname(normalizeDocPath(fromModule.path));
  const target = hrefPath.startsWith('./') || hrefPath.startsWith('../')
    ? normalizeRelativePath(currentDir === '.' ? hrefPath : `${currentDir}/${hrefPath}`)
    : normalizeDocPath(hrefPath);
  return api.modules.find((moduleDoc) => normalizeDocPath(moduleDoc.path) === target);
}

function resolveSourceGuide(api: ApiDoc, sourcePath: string, hrefPath: string): GuideDoc | undefined {
  const currentDir = dirname(normalizeDocPath(sourcePath));
  const target = hrefPath.startsWith('./') || hrefPath.startsWith('../')
    ? normalizeRelativePath(currentDir === '.' ? hrefPath : `${currentDir}/${hrefPath}`)
    : normalizeDocPath(hrefPath);
  return (api.guides ?? []).find((guide) => normalizeDocPath(guide.path) === target);
}

function normalizeRelativePath(path: string): string {
  const out: string[] = [];
  const scanner = new Scanner(path, { encoding: 'utf-8', format: 'doc-path' });
  while (!scanner.done) {
    const start = scanner.mark();
    scanner.eatUntil((code) => code === 0x2F);
    const part = scanner.text(start);
    scanner.eatChar('/');
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function buildLinkResolver(api: ApiDoc, moduleDoc: ModuleDoc): (href: string, label: string) => string | undefined {
  return buildSourceLinkResolver(api, moduleDoc.path, moduleHref(moduleDoc), moduleDoc);
}

function buildSourceLinkResolver(api: ApiDoc, sourcePath: string, outputHref: string, moduleDoc?: ModuleDoc, options: SourceLinkResolverOptions = {}): (href: string, label: string) => string | undefined {
  return (href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
    const [pathPart, fragment = ''] = href.split('#', 2);
    if (!pathPart && fragment && moduleDoc) {
      const symbol = findSymbolInModule(api, moduleDoc, fragment);
      return symbol ? symbolHref(symbol, outputHref) : href;
    }
    const targetGuide = pathPart ? resolveSourceGuide(api, sourcePath, pathPart) : undefined;
    if (targetGuide) return `${relativeHref(outputHref, targetGuide.href)}${fragment ? `#${slug(fragment)}` : ''}`;
    const targetModule = moduleDoc
      ? resolveSourceModule(api, moduleDoc, pathPart)
      : resolveSourceModuleFromPath(api, sourcePath, pathPart);
    if (!targetModule) return rewriteSourceRelativeHref(sourcePath, outputHref, href, options);
    if (!fragment) return relativeHref(outputHref, moduleHref(targetModule));
    const symbol = findSymbolInModule(api, targetModule, fragment);
    return symbol ? symbolHref(symbol, outputHref) : `${relativeHref(outputHref, moduleHref(targetModule))}#${slug(fragment)}`;
  };
}

function resolveSourceModuleFromPath(api: ApiDoc, sourcePath: string, hrefPath: string): ModuleDoc | undefined {
  const currentDir = dirname(normalizeDocPath(sourcePath));
  const target = hrefPath.startsWith('./') || hrefPath.startsWith('../')
    ? normalizeRelativePath(currentDir === '.' ? hrefPath : `${currentDir}/${hrefPath}`)
    : normalizeDocPath(hrefPath);
  return api.modules.find((moduleDoc) => normalizeDocPath(moduleDoc.path) === target);
}

function rewriteSourceRelativeHref(sourcePath: string, outputHref: string, href: string, options: SourceLinkResolverOptions = {}): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href;
  const suffixIndex = firstHrefSuffixIndex(href);
  const pathPart = suffixIndex >= 0 ? href.slice(0, suffixIndex) : href;
  const suffix = suffixIndex >= 0 ? href.slice(suffixIndex) : '';
  if (!pathPart || pathPart.startsWith('#')) return href;
  const sourceDir = dirname(normalizeDocPath(sourcePath));
  const targetPath = normalizeRelativePath(sourceDir === '.' ? pathPart : `${sourceDir}/${pathPart}`);
  const copiedAsset = sourceAssetHref(targetPath, href, options);
  if (copiedAsset) return copiedAsset;
  return relativeHref(`${DOCS_DIR_NAME}/${outputHref}`, targetPath) + suffix;
}

function sourceAssetHref(sourcePath: string, href: string, options: SourceLinkResolverOptions): string | undefined {
  if (!options.assets || !isCopyableDocAsset(sourcePath)) return undefined;
  const outputPath = normalizeDocPath(sourcePath);
  options.assets.set(outputPath, {
    sourcePath: joinPath(cwd(), sourcePath),
    outputPath: joinPath(docsDir(), outputPath),
  });
  return href;
}

function isCopyableDocAsset(path: string): boolean {
  return /\.(avif|gif|ico|jpe?g|png|svg|webp)$/i.test(path);
}

async function copySourceAssets(assets: Map<string, SourceAssetRef>): Promise<void> {
  for (const asset of assets.values()) {
    if (!(await exists(asset.sourcePath))) continue;
    await ensureDir(dirname(asset.outputPath));
    await fs.copyFile(asset.sourcePath, asset.outputPath);
  }
}

function firstHrefSuffixIndex(href: string): number {
  const scanner = new Scanner(href, { encoding: 'utf-8', format: 'doc-link' });
  while (!scanner.done) {
    if (scanner.peekCode() === 0x3F || scanner.peekCode() === 0x23) return scanner.offset;
    scanner.eat();
  }
  return -1;
}

function toHtmlExport(item: DocExport, ctx: HtmlRenderContext): HtmlExport {
  const members = item.members.map((member) => toHtmlMember(member, ctx));
  const memberGroups = groupHtmlItems(members);
  const signatures = signaturesOf(item);
  const reExportHtml = renderReExportHtml(item, ctx);
  const docHtml = [reExportHtml, renderDocHtml(item.doc, ctx, 3)].filter(Boolean).join('\n');
  return {
    id: slug(item.id ?? item.name),
    name: item.name,
    kind: item.kind,
    titleHtml: renderSignatureTitleHtml(item.name, signatures, ctx),
    overloadsHtml: renderOverloadsHtml(signatures, ctx),
    docHtml,
    memberGroups,
    hasMemberGroups: memberGroups.length > 0,
  };
}

function renderReExportHtml(item: DocExport, ctx: HtmlRenderContext): string {
  if (item.reExport?.mode !== 'link') return '';
  const sourceId = item.reExport.sourceId;
  const source = sourceId ? flatten(ctx.api).find((symbol) => symbol.id === sourceId) : undefined;
  const label = sourceId ?? `${item.reExport.sourceModule}.${item.reExport.sourceName}`;
  if (!source) return `<p class="muted">Re-exported from <code>${escapeHtml(label)}</code>.</p>`;
  return `<p class="muted">Re-exported from <a href="${escapeHtml(symbolHref(source, ctx.currentHref))}">${escapeHtml(label)}</a>.</p>`;
}

function toHtmlMember(member: DocMember, ctx: HtmlRenderContext): HtmlMember {
  const signatures = signaturesOf(member);
  return {
    id: slug(member.id ?? member.name),
    name: member.name,
    kind: member.kind,
    titleHtml: renderSignatureTitleHtml(member.name, signatures, ctx),
    overloadsHtml: renderOverloadsHtml(signatures, ctx),
    docHtml: renderDocHtml(member.doc, ctx, 5),
  };
}

function groupHtmlItems<T extends { kind: string }>(items: T[]): HtmlGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const title = displayKind(item.kind);
    const group = groups.get(title);
    if (group) group.push(item);
    else groups.set(title, [item]);
  }
  return [...groups].map(([title, groupItems]) => ({ title, items: groupItems }));
}

function displayKind(kind: string): string {
  const normalized = kind.replace(/-/g, ' ');
  const special: Record<string, string> = {
    class: 'Classes',
    const: 'Constants',
    constructor: 'Constructors',
    enum: 'Enums',
    function: 'Functions',
    getter: 'Getters',
    interface: 'Interfaces',
    method: 'Methods',
    namespace: 'Namespaces',
    property: 'Properties',
    'readonly-property': 'Readonly Properties',
    'static-property': 'Static Properties',
    'static-readonly-property': 'Static Readonly Properties',
    setter: 'Setters',
    type: 'Types',
    variable: 'Variables',
  };
  if (special[kind]) return special[kind]!;
  return normalized.split(/\s+/).map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(' ') + 's';
}

function renderSignatureTitleHtml(name: string, signatures: string[], ctx: HtmlRenderContext): string {
  return `<code>${renderHighlightedTypeScript(signatures[0] ?? name, { ...ctx, linkIdentifiers: true })}</code>`;
}

function renderOverloadsHtml(signatures: string[], ctx: HtmlRenderContext): string {
  if (signatures.length <= 1) return '';
  return renderCodeHtml('ts', signatures.join('\n'), { ...ctx, linkIdentifiers: true });
}

function renderCodeHtml(lang: string, code: string, ctx?: HighlightContext): string {
  const label = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  const body = shouldHighlightLanguage(lang)
    ? renderHighlightedTypeScript(code, ctx)
    : escapeHtml(code);
  return `<pre><code${label}>${body}</code></pre>`;
}

const HIGHLIGHT_LANGUAGES = new Set(['ts', 'mts', 'typescript', 'js', 'mjs', 'javascript']);
const KEYWORD_TOKENS = new Set([
  'abstract', 'any', 'as', 'asserts', 'async', 'await', 'bigint', 'boolean', 'break', 'case',
  'catch', 'class', 'const', 'constructor', 'continue', 'debugger', 'declare', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface',
  'keyof', 'let', 'module', 'namespace', 'never', 'new', 'null', 'number', 'object', 'of',
  'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'string', 'super',
  'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unique',
  'unknown', 'var', 'void', 'while', 'with', 'yield',
]);

const MDN_SIGNATURE_TYPES: Record<string, string> = {
  AbortController: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortController',
  AbortSignal: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal',
  Array: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
  ArrayBuffer: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer',
  AsyncGenerator: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncGenerator',
  AsyncIterable: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncIterator',
  BigInt: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt',
  Blob: 'https://developer.mozilla.org/en-US/docs/Web/API/Blob',
  Error: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error',
  Event: 'https://developer.mozilla.org/en-US/docs/Web/API/Event',
  EventTarget: 'https://developer.mozilla.org/en-US/docs/Web/API/EventTarget',
  File: 'https://developer.mozilla.org/en-US/docs/Web/API/File',
  Float32Array: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Float32Array',
  Headers: 'https://developer.mozilla.org/en-US/docs/Web/API/Headers',
  Map: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map',
  Promise: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise',
  Record: 'https://www.typescriptlang.org/docs/handbook/utility-types.html#recordkeys-type',
  Request: 'https://developer.mozilla.org/en-US/docs/Web/API/Request',
  Response: 'https://developer.mozilla.org/en-US/docs/Web/API/Response',
  Set: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set',
  Uint8Array: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array',
  URL: 'https://developer.mozilla.org/en-US/docs/Web/API/URL',
  WeakMap: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap',
};

function shouldHighlightLanguage(lang: string): boolean {
  return HIGHLIGHT_LANGUAGES.has((lang || 'ts').toLowerCase());
}

function renderHighlightedTypeScript(code: string, ctx?: HighlightContext): string {
  const spans = highlightSpans(code);
  if (spans.length === 0) return escapeHtml(code);

  let offset = 0;
  let html = '';
  for (const span of spans) {
    if (span.start < offset) continue;
    if (span.start > offset) html += escapeHtml(code.slice(offset, span.start));
    html += renderTokenSpan(span.text, span.kind, ctx);
    offset = span.end;
  }
  if (offset < code.length) html += escapeHtml(code.slice(offset));
  return html;
}

function highlightSpans(code: string): HighlightSpan[] {
  const direct = parseHighlightSpans(code, code, 0, utf8ByteLength(code), 0);
  if (direct.length > 0) return direct;

  if (code.trimEnd().endsWith('{')) {
    const completed = `${code}}`;
    const classHeader = parseHighlightSpans(completed, code, 0, utf8ByteLength(code), 0);
    if (classHeader.length > 0) return classHeader;
  }

  const prefix = 'class __Doc { ';
  const wrapped = `${prefix}${code} }`;
  const startByte = utf8ByteLength(prefix);
  return parseHighlightSpans(wrapped, code, startByte, startByte + utf8ByteLength(code), prefix.length);
}

function parseHighlightSpans(source: string, original: string, startByte: number, endByte: number, startIndex: number): HighlightSpan[] {
  let parsed: ParseResult;
  try {
    parsed = parseTypeScript(source, { sourceType: 'ts', tokens: true });
  } catch (_) {
    return [];
  }
  const spans = [
    ...parsed.comments.map((comment) => ({ start: comment.start, end: comment.end, kind: 'comment' })),
    ...parsed.tokens.map((token) => ({ start: token.start, end: token.end, kind: token.kind })),
  ];
  return spans
    .filter((span) => span.end > span.start && span.start >= startByte && span.end <= endByte)
    .map((span) => {
      const sourceStart = stringIndexForByteOffset(source, span.start);
      const sourceEnd = stringIndexForByteOffset(source, span.end);
      const start = sourceStart - startIndex;
      const end = sourceEnd - startIndex;
      return {
        start,
        end,
        kind: span.kind,
        text: original.slice(start, end),
      };
    })
    .filter((span) => span.text.length > 0)
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

function renderTokenSpan(text: string, kind: string, ctx?: HighlightContext): string {
  if (kind === 'comment') return `<span class="tok-comment">${escapeHtml(text)}</span>`;
  if (kind === 'Identifier' && ctx?.linkIdentifiers) {
    const href = signatureIdentifierHref(text, ctx);
    if (href) return `<a class="tok-type" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  }
  const cls = tokenClass(text, kind);
  return cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
}

function tokenClass(text: string, kind: string): string {
  if (kind === 'jsx' || text.startsWith('"') || text.startsWith("'") || text.startsWith('`')) return 'tok-string';
  if (kind.includes('bigint') || kind === 'decimal' || kind === 'float' || kind === 'binary' || kind === 'octal' || kind === 'hex') return 'tok-number';
  if (kind === '/regexp/') return 'tok-regexp';
  if (KEYWORD_TOKENS.has(kind) || KEYWORD_TOKENS.has(text)) return 'tok-keyword';
  return '';
}

function signatureIdentifierHref(name: string, ctx: HtmlRenderContext): string | undefined {
  if (!/^[A-Z]/.test(name) && !MDN_SIGNATURE_TYPES[name]) return undefined;
  const symbols = flatten(ctx.api);
  const local = symbols.find((symbol) => symbol.module === ctx.module && symbol.name === name)
    ?? symbols.find((symbol) => symbol.module === ctx.module && symbol.qualifiedName.endsWith(`.${name}`))
    ?? symbols.find((symbol) => symbol.name === name)
    ?? symbols.find((symbol) => symbol.qualifiedName.endsWith(`.${name}`));
  if (local) return symbolHref(local, ctx.currentHref);
  return MDN_SIGNATURE_TYPES[name];
}

function firstSummary(doc: DocBlock): string {
  const paragraph = (doc.blocks ?? []).find((block) => block.kind === 'paragraph' && block.text);
  const text = String(paragraph?.text ?? doc.text ?? '').trim().split(/\n\s*\n/)[0] ?? '';
  return text.length > 180 ? text.slice(0, 177).trimEnd() + '...' : text;
}

function renderSidebarHtml(api: ApiDoc, currentHref: string, title: string): string {
  const guideEntries: SidebarEntry[] = (api.guides ?? [])
    .map((guide) => ({ label: guide.title, href: guide.href, kind: 'guide' as const, weight: guide.weight }))
    .sort((a, b) => compareAscii(a.href, b.href));
  const apiEntries: SidebarEntry[] = api.modules
    .map((moduleDoc) => ({ label: moduleDoc.name.split('/').pop() ?? moduleDoc.name, href: moduleHref(moduleDoc), kind: 'api' as const }))
    .sort((a, b) => compareAscii(a.href, b.href));
  const guideTree = sidebarTree(guideEntries, 'Docs');
  const apiTree = sidebarTree(apiEntries, 'API Reference');
  return `<nav class="docs-sidebar" aria-label="Documentation navigation">
<p class="docs-sidebar-title"><a href="${escapeHtml(relativeHref(currentHref, 'index.html'))}">${escapeHtml(title)}</a></p>
${renderSidebarItems([...guideTree, ...apiTree], currentHref)}
</nav>`;
}

interface SidebarNode {
  name: string;
  path: string;
  entry?: SidebarEntry;
  children: Map<string, SidebarNode>;
}

interface SidebarEntry {
  label: string;
  href: string;
  kind: 'api' | 'guide';
  weight?: number;
}

function sidebarTree(entries: SidebarEntry[], rootName?: string): SidebarNode[] {
  if (entries.length === 0) return [];
  const root = new Map<string, SidebarNode>();
  const base = sharedSidebarBase(entries);
  const ensureNode = (siblings: Map<string, SidebarNode>, name: string, path: string): SidebarNode => {
    let node = siblings.get(name);
    if (!node) {
      node = { name, path, children: new Map() };
      siblings.set(name, node);
    }
    return node;
  };
  for (const entry of entries) {
    const hrefParts = entry.href.replace(/\.html$/i, '').split('/').filter(Boolean);
    const parts = base === undefined ? hrefParts : hrefParts.slice(1);
    let siblings = root;
    let currentPath = '';
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const node = ensureNode(siblings, part, currentPath);
      if (index === parts.length - 1) node.entry = entry;
      siblings = node.children;
    }
  }
  const sorted = collapseSidebarDirectories(sortSidebarNodes([...root.values()]));
  if (rootName === undefined) return sorted;
  return [{
    name: rootName,
    path: rootName,
    children: new Map(sorted.map((node) => [node.name, node])),
  }];
}

function sharedSidebarBase(entries: SidebarEntry[]): string | undefined {
  let first: string | undefined;
  let hasNested = false;
  for (const entry of entries) {
    const parts = entry.href.replace(/\.html$/i, '').split('/').filter(Boolean);
    if (parts.length === 0) return undefined;
    first ??= parts[0];
    if (parts[0] !== first) return undefined;
    if (parts.length > 1) hasNested = true;
  }
  return hasNested ? first : undefined;
}

function collapseSidebarDirectories(nodes: SidebarNode[]): SidebarNode[] {
  return nodes.map(collapseSidebarDirectory);
}

function collapseSidebarDirectory(node: SidebarNode): SidebarNode {
  node.children = new Map(collapseSidebarDirectories([...node.children.values()]).map((child) => [child.name, child]));
  let collapsed = node;
  while (!collapsed.entry && collapsed.children.size === 1) {
    const child = [...collapsed.children.values()][0]!;
    if (child.entry) break;
    collapsed = {
      name: `${collapsed.name}/${child.name}`,
      path: child.path,
      children: child.children,
    };
  }
  return collapsed;
}

function sortSidebarNodes(nodes: SidebarNode[]): SidebarNode[] {
  return nodes.sort(compareSidebarNodes).map((node) => {
    node.children = new Map(sortSidebarNodes([...node.children.values()]).map((child) => [child.name, child]));
    return node;
  });
}

function compareSidebarNodes(a: SidebarNode, b: SidebarNode): number {
  const rank = (node: SidebarNode) => node.entry?.kind === 'guide' ? 0 : 1;
  return rank(a) - rank(b) || compareGuideWeight(a, b) || compareAscii(a.name, b.name);
}

function compareGuideWeight(a: SidebarNode, b: SidebarNode): number {
  if (a.entry?.kind !== 'guide' || b.entry?.kind !== 'guide') return 0;
  const left = a.entry.weight;
  const right = b.entry.weight;
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function renderSidebarItems(nodes: SidebarNode[], currentHref: string): string {
  if (nodes.length === 0) return '';
  return `<ul>${nodes.map((node) => renderSidebarNode(node, currentHref)).join('')}</ul>`;
}

function renderSidebarNode(node: SidebarNode, currentHref: string): string {
  const children = renderSidebarItems([...node.children.values()], currentHref);
  if (node.entry) {
    const href = relativeHref(currentHref, node.entry.href);
    const current = node.entry.href === currentHref ? ' aria-current="page"' : '';
    return `<li><a class="docs-sidebar-link docs-sidebar-link-${node.entry.kind}" href="${escapeHtml(href)}"${current}>${sidebarIcon(node.entry.kind)}<span>${escapeHtml(node.entry.label)}</span></a>${children}</li>`;
  }
  return `<li><div class="docs-sidebar-directory">${escapeHtml(node.name)}</div>${children}</li>`;
}

function sidebarIcon(kind: SidebarEntry['kind']): string {
  if (kind === 'guide') {
    return '<svg class="docs-sidebar-icon docs-sidebar-icon-guide" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 8h2"/><path d="M6 12h2"/><path d="M16 8h2"/><path d="M16 12h2"/></svg>';
  }
  return '<svg class="docs-sidebar-icon docs-sidebar-icon-api" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>';
}

function relativeHref(fromHref: string, toHref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(toHref) || toHref.startsWith('#')) return toHref;
  const fromParts = fromHref.split('/').filter(Boolean);
  const toParts = toHref.split('/').filter(Boolean);
  fromParts.pop();
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  return [...fromParts.map(() => '..'), ...toParts].join('/') || basename(toHref);
}

async function readApi(path: string): Promise<ApiDoc> {
  return JSON.parse(await fs.readFile(path)) as ApiDoc;
}

async function extractApi(files: string[], includePrivate: boolean = false): Promise<ApiDoc> {
  const modules: ParsedModuleDoc[] = [];
  for (const file of files) {
    const moduleDoc = await extractModuleFromSource(String(file), includePrivate);
    modules.push(moduleDoc);
  }
  disambiguateModules(modules);
  resolveReExports(modules, includePrivate);
  const visibleModules = includePrivate ? modules : modules.filter((moduleDoc) => !moduleDoc.internal);
  return { schemaVersion: 4, modules: visibleModules.map(stripParsedModuleFields) };
}

async function extractDocs(sourceFiles: string[], guideFiles: string[], includePrivate: boolean = false): Promise<ApiDoc> {
  const api = await extractApi(sourceFiles, includePrivate);
  api.guides = await extractGuides(guideFiles);
  return api;
}

async function extractDocsCached(inputs: DocInputs, includePrivate: boolean = false, options: DocCacheOptions = {}): Promise<ApiDoc> {
  if (!sqlite.sqliteAvailable) return extractDocs(inputs.sourceFiles, inputs.guideFiles, includePrivate);
  const db = await openDocsDb();
  try {
    await ensureDocsCacheSchema(db);
    return await extractDocsFromCache(db, inputs, includePrivate, options);
  } finally {
    await db.close();
  }
}

async function openDocsDb(): Promise<DocsDatabase> {
  await ensureDir(docsDir());
  return sqlite.Database.open(docsDbPath()) as Promise<DocsDatabase>;
}

async function ensureDocsCacheSchema(db: DocsDatabase): Promise<void> {
  for (const statement of DOCS_CACHE_SCHEMA_STATEMENTS) await db.exec(statement);
  await runDocsStatement(db, 'INSERT OR REPLACE INTO doc_meta VALUES (?, ?)', 'cache_schema_version', '1');
}

async function extractDocsFromCache(db: DocsDatabase, inputs: DocInputs, includePrivate: boolean, options: DocCacheOptions = {}): Promise<ApiDoc> {
  const current = await currentDocFiles(inputs);
  const currentKeys = new Set(current.map((file) => file.path));
  const cached = await readCachedDocFiles(db, includePrivate);
  const parsedModules: ParsedModuleDoc[] = [];
  const guides: GuideDoc[] = [];

  for (const [path, cachedFile] of cached) {
    if (!currentKeys.has(path)) {
      await deleteCachedDocFile(db, cachedFile.path, cachedFile.kind, includePrivate);
    }
  }

  for (const file of current) {
    const cachedFile = cached.get(file.path);
    const fresh = cachedFile
      && cachedFile.kind === file.kind
      && cachedFile.mtimeMs === file.mtimeMs
      && cachedFile.size === file.size;
    let json: string | undefined;
    if (fresh) {
      json = cachedFile!.json;
    } else if (options.shouldParseChanged && !(await options.shouldParseChanged(file))) {
      json = cachedFile?.json;
    } else {
      json = JSON.stringify(await parseCurrentDocFile(file, includePrivate));
      await writeCachedDocFile(db, file, includePrivate, json);
    }
    if (json === undefined) continue;
    const parsed = JSON.parse(json);
    if (file.kind === 'source') parsedModules.push(parsed as ParsedModuleDoc);
    else guides.push(parsed as GuideDoc);
  }

  disambiguateModules(parsedModules);
  resolveReExports(parsedModules, includePrivate);
  const visibleModules = includePrivate ? parsedModules : parsedModules.filter((moduleDoc) => !moduleDoc.internal);
  return {
    schemaVersion: 4,
    modules: visibleModules.map(stripParsedModuleFields),
    guides: guides.sort((a, b) => compareAscii(a.href, b.href)),
  };
}

async function currentDocFiles(inputs: DocInputs): Promise<CurrentDocFile[]> {
  const files: CurrentDocFile[] = [];
  for (const file of inputs.sourceFiles) files.push(await currentDocFile(file, 'source'));
  for (const file of inputs.guideFiles) files.push(await currentDocFile(file, 'guide'));
  return files.sort((a, b) => compareAscii(a.path, b.path) || compareAscii(a.kind, b.kind));
}

async function currentDocFile(file: string, kind: DocFileKind): Promise<CurrentDocFile> {
  const stat = await fs.lstat(file);
  return {
    path: normalizeDocPath(file),
    file,
    kind,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

async function parseCurrentDocFile(file: CurrentDocFile, includePrivate: boolean): Promise<ParsedModuleDoc | GuideDoc> {
  if (file.kind === 'source') return extractModuleFromSource(file.file, includePrivate);
  const parsed = parseGuideMarkdown(file.path, String(await fs.readFile(file.file)));
  const guide: GuideDoc = {
    id: guideId(file.path),
    path: file.path,
    href: guideHref(parsed.virtualPath ?? file.path),
    title: guideTitle(file.path, parsed.text),
    summary: guideSummary(parsed.text),
    text: parsed.text,
  };
  if (parsed.weight !== undefined) guide.weight = parsed.weight;
  return guide;
}

async function readCachedDocFiles(db: DocsDatabase, includePrivate: boolean): Promise<Map<string, CachedDocFile>> {
  const stmt = db.prepare('SELECT path, kind, include_private, mtime_ms, size, json FROM doc_files WHERE include_private = ?');
  try {
    const rows = await stmt.all(includePrivate ? 1 : 0);
    return new Map(rows.map((row) => {
      const cached: CachedDocFile = {
        path: String(row.path),
        kind: String(row.kind) as DocFileKind,
        includePrivate: Number(row.include_private) === 1,
        mtimeMs: Number(row.mtime_ms),
        size: Number(row.size),
        json: String(row.json),
      };
      return [cached.path, cached];
    }));
  } finally {
    stmt.finalize();
  }
}

async function writeCachedDocFile(db: DocsDatabase, file: CurrentDocFile, includePrivate: boolean, json: string): Promise<void> {
  await runDocsStatement(db, 'INSERT OR REPLACE INTO doc_files VALUES (?, ?, ?, ?, ?, ?)',
    file.path,
    file.kind,
    includePrivate ? 1 : 0,
    file.mtimeMs,
    file.size,
    json,
  );
}

async function deleteCachedDocFile(db: DocsDatabase, path: string, kind: DocFileKind, includePrivate: boolean): Promise<void> {
  await runDocsStatement(db, 'DELETE FROM doc_files WHERE path = ? AND kind = ? AND include_private = ?',
    path,
    kind,
    includePrivate ? 1 : 0,
  );
}

async function extractGuides(files: string[]): Promise<GuideDoc[]> {
  const guides: GuideDoc[] = [];
  for (const file of files) {
    const path = normalizeDocPath(file);
    const parsed = parseGuideMarkdown(path, String(await fs.readFile(file)));
    const guide: GuideDoc = {
      id: guideId(path),
      path,
      href: guideHref(parsed.virtualPath ?? path),
      title: guideTitle(path, parsed.text),
      summary: guideSummary(parsed.text),
      text: parsed.text,
    };
    if (parsed.weight !== undefined) guide.weight = parsed.weight;
    guides.push(guide);
  }
  return guides.sort((a, b) => compareAscii(a.href, b.href));
}

interface ParsedGuideMarkdown {
  text: string;
  weight?: number;
  virtualPath?: string;
}

function parseGuideMarkdown(path: string, raw: string): ParsedGuideMarkdown {
  const frontmatter = extractGuideFrontmatter(path, raw);
  if (frontmatter === null) return { text: raw };
  const parsed: ParsedGuideMarkdown = { text: frontmatter.text };
  const weight = frontmatter.data['weight'];
  if (weight !== undefined) {
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      throw new Error(`fino doc: guide ${path} frontmatter weight must be a finite number`);
    }
    parsed.weight = weight;
  }
  const virtualPath = frontmatter.data['path'];
  if (virtualPath !== undefined) {
    if (typeof virtualPath !== 'string') {
      throw new Error(`fino doc: guide ${path} frontmatter path must be a string`);
    }
    parsed.virtualPath = normalizeGuideVirtualPath(path, virtualPath);
  }
  return parsed;
}

function normalizeGuideVirtualPath(sourcePath: string, value: string): string {
  const path = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path || path.includes('\0') || path.split('/').some((part) => part === '..')) {
    throw new Error(`fino doc: guide ${sourcePath} frontmatter path must stay within the docs output`);
  }
  if (!/\.md$/i.test(path)) throw new Error(`fino doc: guide ${sourcePath} frontmatter path must end with .md`);
  return normalizeDocPath(path);
}

function extractGuideFrontmatter(path: string, raw: string): { data: Record<string, unknown>; text: string } | null {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return null;
  const firstLineEnd = raw.startsWith('---\r\n') ? 5 : 4;
  const closeMatch = /\r?\n---(?:\r?\n|$)/.exec(raw.slice(firstLineEnd));
  if (!closeMatch) throw new Error(`fino doc: guide ${path} has unterminated frontmatter`);
  const closeStart = firstLineEnd + closeMatch.index;
  const closeEnd = firstLineEnd + closeMatch.index + closeMatch[0].length;
  const yaml = raw.slice(firstLineEnd, closeStart);
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (err: unknown) {
    throw new Error(`fino doc: guide ${path} has invalid frontmatter: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (data === null) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`fino doc: guide ${path} frontmatter must be a mapping`);
  }
  return { data: data as Record<string, unknown>, text: raw.slice(closeEnd) };
}

function guideId(path: string): string {
  return `guide:${normalizeDocPath(path).replace(/\.md$/i, '')}`;
}

function guideHref(path: string): string {
  return normalizeDocPath(path).replace(/\.md$/i, '.html');
}

function guideTitle(path: string, markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return plainMarkdownText(match[1]!).trim() || basename(path).replace(/\.md$/i, '');
  }
  return basename(path).replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
}

function guideSummary(markdown: string): string {
  const lines: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^#/.test(trimmed) || /^\[.+\]:/.test(trimmed)) {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(trimmed);
  }
  const summary = plainMarkdownText(lines.join(' ')).trim();
  return summary.length > 180 ? summary.slice(0, 177).trimEnd() + '...' : summary;
}

function plainMarkdownText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/[_#]/g, '')
    .replace(/\s+/g, ' ');
}

function stripParsedModuleFields(moduleDoc: ParsedModuleDoc): ModuleDoc {
  const { internal: _internal, reExports: _reExports, reExportsResolved: _resolved, ...publicDoc } = moduleDoc;
  return publicDoc;
}

function resolveReExports(modules: ParsedModuleDoc[], includePrivate: boolean): void {
  for (const moduleDoc of modules) resolveModuleReExports(moduleDoc, modules, includePrivate, new Set());
}

function resolveModuleReExports(moduleDoc: ParsedModuleDoc, modules: ParsedModuleDoc[], includePrivate: boolean, stack: Set<string>): void {
  if (moduleDoc.reExportsResolved) return;
  const key = normalizeDocPath(moduleDoc.path);
  if (stack.has(key)) return;
  stack.add(key);

  const existingNames = new Set(moduleDoc.exports.map((item) => item.name));
  for (const spec of moduleDoc.reExports) {
    const sourceModule = resolveReExportModule(modules, moduleDoc, spec.source);
    if (!sourceModule) continue;
    resolveModuleReExports(sourceModule, modules, includePrivate, stack);

    if (spec.all) {
      for (const sourceExport of sourceModule.exports) {
        if (sourceExport.name === 'default' || existingNames.has(sourceExport.name)) continue;
        const item = materializeReExport(sourceExport, sourceExport.name, sourceModule, includePrivate);
        if (!item) continue;
        moduleDoc.exports.push(item);
        existingNames.add(item.name);
      }
      continue;
    }

    if (spec.namespace) {
      if (existingNames.has(spec.exportedName)) continue;
      const item = materializeNamespaceReExport(spec.exportedName, sourceModule, includePrivate);
      if (!item) continue;
      moduleDoc.exports.push(item);
      existingNames.add(item.name);
      continue;
    }

    if (existingNames.has(spec.exportedName)) continue;
    const sourceExport = sourceModule.exports.find((item) => item.name === spec.sourceName);
    if (!sourceExport) continue;
    const item = materializeReExport(sourceExport, spec.exportedName, sourceModule, includePrivate);
    if (!item) continue;
    moduleDoc.exports.push(item);
    existingNames.add(item.name);
  }

  groupOverloads(moduleDoc.exports);
  assignDocIds(moduleDoc);
  moduleDoc.reExportsResolved = true;
  stack.delete(key);
}

function resolveReExportModule(modules: ParsedModuleDoc[], fromModule: ParsedModuleDoc, specifier: string): ParsedModuleDoc | undefined {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const currentDir = dirname(normalizeDocPath(fromModule.path));
    const target = normalizeRelativePath(currentDir === '.' ? specifier : `${currentDir}/${specifier}`);
    const candidates = modulePathCandidates(target);
    return modules.find((moduleDoc) => candidates.has(normalizeDocPath(moduleDoc.path)));
  }

  return modules.find((moduleDoc) =>
    moduleDoc.sourceModule === specifier ||
    moduleDoc.name === specifier ||
    normalizeDocPath(moduleDoc.path) === specifier);
}

function modulePathCandidates(path: string): Set<string> {
  const out = new Set<string>([normalizeDocPath(path)]);
  if (!/\.(m?ts|m?js)$/i.test(path)) {
    for (const ext of ['.ts', '.mts', '.mjs', '.js']) out.add(normalizeDocPath(path + ext));
    for (const ext of ['.ts', '.mts', '.mjs', '.js']) out.add(normalizeDocPath(`${path}/index${ext}`));
  }
  return out;
}

function materializeReExport(sourceExport: DocExport, exportedName: string, sourceModule: ParsedModuleDoc, includePrivate: boolean): DocExport | undefined {
  if (sourceExport.reExport?.mode === 'link') {
    return linkedReExport(sourceExport, exportedName, sourceExport.reExport.sourceModule, sourceExport.reExport.sourceName, sourceExport.reExport.sourceId);
  }

  const sourceVisible = includePrivate || !sourceModule.internal;
  if (sourceVisible) {
    return linkedReExport(sourceExport, exportedName, sourceModule.name, sourceExport.name, sourceExport.id);
  }

  const item = cloneExport(sourceExport);
  item.name = exportedName;
  item.signature = aliasSignature(item.signature, sourceExport.name, exportedName);
  item.signatures = signaturesOf(item).map((signature) => aliasSignature(signature, sourceExport.name, exportedName));
  item.reExport = {
    mode: 'inline',
    sourceModule: sourceModule.name,
    sourceName: sourceExport.name,
    sourceId: sourceExport.id,
  };
  return item;
}

function linkedReExport(sourceExport: DocExport, exportedName: string, sourceModule: string, sourceName: string, sourceId?: string): DocExport {
  const item = cloneExport(sourceExport);
  item.name = exportedName;
  item.signature = aliasSignature(item.signature, sourceExport.name, exportedName);
  item.signatures = signaturesOf(item).map((signature) => aliasSignature(signature, sourceExport.name, exportedName));
  item.doc = emptyDoc();
  item.members = [];
  item.reExport = {
    mode: 'link',
    sourceModule,
    sourceName,
    sourceId,
  };
  return item;
}

function materializeNamespaceReExport(exportedName: string, sourceModule: ParsedModuleDoc, includePrivate: boolean): DocExport {
  const sourceVisible = includePrivate || !sourceModule.internal;
  const item = exportDoc(exportedName, 'namespace', `namespace ${exportedName}`, sourceVisible ? emptyDoc() : cloneDoc(sourceModule.doc), { line: 1, column: 1 });
  item.reExport = {
    mode: sourceVisible ? 'link' : 'inline',
    sourceModule: sourceModule.name,
    sourceName: '*',
    sourceId: sourceModule.id,
  };
  if (!sourceVisible) {
    item.members = sourceModule.exports
      .filter((sourceExport) => sourceExport.name !== 'default')
      .map((sourceExport) => exportAsMember(sourceExport));
  }
  return item;
}

function exportAsMember(item: DocExport): DocMember {
  return {
    id: '',
    name: item.name,
    kind: item.kind,
    signature: item.signature,
    signatures: signaturesOf(item),
    aliases: [...(item.aliases ?? [])],
    reExport: item.reExport ? { ...item.reExport } : undefined,
    doc: cloneDoc(item.doc),
    location: item.location,
  };
}

function aliasSignature(signature: string, sourceName: string, exportedName: string): string {
  if (!signature || sourceName === exportedName || sourceName === '*') return signature;
  const escaped = sourceName.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return signature.replace(new RegExp(`\\b${escaped}\\b`), exportedName);
}

function disambiguateModules(modules: ModuleDoc[]): void {
  const counts = new Map<string, number>();
  for (const moduleDoc of modules) counts.set(moduleDoc.name, (counts.get(moduleDoc.name) ?? 0) + 1);
  for (const moduleDoc of modules) {
    if ((counts.get(moduleDoc.name) ?? 0) <= 1 && moduleDoc.name !== 'index') continue;
    const oldName = moduleDoc.name;
    const newName = moduleNameFromPath(moduleDoc.path);
    if (newName === oldName) continue;
    moduleDoc.name = newName;
    moduleDoc.id = `module:${newName}`;
    moduleDoc.sourceModule = newName;
    rewriteSymbolIds(moduleDoc, oldName, newName);
  }
}

function moduleNameFromPath(path: string): string {
  let rel = path;
  const base = cwd().replace(/\/$/, '') + '/';
  if (rel.startsWith(base)) rel = rel.slice(base.length);
  rel = rel.replace(/\.(m?ts|m?js)$/i, '');
  return rel.replace(/^\.\//, '').replace(/\/index$/i, '');
}

function rewriteSymbolIds(moduleDoc: ModuleDoc, oldName: string, newName: string): void {
  const oldPrefix = `${oldName}.`;
  const newPrefix = `${newName}.`;
  for (const item of moduleDoc.exports) {
    if (item.id?.startsWith(oldPrefix)) item.id = newPrefix + item.id.slice(oldPrefix.length);
    for (const member of item.members) {
      if (member.id?.startsWith(oldPrefix)) member.id = newPrefix + member.id.slice(oldPrefix.length);
    }
  }
}

async function discoverProjectDocInputs(): Promise<DocInputs> {
  return expandDocInputs(['.']);
}

async function ensureApiJson(): Promise<ApiDoc> {
  const path = apiJsonPath();
  const inputs = await discoverProjectDocInputs();
  if (inputs.sourceFiles.length === 0 && inputs.guideFiles.length === 0) throw new Error('fino doc search: no source files found to document');
  const api = await extractDocsCached(inputs);
  await ensureDir(docsDir());
  await fs.writeFile(path, JSON.stringify(api, null, 2) + '\n');
  return api;
}

async function ensureDocsDb(): Promise<string> {
  const dbPath = docsDbPath();
  const api = await ensureApiJson();
  await writeSqliteIndex(api, dbPath);
  return dbPath;
}

function flatten(api: ApiDoc): FlatSymbol[] {
  const symbols: FlatSymbol[] = [];
  for (const moduleDoc of api.modules) {
    for (const item of moduleDoc.exports) {
      const exportId = item.id ?? `${moduleDoc.name}.${item.name}`;
      symbols.push({
        module: moduleDoc,
        export: item,
        id: exportId,
        name: item.name,
        qualifiedName: `${moduleDoc.name}.${item.name}`,
        kind: item.kind,
        signature: item.signature,
        signatures: signaturesOf(item),
        doc: item.doc,
        location: item.location,
      });
      for (const member of item.members) {
        const memberId = member.id ?? `${exportId}.${member.name}`;
        symbols.push({
          module: moduleDoc,
          export: item,
          member,
          id: memberId,
          name: member.name,
          qualifiedName: `${moduleDoc.name}.${item.name}.${member.name}`,
          kind: member.kind,
          signature: member.signature,
          signatures: signaturesOf(member),
          doc: member.doc,
          location: member.location,
        });
      }
    }
  }
  return symbols;
}

function searchableText(symbol: FlatSymbol): string {
  const blocks = symbol.doc.blocks ?? [];
  return [
    symbol.id,
    symbol.name,
    symbol.qualifiedName,
    symbol.kind,
    symbol.signatures.join('\n'),
    symbol.member?.reExport ? `${symbol.member.reExport.sourceModule} ${symbol.member.reExport.sourceName} ${symbol.member.reExport.sourceId ?? ''}` : '',
    symbol.export.reExport ? `${symbol.export.reExport.sourceModule} ${symbol.export.reExport.sourceName} ${symbol.export.reExport.sourceId ?? ''}` : '',
    symbol.doc.text,
    ...symbol.doc.tags.map((tag) => `${tag.name} ${tag.value}`),
    ...blocks.map((block) => [block.kind, block.text, block.name, block.description, block.code].filter(Boolean).join(' ')),
  ].join('\n');
}

function scoreSymbol(symbol: FlatSymbol, query: string): number {
  const q = query.toLowerCase();
  const id = symbol.id.toLowerCase();
  const name = symbol.name.toLowerCase();
  const qualified = symbol.qualifiedName.toLowerCase();
  const text = searchableText(symbol).toLowerCase();
  let score = 0;
  if (id === q || qualified === q) score += 1000;
  if (name === q) score += 700;
  if (id.endsWith('.' + q) || qualified.endsWith('.' + q)) score += 400;
  if (id.includes(q) || qualified.includes(q)) score += 200;
  if (text.includes(q)) score += 100;
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (text.includes(token)) score += 20;
  }
  return score;
}

function findSymbols(api: ApiDoc, query: string): FlatSymbol[] {
  const symbols = flatten(api);
  return symbols
    .map((symbol) => ({ symbol, score: scoreSymbol(symbol, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || compareAscii(a.symbol.id, b.symbol.id))
    .map((item) => item.symbol);
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveSymbol(api: ApiDoc, query: string): FlatSymbol | FlatSymbol[] | null {
  const symbols = flatten(api);
  const q = query.toLowerCase();
  const exact = symbols.filter((symbol) =>
    symbol.id.toLowerCase() === q ||
    symbol.qualifiedName.toLowerCase() === q ||
    symbol.name.toLowerCase() === q ||
    `${symbol.export.name}.${symbol.name}`.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return query.includes('.') ? exact[0]! : exact;
  const matches = findSymbols(api, query).slice(0, 8);
  if (matches.length === 1) return matches[0]!;
  return matches.length > 1 ? matches : null;
}

function renderFlatSymbol(symbol: FlatSymbol): string {
  if (symbol.member) return renderMember(symbol.member);
  return renderExport(symbol.export);
}

function renderCandidates(title: string, candidates: FlatSymbol[]): string {
  return [
    title,
    '',
    ...candidates.map((symbol) => `${symbol.id} (${symbol.kind}) - ${symbol.signature}`),
  ].join('\n') + '\n';
}

async function writeSqliteIndex(api: ApiDoc, dbPath: string): Promise<string> {
  if (!sqlite.sqliteAvailable) throw new Error('fino doc: sqlite unavailable');
  await ensureDir(dirname(dbPath));
  const db = await sqlite.Database.open(dbPath) as DocsDatabase;
  try {
    await ensureDocsCacheSchema(db);
    await resetDocsIndex(db);
    await populateDocsIndex(db, api);
    return `Wrote ${dbPath}`;
  } finally {
    await db.close();
  }
}

async function resetDocsIndex(db: DocsDatabase): Promise<void> {
  for (const table of ['docs_fts', 'doc_blocks', 'aliases', 'symbols', 'guides', 'modules']) {
    await db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

async function populateDocsIndex(db: DocsDatabase, api: ApiDoc): Promise<void> {
  for (const statement of DOCS_INDEX_SCHEMA_STATEMENTS) await db.exec(statement);
  for (const guide of api.guides ?? []) {
    await runDocsStatement(db, 'INSERT INTO guides VALUES (?, ?, ?, ?, ?, ?)',
      guide.id,
      guide.title,
      guide.path,
      guide.href,
      guide.summary,
      guide.text,
    );
    await runDocsStatement(db, 'INSERT INTO docs_fts (id, name, kind, signature, doc) VALUES (?, ?, ?, ?, ?)',
      guide.id,
      guide.title,
      'guide',
      guide.href,
      [guide.title, guide.summary, guide.path, guide.text].join('\n'),
    );
  }
  for (const moduleDoc of api.modules) {
    await runDocsStatement(db, 'INSERT INTO modules VALUES (?, ?, ?, ?)',
      moduleDoc.id ?? `module:${moduleDoc.name}`,
      moduleDoc.name,
      moduleDoc.path,
      moduleDoc.sourceModule ?? moduleDoc.name,
    );
    for (const symbol of flatten({ modules: [moduleDoc] })) {
      const parentId = symbol.member ? (symbol.export.id ?? `${moduleDoc.name}.${symbol.export.name}`) : null;
      const docText = searchableText(symbol);
      await runDocsStatement(db, 'INSERT INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        symbol.id,
        moduleDoc.id ?? `module:${moduleDoc.name}`,
        parentId,
        symbol.name,
        symbol.kind,
        symbol.signatures.join('\n'),
        docText,
        BigInt(symbol.location.line),
        BigInt(symbol.location.column),
      );
      await runDocsStatement(db, 'INSERT INTO docs_fts (id, name, kind, signature, doc) VALUES (?, ?, ?, ?, ?)',
        symbol.id,
        symbol.name,
        symbol.kind,
        symbol.signatures.join('\n'),
        docText,
      );
      const aliases = symbol.member ? (symbol.member.aliases ?? []) : (symbol.export.aliases ?? []);
      for (const alias of aliases) await runDocsStatement(db, 'INSERT INTO aliases VALUES (?, ?)', symbol.id, alias);
      let ordinal = 0;
      for (const block of symbol.doc.blocks ?? []) {
        await runDocsStatement(db, 'INSERT INTO doc_blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          symbol.id,
          BigInt(ordinal++),
          block.kind,
          block.text ?? '',
          block.lang ?? '',
          block.meta ?? '',
          block.code ?? '',
          block.name ?? '',
          block.description ?? '',
        );
      }
    }
  }
}

async function runDocsStatement(db: DocsDatabase, sql: string, ...params: unknown[]): Promise<void> {
  const stmt = db.prepare(sql);
  try {
    await stmt.run(...params);
  } finally {
    stmt.finalize();
  }
}

async function runBuildCommand(input: Record<string, unknown>, ctx: TaskContext): Promise<string | Record<string, unknown>> {
  const outDir = docsDir();
  const format = String(input.format ?? 'markdown');
  const title = ctx.optionProvided?.('title') ? String(input.title ?? '') : await inferDocsTitle();
  const includePrivate = input['include-private'] === true;
  const written: string[] = [];
  const inputs = await expandDocInputs(input.files);

  if (inputs.sourceFiles.length === 0 && inputs.guideFiles.length === 0) throw new Error('fino doc: no source files specified');
  await ensureDir(outDir);

  const api = await extractDocsCached(inputs, includePrivate);
  validateOutputPaths(api, format);
  const expectedOutputs = expectedDocOutputs(api, format);
  for (const moduleDoc of api.modules) {
    if (format === 'markdown' || format === 'both') {
      const markdownPath = `${outDir}/${moduleHref(moduleDoc).replace(/\.html$/i, '.md')}`;
      await ensureDir(dirname(markdownPath));
      await fs.writeFile(markdownPath, renderModule(moduleDoc));
      written.push(`Wrote ${markdownPath}`);
    }
    if (format === 'html' || format === 'both') {
      const htmlPath = `${outDir}/${moduleHref(moduleDoc)}`;
      await ensureDir(dirname(htmlPath));
      await fs.writeFile(htmlPath, renderModuleHtml(api, moduleDoc, title));
      written.push(`Wrote ${htmlPath}`);
    }
  }
  for (const guide of api.guides ?? []) {
    if (format === 'markdown' || format === 'both') {
      const markdownPath = `${outDir}/${guide.href.replace(/\.html$/i, '.md')}`;
      await ensureDir(dirname(markdownPath));
      await fs.writeFile(markdownPath, guide.text);
      written.push(`Wrote ${markdownPath}`);
    }
    if (format === 'html' || format === 'both') {
      const htmlPath = `${outDir}/${guide.href}`;
      await ensureDir(dirname(htmlPath));
      await fs.writeFile(htmlPath, renderGuideHtml(api, guide, title));
      written.push(`Wrote ${htmlPath}`);
    }
  }
  if (format === 'html' || format === 'both') {
    const indexPath = `${outDir}/index.html`;
    await fs.writeFile(indexPath, await renderIndexHtml(api, title));
    written.push(`Wrote ${indexPath}`);
  }

  const jsonPath = apiJsonPath();
  await ensureDir(dirname(jsonPath));
  await fs.writeFile(jsonPath, JSON.stringify(api, null, 2) + '\n');
  written.push(`Wrote ${jsonPath}`);
  written.push(await writeSqliteIndex(api, docsDbPath()));
  await pruneGeneratedOutputs(expectedOutputs);
  await writeOutputManifest(expectedOutputs);

  const message = written.join('\n');
  if (ctx.writer.mode === 'json') {
    const result = {
      command: 'doc build',
      ok: true,
      format,
      title,
      includePrivate,
      sourceFiles: inputs.sourceFiles,
      guideFiles: inputs.guideFiles,
      written,
      message,
    };
    await ctx.writer.writeJson(result);
    return result;
  }
  return message;
}

async function inferDocsTitle(): Promise<string> {
  const root = cwd().replace(/\/+$/, '');
  const packageTitle = await inferPackageJsonTitle(`${root}/package.json`);
  if (packageTitle !== undefined) return packageTitle;
  const cargoTitle = await inferCargoPackageTitle(`${root}/Cargo.toml`);
  if (cargoTitle !== undefined) return cargoTitle;
  return 'API';
}

async function inferPackageJsonTitle(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(await fs.readFile(path));
  } catch (_) {
    return undefined;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ['title', 'displayName', 'name']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

async function inferCargoPackageTitle(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  let inPackage = false;
  for (const line of (await fs.readFile(path)).split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inPackage = section[1] === 'package';
      continue;
    }
    if (!inPackage) continue;
    const name = /^\s*name\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (name && name[1]!.trim().length > 0) return name[1]!.trim();
  }
  return undefined;
}

function validateOutputPaths(api: ApiDoc, format: string): void {
  const claims = new Map<string, string>();
  const claim = (path: string, owner: string) => {
    const existing = claims.get(path);
    if (existing) throw new Error(`fino doc: output path collision for ${path} (${existing} and ${owner})`);
    claims.set(path, owner);
  };
  for (const moduleDoc of api.modules) {
    if (format === 'markdown' || format === 'both') claim(moduleHref(moduleDoc).replace(/\.html$/i, '.md'), `module ${moduleDoc.name}`);
    if (format === 'html' || format === 'both') claim(moduleHref(moduleDoc), `module ${moduleDoc.name}`);
  }
  for (const guide of api.guides ?? []) {
    if (format === 'markdown' || format === 'both') claim(guide.href.replace(/\.html$/i, '.md'), `guide ${guide.path}`);
    if (format === 'html' || format === 'both') claim(guide.href, `guide ${guide.path}`);
  }
}

function expectedDocOutputs(api: ApiDoc, format: string): Set<string> {
  const outputs = new Set<string>([API_JSON_NAME, DOCS_DB_NAME]);
  for (const moduleDoc of api.modules) {
    if (format === 'markdown' || format === 'both') outputs.add(moduleHref(moduleDoc).replace(/\.html$/i, '.md'));
    if (format === 'html' || format === 'both') outputs.add(moduleHref(moduleDoc));
  }
  for (const guide of api.guides ?? []) {
    if (format === 'markdown' || format === 'both') outputs.add(guide.href.replace(/\.html$/i, '.md'));
    if (format === 'html' || format === 'both') outputs.add(guide.href);
  }
  if (format === 'html' || format === 'both') outputs.add('index.html');
  return outputs;
}

async function pruneGeneratedOutputs(expected: Set<string>): Promise<void> {
  const root = docsDir();
  if (!(await exists(root))) return;
  await pruneGeneratedOutputsIn(root, expected);
}

async function pruneGeneratedOutputsIn(dirPath: string, expected: Set<string>): Promise<void> {
  const dir = await fs.dir(dirPath);
  for (const child of await dir.entries()) {
    const path = child.path.toString();
    const rel = normalizeDocPath(path).replace(new RegExp(`^${escapeRegExp(normalizeDocPath(docsDir()))}/?`), '');
    if (child.isDirectory()) {
      await pruneGeneratedOutputsIn(path, expected);
      if (await isEmptyDirectory(path)) await fs.rmdir(path);
      continue;
    }
    if (expected.has(rel)) continue;
    if (isPrunableDocOutput(rel)) await fs.unlink(path);
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  const dir = await fs.dir(path);
  return (await dir.entries()).length === 0;
}

function isPrunableDocOutput(path: string): boolean {
  return /\.(html|md)$/i.test(path) || path === API_JSON_NAME;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

async function writeOutputManifest(outputs: Set<string>): Promise<void> {
  if (!sqlite.sqliteAvailable || !(await exists(docsDbPath()))) return;
  const db = await sqlite.Database.open(docsDbPath()) as DocsDatabase;
  try {
    await ensureDocsCacheSchema(db);
    await db.exec('DELETE FROM doc_outputs');
    for (const output of [...outputs].sort(compareAscii)) await runDocsStatement(db, 'INSERT INTO doc_outputs VALUES (?)', output);
  } finally {
    await db.close();
  }
}

async function runShowCommand(input: Record<string, unknown>, ctx: TaskContext): Promise<string | Record<string, unknown>> {
  const symbol = String(input.symbol ?? '');
  const existingApi = await readExistingApiJson();
  const existing = existingApi ? renderShowResult(existingApi, symbol) : undefined;
  if (existing !== undefined) {
    if (ctx.writer.mode === 'json') {
      const result = { command: 'doc show', ok: true, symbol, found: true, output: existing };
      await ctx.writer.writeJson(result);
      return result;
    }
    return existing;
  }
  const api = existingApi ? await refreshDocsForQuery(symbol) : await ensureApiJson();
  const output = renderShowResult(api, symbol);
  const message = output ?? renderShowMiss(api, symbol);
  if (ctx.writer.mode === 'json') {
    const result = { command: 'doc show', ok: true, symbol, found: output !== undefined, output: message };
    await ctx.writer.writeJson(result);
    return result;
  }
  return message;
}

async function readExistingApiJson(): Promise<ApiDoc | undefined> {
  const path = apiJsonPath();
  if (!(await exists(path))) return undefined;
  return readApi(path);
}

function renderShowResult(api: ApiDoc, symbol: string): string | undefined {
  const resolved = resolveSymbol(api, symbol);
  if (resolved === null) return undefined;
  if (Array.isArray(resolved)) return renderCandidates('Multiple matches:', resolved);
  const loc = `${basename(resolved.module.path)}:${resolved.location.line}:${resolved.location.column}`;
  return renderFlatSymbol(resolved) + `\n\n_Source: ${loc}_\n`;
}

function renderShowMiss(api: ApiDoc, symbol: string): string {
  const suggestions = findSymbols(api, symbol).slice(0, 8);
  return suggestions.length === 0
    ? `No documentation found for ${symbol}\n`
    : renderCandidates(`No exact match for ${symbol}. Did you mean:`, suggestions);
}

async function runSearchCommand(input: Record<string, unknown>, ctx: TaskContext): Promise<string | Record<string, unknown>> {
  const parts = Array.isArray(input.query) ? input.query.map(String) : [String(input.query ?? '')];
  const query = parts.join(' ').trim();
  const existingDbPath = docsDbPath();
  if (await exists(existingDbPath)) {
    try {
      const existing = await searchSqlite(existingDbPath, query);
      if (!isNoResults(existing, query)) {
        if (ctx.writer.mode === 'json') {
          const result = { command: 'doc search', ok: true, query, found: true, output: existing };
          await ctx.writer.writeJson(result);
          return result;
        }
        return existing;
      }
    } catch (_) {
      // Fall through to transparent refresh for legacy or corrupt indexes.
    }
  }
  const dbPath = await exists(existingDbPath) ? await refreshDocsDbForQuery(query) : await ensureDocsDb();
  const output = await searchSqlite(dbPath, query);
  if (ctx.writer.mode === 'json') {
    const result = { command: 'doc search', ok: true, query, found: !isNoResults(output, query), output };
    await ctx.writer.writeJson(result);
    return result;
  }
  return output;
}

function isNoResults(output: string, query: string): boolean {
  return output === `No results for ${query}\n`;
}

async function refreshDocsDbForQuery(query: string): Promise<string> {
  const api = await refreshDocsForQuery(query);
  await writeSqliteIndex(api, docsDbPath());
  return docsDbPath();
}

async function refreshDocsForQuery(query: string): Promise<ApiDoc> {
  const inputs = await discoverProjectDocInputs();
  if (inputs.sourceFiles.length === 0 && inputs.guideFiles.length === 0) throw new Error('fino doc search: no source files found to document');
  const terms = docQueryTerms(query);
  const api = await extractDocsCached(inputs, false, {
    shouldParseChanged: (file) => docFileContainsAnyTerm(file.file, terms),
  });
  await ensureDir(docsDir());
  await fs.writeFile(apiJsonPath(), JSON.stringify(api, null, 2) + '\n');
  return api;
}

function docQueryTerms(query: string): string[] {
  const out = new Set<string>();
  const add = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized) out.add(normalized);
  };
  add(query);
  for (const token of query.split(/\s+/)) {
    add(token);
    const parts = token.split('.').filter(Boolean);
    for (let index = 0; index < parts.length; index++) add(parts.slice(index).join('.'));
    if (parts.length > 0) add(parts[parts.length - 1]!);
  }
  return [...out].sort((a, b) => b.length - a.length || compareAscii(a, b));
}

async function docFileContainsAnyTerm(path: string, terms: string[]): Promise<boolean> {
  if (terms.length === 0) return false;
  const text = String(await fs.readFile(path)).toLowerCase();
  return terms.some((term) => text.includes(term));
}

async function searchSqlite(dbPath: string, query: string): Promise<string> {
  if (!sqlite.sqliteAvailable) throw new Error('fino doc search: sqlite unavailable');

  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return `No results for ${query}\n`;

  const db = await sqlite.Database.open(dbPath, { readonly: true }) as DocsDatabase;

  try {
    const stmt = db.prepare('SELECT id, name, kind, signature FROM docs_fts WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT 20');
    const rows = await stmt.all(ftsQuery).finally(() => stmt.finalize());
    if (rows.length === 0) return `No results for ${query}\n`;
    return rows.map((row) => `${String(row.id)} (${String(row.kind)})\n  ${String(row.signature)}`).join('\n') + '\n';
  } finally {
    await db.close();
  }
}

function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9_:.*-]/g, ''))
    .filter(Boolean)
    .join(' ');
}

function docTestExamples(api: ApiDoc): Array<{ module: ModuleDoc; symbol: FlatSymbol; block: DocBlockItem; index: number }> {
  const examples: Array<{ module: ModuleDoc; symbol: FlatSymbol; block: DocBlockItem; index: number }> = [];
  for (const symbol of flatten(api)) {
    let index = 0;
    for (const block of symbol.doc.blocks ?? []) {
      if (block.kind !== 'code') continue;
      const lang = (block.lang ?? '').toLowerCase();
      if (lang && !['ts', 'mts', 'js', 'mjs'].includes(lang)) continue;
      index += 1;
      examples.push({ module: symbol.module, symbol, block, index });
    }
  }
  return examples;
}

function docTestSpecifier(example: { module: ModuleDoc; symbol: FlatSymbol; index: number }): string {
  const rawPath = example.module.path;
  const modulePath = rawPath.startsWith('/') || rawPath.startsWith('file://') || rawPath.startsWith('./') || rawPath.startsWith('../')
    ? normalizePath(rawPath)
    : joinPath(cwd(), rawPath);
  const safeId = example.symbol.id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const suffix = `.doc-test-${safeId}-${example.index}`;
  const slash = modulePath.lastIndexOf('/');
  const dot = modulePath.lastIndexOf('.');
  const insertAt = dot > slash ? dot : modulePath.length;
  const ext = dot > slash ? modulePath.slice(dot) : '.ts';
  return modulePath.slice(0, insertAt) + suffix + ext;
}

async function runDocTestCommand(input: Record<string, unknown>, ctx: TaskContext): Promise<string | Record<string, unknown>> {
  const files = await expandInputs(input.files);
  if (files.length === 0) throw new Error('fino doc test: no source files specified');

  const api = await extractApi(files, false);
  const examples = docTestExamples(api);
  const tempDir = `/tmp/fino-doc-test-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  await ensureDir(tempDir);
  const testPath = `${tempDir}/doc-examples.test.ts`;
  const lines = [
    `import { describe, it } from 'fino:test/test';`,
    `import { Realm } from 'fino:realm';`,
    ``,
    `describe('fino doc examples', () => {`,
  ];
  let runnable = 0;
  let ignored = 0;

  for (const example of examples) {
    const meta = (example.block.meta ?? '').split(/\s+/).filter(Boolean);
    const skip = meta.includes('ignore') || meta.includes('no_run');
    const throws = meta.includes('throws') || meta.includes('should_panic') || meta.includes('should-panic');
    const name = `${example.symbol.id} code block ${example.index}`;
    const code = example.block.hiddenCode || example.block.code || '';
    if (skip) ignored += 1;
    else runnable += 1;
    lines.push(`  it(${JSON.stringify(name)}, ${skip ? `{ skip: 'ignored' }, ` : ''}async (t) => {`);
    if (skip) {
      lines.push(`    // ignored doc example`);
    } else if (throws) {
      lines.push(`    const realm = Realm.fromSource(${JSON.stringify(code)}, { specifier: ${JSON.stringify(docTestSpecifier(example))} });`);
      lines.push(`    await t.rejects(() => realm.run(), null, 'expected example to throw');`);
    } else {
      lines.push(`    const realm = Realm.fromSource(${JSON.stringify(code)}, { specifier: ${JSON.stringify(docTestSpecifier(example))} });`);
      lines.push(`    await realm.run();`);
    }
    lines.push(`  });`);
  }
  lines.push(`});`, ``);
  await fs.writeFile(testPath, lines.join('\n'));

  await import(normalizeModuleSpecifier(testPath));
  const { run } = await import('fino:test/test');
  await run({});
  const message = `${runnable} passed\n${ignored} ignored`;
  if (ctx.writer.mode === 'json') {
    const result = { command: 'doc test', ok: true, files, runnable, ignored, message };
    await ctx.writer.writeJson(result);
    return result;
  }
  return message;
}

function buildOptions() {
  return [
    { flags: '--format', type: 'string' as const, description: 'Output format: markdown, html, or both', default: 'markdown' },
    { flags: '--title', type: 'string' as const, description: 'Title used for generated HTML pages' },
    { flags: '--include-private', type: 'boolean' as const, description: 'Include private and internal members' },
  ];
}

function filesPositional() {
  return [
    { name: 'files', type: 'string' as const, multiple: true, required: true, description: 'Source files, directories, or globs to document' },
  ];
}

/**
 * Create the `doc` subcommand tree used by the root Fino CLI.
 *
 * The returned command supports `build`, `show`, `search`, and `test`.
 * Invoking `fino doc` directly runs the build path. Build accepts source files,
 * directories, or globs and writes Markdown or HTML documentation depending on
 * `--format`. `--include-private` includes internal and private declarations.
 * `show` and `search` read generated docs, while `test` extracts fenced examples
 * from comments and executes runnable examples. Parser, filesystem, rendering,
 * and doc-test failures propagate as command errors.
 *
 * ```js
 * import { createDocCommand } from 'internal:commands/doc';
 * const doc = createDocCommand();
 * await doc.parse(['build', '--format', 'markdown', 'js/internal/stream.ts']);
 * ```
 *
 * @returns A configured `Task` instance for `fino doc`.
 * @internal
 */
export function createDocCommand(): Task {
  return new Task({
    name: 'doc',
    description: 'Generate, search, and test API docs from commented source files',
    outputMode: 'both',
    run: runBuildCommand,
    cli: {
      options: buildOptions(),
      positionals: filesPositional(),
    },
    children: [
      new Task({
        name: 'build',
        description: 'Generate API docs',
        outputMode: 'both',
        run: runBuildCommand,
        cli: {
          options: buildOptions(),
          positionals: filesPositional(),
        },
      }),
      new Task({
        name: 'show',
        description: 'Print one documented symbol as Markdown',
        outputMode: 'both',
        run: runShowCommand,
        cli: {
          positionals: [
            { name: 'symbol', type: 'string', required: true, description: 'Symbol id or name to show' },
          ],
        },
      }),
      new Task({
        name: 'search',
        description: 'Search generated docs',
        outputMode: 'both',
        run: runSearchCommand,
        cli: {
          positionals: [
            { name: 'query', type: 'string', multiple: true, required: true, description: 'Search query' },
          ],
        },
      }),
      new Task({
        name: 'test',
        description: 'Run examples from documentation comments',
        outputMode: 'both',
        run: runDocTestCommand,
        cli: {
          positionals: filesPositional(),
        },
      }),
    ],
  });
}
