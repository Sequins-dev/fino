/**
 * Benchmarks for fino:util/argv
 *
 * Run with: cargo run -- bench benchmarks/util/argv.bench.mts
 */

import { Command } from 'fino:util/argv';
import { bench } from 'fino:bench';

const command = new Command({
  name: 'bench',
  options: [{ flags: '--port, -p', type: 'number', default: 3030 }],
  positionals: [{ name: 'file', type: 'string', required: true }],
  run: (ctx) => ctx.options.port,
});

bench('util/argv', (b) => {
  b.measure('parse command', () => command.parse(['--port', '4040', 'app.mts']));
  b.measure('help text', () => command.help('fino'));
});
