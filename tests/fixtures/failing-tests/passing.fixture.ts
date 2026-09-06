// A file that does pass, used to check a broken sibling does not silence it.
import { describe, it } from 'fino:test/test';
describe('sibling', () => {
  it('passes', (t) => t.ok(true, 'this file is fine'));
});
