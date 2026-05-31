/**
 * internal/commands/doc — internal runtime module.
 *
 * 
 * @internal
 */

import { DiskFileSystem } from '../../file/fs.mts';
import { Command, type CommandContext } from '../../util/argv.mts';
import { cwd } from '../../runtime/process.mts';
import { renderMarkdown, renderMarkdownInline, type MarkdownOptions } from '../../markdown.mts';
import { escapeHtml, render as renderTemplate } from '../../template.mts';
import { parse as parseTypeScript, type ParseComment, type ParseResult } from '../../format/typescript/index.mts';

const fs = new DiskFileSystem();
const DOCS_DIR_NAME = 'docs';
const API_JSON_NAME = 'api.json';
const DOCS_DB_NAME = 'docs.db';

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
  doc: DocBlock;
  location: Location;
}

interface DocExport extends DocMember {
  members: DocMember[];
}

interface ModuleDoc {
  id?: string;
  path: string;
  name: string;
  sourceModule?: string;
  doc: DocBlock;
  exports: DocExport[];
}

interface ApiDoc {
  schemaVersion?: number;
  modules: ModuleDoc[];
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
  groups: HtmlGroup<HtmlExport>[];
  hasGroups: boolean;
}

interface DocsDatabase {
  exec(sql: string): Promise<void>;
  prepare(sql: string): {
    run(...params: unknown[]): Promise<unknown>;
    all(...params: unknown[]): Promise<Array<Record<string, unknown>>>;
  };
  close(): Promise<void>;
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
  CREATE TABLE symbols (id TEXT PRIMARY KEY, module_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, doc TEXT NOT NULL, location_line INTEGER, location_column INTEGER);
  CREATE TABLE aliases (symbol_id TEXT NOT NULL, alias TEXT NOT NULL);
  CREATE TABLE doc_blocks (symbol_id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, lang TEXT, meta TEXT, code TEXT, name TEXT, description TEXT);
  CREATE VIRTUAL TABLE docs_fts USING fts5(id UNINDEXED, name, kind, signature, doc);
`;

const DOCS_INDEX_SCHEMA_STATEMENTS = DOCS_INDEX_SCHEMA
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

const DOCS_CSS = `:root{color-scheme:light;--border:#d0d7de;--muted:#57606a;--text:#1f2328;--link:#0969da;--bg:#ffffff;--sidebar:#f6f8fa}*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;line-height:1.5;color:var(--text);background:var(--bg);overflow:hidden}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}.docs-layout{display:grid;grid-template-columns:280px minmax(0,1fr);height:100vh}.docs-sidebar{background:var(--sidebar);border-right:1px solid var(--border);padding:24px 18px;overflow:auto}.docs-sidebar-title{font-weight:700;margin:0 0 12px}.docs-sidebar ul{list-style:none;margin:0;padding-left:14px}.docs-sidebar>ul{padding-left:0}.docs-sidebar li{margin:4px 0}.docs-sidebar-directory{font-size:.85rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:12px}.docs-sidebar a{display:inline-block;padding:2px 0}.docs-sidebar a[aria-current="page"]{font-weight:700;color:var(--text)}main{display:block;max-width:980px;width:100%;height:100vh;overflow:auto;padding:40px 48px 72px}pre{background:#f6f8fa;border:1px solid var(--border);border-radius:6px;padding:12px;overflow:auto}code{font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap}.tok-keyword{color:#cf222e}.tok-string{color:#0a3069}.tok-number{color:#0550ae}.tok-comment{color:#6e7781}.tok-regexp{color:#8250df}.tok-type{color:#953800}.tag{color:var(--muted)}.muted{color:var(--muted)}.member{border-left:3px solid var(--border);padding-left:12px}@media(max-width:760px){body{overflow:auto}.docs-layout{display:block;height:auto}.docs-sidebar{border-right:0;border-bottom:1px solid var(--border);max-height:45vh}.docs-sidebar,main{height:auto}main{padding:28px 20px 48px;overflow:visible}}`;

const HTML_PAGE_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>{{title}}</title>
<style>{{{css}}}</style>
</head>
<body>
<div class="docs-layout">
{{{sidebarHtml}}}
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
<section id="{{id}}">
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
    ? ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'].map((pattern) => joinPath(absolute, pattern))
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

function signaturesOf(item: { signature: string; signatures?: string[] }): string[] {
  if (Array.isArray(item.signatures) && item.signatures.length > 0) return item.signatures;
  return item.signature ? [item.signature] : [];
}

async function extractModuleFromSource(path: string, includePrivate: boolean): Promise<ModuleDoc | undefined> {
  const source = String(await fs.readFile(path));
  const parsed = parseTypeScript(source, { filename: path, tokens: true });
  if (!parsed.ok) {
    throw new Error(`failed to parse ${path}:\n${parsed.errors.map((error) => error.message).join('\n')}`);
  }
  const comments = parsed.comments;
  const body = Array.isArray(parsed.ast?.body) ? parsed.ast.body as AstNode[] : [];
  const locals = collectLocalBindings(body, comments, source, includePrivate);
  const exports: DocExport[] = [];

  for (const statement of body) {
    if (statement.type === 'ExportNamedDeclaration') {
      collectNamedExport(exports, statement, comments, locals, source, includePrivate);
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const item = collectDeclarationExport(statement.declaration, statement, comments, source, includePrivate, 'default');
      if (item) exports.push(item);
    }
  }

  const moduleName = basename(path).replace(/\.(m?ts|m?js)$/i, '') || 'module';
  const moduleDocBlock = firstJsdocBefore(comments, body[0]?.start ?? Number.MAX_SAFE_INTEGER, source) ?? emptyDoc();
  if (!includePrivate && hasDocTag(moduleDocBlock, 'internal')) return undefined;
  const moduleDoc: ModuleDoc = {
    id: `module:${moduleName}`,
    path: projectRelativePath(path),
    name: moduleName,
    sourceModule: moduleName,
    doc: moduleDocBlock,
    exports,
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
    out.push(...collectVariableExports(statement, statement, comments, source, false));
  }
  return out;
}

function collectNamedExport(exports: DocExport[], statement: AstNode, comments: ParseComment[], locals: Map<string, DocExport>, source: string, includePrivate: boolean): void {
  if (statement.declaration) {
    if (statement.declaration.type === 'VariableDeclaration') {
      exports.push(...collectVariableExports(statement.declaration, statement, comments, source, true, locals));
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
    return exportDoc(name, 'interface', interfaceSignature(owner, declaration, source), doc, locationFor(source, owner.start ?? declaration.start), interfaceMembers(declaration, comments, source));
  }
  if (declaration.type === 'TSTypeAliasDeclaration') {
    return exportDoc(name, 'type', statementSignature(owner, declaration, source), doc, locationFor(source, owner.start ?? declaration.start));
  }
  if (declaration.type === 'TSEnumDeclaration') {
    return exportDoc(name, 'enum', enumSignature(owner, declaration, source), doc, locationFor(source, owner.start ?? declaration.start));
  }
  return undefined;
}

function collectVariableExports(declaration: AstNode, owner: AstNode, comments: ParseComment[], source: string, exported: boolean, locals: Map<string, DocExport> = new Map()): DocExport[] {
  const out: DocExport[] = [];
  const kind = declaration.kind ?? 'const';
  for (const declarator of declaration.declarations ?? []) {
    const name = bindingName(declarator.id);
    if (!name) continue;
    const doc = docForNode(comments, owner, declarator, source);
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
    doc: cloneDoc(item.doc),
    members: item.members.map((member) => ({ ...member, signatures: [...(member.signatures ?? [])], aliases: [...(member.aliases ?? [])], doc: cloneDoc(member.doc) })),
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

function interfaceMembers(declaration: AstNode, comments: ParseComment[], source: string): DocMember[] {
  const members: DocMember[] = [];
  for (const item of declaration.body?.body ?? []) {
    const name = propertyName(item.key);
    if (!name) continue;
    members.push({
      id: '',
      name,
      kind: item.type === 'TSMethodSignature' ? 'method' : item.readonly ? 'readonly-property' : 'property',
      signature: interfaceMemberSignature(item, source),
      signatures: [],
      aliases: [],
      doc: docForNode(comments, item, item, source),
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
  const lines = comment.text.split(/\r?\n/).map((rawLine) => {
    let line = rawLine.replace(/^\s+/, '');
    if (line.startsWith('*')) line = line.slice(1).startsWith(' ') ? line.slice(2) : line.slice(1);
    return line;
  });
  const textLines: string[] = [];
  const tags: DocTag[] = [];
  const freeLines: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith('@')) {
      const match = /^@(\S+)\s*(.*)$/.exec(line);
      if (match) tags.push({ name: match[1]!, value: match[2] ?? '' });
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

function stripInlineDirective(line: string): string {
  return line.replace(/\s@(param|returns?|throws|example|see|deprecated)\b.*$/u, '').trimEnd();
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
      const [lang = '', ...metaParts] = fence.trim().split(/\s+/).filter(Boolean);
      index++;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index]!.trimStart().startsWith('```')) {
        codeLines.push(lines[index]!);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push(codeBlock(lang, metaParts.join(' '), codeLines));
      continue;
    }
    if (line.trim() === '') pushParagraph();
    else paragraph.push(line);
    index++;
  }
  pushParagraph();
  return blocks;
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
  for (const item of moduleDoc.exports) {
    item.id = `${moduleDoc.name}.${item.name}`;
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
  return value.trim()
    .replace(/^export\s+default\s+/, '')
    .replace(/^export\s+/, '')
    .replace(/;+\s*$/, '')
    .replace(/\n/g, ' ')
    .split(/\s+/)
    .join(' ');
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
  const docLines = renderDocBlock(item.doc);
  if (docLines.length > 0) lines.push('', ...docLines);
  for (const member of item.members) lines.push('', renderMember(member));
  return lines.join('\n');
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
    sidebarHtml: renderSidebarHtml(api, htmlModule.href),
    contentHtml,
  });
}

async function renderIndexHtml(api: ApiDoc, title: string): Promise<string> {
  const contentHtml = renderTemplate(INDEX_PAGE_TEMPLATE, {
    readmeHtml: await renderReadmeHtml(),
  });
  return renderTemplate(HTML_PAGE_TEMPLATE, {
    title,
    css: DOCS_CSS,
    sidebarHtml: renderSidebarHtml(api, 'index.html'),
    contentHtml,
  });
}

function toHtmlModule(api: ApiDoc, moduleDoc: ModuleDoc): HtmlModule {
  const href = moduleHref(moduleDoc);
  const ctx = { api, module: moduleDoc, currentHref: href };
  const exports = moduleDoc.exports.map((item) => toHtmlExport(item, ctx));
  const summary = firstSummary(moduleDoc.doc);
  const groups = groupHtmlItems(exports);
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
    groups,
    hasGroups: groups.length > 0,
  };
}

async function renderReadmeHtml(): Promise<string> {
  const readmePath = `${cwd().replace(/\/+$/, '')}/README.md`;
  if (!(await exists(readmePath))) return '<h1>API Documentation</h1>\n<p class="muted">No README.md found.</p>';
  return renderMarkdown(await fs.readFile(readmePath), {
    headingOffset: 0,
    resolveLink: (href) => rewriteSourceRelativeHref('README.md', 'index.html', href),
  });
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
  const path = normalizeDocPath(moduleDoc.path).replace(/\.(m?ts|m?js)$/i, '');
  return `${path || moduleDoc.name}.html`;
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

function normalizeRelativePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function buildLinkResolver(api: ApiDoc, moduleDoc: ModuleDoc): (href: string, label: string) => string | undefined {
  return (href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
    const [pathPart, fragment = ''] = href.split('#', 2);
    if (!pathPart && fragment) {
      const symbol = findSymbolInModule(api, moduleDoc, fragment);
      return symbol ? symbolHref(symbol, moduleHref(moduleDoc)) : href;
    }
    const targetModule = resolveSourceModule(api, moduleDoc, pathPart);
    if (!targetModule) return rewriteSourceRelativeHref(moduleDoc.path, moduleHref(moduleDoc), href);
    if (!fragment) return relativeHref(moduleHref(moduleDoc), moduleHref(targetModule));
    const symbol = findSymbolInModule(api, targetModule, fragment);
    return symbol ? symbolHref(symbol, moduleHref(moduleDoc)) : `${relativeHref(moduleHref(moduleDoc), moduleHref(targetModule))}#${slug(fragment)}`;
  };
}

function rewriteSourceRelativeHref(sourcePath: string, outputHref: string, href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href;
  const suffixIndex = firstHrefSuffixIndex(href);
  const pathPart = suffixIndex >= 0 ? href.slice(0, suffixIndex) : href;
  const suffix = suffixIndex >= 0 ? href.slice(suffixIndex) : '';
  if (!pathPart || pathPart.startsWith('#')) return href;
  const sourceDir = dirname(normalizeDocPath(sourcePath));
  const targetPath = normalizeRelativePath(sourceDir === '.' ? pathPart : `${sourceDir}/${pathPart}`);
  return relativeHref(`${DOCS_DIR_NAME}/${outputHref}`, targetPath) + suffix;
}

function firstHrefSuffixIndex(href: string): number {
  const query = href.indexOf('?');
  const fragment = href.indexOf('#');
  if (query < 0) return fragment;
  if (fragment < 0) return query;
  return Math.min(query, fragment);
}

function toHtmlExport(item: DocExport, ctx: HtmlRenderContext): HtmlExport {
  const members = item.members.map((member) => toHtmlMember(member, ctx));
  const memberGroups = groupHtmlItems(members);
  const signatures = signaturesOf(item);
  return {
    id: slug(item.id ?? item.name),
    name: item.name,
    kind: item.kind,
    titleHtml: renderSignatureTitleHtml(item.name, signatures, ctx),
    overloadsHtml: renderOverloadsHtml(signatures, ctx),
    docHtml: renderDocHtml(item.doc, ctx, 3),
    memberGroups,
    hasMemberGroups: memberGroups.length > 0,
  };
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

function renderSidebarHtml(api: ApiDoc, currentHref: string): string {
  const modules = api.modules
    .map((moduleDoc) => ({ name: moduleDoc.name, href: moduleHref(moduleDoc) }))
    .sort((a, b) => compareAscii(a.href, b.href));
  const tree = sidebarTree(modules);
  return `<nav class="docs-sidebar" aria-label="Documentation navigation">
<p class="docs-sidebar-title"><a href="${escapeHtml(relativeHref(currentHref, 'index.html'))}">API Documentation</a></p>
${renderSidebarItems(tree, currentHref)}
</nav>`;
}

interface SidebarNode {
  name: string;
  path: string;
  module?: SidebarModule;
  children: Map<string, SidebarNode>;
}

interface SidebarModule {
  name: string;
  href: string;
}

function sidebarTree(modules: SidebarModule[]): SidebarNode[] {
  const root = new Map<string, SidebarNode>();
  const ensureNode = (siblings: Map<string, SidebarNode>, name: string, path: string): SidebarNode => {
    let node = siblings.get(name);
    if (!node) {
      node = { name, path, children: new Map() };
      siblings.set(name, node);
    }
    return node;
  };
  for (const moduleDoc of modules) {
    const parts = moduleDoc.href.replace(/\.html$/i, '').split('/').filter(Boolean);
    let siblings = root;
    let currentPath = '';
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const node = ensureNode(siblings, part, currentPath);
      if (index === parts.length - 1) node.module = moduleDoc;
      siblings = node.children;
    }
  }
  return sortSidebarNodes([...root.values()]);
}

function sortSidebarNodes(nodes: SidebarNode[]): SidebarNode[] {
  return nodes.sort((a, b) => compareAscii(a.name, b.name)).map((node) => {
    node.children = new Map(sortSidebarNodes([...node.children.values()]).map((child) => [child.name, child]));
    return node;
  });
}

function renderSidebarItems(nodes: SidebarNode[], currentHref: string): string {
  if (nodes.length === 0) return '';
  return `<ul>${nodes.map((node) => renderSidebarNode(node, currentHref)).join('')}</ul>`;
}

function renderSidebarNode(node: SidebarNode, currentHref: string): string {
  const children = renderSidebarItems([...node.children.values()], currentHref);
  if (node.module) {
    const href = relativeHref(currentHref, node.module.href);
    const current = node.module.href === currentHref ? ' aria-current="page"' : '';
    return `<li><a href="${escapeHtml(href)}"${current}>${escapeHtml(node.name)}</a>${children}</li>`;
  }
  return `<li><div class="docs-sidebar-directory">${escapeHtml(node.name)}</div>${children}</li>`;
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
  const modules: ModuleDoc[] = [];
  for (const file of files) {
    const moduleDoc = await extractModuleFromSource(String(file), includePrivate);
    if (moduleDoc) modules.push(moduleDoc);
  }
  disambiguateModules(modules);
  return { schemaVersion: 2, modules };
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
  return rel.replace(/^\.\//, '');
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

async function discoverProjectSourceFiles(): Promise<string[]> {
  const files = await expandInput('.');
  return files.filter((file) => !file.includes(`/${DOCS_DIR_NAME}/`));
}

async function ensureApiJson(): Promise<ApiDoc> {
  const path = apiJsonPath();
  if (await exists(path)) return readApi(path);

  const files = await discoverProjectSourceFiles();
  if (files.length === 0) throw new Error('fino doc search: no source files found to document');
  const api = await extractApi(files);
  await ensureDir(docsDir());
  await fs.writeFile(path, JSON.stringify(api, null, 2) + '\n');
  return api;
}

async function ensureDocsDb(): Promise<string> {
  const dbPath = docsDbPath();
  if (await exists(dbPath)) return dbPath;
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
  const sqlite = await import('fino:sqlite');
  if (!sqlite.sqliteAvailable) throw new Error('fino doc: sqlite unavailable');
  await ensureDir(dirname(dbPath));
  if (await exists(dbPath)) await fs.unlink(dbPath);
  const db = await sqlite.Database.open(dbPath) as DocsDatabase;
  try {
    await populateDocsIndex(db, api);
    return `Wrote ${dbPath}`;
  } finally {
    await db.close();
  }
}

async function populateDocsIndex(db: DocsDatabase, api: ApiDoc): Promise<void> {
  for (const statement of DOCS_INDEX_SCHEMA_STATEMENTS) await db.exec(statement);
  for (const moduleDoc of api.modules) {
    await db.prepare('INSERT INTO modules VALUES (?, ?, ?, ?)').run(
      moduleDoc.id ?? `module:${moduleDoc.name}`,
      moduleDoc.name,
      moduleDoc.path,
      moduleDoc.sourceModule ?? moduleDoc.name,
    );
    for (const symbol of flatten({ modules: [moduleDoc] })) {
      const parentId = symbol.member ? (symbol.export.id ?? `${moduleDoc.name}.${symbol.export.name}`) : null;
      const docText = searchableText(symbol);
      await db.prepare('INSERT INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
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
      await db.prepare('INSERT INTO docs_fts (id, name, kind, signature, doc) VALUES (?, ?, ?, ?, ?)').run(
        symbol.id,
        symbol.name,
        symbol.kind,
        symbol.signatures.join('\n'),
        docText,
      );
      const aliases = symbol.member ? (symbol.member.aliases ?? []) : (symbol.export.aliases ?? []);
      for (const alias of aliases) await db.prepare('INSERT INTO aliases VALUES (?, ?)').run(symbol.id, alias);
      let ordinal = 0;
      for (const block of symbol.doc.blocks ?? []) {
        await db.prepare('INSERT INTO doc_blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
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

async function runBuildCommand(ctx: CommandContext): Promise<string> {
  const outDir = docsDir();
  const format = String(ctx.options.format ?? 'markdown');
  const title = String(ctx.options.title ?? 'API');
  const includePrivate = ctx.options['include-private'] === true;
  const written: string[] = [];
  const files = await expandInputs(ctx.args.files);

  if (files.length === 0) throw new Error('fino doc: no source files specified');
  await removeTree(outDir);
  await ensureDir(outDir);

  const api = await extractApi(files, includePrivate);
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

  return written.join('\n');
}

async function runShowCommand(ctx: CommandContext): Promise<string> {
  const symbol = String(ctx.args.symbol ?? '');
  const api = await ensureApiJson();
  const resolved = resolveSymbol(api, symbol);
  if (resolved === null) {
    const suggestions = findSymbols(api, symbol).slice(0, 8);
    return suggestions.length === 0
      ? `No documentation found for ${symbol}\n`
      : renderCandidates(`No exact match for ${symbol}. Did you mean:`, suggestions);
  }
  if (Array.isArray(resolved)) return renderCandidates('Multiple matches:', resolved);
  const loc = `${basename(resolved.module.path)}:${resolved.location.line}:${resolved.location.column}`;
  return renderFlatSymbol(resolved) + `\n\n_Source: ${loc}_\n`;
}

async function runSearchCommand(ctx: CommandContext): Promise<string> {
  const parts = Array.isArray(ctx.args.query) ? ctx.args.query.map(String) : [String(ctx.args.query ?? '')];
  const query = parts.join(' ').trim();
  const dbPath = await ensureDocsDb();
  return searchSqlite(dbPath, query);
}

async function searchSqlite(dbPath: string, query: string): Promise<string> {
  const sqlite = await import('fino:sqlite');
  if (!sqlite.sqliteAvailable) throw new Error('fino doc search: sqlite unavailable');

  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return `No results for ${query}\n`;

  const db = await sqlite.Database.open(dbPath, { readonly: true }) as DocsDatabase;

  try {
    const rows = await db
      .prepare('SELECT id, name, kind, signature FROM docs_fts WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT 20')
      .all(ftsQuery);
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

async function runDocTestCommand(ctx: CommandContext): Promise<string> {
  const files = await expandInputs(ctx.args.files);
  if (files.length === 0) throw new Error('fino doc test: no source files specified');

  const api = await extractApi(files, false);
  const examples = docTestExamples(api);
  const tempDir = `/tmp/fino-doc-test-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  await ensureDir(tempDir);
  const testPath = `${tempDir}/doc-examples.test.mts`;
  const lines = [`import { describe, it } from 'fino:test/test';`, ``, `describe('fino doc examples', () => {`];
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
    lines.push(`  it(${JSON.stringify(name)}, ${skip ? `{ skip: 'ignored' }, ` : ''}async () => {`);
    if (throws) {
      lines.push(`    let threw = false;`);
      lines.push(`    try {`);
      lines.push(indentCode(code, 6));
      lines.push(`    } catch (_) { threw = true; }`);
      lines.push(`    if (!threw) throw new Error('expected example to throw');`);
    } else {
      lines.push(indentCode(code, 4));
    }
    lines.push(`  });`);
  }
  lines.push(`});`, ``);
  await fs.writeFile(testPath, lines.join('\n'));

  await import(normalizeModuleSpecifier(testPath));
  const { run } = await import('fino:test/test');
  await run({});
  return `${runnable} passed\n${ignored} ignored`;
}

function indentCode(code: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return code.split('\n').map((line) => prefix + line).join('\n');
}

function buildOptions() {
  return [
    { flags: '--format', type: 'string' as const, description: 'Output format: markdown, html, or both', default: 'markdown' },
    { flags: '--title', type: 'string' as const, description: 'Title used for generated HTML pages', default: 'API' },
    { flags: '--include-private', type: 'boolean' as const, description: 'Include private and internal members' },
  ];
}

function filesPositional() {
  return [
    { name: 'files', type: 'string' as const, multiple: true, required: true, description: 'Source files, directories, or globs to document' },
  ];
}

export function createDocCommand(): Command {
  return new Command({
    name: 'doc',
    description: 'Generate, search, and test API docs from commented source files',
    run: runBuildCommand,
    options: buildOptions(),
    positionals: filesPositional(),
    commands: [
      new Command({
        name: 'build',
        description: 'Generate API docs',
        run: runBuildCommand,
        options: buildOptions(),
        positionals: filesPositional(),
      }),
      new Command({
        name: 'show',
        description: 'Print one documented symbol as Markdown',
        run: runShowCommand,
        positionals: [
          { name: 'symbol', type: 'string', required: true, description: 'Symbol id or name to show' },
        ],
      }),
      new Command({
        name: 'search',
        description: 'Search generated docs',
        run: runSearchCommand,
        positionals: [
          { name: 'query', type: 'string', multiple: true, required: true, description: 'Search query' },
        ],
      }),
      new Command({
        name: 'test',
        description: 'Run examples from documentation comments',
        run: runDocTestCommand,
        positionals: filesPositional(),
      }),
    ],
  });
}
