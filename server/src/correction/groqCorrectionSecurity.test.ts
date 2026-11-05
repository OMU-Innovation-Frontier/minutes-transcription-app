// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Groq correction security boundaries', () => {
  it('keeps the credential variable and Groq endpoint out of browser source', async () => {
    const browserSource = await readTree('src');
    expect(browserSource).not.toContain('GROQ_CORRECTION_API_KEY');
    expect(browserSource).not.toContain('VITE_GROQ_CORRECTION_API_KEY');
    expect(browserSource).not.toContain('api.groq.com');
  });

  it('uses an empty server-only placeholder and never defines a VITE credential', async () => {
    const example = await readFile('.env.example', 'utf8');
    expect(example).toMatch(/^GROQ_CORRECTION_API_KEY=$/mu);
    expect(example).not.toContain('VITE_GROQ_CORRECTION_API_KEY');
  });

  it('keeps the external client free of body logging, URL credentials, and multipart credentials', async () => {
    const source = await readFile('server/src/correction/groqCorrectionClient.ts', 'utf8');
    expect(source).not.toContain('console.');
    expect(source).not.toContain('URLSearchParams');
    expect(source).not.toContain('FormData');
    expect(source.match(/https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions/gu)).toHaveLength(1);
  });
});

async function readTree(root: string): Promise<string> {
  const values: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(await readTree(path));
    else if (/\.(?:ts|html|css)$/u.test(entry.name)) values.push(await readFile(path, 'utf8'));
  }
  return values.join('\n');
}
