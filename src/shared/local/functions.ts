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
import { StatusRow } from './types';
export const IS_WINDOWS = os.type() === 'Windows_NT'; // array members for status results

// filenames were normalized when read from the shadow repo
export const toFilenames = (rows: StatusRow[]): string[] => rows.map((row) => row[FILE]);
export const isDeleted = (status: StatusRow): boolean => status[WORKDIR] === 0;
export const isAdded = (status: StatusRow): boolean => status[HEAD] === 0 && status[WORKDIR] === 2;
export const ensurePosix = (filepath: string): string => filepath.split(path.sep).join(path.posix.sep);

// We don't use STAGE (StatusRow[3]). Changes are added and committed in one step
export const FILE = 0;
export const HEAD = 1;
export const WORKDIR = 2;

/**
 * Check for matching added/deleted filenames by basename.
 * Used by move detection to find potential moved files.
 */
export const getMatches = (status: StatusRow[]): { added: Set<string>; deleted: Set<string> } => {
  // We check for moved files in incremental steps and exit as early as we can to avoid any performance degradation
  // Deleted files will be more rare than added files, so we'll check them first and exit early if there are none
  const emptyResult = { added: new Set<string>(), deleted: new Set<string>() };
  const deletedFiles = status.filter(isDeleted);
  if (!deletedFiles.length) return emptyResult;

  const addedFiles = status.filter(isAdded);
  if (!addedFiles.length) return emptyResult;

  // Both arrays have contents, look for matching basenames
  const addedFilenames = toFilenames(addedFiles);
  const deletedFilenames = toFilenames(deletedFiles);

  // Build Sets of basenames for added and deleted files for quick lookups
  const addedBasenames = new Set(addedFilenames.map((filename) => path.basename(filename)));
  const deletedBasenames = new Set(deletedFilenames.map((filename) => path.basename(filename)));

  // Filter over the deleted files first and exit early if there are no filename matches
  const deletedFilenamesWithMatches = new Set(deletedFilenames.filter((f) => addedBasenames.has(path.basename(f))));
  if (!deletedFilenamesWithMatches.size) return emptyResult;

  const addedFilenamesWithMatches = new Set(addedFilenames.filter((f) => deletedBasenames.has(path.basename(f))));
  if (!addedFilenamesWithMatches.size) return emptyResult;

  return { added: addedFilenamesWithMatches, deleted: deletedFilenamesWithMatches };
};
