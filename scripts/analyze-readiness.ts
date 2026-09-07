// Read a JSON snapshot or the last readiness snapshot embedded in a TAP log.
import { DiskFileSystem } from 'fino:file';
import { argv } from 'fino:process';
import { analyzeReadiness } from '../js/internal/scheduler/readiness-analysis.ts';

const path = argv[argv[1] === 'run' ? 3 : 2];
if (!path) throw new Error('Usage: fino run scripts/analyze-readiness.ts TRACE_OR_TAP');
const text = new TextDecoder().decode(await new DiskFileSystem().readFile(path));
const marker = '# readiness trace: ';
const line = text.split('\n').findLast((line) => line.startsWith(marker));
const snapshot = JSON.parse(line ? line.slice(marker.length) : text);
const realms = Object.entries(snapshot.realms ?? {}).map(([owner, state]) => ({
  owner: Number(owner),
  ...state,
  observations: Object.fromEntries(
    Object.entries(state.observations ?? {}).map(([name, value]) => [name, JSON.parse(value)]),
  ),
}));
console.log(
  JSON.stringify({ ...analyzeReadiness(snapshot), pool: snapshot.pool, realms }, null, 2),
);
