/*
 * Copyright 2025, Salesforce, Inc.
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

// filenames were normalized when read from isogit
export const toFilenames = (rows: StatusRow[]): string[] => rows.map((row) => row[FILE]);
export const isDeleted = (status: StatusRow): boolean => status[WORKDIR] === 0;
export const isAdded = (status: StatusRow): boolean => status[HEAD] === 0 && status[WORKDIR] === 2;
export const ensurePosix = (filepath: string): string => filepath.split(path.sep).join(path.posix.sep);

// We don't use STAGE (StatusRow[3]). Changes are added and committed in one step
export const FILE = 0;
export const HEAD = 1;
export const WORKDIR = 2;
