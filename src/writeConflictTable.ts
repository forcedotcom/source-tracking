/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { UX } from '@salesforce/command';
import { ChangeResult } from './sourceTracking';

export const writeConflictTable = (conflicts: ChangeResult[], ux: UX): void => {
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
