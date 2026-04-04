import { describe, it } from 'fino:test/test';

describe('alpha outer', () => {
  it('runs alpha root test', (t) => {
    t.ok(true, 'alpha root');
  });

  describe('match leaf', () => {
    it('runs nested alpha match', (t) => {
      t.ok(true, 'alpha nested');
    });
  });
});

describe('beta outer', () => {
  it('runs beta root test', (t) => {
    t.ok(true, 'beta root');
  });

  describe('needle child', () => {
    it('runs filtered beta child test', (t) => {
      t.ok(true, 'beta nested');
    });
  });
});
