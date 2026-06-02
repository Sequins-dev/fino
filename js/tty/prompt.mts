/**
 * fino:tty/prompt — interactive command-line prompts with non-interactive
 * defaults.
 *
 * PromptSession wraps the low-level `fino:tty` helpers and centralizes the
 * policy for CI or redirected input: prompts either return explicit defaults
 * or throw instead of blocking forever.
 *
 * @example
 * ```ts no_run
 * import { PromptSession } from 'fino:tty/prompt';
 *
 * const prompt = new PromptSession();
 * const project = await prompt.text({ label: 'Project name', defaultValue: 'app' });
 * const install = await prompt.confirm({ label: 'Install dependencies', defaultValue: true });
 * const template = await prompt.select({
 *   label: 'Template',
 *   options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
 *   defaultValue: 'server',
 * });
 * ```
 */

import { readLine, stdinIsTTY, stdoutIsTTY, writeStdout, writeStderr } from '../tty.mts';

/**
 * Options for a text prompt.
 *
 * `defaultValue` is returned when the user submits an empty line and is also
 * used automatically in non-interactive sessions. `validate` may return an
 * error message to retry the prompt, or `null`/`undefined` to accept the value.
 *
 * ```ts no_run
 * import { PromptSession } from 'fino:tty/prompt';
 *
 * const prompt = new PromptSession();
 * const options = {
 *   label: 'Project name',
 *   defaultValue: 'app',
 *   validate: (value) => value ? null : 'Name is required',
 * };
 * await prompt.text(options);
 * ```
 */
interface TextPromptOptions {
  /**
   * Label shown before the input field.
   *
   * ```ts no_run
   * const options = { label: 'Project name' };
   * ```
   */
  label: string;
  /**
   * Value used for empty input and non-interactive mode.
   *
   * ```ts no_run
   * const options = { label: 'Project name', defaultValue: 'app' };
   * ```
   */
  defaultValue?: string;
  /**
   * Optional validator that returns an error message when input is invalid.
   *
   * ```ts no_run
   * const options = {
   *   label: 'Port',
   *   validate: (value: string) => Number(value) > 0 ? null : 'Enter a port',
   * };
   * ```
   */
  validate?: (value: string) => string | null | undefined;
}

/**
 * Options for a yes/no prompt.
 *
 * `defaultValue` controls the hint (`Y/n` or `y/N`) and is returned when the
 * user submits an empty line. In non-interactive mode it is required.
 *
 * ```ts no_run
 * import { PromptSession } from 'fino:tty/prompt';
 *
 * const prompt = new PromptSession();
 * const options = {
 *   label: 'Install dependencies',
 *   defaultValue: true,
 * };
 * await prompt.confirm(options);
 * ```
 */
interface ConfirmPromptOptions {
  /**
   * Question shown before the yes/no hint.
   *
   * ```ts no_run
   * const options = { label: 'Continue' };
   * ```
   */
  label: string;
  /**
   * Boolean returned for empty input and non-interactive mode.
   *
   * ```ts no_run
   * const options = { label: 'Overwrite', defaultValue: false };
   * ```
   */
  defaultValue?: boolean;
}

/**
 * Options for a select prompt.
 *
 * Options may be strings, where label and value are the same, or objects with
 * separate display labels and returned values. In non-interactive mode,
 * `defaultValue` is returned without checking that it appears in `options`.
 *
 * ```ts no_run
 * import { PromptSession } from 'fino:tty/prompt';
 *
 * const prompt = new PromptSession();
 * const options = {
 *   label: 'Template',
 *   options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
 *   defaultValue: 'server',
 * };
 * await prompt.select(options);
 * ```
 */
interface SelectPromptOptions {
  /**
   * Heading printed above the numbered choices.
   *
   * ```ts no_run
   * const options = { label: 'Template', options: ['empty'] };
   * ```
   */
  label: string;
  /**
   * Choices accepted by number, exact label, or exact value.
   *
   * ```ts no_run
   * const options = {
   *   label: 'Template',
   *   options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
   * };
   * ```
   */
  options: Array<{ label: string; value: string } | string>;
  /**
   * Value returned for empty input and non-interactive mode.
   *
   * ```ts no_run
   * const options = {
   *   label: 'Template',
   *   options: ['empty'],
   *   defaultValue: 'empty',
   * };
   * ```
   */
  defaultValue?: string;
}

