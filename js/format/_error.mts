/**
 * internal:format/error — Shared parse-error class for all fino:format/* modules.
 *
 * Each module subclasses FormatParseError to set `this.name` and gets
 * positioned error messages automatically.
 */

export class FormatParseError extends Error {
  readonly format: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly snippet: string;

  constructor(
    format: string,
    message: string,
    line: number,
    column: number,
    offset: number,
    snippet: string,
  ) {
    super(`${format}: ${message} at line ${line}, column ${column}\n  ${snippet}`);
    this.name = 'FormatParseError';
    this.format = format;
    this.line = line;
    this.column = column;
    this.offset = offset;
    this.snippet = snippet;
  }
}

export class CsvParseError extends FormatParseError {
  constructor(msg: string, line: number, col: number, offset: number, snippet: string) {
    super('csv', msg, line, col, offset, snippet);
    this.name = 'CsvParseError';
  }
}

export class TomlParseError extends FormatParseError {
  constructor(msg: string, line: number, col: number, offset: number, snippet: string) {
    super('toml', msg, line, col, offset, snippet);
    this.name = 'TomlParseError';
  }
}

export class XmlParseError extends FormatParseError {
  constructor(msg: string, line: number, col: number, offset: number, snippet: string) {
    super('xml', msg, line, col, offset, snippet);
    this.name = 'XmlParseError';
  }
}

export class YamlParseError extends FormatParseError {
  constructor(msg: string, line: number, col: number, offset: number, snippet: string) {
    super('yaml', msg, line, col, offset, snippet);
    this.name = 'YamlParseError';
  }
}
