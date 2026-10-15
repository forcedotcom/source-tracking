/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createRequire } from 'node:module';
import { expect } from 'chai';
import { Linter } from 'eslint';

const require = createRequire(import.meta.url);
type LintMessage = Linter.LintMessage;

const linter = new Linter();
const config: Linter.Config = {
  files: ['**/*.ts'],
  languageOptions: {
    parser: require('@typescript-eslint/parser'),
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
  plugins: {
    'local-rules': {
      rules: {
        'no-explicit-effect-return-type': require('../../eslint-local-rules/noExplicitEffectReturnType.cjs'),
      },
    },
  },
  rules: { 'local-rules/no-explicit-effect-return-type': 'error' },
};

const lint = (code: string): LintMessage[] => linter.verify(code, config, 'effect-return-type.ts');

describe('no-explicit-effect-return-type', () => {
  it('flags Effect.fn.Return annotations and removes them in the autofix', () => {
    const code = 'const read = (id: string): Effect.fn.Return<string> => id;';

    expect(lint(code)).to.have.length(1);
    expect(linter.verifyAndFix(code, config, 'effect-return-type.ts').output).to.equal(
      'const read = (id: string) => id;'
    );
  });

  it('continues to flag Effect.Effect annotations', () => {
    expect(lint('const read = (id: string): Effect.Effect<string> => Effect.succeed(id);')).to.have.length(1);
  });

  it('does not flag unrelated return types', () => {
    expect(lint('const read = (id: string): Promise<string> => Promise.resolve(id);')).to.have.length(0);
  });
});
