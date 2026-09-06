/**
 * Minimal SPIR-V disassembler for diagnostics.
 *
 * Prints opcode names and raw operands. It deliberately does not know each
 * instruction's operand grammar — that would be a second transcription of the
 * specification to keep in sync — so literal strings and enumerants show as
 * numbers. That is enough to tell "the loop merge is missing" from "the
 * decoration is on the wrong id", which is what a failing golden-word test needs.
 *
 * Specification: [SPIR-V](https://registry.khronos.org/SPIR-V/specs/unified1/SPIRV.html),
 * sections 2.3, 2.4, and 2.11 (binary layout, module layout, structured control flow).
 *
 * @internal
 *
 * This module is re-exported through `internal:spirv`; import from there.
 */
import { MAGIC, OP_NAMES, Op } from './opcodes.ts';
import { decodeLiteralString } from './writer.ts';

/** One decoded instruction. */
export interface DisasmInstruction {
  /** Word offset of the instruction header. */
  offset: number;
  /** Numeric opcode. */
  opcode: number;
  /** Spec name, or `Op<number>` when unrecognised. */
  name: string;
  /** Operand words, excluding the header. */
  operands: number[];
}

/** Opcodes whose trailing operands are a literal string, for readable output. */
const STRING_TAIL: Record<number, number> = {
  [Op.Name]: 1,
  [Op.MemberName]: 2,
  [Op.ExtInstImport]: 1,
  [Op.Extension]: 0,
  [Op.EntryPoint]: 2,
};

/**
 * Decode a SPIR-V binary into instructions.
 *
 * Throws when the magic number is wrong or an instruction claims a word count
 * that runs past the end, since both mean the emitter produced garbage rather
 * than a module a validator would merely reject.
 */
export function disassemble(words: Uint32Array): DisasmInstruction[] {
  if (words.length < 5) throw new Error('SPIR-V binary is shorter than its header');
  if (words[0] !== MAGIC) {
    throw new Error(
      `SPIR-V magic mismatch: got 0x${(words[0] ?? 0).toString(16)}, want 0x${MAGIC.toString(16)}`,
    );
  }
  const out: DisasmInstruction[] = [];
  let index = 5;
  while (index < words.length) {
    const header = words[index]!;
    const count = header >>> 16;
    const opcode = header & 0xffff;
    if (count === 0) throw new Error(`zero-length instruction at word ${index}`);
    if (index + count > words.length) {
      throw new Error(`instruction at word ${index} claims ${count} words past end of module`);
    }
    out.push({
      offset: index,
      opcode,
      name: OP_NAMES[opcode] ?? `Op<${opcode}>`,
      operands: Array.from(words.subarray(index + 1, index + count)),
    });
    index += count;
  }
  return out;
}

/** Render a decoded module as one line per instruction. */
export function formatDisassembly(words: Uint32Array): string {
  const lines: string[] = [];
  for (const inst of disassemble(words)) {
    const stringAt = STRING_TAIL[inst.opcode];
    let rendered: string;
    if (stringAt !== undefined && inst.operands.length > stringAt) {
      const head = inst.operands.slice(0, stringAt);
      const { text } = decodeLiteralString(new Uint32Array(inst.operands.slice(stringAt)), 0);
      rendered = [...head.map((w) => `%${w}`), JSON.stringify(text)].join(' ');
    } else {
      rendered = inst.operands.map((w) => `%${w}`).join(' ');
    }
    lines.push(`${String(inst.offset).padStart(5)}: ${inst.name} ${rendered}`.trimEnd());
  }
  return lines.join('\n');
}

/** Count how many times an opcode appears, for structural assertions. */
export function countOp(words: Uint32Array, opcode: number): number {
  let n = 0;
  for (const inst of disassemble(words)) {
    if (inst.opcode === opcode) n++;
  }
  return n;
}
