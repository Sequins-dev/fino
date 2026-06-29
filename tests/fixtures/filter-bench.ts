import { bench } from 'fino:bench';

bench('alpha bench', (b) => {
  b.measure('alpha measure', () => {
    let n = 0;
    n++;
  });
});

bench('beta bench', (b) => {
  b.group('needle group', (g) => {
    g.measure('beta nested', () => {
      let n = 0;
      n++;
    });
  });

  b.group('other group', (g) => {
    g.measure('other nested', () => {
      let n = 0;
      n++;
    });
  });
});
