import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { parse as parseYaml } from 'fino:format/yaml';

type WorkflowEnvironment = Record<string, string>;
type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: WorkflowEnvironment;
  with?: Record<string, string | number>;
};
type WorkflowJob = {
  needs?: string | string[];
  permissions?: Record<string, string>;
  'runs-on'?: string;
  strategy?: {
    matrix?: {
      include?: Array<Record<string, string>>;
    };
  };
  'timeout-minutes'?: number;
  env?: WorkflowEnvironment;
  steps?: WorkflowStep[];
};
type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, Record<string, unknown>>;
    };
  };
  permissions?: Record<string, string>;
  env?: WorkflowEnvironment;
  jobs?: Record<string, WorkflowJob>;
};

const fs = new DiskFileSystem();
const decoder = new TextDecoder();

async function readWorkflow(path = '.github/workflows/ci.yml'): Promise<Workflow> {
  const source = decoder.decode(await fs.readFile(path));
  return parseYaml(source) as Workflow;
}

function jobDefinition(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) throw new Error(`CI workflow is missing the ${name} job`);
  return job;
}

describe('CI workflow', () => {
  it('runs the complete parallel suite once on Linux and once on macOS', async (t) => {
    const workflow = await readWorkflow();
    const jobs = Object.values(workflow.jobs ?? {});
    const steps = jobs.flatMap((job) => job.steps ?? []);
    const fullRuns = steps.filter(
      (step) => step.run === 'FINO_REQUIRE_SQLITE=1 ./target/debug/fino test --parallel tests',
    );
    t.equal(fullRuns.length, 2, 'Linux and macOS each run the complete parallel suite');

    const environments = [
      workflow.env,
      ...jobs.flatMap((job) => [job.env, ...(job.steps ?? []).map((step) => step.env)]),
    ];
    t.equal(
      environments.some((env) => env?.FINO_TEST_CONCURRENCY !== undefined),
      false,
      'CI retains the reactor-scaled default concurrency',
    );
  });

  it('caps every full-suite test job at 15 minutes', async (t) => {
    const workflow = await readWorkflow();

    for (const name of ['linux-tests', 'macos-tests']) {
      t.equal(jobDefinition(workflow, name)['timeout-minutes'], 15);
    }
  });

  it('reuses the Linux build for linting', async (t) => {
    const workflow = await readWorkflow();
    const lintJob = jobDefinition(workflow, 'lint');
    const linuxBuildJob = jobDefinition(workflow, 'linux-build');

    t.equal(lintJob.needs, 'linux-build', 'lint waits for the Linux build');
    t.equal(
      lintJob.steps?.some((step) => step.run?.startsWith('cargo ')),
      false,
      'lint does not invoke Cargo',
    );
    t.ok(
      lintJob.steps?.some((step) => step.name === 'Restore Linux build'),
      'lint restores the built Fino binary',
    );
    t.ok(
      linuxBuildJob.steps?.some((step) => step.run === 'cargo clippy'),
      'the Linux build runs Rust lint',
    );
  });

  it('builds downloadable HTML documentation for every CI run', async (t) => {
    const workflow = await readWorkflow();
    const docsJob = jobDefinition(workflow, 'docs');

    t.equal(docsJob.needs, 'linux-build', 'docs reuse the Linux build');
    t.ok(
      docsJob.steps?.some(
        (step) =>
          step.run ===
          './target/debug/fino doc build --format html --title "Fino Runtime" --types runtime-builtins.d.ts js',
      ),
      'docs are built as a static HTML site',
    );

    const artifact = docsJob.steps?.find((step) => step.uses === 'actions/upload-artifact@v4');
    t.equal(artifact?.with?.name, 'fino-docs', 'the artifact has a stable download name');
    t.equal(artifact?.with?.path, 'docs/', 'the static docs output is uploaded');
    t.ok(
      docsJob.steps?.some((step) => step.run?.includes('rm docs/docs.db')),
      'the server-side search database is omitted from the static artifact',
    );
  });

  it('deploys main and same-repository PR docs through Surge', async (t) => {
    const workflow = await readWorkflow();
    const docsJob = jobDefinition(workflow, 'docs');
    const production = docsJob.steps?.find((step) => step.name === 'Deploy production docs');
    const preview = docsJob.steps?.find((step) => step.name === 'Deploy PR preview');

    t.equal(production?.if, "github.event_name == 'push'", 'only main pushes deploy production');
    t.equal(production?.env?.SURGE_DOMAIN, '${{ vars.SURGE_DOMAIN }}');
    t.equal(
      preview?.if,
      "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
    );
    t.ok(
      preview?.run?.includes('pr-${{ github.event.pull_request.number }}.fino.fast'),
      'each pull request uses a stable preview domain',
    );
    t.equal(preview?.env?.SURGE_TOKEN, '${{ secrets.SURGE_TOKEN }}');
  });

  it('uses GitHub-hosted runners for every workflow', async (t) => {
    for (const path of [
      '.github/workflows/ci.yml',
      '.github/workflows/benchmarks.yml',
      '.github/workflows/dnssec-release.yml',
      '.github/workflows/release.yml',
    ]) {
      const source = decoder.decode(await fs.readFile(path));
      t.notOk(source.includes('blacksmith-'), `${path} has no Blacksmith runner labels`);
    }
  });

  it('shares the customized V8 artifact across Cargo profiles', async (t) => {
    const source = decoder.decode(await fs.readFile('.github/actions/cache-cargo-deps/action.yml'));
    const cargoConfig = decoder.decode(await fs.readFile('.cargo/config.toml'));
    const primaryKey = source.match(/key: (rusty-v8-artifact-v2-[^\n]+)/)?.[1];

    t.match(
      cargoConfig,
      /^GN_ARGS = .*\bis_debug=false\b.*\bforce = true/m,
      'debug and release Cargo profiles both force the same V8 build mode',
    );
    t.ok(primaryKey, 'the V8 cache uses the profile-independent v2 key');
    t.notOk(
      primaryKey?.includes('inputs.profile'),
      'the V8 cache key does not rebuild the same artifact for debug and release',
    );
    t.ok(
      primaryKey?.includes('inputs.variant'),
      'the shared V8 cache remains isolated by native ABI and toolchain variant',
    );
    t.ok(
      source.includes('target/debug/gn_out/obj/librusty_v8.a') &&
        source.includes('target/release/gn_out/obj/librusty_v8.a'),
      'either profile can restore the shared V8 archive',
    );
    t.ok(
      source.includes('id: v8-cache-v1') &&
        source.includes('target/${{ inputs.profile }}/gn_out/obj/librusty_v8.a') &&
        source.includes(
          'rusty-v8-artifact-v1-${{ runner.os }}-${{ runner.arch }}-${{ inputs.profile }}-',
        ),
      'migration restores v1 with its original profile-specific cache path',
    );
  });

  it('publishes three native archives from an explicit version', async (t) => {
    const workflow = await readWorkflow('.github/workflows/release.yml');
    const version = workflow.on?.workflow_dispatch?.inputs?.version;
    const build = jobDefinition(workflow, 'build');
    const publish = jobDefinition(workflow, 'publish');
    const targets = build.strategy?.matrix?.include ?? [];

    t.equal(version?.required, true, 'release version is required');
    t.equal(version?.type, 'string', 'release version is entered as text');
    t.equal(
      JSON.stringify(targets.map((target) => target.target)),
      JSON.stringify([
        'x86_64-unknown-linux-gnu',
        'aarch64-unknown-linux-gnu',
        'aarch64-apple-darwin',
      ]),
      'release builds cover the supported native targets',
    );
    t.equal(
      build.container,
      '${{ matrix.container || null }}',
      'release matrix jobs opt into an ABI baseline container per target',
    );
    t.equal(build.defaults?.run?.shell, 'bash', 'container release steps retain Bash semantics');
    for (const target of targets.filter((target) => target.os === 'linux')) {
      t.equal(target.container, 'ubuntu:22.04', `${target.target} builds on glibc 2.35`);
      t.equal(target.cacheVariant, 'glibc-2.35', `${target.target} isolates native caches by ABI`);
    }
    t.notOk(
      targets.find((target) => target.os === 'macos')?.container,
      'macOS release builds run directly on the hosted runner',
    );
    const cargoCache = build.steps?.find((step) => step.name === 'Cache Cargo and V8 build');
    t.equal(
      cargoCache?.with?.variant,
      '${{ matrix.cacheVariant }}',
      'V8 caches are isolated by the target ABI baseline',
    );
    const protocolCache = build.steps?.find(
      (step) => step.name === 'Install current Linux protocol dependencies',
    );
    t.equal(
      protocolCache?.with?.variant,
      '${{ matrix.cacheVariant }}',
      'Linux protocol caches are isolated by the target ABI baseline',
    );
    const cargoCacheSource = decoder.decode(
      await fs.readFile('.github/actions/cache-cargo-deps/action.yml'),
    );
    const protocolCacheSource = decoder.decode(
      await fs.readFile('.github/actions/install-linux-protocol-deps/action.yml'),
    );
    const primaryV8CacheKey = cargoCacheSource.match(/key: (rusty-v8-artifact-v2-[^\n]+)/)?.[1];
    t.ok(
      primaryV8CacheKey?.includes('inputs.variant'),
      'the V8 cache key incorporates its ABI variant',
    );
    t.ok(
      protocolCacheSource.includes('inputs.variant'),
      'the protocol cache key incorporates its ABI variant',
    );
    const linuxDependencies = build.steps?.find(
      (step) => step.name === 'Install Linux native dependencies',
    );
    t.notOk(
      linuxDependencies?.run?.includes('sudo'),
      'Linux setup runs as root inside the release container',
    );
    const releaseBuild = build.steps?.find((step) => step.name === 'Build release binary');
    t.ok(
      releaseBuild?.run?.includes('cargo build --release --locked'),
      'release archives use a locked optimized build',
    );
    t.ok(
      releaseBuild?.run?.includes('for attempt in 1 2 3'),
      'release builds retry transient toolchain and sysroot download failures',
    );
    const llvm = build.steps?.find((step) => step.name === 'Install native LLVM on Linux');
    t.ok(
      llvm?.run?.includes('libclang-rt-23-dev'),
      'Linux release builds install the compiler-rt builtins required by V8',
    );
    t.ok(
      llvm?.run?.split('\n').some((line) => line.trim().startsWith('llvm-23')),
      'Linux release builds install the LLVM binutils required by V8',
    );
    t.ok(
      llvm?.run?.split('\n').some((line) => line.trim().startsWith('lld-23')),
      'Linux release builds install the LLD linker required by V8',
    );
    for (const [archive, target] of [
      ['libclang_rt.builtins-x86_64.a', 'x86_64-unknown-linux-gnu'],
      ['libclang_rt.builtins-aarch64.a', 'aarch64-unknown-linux-gnu'],
    ]) {
      t.ok(
        llvm?.run?.includes(archive) && llvm.run.includes(target),
        `Linux release builds expose ${archive} under V8's ${target} resource path`,
      );
    }
    t.equal(build.env?.FINO_VERSION, '${{ needs.validate.outputs.version }}');
    t.ok(
      build.steps?.some(
        (step) => step.run?.includes('codesign') && step.run.includes('notarytool submit'),
      ),
      'the macOS release is signed and notarized before packaging',
    );
    const signing = build.steps?.find((step) => step.name === 'Sign and notarize macOS binary');
    t.ok(
      signing?.run?.includes('--entitlements .github/entitlements/fino.plist'),
      'the hardened macOS binary is signed with the Fino runtime entitlements',
    );
    t.ok(
      signing?.run?.includes('./target/release/fino --version'),
      'the macOS binary is executed after signing',
    );
    const entitlements = decoder.decode(
      await fs.readFile('.github/entitlements/fino.plist').catch(() => new Uint8Array()),
    );
    t.ok(
      entitlements.includes('<key>com.apple.security.cs.allow-jit</key>') &&
        entitlements.includes('<true/>'),
      'the macOS runtime permits V8 JIT memory',
    );
    t.equal(publish.needs, 'build', 'publishing waits for every matrix build');
    t.equal(publish.permissions?.contents, 'write', 'only the publisher can create a release');
    t.ok(
      publish.steps?.some(
        (step) => step.run?.includes('sha256sum') && step.run.includes('gh release create'),
      ),
      'publication creates checksums and the GitHub release together',
    );
  });

  it('directs README users to GitHub release downloads', async (t) => {
    const readme = decoder.decode(await fs.readFile('README.md'));
    t.ok(
      readme.includes('https://github.com/Sequins-dev/fino/releases/latest'),
      'README links the latest release page rendered by the docs site',
    );
  });

  it('ships an explicit MIT license with public releases', async (t) => {
    const license = decoder.decode(await fs.readFile('LICENSE'));
    t.ok(license.includes('MIT License'));
    t.ok(license.includes('Fino contributors'));
  });
});
