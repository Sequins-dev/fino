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
  'timeout-minutes'?: number;
  env?: WorkflowEnvironment;
  steps?: WorkflowStep[];
};
type Workflow = {
  env?: WorkflowEnvironment;
  jobs?: Record<string, WorkflowJob>;
};

const fs = new DiskFileSystem();
const decoder = new TextDecoder();

async function readWorkflow(): Promise<Workflow> {
  const source = decoder.decode(await fs.readFile('.github/workflows/ci.yml'));
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
});
