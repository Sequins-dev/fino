import { DiskFileSystem } from 'fino:file';
import { getRealmData } from 'internal:realm-bridge';

const readyPath = JSON.parse((getRealmData as () => string)()) as string;
await new DiskFileSystem().writeFile(readyPath, new Uint8Array());
// A finite busy loop makes parent-channel EOF unable to mask a missing force
// termination while still letting a broken regression recover on its own.
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {}
