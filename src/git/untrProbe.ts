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
import * as Option from 'effect/Option';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';

/**
 * UNTR cache requires the filesystem to advance `mtime_nsec`, `ctime`, and
 * `ino` when a directory mutates. Lite probes once per gitdir on first
 * switchTo; on failure, persists `untr.disabled = true` in `.git/config`
 * and skips the extension forever for that fs.
 *
 * Probe sequence: mkdir tmpdir → stat → touch child → stat. Verify
 * `mtime_nsec` and `ctime` advance, and the child's `ino` is non-zero
 * (memfs and some web fs polyfills return 0 for ino).
 */
export const probeUntr = Effect.fn('probeUntr')(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const probeDir = path.join(gitdir, '.untr-probe');

  // Best-effort: create + stat + write child + stat. Any error from the
  // probe is swallowed and treated as "failed" — we never fail the
  // outer effect for a probe issue.
  const tryProbe = Effect.gen(function* () {
    yield* fs.makeDirectory(probeDir, { recursive: true });
    const before = yield* fs.stat(probeDir);
    // Wait a tick so mtime_nsec actually advances on filesystems where
    // we'd otherwise observe identical readings.
    yield* Effect.sleep('5 millis');
    const child = path.join(probeDir, 'p');
    yield* fs.writeFileString(child, 'p');
    const after = yield* fs.stat(probeDir);
    const childStat = yield* fs.stat(child);
    const mtA = Option.getOrElse(before.mtime, () => new Date(0)).getTime();
    const mtB = Option.getOrElse(after.mtime, () => new Date(0)).getTime();
    const ctA = Option.getOrElse(before.birthtime, () => new Date(0)).getTime();
    const ctB = Option.getOrElse(after.birthtime, () => new Date(0)).getTime();
    // Three invariants in order of severity. Some platforms tie ctime to
    // creation only; treat ctime that never advances and starts at 0 as
    // ctime_static (the conservative answer).
    return Option.isNone(childStat.ino) || Number(childStat.ino.value) === 0
      ? ({ kind: 'failed', reason: 'unstable_ino' } as const)
      : mtA === mtB
      ? ({ kind: 'failed', reason: 'coarse_mtime' } as const)
      : ctA === ctB && ctA === 0
      ? ({ kind: 'failed', reason: 'ctime_static' } as const)
      : ({ kind: 'ok' } as const);
  }).pipe(Effect.scoped);

  const result = yield* tryProbe.pipe(
    Effect.catchAll(() => Effect.succeed({ kind: 'failed' as const, reason: 'unstable_ino' as const }))
  );

  // Cleanup probe dir; ignore failures.
  yield* fs.remove(probeDir, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
  return result;
});
