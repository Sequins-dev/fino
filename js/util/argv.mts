/**
 * fino:util/argv — config-based argv parser with nested command execution.
 */

import { createDefaultPrompt, PromptSession } from './prompt.mts';

type OptionDefault =
  | boolean
  | string
  | number
  | Array<string | number>
  | ((ctx: CommandContext) => boolean | string | number | Array<string | number> | Promise<boolean | string | number | Array<string | number>>);

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as Promise<unknown>).then === 'function';
}

export interface CommandConfig {
  name?: string;
  description?: string;
  allowUnknown?: boolean;
  run?: (ctx: CommandContext) => unknown;
  options?: OptionConfig[];
  positionals?: PositionalConfig[];
  commands?: Array<Command | CommandConfig>;
}

export interface OptionConfig {
  flags: string;
  type?: 'boolean' | 'string' | 'number';
  multiple?: boolean;
  required?: boolean;
  description?: string;
  default?: OptionDefault;
}

export interface PositionalConfig {
  name: string;
  type?: 'string' | 'number';
  required?: boolean;
  multiple?: boolean;
  description?: string;
}

export interface CommandContext {
  command: Command;
  invocation: CommandInvocation;
  parent: CommandInvocation | null;
  root: CommandInvocation;
  path: string[];
  args: Record<string, unknown>;
  options: Record<string, unknown>;
  positionals: unknown[];
  chain: CommandInvocation[];
  prompt: PromptSession;
  providedOptions: Set<string>;
  optionProvided(key: string): boolean;
}

interface OptionDefinition {
  key: string;
  longName: string | null;
  shortName: string | null;
  type: 'boolean' | 'string' | 'number';
  multiple: boolean;
  required: boolean;
  description: string | undefined;
  default: OptionDefault | undefined;
}

interface PositionalDefinition {
  name: string;
  type: 'string' | 'number';
  required: boolean;
  multiple: boolean;
  description: string | undefined;
}

interface ParseState {
  argv: string[];
  index: number;
}

interface ParsedNode {
  command: Command;
  args: Record<string, unknown>;
  options: Record<string, unknown>;
  positionals: unknown[];
  rawPositionals: string[];
  helpRequested: boolean;
  providedOptions: Set<string>;
}

interface FinalizeConfig {
  allowMissingPositionals: boolean;
}

interface ParseOptions {
  prompt?: PromptSession;
}

export class CommandInvocation {
  command: Command;
  parent: CommandInvocation | null;
  args: Record<string, unknown>;
  options: Record<string, unknown>;
  positionals: unknown[];
  providedOptions: Set<string>;

  constructor(command: Command, parent: CommandInvocation | null, args: Record<string, unknown>, options: Record<string, unknown>, positionals: unknown[], providedOptions: Set<string>) {
    this.command = command;
    this.parent = parent;
    this.args = args;
    this.options = options;
    this.positionals = positionals;
    this.providedOptions = providedOptions;
  }

  get name(): string | null {
    return this.command.name;
  }

  get path(): string[] {
    const names: string[] = [];
    let current: CommandInvocation | null = this;
    while (current !== null) {
      if (current.name !== null) names.push(current.name);
      current = current.parent;
    }
    names.reverse();
    return names;
  }
}

export class Command {
  #name: string | null = null;
  #description: string | undefined = undefined;
  #allowUnknown: boolean = false;
  #runHandler: ((ctx: CommandContext) => unknown) | undefined = undefined;
  #parent: Command | null = null;
  #children: Command[] = [];
  #childMap = new Map<string, Command>();
  #options: OptionDefinition[] = [];
  #positionals: PositionalDefinition[] = [];
  #longOptions = new Map<string, OptionDefinition>();
  #shortOptions = new Map<string, OptionDefinition>();

  constructor(config: CommandConfig = {}) {
    this.#name = config.name ?? null;
    this.#description = config.description;
    this.#allowUnknown = config.allowUnknown ?? false;
    this.#runHandler = config.run;

    for (const option of config.options ?? []) this.#registerOption(option);
    for (const positional of config.positionals ?? []) this.#registerPositional(positional);
    for (const child of config.commands ?? []) this.#registerChild(child instanceof Command ? child : new Command(child));
  }

