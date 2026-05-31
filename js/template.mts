/**
 * fino:template — small Mustache-compatible template rendering.
 */

type Token =
  | { type: 'text'; value: string }
  | { type: 'variable'; name: string; escaped: boolean }
  | { type: 'section'; name: string; inverted: boolean; children: Token[] };

export interface RenderOptions {}
export interface CompileOptions extends RenderOptions {}

interface ContextFrame {
  value: unknown;
  parent: ContextFrame | null;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function compile(template: string, _options: CompileOptions = {}): (data?: unknown) => string {
  const tokens = parseTemplate(template);
  return (data: unknown = {}) => renderTokens(tokens, { value: data, parent: null });
}

export function render(template: string, data: unknown = {}, options: RenderOptions = {}): string {
  return compile(template, options)(data);
}

function parseTemplate(template: string): Token[] {
  const root: Token[] = [];
  const stack: Array<{ name: string; tokens: Token[]; section: Token & { type: 'section' } }> = [];
  let tokens = root;
  let index = 0;

  while (index < template.length) {
    const open = template.indexOf('{{', index);
    if (open < 0) {
      tokens.push({ type: 'text', value: template.slice(index) });
      break;
    }
    if (open > index) tokens.push({ type: 'text', value: template.slice(index, open) });

    if (template.startsWith('{{{', open)) {
      const close = template.indexOf('}}}', open + 3);
      if (close < 0) throw new Error('template: unclosed triple mustache');
      const name = template.slice(open + 3, close).trim();
      tokens.push({ type: 'variable', name, escaped: false });
      index = close + 3;
      continue;
    }

    const close = template.indexOf('}}', open + 2);
    if (close < 0) throw new Error('template: unclosed tag');
    let tag = template.slice(open + 2, close).trim();
    index = close + 2;
    if (tag.length === 0) continue;

    const sigil = tag[0]!;
    if ('#^/!>&'.includes(sigil)) tag = tag.slice(1).trim();

    if (sigil === '!') continue;
    if (sigil === '>') throw new Error('template: partials are not supported yet');
    if (sigil === '#') {
      const section: Token & { type: 'section' } = { type: 'section', name: tag, inverted: false, children: [] };
      tokens.push(section);
      stack.push({ name: tag, tokens, section });
      tokens = section.children;
      continue;
    }
    if (sigil === '^') {
      const section: Token & { type: 'section' } = { type: 'section', name: tag, inverted: true, children: [] };
      tokens.push(section);
      stack.push({ name: tag, tokens, section });
      tokens = section.children;
      continue;
    }
    if (sigil === '/') {
      const frame = stack.pop();
      if (frame === undefined || frame.name !== tag) throw new Error(`template: unmatched section close "${tag}"`);
      tokens = frame.tokens;
      continue;
    }
    tokens.push({ type: 'variable', name: sigil === '&' ? tag : template.slice(open + 2, close).trim(), escaped: sigil !== '&' });
  }

  const unclosed = stack.pop();
  if (unclosed !== undefined) throw new Error(`template: unclosed section "${unclosed.name}"`);
  return root;
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
