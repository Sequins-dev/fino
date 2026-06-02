/**
 * fino:tty/prompt — interactive command-line prompts with non-interactive
 * defaults.
 *
 * PromptSession wraps the low-level `fino:tty` helpers and centralizes the
 * policy for CI or redirected input: prompts either return explicit defaults
 * or throw instead of blocking forever.
 */

import { readLine, stdinIsTTY, stdoutIsTTY, writeStdout, writeStderr } from '../tty.mts';

interface TextPromptOptions {
  label: string;
  defaultValue?: string;
  validate?: (value: string) => string | null | undefined;
}

interface ConfirmPromptOptions {
  label: string;
  defaultValue?: boolean;
}

interface SelectPromptOptions {
  label: string;
  options: Array<{ label: string; value: string } | string>;
  defaultValue?: string;
}

interface PromptSessionOptions {
  isInteractive?: boolean;
  readLine?: (prompt: string) => Promise<string | null>;
  write?: (text: string) => Promise<void>;
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
  isInteractive: boolean;
  #readLine: (prompt: string) => Promise<string | null>;
  #write: (text: string) => Promise<void>;
  #writeError: (text: string) => Promise<void>;

  constructor(options: PromptSessionOptions = {}) {
    this.isInteractive = options.isInteractive ?? (stdinIsTTY && stdoutIsTTY);
    this.#readLine = options.readLine ?? readLine;
    this.#write = options.write ?? writeStdout;
    this.#writeError = options.writeError ?? writeStderr;
  }

  /** Ask for a text value, repeating until optional validation passes. */
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

  /** Ask a yes/no question and return the selected boolean value. */
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

  /** Ask the user to choose one labeled option and return its value. */
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

/** Create a PromptSession using the process standard input and output. */
export function createDefaultPrompt(): PromptSession {
  return new PromptSession();
}
