/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import path from 'node:path';
import { WORKDIR, HEAD } from './localShadowRepo';
import { FILE } from './localShadowRepo';

import { StatusRow } from './types';

// filenames were normalized when read from isogit

export const toFilenames = (rows: StatusRow[]): string[] => rows.map((row) => row[FILE]);
export const isDeleted = (status: StatusRow): boolean => status[WORKDIR] === 0;
export const isAdded = (status: StatusRow): boolean => status[HEAD] === 0 && status[WORKDIR] === 2;
export const ensureWindows = (filepath: string): string => path.win32.normalize(filepath);