/**
 * Constructor options for `PromptSession`.
 *
 * Tests and CLI tools can inject custom read/write functions to avoid touching
 * process stdio. When `isInteractive` is false, prompts return defaults or
 * throw instead of reading from stdin.
 *
 * ```ts no_run
 * import { PromptSession } from 'fino:tty/prompt';
 *
 * const options = {
 *   isInteractive: false,
 *   readLine: async () => null,
 *   write: async () => {},
 *   writeError: async () => {},
 * };
 * const prompt = new PromptSession(options);
 * ```
 */
interface PromptSessionOptions {
  /**
   * Override automatic TTY detection.
   *
   * ```ts no_run
   * const options = { isInteractive: false };
   * ```
   */
  isInteractive?: boolean;
  /**
   * Function used to read one prompted line.
   *
   * ```ts no_run
   * const options = { readLine: async (prompt: string) => 'answer' };
   * ```
   */
  readLine?: (prompt: string) => Promise<string | null>;
  /**
   * Function used for normal prompt output.
   *
   * ```ts no_run
   * const options = { write: async (text: string) => {} };
   * ```
   */
  write?: (text: string) => Promise<void>;
  /**
   * Function used for validation and choice errors.
   *
   * ```ts no_run
   * const options = { writeError: async (text: string) => {} };
   * ```
   */
  writeError?: (text: string) => Promise<void>;
}

function normalizeOptions(options: Array<{ label: string; value: string } | string>) {
  return options.map((option) => typeof option === 'string' ? { label: option, value: option } : option);
}

/**
 * Stateful prompt runner for text, confirm, and select questions.
 *
 * ```ts no_run
 * import { PromptSession } from 'fino:tty/prompt';
 *
 * const prompt = new PromptSession();
 * const name = await prompt.text({ label: 'Project name', defaultValue: 'app' });
 * const install = await prompt.confirm({ label: 'Install dependencies', defaultValue: true });
 * ```
 */
export class PromptSession {
  /**
   * Whether this session may ask questions on stdin/stdout.
   *
   * ```ts no_run
   * import { PromptSession } from 'fino:tty/prompt';
   *
   * const prompt = new PromptSession({ isInteractive: false });
   * prompt.isInteractive; // false
   * ```
   */
  isInteractive: boolean;
  /**
   * Private property `#readLine` used by `PromptSession`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readLine = undefined;
   *
   *   readInternalState() {
   *     return this.#readLine;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readLine: (prompt: string) => Promise<string | null>;
  /**
   * Private property `#write` used by `PromptSession`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #write = undefined;
   *
   *   readInternalState() {
   *     return this.#write;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #write: (text: string) => Promise<void>;
  /**
   * Private property `#writeError` used by `PromptSession`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #writeError = undefined;
   *
   *   readInternalState() {
   *     return this.#writeError;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #writeError: (text: string) => Promise<void>;

  /**
   * Create a prompt session.
   *
   * By default the session is interactive only when both stdin and stdout are
   * TTYs. Inject `readLine`, `write`, and `writeError` in tests or command
   * flows that need deterministic prompt behavior.
   *
   * ```ts no_run
   * import { PromptSession } from 'fino:tty/prompt';
   *
   * const prompt = new PromptSession({
   *   isInteractive: true,
   *   readLine: async () => 'yes',
   *   write: async () => {},
   *   writeError: async () => {},
   * });
   * ```
   */
  constructor(options: PromptSessionOptions = {}) {
    this.isInteractive = options.isInteractive ?? (stdinIsTTY && stdoutIsTTY);
    this.#readLine = options.readLine ?? readLine;
    this.#write = options.write ?? writeStdout;
    this.#writeError = options.writeError ?? writeStderr;
  }

