import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

describe('release-please configuration', () => {
  it('keeps the manifest version in sync with package.json', async () => {
    const packageJson = await readJson<{ name: string; version: string }>('package.json');
    const manifest = await readJson<Record<string, string>>('.release-please-manifest.json');

    expect(manifest).toEqual({ '.': packageJson.version });
  });

  it('configures the root package release metadata', async () => {
    const packageJson = await readJson<{ name: string }>('package.json');
    const config = await readJson<{
      'bootstrap-sha': string;
      packages: Record<
        string,
        {
          'release-type': string;
          'package-name': string;
          'include-component-in-tag': boolean;
          'changelog-path': string;
        }
      >;
    }>('release-please-config.json');

    expect(config['bootstrap-sha']).toMatch(/^[0-9a-f]{40}$/);
    expect(config.packages['.']).toEqual({
      'release-type': 'node',
      'package-name': packageJson.name,
      'include-component-in-tag': false,
      'changelog-path': 'CHANGELOG.md',
    });
  });

  it('runs release-please on main with explicit write permissions and the current action major', async () => {
    const workflow = await readFile('.github/workflows/release-please.yml', 'utf8');

    expect(workflow).toContain('name: Release Please');
    expect(workflow).toMatch(/push:\n\s+branches:\n\s+- main/);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toMatch(/permissions:\n\s+contents: write\n\s+issues: write\n\s+pull-requests: write/);
    expect(workflow).toContain('uses: googleapis/release-please-action@v5');
    expect(workflow).toContain('config-file: release-please-config.json');
    expect(workflow).toContain('manifest-file: .release-please-manifest.json');
  });
});