  get name(): string | null {
    return this.#name;
  }

  get description(): string | undefined {
    return this.#description;
  }

  get parent(): Command | null {
    return this.#parent;
  }

  parse(argv: string[], options: ParseOptions = {}): unknown {
    const state: ParseState = { argv, index: 0 };
    const parsedChain = this.#parseInto(state, []);
    const invocationChain = buildInvocationChain(parsedChain);
    const finalInvocation = invocationChain[invocationChain.length - 1];
    const finalParsed = parsedChain[parsedChain.length - 1];
    const prompt = options.prompt ?? createDefaultPrompt();
    if (finalInvocation === undefined || finalParsed === undefined) throw new Error('Command parse failed');

    if (finalParsed.helpRequested) return finalInvocation.command.help();
    const resolved = this.#resolveOptionDefaults(invocationChain, prompt);
    if (isPromiseLike(resolved)) {
      return resolved.then(() => finalInvocation.command.run(createContext(finalInvocation, invocationChain, prompt)));
    }
    return finalInvocation.command.run(createContext(finalInvocation, invocationChain, prompt));
  }

  run(ctx: CommandContext): unknown {
    if (this.#runHandler !== undefined) return this.#runHandler(ctx);
    return this.help();
  }

  usage(programName?: string): string {
    const segments = this.#commandPath();
    const parts: string[] = ['Usage:'];
    if (programName !== undefined && programName.length > 0) parts.push(programName);
    if (segments.length > 0) {
      const visibleSegments = programName !== undefined && segments[0] === programName ? segments.slice(1) : segments;
      parts.push(...visibleSegments);
    }
    if (this.#options.length > 0 || this.#children.length > 0) parts.push('[options]');
    parts.push(...this.#positionals.map(formatPositionalUsage));
    if (this.#children.length > 0) parts.push('[command]');
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  help(programName?: string): string {
    const lines = [this.usage(programName)];
    if (this.#description !== undefined && this.#description.length > 0) {
      lines.push('');
      lines.push(this.#description);
    }
    if (this.#options.length > 0) {
      lines.push('');
      lines.push('Options:');
      for (const def of this.#options) lines.push(`  ${formatFlags(def)}${formatDescription(def.description)}`);
    }
    if (this.#positionals.length > 0) {
      lines.push('');
      lines.push('Arguments:');
      for (const def of this.#positionals) {
        lines.push(`  ${def.name} (${def.type}${def.multiple ? '[]' : ''})${formatDescription(def.description)}`);
      }
    }
    if (this.#children.length > 0) {
      lines.push('');
      lines.push('Commands:');
      for (const child of this.#children) lines.push(`  ${child.name}${formatDescription(child.description)}`);
    }
    return lines.join('\n');
  }

  #registerOption(config: OptionConfig): void {
    const parsed = parseFlags(config.flags);
    const def: OptionDefinition = {
      key: parsed.longName ?? parsed.shortName!,
      longName: parsed.longName,
      shortName: parsed.shortName,
      type: config.type ?? 'boolean',
      multiple: config.multiple ?? false,
      required: config.required ?? false,
      description: config.description,
      default: config.default,
    };
    this.#options.push(def);
    if (def.longName !== null) this.#longOptions.set(def.longName, def);
    if (def.shortName !== null) this.#shortOptions.set(def.shortName, def);
  }

  #registerPositional(config: PositionalConfig): void {
    if (config.name.length === 0) throw new Error('Positional name must not be empty');
    const def: PositionalDefinition = {
      name: config.name,
      type: config.type ?? 'string',
      required: config.required ?? false,
      multiple: config.multiple ?? false,
      description: config.description,
    };
    if (def.multiple && this.#positionals.some((item) => item.multiple)) {
      throw new Error(`Command "${this.#name ?? 'root'}" already has a variadic positional`);
    }
    if (this.#positionals.some((item) => item.multiple)) {
      throw new Error('Variadic positional must be declared last');
    }
    this.#positionals.push(def);
  }

  #registerChild(command: Command): void {
    if (command.name === null) throw new Error('Subcommands must have a name');
    if (this.#childMap.has(command.name)) throw new Error(`Duplicate command "${command.name}"`);
    command.#parent = this;
    this.#children.push(command);
    this.#childMap.set(command.name, command);
  }

  #parseInto(state: ParseState, path: string[]): ParsedNode[] {
    const parsed: ParsedNode = {
      command: this,
      args: {},
      options: makeInitialOptions(this.#options),
      positionals: [],
      rawPositionals: [],
      helpRequested: false,
      providedOptions: new Set(),
    };
    let stopOptions = false;

    while (state.index < state.argv.length) {
      const token = state.argv[state.index];
      if (token === undefined) break;
      const child = this.#childMap.get(token);
      if (!stopOptions && child !== undefined) {
        if (!parsed.helpRequested) this.#finalizeParsedNode(parsed, this.#formatPath(path), { allowMissingPositionals: true });
        state.index++;
        return [parsed, ...child.#parseInto(state, [...path, child.name!])];
      }

      if (!stopOptions && token === '--') {
        stopOptions = true;
        state.index++;
        continue;
      }

      if (!stopOptions && token === '--help') {
        parsed.helpRequested = true;
        state.index++;
        continue;
      }

      if (!stopOptions && token.startsWith('--') && token.length > 2) {
        if (!this.#consumeLongOption(state, parsed, path)) {
          if (this.#allowUnknown) {
            stopOptions = true;
            continue;
          }
          throw new Error(`Unknown option "${token}" for ${this.#formatPath(path)}`);
        }
        continue;
      }

      if (!stopOptions && token.startsWith('-') && token.length > 1) {
        if (!this.#consumeShortOptions(state, parsed, path)) {
          if (this.#allowUnknown) {
            stopOptions = true;
            continue;
          }
          throw new Error(`Unknown option "${token}" for ${this.#formatPath(path)}`);
        }
        continue;
      }

      parsed.rawPositionals.push(token);
      state.index++;
    }

    if (!parsed.helpRequested) this.#finalizeParsedNode(parsed, this.#formatPath(path), { allowMissingPositionals: false });
    return [parsed];
  }

  #consumeLongOption(state: ParseState, parsed: ParsedNode, path: string[]): boolean {
    const token = state.argv[state.index];
    if (token === undefined) return false;
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const value = eq === -1 ? null : token.slice(eq + 1);
    const def = this.#longOptions.get(flag);
    if (def === undefined) return false;

    state.index++;

    if (def.type === 'boolean') {
      assignOptionValue(parsed.options, parsed.providedOptions, def, value === null ? true : coerceScalarValue(def.type, value, formatPath(path), formatOption(def)));
      return true;
    }

    const raw = value === null ? takeNextValue(state, def, this.#formatPath(path)) : value;
    assignOptionValue(parsed.options, parsed.providedOptions, def, coerceScalarValue(def.type, raw, formatPath(path), formatOption(def)));
    return true;
  }

  #consumeShortOptions(state: ParseState, parsed: ParsedNode, path: string[]): boolean {
    const token = state.argv[state.index];
    if (token === undefined) return false;
    const group = token.slice(1);
    let consumedAny = false;

    for (let i = 0; i < group.length; i++) {
      const name = group[i];
      if (name === undefined) continue;
      const def = this.#shortOptions.get(name);
      if (def === undefined) {
        if (!consumedAny) return false;
        throw new Error(`Unknown option "-${name}" for ${this.#formatPath(path)}`);
      }

      consumedAny = true;
      if (def.type === 'boolean') {
        assignOptionValue(parsed.options, parsed.providedOptions, def, true);
        continue;
      }

      const inline = group.slice(i + 1);
      state.index++;
      const raw = inline.length > 0 ? inline : takeNextValue(state, def, this.#formatPath(path));
      assignOptionValue(parsed.options, parsed.providedOptions, def, coerceScalarValue(def.type, raw, formatPath(path), formatOption(def)));
      return true;
    }

    state.index++;
    return true;
  }

  #commandPath(): string[] {
    const names: string[] = [];
    let current: Command | null = this;
    while (current !== null) {
      if (current.name !== null) names.push(current.name);
      current = current.parent;
    }
    names.reverse();
    return names;
  }

  #formatPath(path: string[]): string {
    const names = this.#name === null ? path : path.length === 0 ? [this.#name] : path;
    return names.length === 0 ? 'root command' : `command "${names.join(' ')}"`;
  }

  #finalizeParsedNode(parsed: ParsedNode, formattedPath: string, config: FinalizeConfig): void {
    const args: Record<string, unknown> = {};
    const values: unknown[] = [];
    let index = 0;

    for (const def of this.#positionals) {
      if (def.multiple) {
        const rawValues = parsed.rawPositionals.slice(index);
        if (def.required && rawValues.length === 0 && !config.allowMissingPositionals) {
          throw new Error(`Missing required positional "${def.name}" on ${formattedPath}`);
        }
        const coerced = rawValues.map((raw) => coerceScalarValue(def.type, raw, formattedPath, `positional "${def.name}"`));
        args[def.name] = coerced;
        values.push(...coerced);
        index = parsed.rawPositionals.length;
        continue;
      }

      const raw = parsed.rawPositionals[index];
      if (raw === undefined) {
        if (def.required && !config.allowMissingPositionals) {
          throw new Error(`Missing required positional "${def.name}" on ${formattedPath}`);
        }
        args[def.name] = undefined;
        continue;
      }
      const coerced = coerceScalarValue(def.type, raw, formattedPath, `positional "${def.name}"`);
      args[def.name] = coerced;
      values.push(coerced);
      index++;
    }

    for (; index < parsed.rawPositionals.length; index++) values.push(parsed.rawPositionals[index]);
    parsed.args = args;
    parsed.positionals = values;
  }

  #resolveOptionDefaults(chain: CommandInvocation[], prompt: PromptSession): void | Promise<void> {
    let pending: Promise<void> | null = null;

    function schedule(work: () => void | Promise<void>) {
      if (pending === null) {
        const result = work();
        if (isPromiseLike(result)) pending = Promise.resolve(result).then(() => undefined);
      } else {
        pending = pending.then(async () => { await work(); });
      }
    }

    for (const invocation of chain) {
      for (const def of invocation.command.#options) {
        if (invocation.providedOptions.has(def.key)) continue;
        const defaultValue = def.default;
        if (defaultValue === undefined) continue;

        if (typeof defaultValue === 'function') {
          schedule(async () => {
            invocation.options[def.key] = await defaultValue(createContext(invocation, chain, prompt));
          });
        } else {
          const currentValue = invocation.options[def.key];
          if (currentValue === undefined || (def.multiple && Array.isArray(currentValue) && currentValue.length === 0)) {
            invocation.options[def.key] = cloneDefault(defaultValue);
          }
        }
      }
      schedule(() => {
        validateRequiredOptions(invocation.command.#options, invocation.options, invocation.command.#formatPath(invocation.path));
      });
    }
    return pending ?? undefined;
  }
}

function parseFlags(flags: string): { longName: string | null; shortName: string | null } {
  let longName: string | null = null;
  let shortName: string | null = null;
  for (const part of flags.split(',')) {
    const flag = part.trim();
    if (flag.startsWith('--')) {
      const name = flag.slice(2).trim();
      if (name.length === 0) throw new Error(`Invalid long option "${flags}"`);
      longName = name;
    } else if (flag.startsWith('-')) {
      const name = flag.slice(1).trim();
      if (name.length !== 1) throw new Error(`Invalid short option "${flags}"`);
      shortName = name;
    } else {
      throw new Error(`Invalid option flags "${flags}"`);
    }
  }

  if (longName === null && shortName === null) throw new Error(`Invalid option flags "${flags}"`);
  return { longName, shortName };
}

function makeInitialOptions(defs: OptionDefinition[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    if (def.multiple) {
      out[def.key] = Array.isArray(def.default) ? [...def.default] : [];
    } else if (def.default !== undefined && typeof def.default !== 'function') {
      out[def.key] = cloneDefault(def.default);
    } else if (def.type === 'boolean') {
      out[def.key] = false;
    } else {
      out[def.key] = undefined;
    }
  }
  return out;
}

function cloneDefault(value: boolean | string | number | Array<string | number>) {
  return Array.isArray(value) ? [...value] : value;
}

function takeNextValue(state: ParseState, def: OptionDefinition, formattedPath: string): string {
  if (state.index >= state.argv.length) throw new Error(`Missing value for option "${formatOption(def)}" on ${formattedPath}`);
  const value = state.argv[state.index];
  state.index++;
  if (value === undefined) throw new Error(`Missing value for option "${formatOption(def)}" on ${formattedPath}`);
  return value;
}

function coerceScalarValue(type: 'boolean' | 'string' | 'number', raw: string, path: string, label: string): boolean | string | number {
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`Invalid value "${raw}" for ${label} on ${path}`);
  }
  if (type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid value "${raw}" for ${label} on ${path}`);
    return value;
  }
  return raw;
}

function assignOptionValue(options: Record<string, unknown>, providedOptions: Set<string>, def: OptionDefinition, value: unknown): void {
  providedOptions.add(def.key);
  if (def.multiple) {
    const current = options[def.key];
    const items = Array.isArray(current) ? current : [];
    items.push(value as string | number);
    options[def.key] = items;
    return;
  }
  options[def.key] = value;
}

function validateRequiredOptions(defs: OptionDefinition[], options: Record<string, unknown>, formattedPath: string): void {
  for (const def of defs) {
    const value = options[def.key];
    const missing = def.multiple ? Array.isArray(value) && value.length === 0 : value === undefined;
    if (def.required && missing) throw new Error(`Missing required option "${formatOption(def)}" on ${formattedPath}`);
  }
}

function buildInvocationChain(parsedChain: ParsedNode[]): CommandInvocation[] {
  const chain: CommandInvocation[] = [];
  let parent: CommandInvocation | null = null;
  for (const parsed of parsedChain) {
    const invocation: CommandInvocation = new CommandInvocation(parsed.command, parent, parsed.args, parsed.options, parsed.positionals, parsed.providedOptions);
    chain.push(invocation);
    parent = invocation;
  }
  return chain;
}

function createContext(invocation: CommandInvocation, chain: CommandInvocation[], prompt: PromptSession): CommandContext {
  const root = chain[0];
  if (root === undefined) throw new Error('Command invocation chain is empty');
  return {
    command: invocation.command,
    invocation,
    parent: invocation.parent,
    root,
    path: invocation.path,
    args: invocation.args,
    options: invocation.options,
    positionals: invocation.positionals,
    chain,
    prompt,
    providedOptions: invocation.providedOptions,
    optionProvided(key: string) {
      return invocation.providedOptions.has(key);
    },
  };
}

function formatOption(def: OptionDefinition): string {
  if (def.longName !== null) return `--${def.longName}`;
  if (def.shortName === null) throw new Error('Option definition is missing a flag name');
  return `-${def.shortName}`;
}

function formatFlags(def: OptionDefinition): string {
  const parts = [];
  if (def.longName !== null) parts.push(`--${def.longName}`);
  if (def.shortName !== null) parts.push(`-${def.shortName}`);
  return parts.join(', ');
}

function formatDescription(description?: string): string {
  return description === undefined || description.length === 0 ? '' : `  ${description}`;
}

function formatPositionalUsage(def: PositionalDefinition): string {
  const label = def.multiple ? `${def.name}...` : def.name;
  return def.required ? `<${label}>` : `[${label}]`;
}

function formatPath(path: string[]): string {
  return path.length === 0 ? 'root command' : `command "${path.join(' ')}"`;
}
