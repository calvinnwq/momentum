import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  'runs-on'?: string;
  steps?: WorkflowStep[];
};

type Workflow = {
  name?: string;
  on?: {
    pull_request?: unknown;
    push?: {
      branches?: string[];
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

const readWorkflow = async (): Promise<Workflow> =>
  parse(await readFile('.github/workflows/ci.yml', 'utf8')) as Workflow;

describe('CI workflow configuration', () => {
  it('runs the required local quality gate on pull requests and main pushes', async () => {
    const workflow = await readWorkflow();

    expect(workflow.name).toBe('CI');
    expect(workflow.on).toEqual({
      pull_request: {},
      push: { branches: ['main'] },
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });

    const job = workflow.jobs?.ci;
    expect(job?.['runs-on']).toBe('ubuntu-latest');

    const steps = job?.steps ?? [];
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uses: 'actions/checkout@v6' }),
        expect.objectContaining({
          name: 'Install pnpm',
          uses: 'pnpm/action-setup@v6',
        }),
        expect.objectContaining({
          name: 'Use Node.js 24',
          uses: 'actions/setup-node@v6',
          with: {
            'node-version': '24',
            cache: 'pnpm',
            'cache-dependency-path': 'pnpm-lock.yaml',
          },
        }),
        expect.objectContaining({
          name: 'Install dependencies',
          run: 'pnpm install --frozen-lockfile',
        }),
        expect.objectContaining({ name: 'Test', run: 'pnpm test' }),
        expect.objectContaining({ name: 'Typecheck', run: 'pnpm typecheck' }),
        expect.objectContaining({ name: 'Build', run: 'pnpm build' }),
      ])
    );

    expect(steps).toContainEqual(
      expect.objectContaining({
        name: 'Checkout',
        uses: 'actions/checkout@v6',
        with: { 'fetch-depth': 0 },
      })
    );
    expect(steps).toContainEqual(
      expect.objectContaining({
        name: 'Check whitespace',
        run: expect.stringContaining('git diff --check "$base_sha...HEAD"'),
      })
    );
    expect(steps).toContainEqual(
      expect.objectContaining({
        name: 'Check whitespace',
        run: expect.stringContaining('git diff-tree --check --root HEAD'),
      })
    );
    expect(steps).not.toContainEqual(
      expect.objectContaining({ name: 'Check whitespace', run: 'git diff --check' })
    );
  });
});
