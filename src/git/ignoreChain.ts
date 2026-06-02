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
 * `chainIgnores(chain, p)` returns true if any link declares `p` ignored.
 * Each link consults its matcher with `p` rewritten relative to that
 * link's anchor. Matchers anchored at unrelated subtrees are skipped.
 */
export type IgnoreChainLink = { readonly anchor: string; readonly matcher: Ignore };
export type IgnoreChain = readonly IgnoreChainLink[];

/** Empty matcher used as the placeholder for `''` anchor when info/exclude is absent. */
const EMPTY: Ignore = ignore();

/**
 * Given a chain and a posix workdir-relative path, return whether any link
 * in the chain considers it ignored. Invariant: links are ordered by
 * increasing anchor depth, but `chainIgnores` does not rely on order — it
 * tests every applicable link.
 */
export const chainIgnores = (chain: IgnoreChain, p: string): boolean =>
  chain.some(({ anchor, matcher }) =>
    anchor === '' ? matcher.ignores(p) : p.startsWith(`${anchor}/`) && matcher.ignores(p.slice(anchor.length + 1))
  );

/** Build a chain link from `.gitignore` content. */
export const buildLink = (anchor: string, content: string): IgnoreChainLink => ({
  anchor,
  matcher: ignore().add(content),
});

/** A chain containing only the empty `''`-anchored matcher. Used as a base. */
export const emptyChain = (): IgnoreChain => [{ anchor: '', matcher: EMPTY }];
