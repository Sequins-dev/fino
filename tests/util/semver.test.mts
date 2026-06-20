import { describe, it } from 'fino:test/test';
import * as semver from 'fino:semver';
import { compare, maxSatisfying, parse, satisfies, valid, validRange } from 'fino:semver';

describe('fino:semver parse', () => {
  it('parses core, prerelease, and build metadata', (t) => {
    const version = parse('1.2.3-alpha.1+build.5');

    t.equal(version.major, 1, 'major parsed');
    t.equal(version.minor, 2, 'minor parsed');
    t.equal(version.patch, 3, 'patch parsed');
    t.deepEqual(version.prerelease, ['alpha', 1], 'prerelease identifiers parsed');
    t.deepEqual(version.build, ['build', '5'], 'build identifiers parsed');
    t.equal(version.version, '1.2.3-alpha.1+build.5', 'normalized version preserved');
  });

  it('rejects invalid versions', (t) => {
    t.throws(() => parse('1.2'), /Invalid semver version/, 'missing patch rejected');
    t.throws(() => parse('01.2.3'), /Invalid semver version/, 'leading zero rejected');
    t.throws(() => parse('1.2.3-01'), /Invalid semver version/, 'numeric prerelease leading zero rejected');
    t.throws(() => parse('1.2.3-alpha..1'), /Invalid semver version/, 'empty prerelease identifier rejected');
  });
});

describe('fino:semver compare', () => {
  it('ignores build metadata and orders prereleases below stable versions', (t) => {
    t.equal(compare('1.2.3+build.1', '1.2.3+build.9'), 0, 'build metadata does not affect precedence');
    t.ok(compare('1.2.3-alpha.1', '1.2.3') < 0, 'prerelease sorts below stable');
    t.ok(compare('1.2.3-alpha.1', '1.2.3-alpha.2') < 0, 'numeric prerelease identifiers compare numerically');
    t.ok(compare('1.2.3-beta', '1.2.3-alpha.9') > 0, 'later prerelease identifiers compare lexically');
  });

  it('matches the SemVer 2.0.0 prerelease precedence example', (t) => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];

    for (let i = 1; i < ordered.length; i++) {
      t.ok(compare(ordered[i - 1]!, ordered[i]!) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
    }
  });
});

describe('fino:semver satisfies', () => {
  it('supports exact, wildcard, x-range, caret, tilde, comparator, and or ranges', (t) => {
    t.equal(satisfies('1.2.3', '1.2.3'), true, 'exact version matches');
    t.equal(satisfies('1.2.3', '*'), true, 'wildcard matches');
    t.equal(satisfies('1.9.9', '1.x'), true, 'x-range matches');
    t.equal(satisfies('1.2.5', '~1.2.3'), true, 'tilde range matches');
    t.equal(satisfies('1.4.0', '^1.2.3'), true, 'caret range matches');
    t.equal(satisfies('1.5.0', '>=1.2.3 <2.0.0'), true, 'comparator set matches');
    t.equal(satisfies('2.3.0', '^1.2.3 || ^2.1.0'), true, 'or range matches');
    t.equal(satisfies('1.2.3', '1.2.0 - 1.2.5'), true, 'hyphen range matches');
    t.equal(satisfies('0.2.5', '^0.2.3'), true, 'caret range respects zero-major semantics');
    t.equal(satisfies('0.3.0', '^0.2.3'), false, 'caret range excludes next zero-major minor');
    t.equal(satisfies('0.9.0', '<1.x'), true, 'partial less-than range matches below major floor');
    t.equal(satisfies('1.2.3', '<1.x'), false, 'partial less-than range excludes the target x-range');
    t.equal(satisfies('1.2.3', '>1.x'), false, 'partial greater-than range excludes values inside the target x-range');
    t.equal(satisfies('2.0.0', '>1.x'), true, 'partial greater-than range matches above the target x-range');
  });

  it('supports partial caret and tilde ranges with npm-compatible bounds', (t) => {
    t.equal(satisfies('1.9.9', '^1'), true, '^1 includes same major');
    t.equal(satisfies('2.0.0', '^1'), false, '^1 excludes next major');
    t.equal(satisfies('1.2.9', '^1.2'), true, '^1.2 includes same major after minor floor');
    t.equal(satisfies('2.0.0', '^1.2'), false, '^1.2 excludes next major');
    t.equal(satisfies('0.2.9', '^0.2'), true, '^0.2 includes same zero-major minor');
    t.equal(satisfies('0.3.0', '^0.2'), false, '^0.2 excludes next zero-major minor');
    t.equal(satisfies('1.2.9', '~1.2'), true, '~1.2 includes patch updates');
    t.equal(satisfies('1.3.0', '~1.2'), false, '~1.2 excludes next minor');
  });

  it('trims range whitespace and preserves prerelease admission rules', (t) => {
    t.equal(satisfies('1.2.3', '  >=1.0.0   <2.0.0  '), true, 'outer and inner whitespace is accepted');
    t.equal(satisfies('1.2.3-alpha.2', '  >=1.2.3-alpha.1   <1.2.3  '), true, 'prerelease comparator admits matching prerelease base');
    t.equal(satisfies('1.2.4-alpha.1', '>=1.2.3-alpha.1 <2.0.0'), false, 'different prerelease base remains excluded');
  });

  it('applies npm-style prerelease exclusion for stable ranges', (t) => {
    t.equal(satisfies('1.2.3-alpha.1', '^1.2.3'), false, 'stable caret range excludes prereleases');
    t.equal(satisfies('1.2.3-alpha.2', '>=1.2.3-alpha.1 <1.2.3'), true, 'prerelease comparator range admits prereleases');
  });

  it('rejects malformed disjunctions', (t) => {
    t.throws(() => satisfies('1.2.3', '^1.0.0 ||'), /Invalid semver range/, 'dangling || rejected');
    t.throws(() => satisfies('1.2.3', '|| ^1.0.0'), /Invalid semver range/, 'leading || rejected');
  });
});

