import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve('.');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('team sharing safeguards', () => {
  it('keeps required sensitive and generated paths out of Git', () => {
    const rules = read('.gitignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const required = [
      'node_modules/',
      'dist/',
      'coverage/',
      '.env',
      '.env.*',
      '!.env.example',
      'server/data/',
      '*.wav',
      '*.mp3',
      '*.m4a',
      '*.webm',
      '*.flac',
      '*.log',
      'logs/',
      '*-backup-*/',
      'backup/',
      'backups/',
      '.DS_Store',
      'Thumbs.db',
      '.vscode/',
      '.idea/',
    ];
    expect(rules).toEqual(expect.arrayContaining(required));
  });

  it('uses safe disabled defaults in the shared environment example', () => {
    const env = read('.env.example');
    expect(env).toContain('STT_EXTERNAL_ENABLED=false');
    expect(env).toContain('LLM_CORRECTION_ENABLED=false');
    expect(env).toContain('LLM_CORRECTION_PROVIDER=mock');
    expect(env).toContain('LOCAL_STT_DEBUG_AUDIO=false');
    expect(env).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(env).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(env).not.toMatch(/[A-Z]:[\\/]Users[\\/][^\\/\s]+/i);
  });

  it('provides every required team document and README link target', () => {
    const documents = [
      'docs/SETUP_WINDOWS.md',
      'docs/DEVELOPMENT.md',
      'docs/ARCHITECTURE.md',
      'docs/PRIVACY.md',
      'docs/TEAM_WORKFLOW.md',
      'docs/DEPLOYMENT_OPTIONS.md',
      'docs/CURRENT_LIMITATIONS.md',
      'docs/GITHUB_PRIVATE_REPOSITORY_SETUP.md',
      'docs/MANUAL_UI_SMOKE_TEST.md',
    ];
    for (const document of documents) expect(existsSync(resolve(root, document))).toBe(true);

    const readme = read('README.md');
    const localLinks = [...readme.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]+)?\)/g)].map((match) => match[1]!);
    expect(localLinks.length).toBeGreaterThan(0);
    for (const link of localLinks) expect(existsSync(resolve(root, link))).toBe(true);
  });

  it('keeps the verification scripts read-only', () => {
    const scripts = ['scripts/verify-dev-environment.ps1', 'scripts/check-share-readiness.ps1'];
    const mutatingCmdlets = /\b(Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Out-File|Start-Process|Stop-Process)\b/i;
    for (const script of scripts) {
      expect(existsSync(resolve(root, script))).toBe(true);
      expect(read(script)).not.toMatch(mutatingCmdlets);
    }
  });

  it('defines a CI job that uses only locked local test paths', () => {
    const workflow = read('.github/workflows/ci.yml');
    for (const command of ['pnpm install --frozen-lockfile', 'pnpm run typecheck', 'pnpm run lint', 'pnpm test', 'pnpm run build']) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain("STT_EXTERNAL_ENABLED: 'false'");
    expect(workflow).toContain("LOCAL_STT_ENABLED: 'false'");
    expect(workflow).toContain("RUN_EXTERNAL_STT_TESTS: 'false'");
    expect(workflow).toContain("RUN_LOCAL_STT_TESTS: 'false'");
    expect(workflow).not.toContain('smoke:local:realtime');
    expect(workflow).not.toContain('OPENAI_API_KEY');
  });

  it('does not add a license without an ownership decision', () => {
    expect(existsSync(resolve(root, 'LICENSE'))).toBe(false);
    expect(read('README.md')).toContain('LICENSEを選択していません');
  });
});
