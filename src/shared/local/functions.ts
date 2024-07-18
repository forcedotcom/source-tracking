/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as os from 'node:os';
import { StatusRow } from './types';

// filenames were normalized when read from isogit
export const toFilenames = (rows: StatusRow[]): string[] => rows.map((row) => row[FILE]);
export const isDeleted = (status: StatusRow): boolean => status[WORKDIR] === 0;
export const isAdded = (status: StatusRow): boolean => status[HEAD] === 0 && status[WORKDIR] === 2;
export const IS_WINDOWS = os.type() === 'Windows_NT'; // array members for status results

// We don't use STAGE (StatusRow[3]). Changes are added and committed in one step
export const FILE = 0;
export const HEAD = 1;
export const WORKDIR = 2;