describe('fino:semver valid helpers', () => {
  it('valid returns normalized versions or null', (t) => {
    t.equal(valid('  1.2.3-beta.01  '), null, 'invalid prerelease leading zero returns null');
    t.equal(valid('  1.2.3-beta.1+build.5  '), '1.2.3-beta.1+build.5', 'valid version is trimmed and normalized');
    t.equal(valid('1.2'), null, 'invalid version returns null');
  });

  it('validRange returns trimmed ranges or null', (t) => {
    t.equal(validRange('  ^1.2.3  '), '^1.2.3', 'valid range is trimmed');
    t.equal(validRange(''), '*', 'empty range normalizes to wildcard');
    t.equal(validRange(null), '*', 'null range normalizes to wildcard');
    t.equal(validRange('^1.0.0 ||'), null, 'invalid range returns null');
  });
});

describe('fino:semver — OR range branch coverage', () => {
  it('version matching only the SECOND OR branch is satisfied', (t) => {
    t.equal(satisfies('2.5.0', '^1.0.0 || ^2.1.0'), true,
      '2.5.0 satisfies second branch ^2.1.0');
    t.equal(satisfies('0.9.0', '^1.0.0 || ^2.1.0'), false,
      '0.9.0 satisfies neither branch');
    t.equal(satisfies('1.0.0', '^1.0.0 || ^2.1.0'), true,
      '1.0.0 satisfies first branch ^1.0.0');
  });
});

describe('fino:semver — prerelease identifier ordering (numeric vs string)', () => {
  it('numeric prerelease identifiers sort before string identifiers', (t) => {
    // semver spec §11.4.1: numeric identifiers always have lower precedence
    // than alphanumeric identifiers.
    t.ok(compare('1.0.0-1', '1.0.0-alpha') < 0,
      'numeric prerelease 1 sorts before alpha');
    t.ok(compare('1.0.0-9', '1.0.0-rc.1') < 0,
      'numeric prerelease 9 sorts before rc.1');
    t.ok(compare('1.0.0-alpha', '1.0.0-beta') < 0,
      'alpha sorts before beta lexically');
    t.ok(compare('1.0.0-rc.2', '1.0.0-rc.10') < 0,
      'numeric sub-identifiers compare numerically (2 < 10)');
  });

  it('longer prerelease has higher precedence when shared prefix is equal', (t) => {
    // semver spec §11.4.4: larger set of prerelease fields has higher precedence
    t.ok(compare('1.0.0-alpha.1', '1.0.0-alpha') > 0,
      'alpha.1 has higher precedence than alpha');
  });
});

describe('fino:semver maxSatisfying', () => {
  it('returns the highest matching stable version and skips prereleases unless admitted', (t) => {
    const versions = [
      '1.2.3-alpha.1',
      '1.2.3',
      '1.4.0',
      '1.5.0-beta.1',
      '2.0.0',
    ];

    t.equal(maxSatisfying(versions, '^1.2.3'), '1.4.0', 'highest stable match selected');
    t.equal(maxSatisfying(versions, '>=1.2.3-alpha.1 <1.2.3'), '1.2.3-alpha.1', 'prerelease match selected when range admits it');
    t.equal(maxSatisfying(versions, '^3.0.0'), null, 'null returned when nothing matches');
  });
});

describe('fino:semver release contract', () => {
  it('uses strict SemVer parsing without loose mode or coercion', (t) => {
    t.equal(valid('1.2.3'), '1.2.3', 'strict SemVer is accepted');
    t.equal(valid('v1.2.3'), null, 'v-prefix loose parsing is not accepted');
    t.equal(valid('=1.2.3'), null, 'comparator-looking versions are not accepted');
    t.equal(valid('1.2'), null, 'partial versions are not coerced');
    t.equal(valid('version 1.2.3'), null, 'embedded versions are not coerced');
    t.throws(() => parse('1.2'), /Invalid semver version/, 'parse rejects partial versions');
  });

  it('does not expose npm semver helper APIs outside the release surface', (t) => {
    for (const name of ['inc', 'diff', 'minVersion', 'intersects', 'subset', 'sort', 'rsort']) {
      t.equal(Object.prototype.hasOwnProperty.call(semver, name), false, `${name} is not exported`);
    }
  });

  it('does not support the npm includePrerelease option', (t) => {
    t.equal(satisfies('1.2.3-alpha.1', '^1.2.3'), false, 'stable ranges exclude prereleases');
    t.equal(
      (satisfies as any)('1.2.3-alpha.1', '^1.2.3', { includePrerelease: true }),
      false,
      'third-argument includePrerelease option is not part of this API',
    );
  });
});
