/**
 * Regression coverage for reactor workloads that remain runnable after a
 * bounded scheduler slice.
 */
import { describe, it } from 'fino:test/test';

describe('reactor scheduler batches', () => {
  for (let index = 0; index < 70; index++) {
    it(`continues synchronous work after batch turn ${index + 1}`, (t) => {
      t.ok(true, 'the active workload remained runnable');
    });
  }
});
