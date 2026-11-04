import { createRequire } from 'node:module';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const consumers = [
  'eslint',
  '@eslint/config-array',
  '@eslint/eslintrc',
  'eslint-plugin-react',
  'eslint-plugin-import',
  'eslint-plugin-jsx-a11y',
];

type LegacyMatcher = {
  (path: string, pattern: string): boolean;
  Minimatch: new (pattern: string) => { match(path: string): boolean };
  makeRe(pattern: string): { test(path: string): boolean };
  defaults(options: { dot: boolean }): LegacyMatcher;
};

function lint(source: string, rules: NonNullable<ESLint.ConfigData['rules']>) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.jsx'],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: {
        react: require('eslint-plugin-react') as ESLint.Plugin,
        import: require('eslint-plugin-import') as ESLint.Plugin,
        'jsx-a11y': require('eslint-plugin-jsx-a11y') as ESLint.Plugin,
      },
      rules,
    },
  });
  return eslint.lintText(source, { filePath: 'compat-fixture.jsx' });
}

describe('patched minimatch compatibility for legacy lint consumers', () => {
  it.each(consumers)(
    'resolves %s to the callable adapter and patched upstream',
    (consumer) => {
      const consumerRequire = createRequire(require.resolve(consumer));
      const legacy = consumerRequire('minimatch') as LegacyMatcher;
      const adapterRequire = createRequire(
        consumerRequire.resolve('minimatch'),
      );
      expect(consumerRequire('minimatch/package.json')).toMatchObject({
        name: '@crowdreply/minimatch-compat',
        version: '1.0.0',
      });
      expect(adapterRequire('minimatch/package.json')).toMatchObject({
        name: 'minimatch',
        version: '11.0.4',
      });
      expect(legacy('components/button.tsx', '**/*.tsx')).toBe(true);
      expect(legacy('components/button.ts', '**/*.tsx')).toBe(false);
      expect(
        new legacy.Minimatch('**/*.tsx').match('components/button.tsx'),
      ).toBe(true);
      expect(legacy.defaults({ dot: true })('.hidden.ts', '*.ts')).toBe(true);
      expect(legacy.makeRe('private/**').test('private/internal')).toBe(true);
      expect(legacy.makeRe('private/**').test('public/internal')).toBe(false);
    },
  );

  it('preserves React glob exceptions without disabling invalid component reports', async () => {
    const [result] = await lint(
      '<><IGNORED_COMPONENT /><FORBIDDEN_COMPONENT /></>',
      {
        'react/jsx-pascal-case': ['error', { ignore: ['IGNORED_*'] }],
      },
    );
    expect(result?.messages).toMatchObject([
      { ruleId: 'react/jsx-pascal-case', messageId: 'usePascalCase' },
    ]);
    expect(result?.messages[0]?.message).toContain('FORBIDDEN_COMPONENT');
  });

  it('preserves import restrictions that use the removed makeRe interface', async () => {
    const [result] = await lint(
      'import "./private/internal"; import "./public/internal";',
      {
        'import/no-internal-modules': ['error', { forbid: ['private/**'] }],
      },
    );
    expect(result?.messages).toMatchObject([
      {
        ruleId: 'import/no-internal-modules',
        message: 'Reaching to "./private/internal" is not allowed.',
      },
    ]);
  });

  it('preserves accessibility component globs and rejects missing controls or text', async () => {
    const [result] = await lint(
      '<><label>Label<InputText /></label><label>Label<Other /></label><label><InputText /></label></>',
      {
        'jsx-a11y/label-has-associated-control': [
          'error',
          { controlComponents: ['Input*'], assert: 'nesting' },
        ],
      },
    );
    expect(result?.messages).toMatchObject([
      {
        ruleId: 'jsx-a11y/label-has-associated-control',
        message: 'A form label must be associated with a control.',
      },
      {
        ruleId: 'jsx-a11y/label-has-associated-control',
        message: 'A form label must have accessible text.',
      },
    ]);
  });
});
