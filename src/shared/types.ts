/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FileResponse } from '@salesforce/source-deploy-retrieve';

export type RemoteSyncInput = Pick<FileResponse, 'fullName' | 'filePath' | 'type'>;

export type PushPullResponse = Pick<FileResponse, 'filePath' | 'fullName' | 'state' | 'type'>;
