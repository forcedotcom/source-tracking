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
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { isUndefined } from 'effect/Predicate';

/**
 * Real git evaluates a `.gitignore` at every depth of the tree, with rules
 * anchored at the directory containing the file. Lite's prior cold path
 * only evaluated `.git/info/exclude` once at the root; the warm-status
 * work brings parity.
 *
 * A chain is an ordered list of `(anchor, matcher)` pairs. The first link
 * is anchored at `''` and corresponds to `.git/info/exclude`. Subsequent
 * links are anchored at posix dir paths relative to the workdir; a link
 * at anchor `src/foo` was built from `src/foo/.gitignore` and applies
 * only to paths under `src/foo/`.
 *
 * `chainIgnores(chain, p)` applies the last matching rule across the chain.
 * Each link consults its matcher with `p` rewritten relative to that link's
 * anchor. Matchers anchored at unrelated subtrees are skipped. An ignored
 * parent directory cannot be re-included by a rule for a descendant file.
 */
export type IgnoreChainLink = { readonly anchor: string; readonly matcher: Ignore };
export type IgnoreChain = readonly IgnoreChainLink[];

/** Empty matcher used as the placeholder for `''` anchor when info/exclude is absent. */
const EMPTY: Ignore = ignore();

const relativePathAtAnchor = (anchor: string, path: string): string | undefined => {
  if (anchor === '') return path;
  const prefix = `${anchor}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
};

/**
 * Given a chain and a posix workdir-relative path, return whether any link
 * in the chain considers it ignored. Invariant: links are ordered by
 * increasing anchor depth, so the last applicable matching rule wins.
 */
const ignoredByChain = (chain: IgnoreChain, path: string): boolean => {
  const lastMatchingLink = chain.findLast(({ anchor, matcher }) => {
    const relativePath = relativePathAtAnchor(anchor, path);
    if (isUndefined(relativePath) || relativePath.length === 0) return false;
    const result = matcher.test(relativePath);
    return result.ignored || result.unignored;
  });
  if (isUndefined(lastMatchingLink)) return false;
  const relativePath = relativePathAtAnchor(lastMatchingLink.anchor, path);
  if (isUndefined(relativePath) || relativePath.length === 0) return false;
  return lastMatchingLink.matcher.test(relativePath).ignored;
};

export const chainIgnores = (chain: IgnoreChain, path: string): boolean => {
  const parts = path.split('/');
  const parentDirectories = Array.from(
    { length: Math.max(0, parts.length - 1) },
    (_, index) => `${parts.slice(0, index + 1).join('/')}/`
  );
  return parentDirectories.some((parent) => ignoredByChain(chain, parent)) || ignoredByChain(chain, path);
};

/** Build a chain link from `.gitignore` content. */
export const buildLink = (anchor: string, content: string): IgnoreChainLink => ({
  anchor,
  matcher: ignore().add(content),
});

/** A chain containing only the empty `''`-anchored matcher. Used as a base. */
export const emptyChain = (): IgnoreChain => [{ anchor: '', matcher: EMPTY }];
