import { expect, test } from 'vitest';
import { ESLint } from 'eslint';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

test('the actual ESLint glob/config detects unsafe TypeScript in a temporary fixture', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'tests', '.lint-fixture-'));
  try {
    await writeFile(
      join(directory, 'fixture.ts'),
      'export function unsafe(value: any) { return value; }\n'
    );
    const results = await new ESLint().lintFiles(`${relative(process.cwd(), directory)}/**/*.ts`);
    const rules = results.flatMap((result) => result.messages.map((message) => message.ruleId));
    expect(rules).toContain('@typescript-eslint/no-explicit-any');
    expect(rules).toContain('@typescript-eslint/explicit-function-return-type');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
