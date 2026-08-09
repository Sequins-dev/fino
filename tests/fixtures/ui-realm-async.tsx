/** @jsxImportSource fino:ui */
import { createSignal } from 'fino:ui';

const loaded = createSignal('pending');

void Promise.resolve().then(() => {
  loaded.set('resolved');
});

export default function Page() {
  return <main id="page">{loaded.get()}</main>;
}
