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
import * as path from 'node:path';
import * as os from 'node:os';
import * as HashSet from 'effect/HashSet';
import type { LocalChanges } from './types.js';
export const IS_WINDOWS = os.type() === 'Windows_NT';

export const ensurePosix = (filepath: string): string => filepath.split(path.sep).join(path.posix.sep);

/**
 * Check for matching added/deleted filenames by basename.
 * Used by move detection to find potential moved files.
 */
export const getMatches = (
  changes: LocalChanges
): {
  added: HashSet.HashSet<string>;
  deleted: HashSet.HashSet<string>;
} => {
  // We check for moved files in incremental steps and exit as early as we can to avoid any performance degradation
  // Deleted files will be more rare than added files, so we'll check them first and exit early if there are none
  const emptyResult = { added: HashSet.empty<string>(), deleted: HashSet.empty<string>() };
  if (changes.deleted.length === 0 || changes.added.length === 0) return emptyResult;

  // Both arrays have contents, look for matching basenames
  const addedFilenames = changes.added;
  const deletedFilenames = changes.deleted;

  // Build Sets of basenames for added and deleted files for quick lookups
  const addedBasenames = HashSet.fromIterable(addedFilenames.map((filename) => path.basename(filename)));
  const deletedBasenames = HashSet.fromIterable(deletedFilenames.map((filename) => path.basename(filename)));
  const matchingBasenames = HashSet.intersection(addedBasenames, deletedBasenames);
  if (HashSet.isEmpty(matchingBasenames)) return emptyResult;

  // Keep only full paths whose basename occurs on both sides.
  const deletedFilenamesWithMatches = HashSet.fromIterable(deletedFilenames).pipe(
    HashSet.filter((file) => HashSet.has(matchingBasenames, path.basename(file)))
  );
  const addedFilenamesWithMatches = HashSet.fromIterable(addedFilenames).pipe(
    HashSet.filter((file) => HashSet.has(matchingBasenames, path.basename(file)))
  );

  return { added: addedFilenamesWithMatches, deleted: deletedFilenamesWithMatches };
};
