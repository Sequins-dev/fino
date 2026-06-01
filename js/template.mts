/**
 * fino:template — small Mustache-compatible template rendering.
 *
 * Supports escaped variables, triple-mustache/unescaped variables, truthy and
 * inverted sections, list iteration, and dotted-name lookup. Partials are
 * intentionally not implemented yet.
 */

import { Scanner } from 'fino:parsing/scanner';

type Token =
  | { type: 'text'; value: string }
  | { type: 'variable'; name: string; escaped: boolean }
  | { type: 'section'; name: string; inverted: boolean; children: Token[] };

/** Options accepted by one-shot template rendering. Reserved for future flags. */
export interface RenderOptions {}
/** Options accepted by template compilation. Reserved for future flags. */
export interface CompileOptions extends RenderOptions {}

interface ContextFrame {
  value: unknown;
  parent: ContextFrame | null;
}

/** Escape a value for safe insertion into HTML text or attributes. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Compile a template string into a reusable render function.
 *
 * ```ts
 * import { compile } from 'fino:template';
 *
 * const renderUser = compile('Hello, {{name}}');
 * renderUser({ name: '<Ada>' }); // 'Hello, &lt;Ada&gt;'
 * ```
 */
export function compile(template: string, _options: CompileOptions = {}): (data?: unknown) => string {
  const tokens = parseTemplate(template);
  return (data: unknown = {}) => renderTokens(tokens, { value: data, parent: null });
}

/**
 * Render a template once with the provided data.
 *
 * ```ts
 * import { render } from 'fino:template';
 *
 * render('{{#items}}{{.}} {{/items}}', { items: ['a', 'b'] });
 * ```
 */
export function render(template: string, data: unknown = {}, options: RenderOptions = {}): string {
  return compile(template, options)(data);
}

function parseTemplate(template: string): Token[] {
  const scanner = new Scanner(template, { encoding: 'utf-8', format: 'template' });
  const root: Token[] = [];
  const stack: Array<{ name: string; tokens: Token[]; section: Token & { type: 'section' } }> = [];
  let tokens = root;

  while (!scanner.done) {
    const textStart = scanner.mark();
    while (!scanner.done && scanner.peek(2) !== '{{') scanner.eat();
    const text = scanner.text(textStart);
    if (text !== '') tokens.push({ type: 'text', value: text });
    if (scanner.done) break;

    if (scanner.match('{{{')) {
      const name = validateTemplateName(readUntilSequence(scanner, '}}}', 'template: unclosed triple mustache'), 'variable');
      tokens.push({ type: 'variable', name, escaped: false });
      continue;
    }

    scanner.expect('{{');
    let tag = readUntilSequence(scanner, '}}', 'template: unclosed tag').trim();
    if (tag.length === 0) continue;

    const sigil = tag[0]!;
    if ('#^/!>&'.includes(sigil)) tag = tag.slice(1).trim();

    if (sigil === '!') continue;
    if (sigil === '>') throw new Error('template: partials are not supported yet');
    if (sigil === '#') {
      const name = validateTemplateName(tag, 'section');
      const section: Token & { type: 'section' } = { type: 'section', name: tag, inverted: false, children: [] };
      section.name = name;
      tokens.push(section);
      stack.push({ name, tokens, section });
      tokens = section.children;
      continue;
    }
    if (sigil === '^') {
      const name = validateTemplateName(tag, 'section');
      const section: Token & { type: 'section' } = { type: 'section', name, inverted: true, children: [] };
      tokens.push(section);
      stack.push({ name, tokens, section });
      tokens = section.children;
      continue;
    }
    if (sigil === '/') {
      const name = validateTemplateName(tag, 'section close');
      const frame = stack.pop();
      if (frame === undefined || frame.name !== name) throw new Error(`template: unmatched section close "${name}"`);
      tokens = frame.tokens;
      continue;
    }
    tokens.push({ type: 'variable', name: validateTemplateName(sigil === '&' ? tag : tag, 'variable'), escaped: sigil !== '&' });
  }

  const unclosed = stack.pop();
  if (unclosed !== undefined) throw new Error(`template: unclosed section "${unclosed.name}"`);
  return root;
}

function readUntilSequence(scanner: Scanner, close: string, error: string): string {
  const start = scanner.mark();
  while (!scanner.done) {
    if (scanner.peek(close.length) === close) {
      const out = scanner.text(start);
      scanner.expect(close);
      return out;
    }
    scanner.eat();
  }
  throw new Error(error);
}

function validateTemplateName(raw: string, kind: string): string {
  const name = raw.trim();
  if (name === '') {
    if (kind.includes('section')) throw new Error('template: empty section name');
    throw new Error('template: empty variable name');
  }
  if (name === '.') return name;
  const scanner = new Scanner(name, { encoding: 'utf-8', format: 'template-name' });
  while (scanner.match('../')) {
    if (scanner.done) throw new Error(`template: malformed name "${name}"`);
  }
  const restStart = scanner.mark();
  scanner.eatWhile(() => true);
  const rest = scanner.text(restStart);
  if (rest === '' || rest.startsWith('.') || rest.endsWith('.') || rest.includes('..') || rest.includes('/')) {
    throw new Error(`template: malformed name "${name}"`);
  }
  return name;
}

function renderTokens(tokens: Token[], context: ContextFrame): string {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'text') {
      out += token.value;
    } else if (token.type === 'variable') {
      const value = resolveName(context, token.name);
      out += token.escaped ? escapeHtml(value) : String(value ?? '');
    } else {
      out += renderSection(token, context);
    }
  }
  return out;
}

function renderSection(token: Token & { type: 'section' }, context: ContextFrame): string {
  const value = resolveName(context, token.name);
  const list = iterableValues(value);
  const active = isTruthySectionValue(value, list);
  if (token.inverted) return active ? '' : renderTokens(token.children, context);
  if (!active) return '';
  if (list !== null) {
    let out = '';
    for (const item of list) out += renderTokens(token.children, { value: item, parent: context });
    return out;
  }
  if (isObjectLike(value)) return renderTokens(token.children, { value, parent: context });
  return renderTokens(token.children, context);
}

function resolveName(context: ContextFrame, name: string): unknown {
  if (name === '.') return context.value;
  if (name.startsWith('../')) {
    let current: ContextFrame | null = context;
    let rest = name;
    while (rest.startsWith('../')) {
      current = current?.parent ?? null;
      rest = rest.slice(3);
    }
    return current === null ? undefined : lookupPath(current.value, rest);
  }

  let current: ContextFrame | null = context;
  while (current !== null) {
    const found = lookupPath(current.value, name);
    if (found !== undefined) return found;
    current = current.parent;
  }
  return undefined;
}

function lookupPath(value: unknown, path: string): unknown {
  if (path === '.') return value;
  let current = value;
  for (const part of path.split('.')) {
    if (part.length === 0) return undefined;
    current = lookupPart(current, part);
    if (current === undefined || current === null) return current;
  }
  return current;
}

function lookupPart(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object' || typeof value === 'function') {
    if (value instanceof Map) return value.get(key);
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const out = (value as Record<string, unknown>)[key];
      return typeof out === 'function' ? out.call(value) : out;
    }
  }
  return undefined;
}

function iterableValues(value: unknown): unknown[] | null {
  if (typeof value === 'string') return null;
  if (Array.isArray(value)) return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    Symbol.iterator in value &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  ) {
    return Array.from(value as Iterable<unknown>);
  }
  return null;
}

function isTruthySectionValue(value: unknown, list: unknown[] | null): boolean {
  if (list !== null) return list.length > 0;
  return value !== false && value !== null && value !== undefined && value !== '';
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
