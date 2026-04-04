import { DiskFileSystem } from '../file/fs.mts';
import { Command, type CommandContext } from '../util/argv.mts';
import { extractModule } from 'internal:docgen';

const fs = new DiskFileSystem();

interface DocTag {
  name: string;
  value: string;
}

interface DocBlock {
  text: string;
  tags: DocTag[];
}

interface DocMember {
  name: string;
  signature: string;
  doc: DocBlock;
}

interface DocExport extends DocMember {
  members: DocMember[];
}

interface ModuleDoc {
  name: string;
  doc: DocBlock;
  exports: DocExport[];
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
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

function renderTag(tag: DocTag): string {
  if (tag.name === 'param') {
    const [name, ...rest] = tag.value.split(/\s+/);
    if (!name) return '@param';
    const detail = rest.join(' ').trim();
    return detail.length > 0 ? `@param \`${name}\` ${detail}` : `@param \`${name}\``;
  }
  if (tag.name === 'returns' || tag.name === 'return') {
    return tag.value.length > 0 ? `@returns ${tag.value}` : '@returns';
  }
  return tag.value.length > 0 ? `@${tag.name} ${tag.value}` : `@${tag.name}`;
}

function renderDocBlock(doc: DocBlock): string[] {
  const lines: string[] = [];
  if (doc.text.length > 0) lines.push(doc.text);
  for (const tag of doc.tags) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(renderTag(tag));
  }
  return lines;
}

function renderMember(member: DocMember): string {
  const lines = [
    `### ${member.name}`,
    '',
    '```ts',
    member.signature,
    '```',
  ];

  const docLines = renderDocBlock(member.doc);
  if (docLines.length > 0) {
    lines.push('');
    lines.push(...docLines);
  }

  return lines.join('\n');
}

function renderModule(moduleDoc: ModuleDoc): string {
  const lines = [`# ${moduleDoc.name}`];

  const moduleLines = renderDocBlock(moduleDoc.doc);
  if (moduleLines.length > 0) {
    lines.push('');
    lines.push(...moduleLines);
  }

  for (const item of moduleDoc.exports) {
    lines.push('');
    lines.push(`## ${item.name}`);
    lines.push('');
    lines.push('```ts');
    lines.push(item.signature);
    lines.push('```');

    const docLines = renderDocBlock(item.doc);
    if (docLines.length > 0) {
      lines.push('');
      lines.push(...docLines);
    }

    for (const member of item.members) {
      lines.push('');
      lines.push(renderMember(member));
    }
  }

  return lines.join('\n') + '\n';
}

export function createDocCommand(): Command {
  return new Command({
    name: 'doc',
    description: 'Generate API docs from commented source files',
    run: async function runDocCommand(ctx: CommandContext) {
      const outDir = String(ctx.options.out ?? 'docs');
      const modules: ModuleDoc[] = [];
      const written: string[] = [];
      const files = Array.isArray(ctx.args.files) ? ctx.args.files : [];

      await ensureDir(outDir);

      for (const file of files) {
        const moduleDoc = JSON.parse(extractModule(String(file))) as ModuleDoc;
        modules.push(moduleDoc);
        const markdownPath = `${outDir}/${moduleDoc.name}.md`;
        await fs.writeFile(markdownPath, renderModule(moduleDoc));
        written.push(markdownPath);
      }

      const jsonPath = String(ctx.options.json ?? `${outDir}/api.json`);
      await ensureDir(dirname(jsonPath));
      await fs.writeFile(jsonPath, JSON.stringify({ modules }, null, 2) + '\n');
      written.push(jsonPath);

      return written.map((path) => `Wrote ${path}`).join('\n');
    },
    options: [
      { flags: '--out', type: 'string', description: 'Directory where Markdown docs will be written', default: 'docs' },
      { flags: '--json', type: 'string', description: 'Path to the aggregate JSON docs file' },
    ],
    positionals: [
      { name: 'files', type: 'string', multiple: true, required: true, description: 'Source files to document' },
    ],
  });
}
