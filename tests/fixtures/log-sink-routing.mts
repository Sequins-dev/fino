import {
  createConsoleSink,
  createJsonSink,
  createLogger,
} from 'fino:log';
import { argv } from 'fino:process';

const mode = argv[2];
const sink = mode === 'console' ? createConsoleSink() : createJsonSink();
const log = createLogger({ name: `routing.${mode ?? 'json'}` });

log.info('info message');
log.error('error message');
log.fatal('fatal message');

sink.dispose();