  /**
   * Ask for a text value, repeating until optional validation passes.
   *
   * Empty input resolves to `defaultValue` when provided. In non-interactive
   * mode, this method returns `defaultValue` or throws if no default exists.
   *
   * ```ts no_run
   * import { PromptSession } from 'fino:tty/prompt';
   *
   * const prompt = new PromptSession();
   * const name = await prompt.text({ label: 'Name', defaultValue: 'app' });
   * ```
   */
  async text(options: TextPromptOptions): Promise<string> {
    if (!this.isInteractive) {
      if (options.defaultValue !== undefined) return options.defaultValue;
      throw new Error(`Prompt unavailable for "${options.label}" in non-interactive mode`);
    }

    while (true) {
      const suffix = options.defaultValue !== undefined ? ` (${options.defaultValue})` : '';
      const response = await this.#readLine(`${options.label}${suffix}: `);
      const value = (response == null || response.trim().length === 0)
        ? (options.defaultValue ?? '')
        : response.trim();
      const error = options.validate?.(value) ?? null;
      if (!error) return value;
      await this.#writeError(error + '\n');
    }
  }

  /**
   * Ask a yes/no question and return the selected boolean value.
   *
   * Accepts `y`, `yes`, `n`, and `no` case-insensitively. Empty input uses
   * `defaultValue` when available.
   *
   * ```ts no_run
   * import { PromptSession } from 'fino:tty/prompt';
   *
   * const prompt = new PromptSession();
   * const proceed = await prompt.confirm({ label: 'Continue', defaultValue: true });
   * ```
   */
  async confirm(options: ConfirmPromptOptions): Promise<boolean> {
    if (!this.isInteractive) {
      if (options.defaultValue !== undefined) return options.defaultValue;
      throw new Error(`Prompt unavailable for "${options.label}" in non-interactive mode`);
    }

    while (true) {
      const defaultHint = options.defaultValue === undefined ? 'y/n' : options.defaultValue ? 'Y/n' : 'y/N';
      const response = await this.#readLine(`${options.label} [${defaultHint}]: `);
      const value = response == null ? '' : response.trim().toLowerCase();
      if (value === '' && options.defaultValue !== undefined) return options.defaultValue;
      if (value === 'y' || value === 'yes') return true;
      if (value === 'n' || value === 'no') return false;
      await this.#writeError('Please answer yes or no.\n');
    }
  }

  /**
   * Ask the user to choose one labeled option and return its value.
   *
   * The user may enter a one-based number, an exact label, or an exact value.
   * In non-interactive mode, this method returns `defaultValue` or throws if no
   * default exists.
   *
   * ```ts no_run
   * import { PromptSession } from 'fino:tty/prompt';
   *
   * const prompt = new PromptSession();
   * const template = await prompt.select({
   *   label: 'Template',
   *   options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
   *   defaultValue: 'server',
   * });
   * ```
   */
  async select(options: SelectPromptOptions): Promise<string> {
    const items = normalizeOptions(options.options);
    if (!this.isInteractive) {
      if (options.defaultValue !== undefined) return options.defaultValue;
      throw new Error(`Prompt unavailable for "${options.label}" in non-interactive mode`);
    }

    await this.#write(`${options.label}\n`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue;
      await this.#write(`  ${i + 1}. ${item.label}\n`);
    }

    while (true) {
      const suffix = options.defaultValue !== undefined ? ` (${options.defaultValue})` : '';
      const response = await this.#readLine(`Select${suffix}: `);
      const value = response == null ? '' : response.trim();
      if (value === '' && options.defaultValue !== undefined) return options.defaultValue;
      const index = Number(value);
      if (Number.isInteger(index) && index >= 1 && index <= items.length) {
        const item = items[index - 1];
        if (item !== undefined) return item.value;
      }
      const exact = items.find((item) => item.value === value || item.label === value);
      if (exact) return exact.value;
      await this.#writeError('Please choose one of the listed options.\n');
    }
  }
}

/**
 * Create a `PromptSession` using the process standard input and output.
 *
 * This is a convenience wrapper for `new PromptSession()`. The returned session
 * follows the same automatic TTY detection and non-interactive default policy.
 *
 * ```ts no_run
 * import { createDefaultPrompt } from 'fino:tty/prompt';
 *
 * const prompt = createDefaultPrompt();
 * const name = await prompt.text({ label: 'Name', defaultValue: 'app' });
 * ```
 */
export function createDefaultPrompt(): PromptSession {
  return new PromptSession();
}
