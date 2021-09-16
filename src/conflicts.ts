/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { UX } from '@salesforce/command';
import { SfdxError } from '@salesforce/core';
import { ChangeResult } from './sourceTracking';

const writeConflictTable = (conflicts: ChangeResult[], ux: UX): void => {
  ux.table(
    conflicts.map((conflict) => ({ ...conflict, state: 'Conflict' })),
    {
      columns: [
        { label: 'STATE', key: 'state' },
        { label: 'FULL NAME', key: 'name' },
        { label: 'TYPE', key: 'type' },
        { label: 'PROJECT PATH', key: 'filenames' },
      ],
    }
  );
};

/**
 *
 * @param conflicts
 * @param ux
 * @param message
 */
export const processConflicts = (conflicts: ChangeResult[], ux: UX, message: string): void => {
  if (conflicts.length === 0) {
    return;
  }
  writeConflictTable(conflicts, ux);
  const err = new SfdxError(message);
  err.setData(conflicts);
  throw err;
};
