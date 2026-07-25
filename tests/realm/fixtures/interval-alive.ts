// Entry settles immediately; a referenced interval keeps the realm alive
// until it self-clears after three ticks. The realm port stays receivable
// (and sendable) for the whole handle-alive window.
import { port } from 'fino:realm/self';

let ticks = 0;
const timer = setInterval(() => {
  ticks++;
  port?.postMessage({ tick: ticks });
  if (ticks >= 3) clearInterval(timer);
}, 10);
