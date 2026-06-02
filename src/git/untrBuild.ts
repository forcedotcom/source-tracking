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
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import { dirOf, infoExcludeMtime, readInfoExclude, walkAllRoots } from './dirWalk';
import { chainIgnores } from './ignoreChain';
import { type IndexEntry } from './indexV2';
import { type SwitchCfg } from './schemas';
import { type UntrCache, type UntrEntry } from './untrCache';

/**
 * Build the UNTR cache from a fresh workdir scan. `cfg` is the active
 * SwitchCfg (workdir, gitdir, roots, fdPermits). `trackedNamesByDir`
 * maps a dir to the tracked basenames physically present in the workdir
 * at the time of `applyChanges`; the warm path uses these `trackedNames`
 * to reconstruct workdir-presence without a re-walk.
 *
 * The walk yields one node per directory under any root. We partition
 * each node's file names into tracked vs untracked using
 * `trackedNamesByDir`, then resolve each untracked file's
 * `added | ignored` against the node's effective ignore chain.
 */
export const buildUntrCache = Effect.fn('buildUntrCache')(function* (
  cfg: SwitchCfg,
  trackedNamesByDir: ReadonlyMap<string, ReadonlySet<string>>
) {
  const excludeMtimeMs = yield* infoExcludeMtime(cfg.gitdir);
  const excludeContent = yield* readInfoExclude(cfg.gitdir);
  const walk = yield* walkAllRoots(cfg, excludeContent);

  const entries = HashMap.fromIterable(
    walk.nodes.map(({ snapshot, chain }): readonly [string, UntrEntry] => {
      const trackedSet = trackedNamesByDir.get(snapshot.dir) ?? new Set<string>();
      const trackedHere: string[] = [];
      const untrackedResolved: Array<{ name: string; status: 'added' | 'ignored' }> = [];
      // eslint-disable-next-line functional/no-loop-statements
      for (const name of snapshot.fileNames) {
        if (trackedSet.has(name)) {
          trackedHere.push(name);
        } else {
          const rel = snapshot.dir === '' ? name : `${snapshot.dir}/${name}`;
          untrackedResolved.push({ name, status: chainIgnores(chain, rel) ? 'ignored' : 'added' });
        }
      }
      const entry: UntrEntry = {
        fingerprint: {
          mtimeMs: snapshot.dirMtimeMs,
          size: snapshot.totalEntryCount,
          gitignoreMtimeMs: snapshot.gitignoreMtimeMs,
        },
        untracked: untrackedResolved,
        trackedNames: trackedHere,
      };
      return [snapshot.dir, entry] as const;
    })
  );

  const cache: UntrCache = { schemaVersion: 1, excludeMtimeMs, entries };
  return cache;
});

/**
 * Group tracked-index entries by the workdir directory they live in.
 * Used to feed `buildUntrCache`'s `trackedNamesByDir` input, and also
 * forms the basis of the warm path's tracked-presence reconstruction.
 *
 * Multiple entries with same dir collapse into a single Set of basenames.
 */
export const trackedByDir = (entries: readonly IndexEntry[]): ReadonlyMap<string, ReadonlySet<string>> => {
  const out = new Map<string, Set<string>>();
  // eslint-disable-next-line functional/no-loop-statements
  for (const e of entries) {
    const d = dirOf(e.path);
    const base = e.path.slice(d === '' ? 0 : d.length + 1);
    const set = out.get(d) ?? new Set<string>();
    set.add(base);
    out.set(d, set);
  }
  return out;
};
