/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FileResponse } from '@salesforce/source-deploy-retrieve';

export type RemoteSyncInput = Pick<FileResponse, 'fullName' | 'filePath' | 'type' | 'state'>;

export type RemoteChangeElement = {
  name: string;
  type: string;
  deleted?: boolean;
  modified?: boolean;
};

/**
 * Summary type that supports both local and remote change types
 */
export type ChangeResult = Partial<RemoteChangeElement> & {
  origin: 'local' | 'remote';
  filenames?: string[];
};

export type MemberRevision = {
  serverRevisionCounter: number;
  lastRetrievedFromServer: number | null;
  memberType: string;
  isNameObsolete: boolean;
};

export type SourceMember = {
  MemberType: string;
  MemberName: string;
  IsNameObsolete: boolean;
  RevisionCounter: number;
};
