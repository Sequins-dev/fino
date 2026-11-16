"""Exercise the wrapper and composite action with Cargo's build-script layout."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class V8Layout(unittest.TestCase):
    def test_ninja(self):
        for profile, package in [('debug', 'v8-hash'), ('release', 'v8/hash')]:
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                # Exercise both the local and CI-observed OUT_DIR depths.
                build = root / 'target' / profile / 'build'
                out = build / package / 'out'
                shared = out.parent.parent.parent
                ninja = shared / 'ninja_gn_binaries/ninja/ninja'
                ninja.parent.mkdir(parents=True)
                ninja.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
                ninja.chmod(0o755)
                icu = root / 'crate/third_party/icu/common/icudtl.dat'
                icu.parent.mkdir(parents=True)
                icu.touch()
                gn = shared / 'gn_out'
                gn.mkdir()
                (gn / 'args.gn').write_text('is_debug = false\n')
                result = subprocess.run([str(ROOT / 'scripts/v8-ninja-wrapper.sh'),
                                         '-C', str(gn), 'rusty_v8'],
                                        env={**os.environ, 'OUT_DIR': str(out),
                                             'CARGO_MANIFEST_DIR': str(root / 'crate')},
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), ['-C', str(gn), 'rusty_v8'])
                if os.uname().sysname == 'Darwin':
                    self.assertIn('use_lld = false', (gn / 'args.gn').read_text())

    def test_cache_handoff(self):
        action = (ROOT / '.github/actions/cache-cargo-deps/action.yml').read_text()
        script = action.split('      run: |\n', 1)[1]
        script = '\n'.join(line[8:] for line in script.splitlines())
        for source, destination in [('debug', 'debug'), ('debug', 'release'),
                                    ('release', 'debug'), ('release/build', 'debug'),
                                    ('debug/build', 'release')]:
            with self.subTest(source=source, destination=destination), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cached = root / f'target/{source}/gn_out'
                (cached / 'obj').mkdir(parents=True)
                (cached / 'obj/librusty_v8.a').write_bytes(b'archive fixture')
                (cached / 'src_binding.rs').write_text('// binding fixture\n')
                envfile = root / 'env'
                subprocess.run(['bash', '-eu', '-c', script.replace('${{ inputs.profile }}', destination)],
                               env={**os.environ, 'GITHUB_WORKSPACE': tmp, 'GITHUB_ENV': str(envfile)}, check=True)
                self.assertTrue(envfile.exists(), 'restored archive was not recognized')
                self.assertIn(f'RUSTY_V8_ARCHIVE={cached}/obj/librusty_v8.a', envfile.read_text())
                self.assertIn(f'RUSTY_V8_SRC_BINDING_PATH={cached}/src_binding.rs', envfile.read_text())
                self.assertNotIn('RUSTY_V8_SKIP_DOWNLOAD', envfile.read_text())

    def test_incomplete_cache_keeps_source_build(self):
        action = (ROOT / '.github/actions/cache-cargo-deps/action.yml').read_text()
        script = action.split('      run: |\n', 1)[1]
        script = '\n'.join(line[8:] for line in script.splitlines())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'target/debug/build/gn_out/obj/librusty_v8.a'
            archive.parent.mkdir(parents=True)
            archive.write_bytes(b'incomplete cache')
            envfile = root / 'env'
            subprocess.run(['bash', '-eu', '-c', script.replace('${{ inputs.profile }}', 'debug')],
                           env={**os.environ, 'GITHUB_WORKSPACE': tmp, 'GITHUB_ENV': str(envfile)}, check=True)
            self.assertFalse(envfile.exists())

    def test_cache_save_restore_paths_match(self):
        action = (ROOT / '.github/actions/cache-cargo-deps/action.yml').read_text()
        paths = {line.strip() for line in action.splitlines() if line.strip().startswith('target/')}
        self.assertEqual(len(paths), 8)
        for workflow in ('ci', 'benchmarks', 'release', 'dnssec-release'):
            text = (ROOT / f'.github/workflows/{workflow}.yml').read_text()
            for block in text.split('uses: actions/cache/save@v4')[1:]:
                if 'librusty_v8.a' in block.split('key:', 1)[0]:
                    saved = {line.strip() for line in block.split('key:', 1)[0].splitlines()
                             if line.strip().startswith('target/')}
                    self.assertEqual(saved, paths, workflow)


if __name__ == '__main__':
    unittest.main()
