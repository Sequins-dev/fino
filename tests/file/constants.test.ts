import { describe, it } from 'fino:test/test';
import * as bindings from 'internal:file/bindings';
import * as constants from 'internal:file/constants';

describe('internal:file/constants', () => {
  it('provides the same file flags as the host bindings', (t) => {
    for (const [name, value] of Object.entries(constants)) {
      t.equal(bindings[name as keyof typeof bindings], value, `${name} is re-exported unchanged`);
    }
  });
});
