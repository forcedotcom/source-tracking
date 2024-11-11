/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FileResponse, SourceComponent } from '@salesforce/source-deploy-retrieve';
import { SfError } from '@salesforce/core/sfError';

export type ChangeOptions = {
  origin: 'local' | 'remote';
  state: 'add' | 'delete' | 'modify' | 'nondelete';
  format: 'ChangeResult' | 'SourceComponent' | 'string' | 'ChangeResultWithPaths';
};

export type RemoteSyncInput = Pick<FileResponse, 'fullName' | 'filePath' | 'type' | 'state'>;

export type StatusOutputRow = Pick<FileResponse, 'fullName' | 'filePath' | 'type'> & {
  conflict?: boolean;
  ignored?: boolean;
} & Pick<ChangeOptions, 'origin' | 'state'>;

export type LocalUpdateOptions = {
  files?: string[];
  deletedFiles?: string[];
};

export type RemoteChangeElement = {
  name: string;
  type: string;
  deleted?: boolean;
  modified?: boolean;
  changedBy: string;
  revisionCounter: number;
  /** the ID of the metadata that was changed.  Each metadata type has a different 3-char prefix */
  memberIdOrName: string;
};

/**
 * Summary type that supports both local and remote change types
 */
export type ChangeResult = Partial<RemoteChangeElement> & {
  origin: 'local' | 'remote';
  filenames?: string[];
  ignored?: boolean;
};

export type MemberRevision = SourceMember & {
  /** the last revision retrieved.  Used for detecting changes*/
  lastRetrievedFromServer?: number;
};

/** @deprecated replaced by the new MemberRevision */
export type MemberRevisionLegacy = {
  memberType: string;
  serverRevisionCounter: number;
  lastRetrievedFromServer: number | null;
  isNameObsolete: boolean;
};
export type SourceMember = {
  MemberType: string;
  MemberName: string;
  IsNameObsolete: boolean;
  IsNewMember: boolean;
  RevisionCounter: number;
  MemberIdOrName: string;
  ChangedBy: string;
};

export type ConflictResponse = {
  state: 'Conflict';
  fullName: string;
  type: string;
  filePath: string;
};

// this and the related class are not enforced but a convention of this library.
// This helps the consumers get correct typing--if the error name matches SourceConflictError,
// there will be a data property of type ConflictResponse[]
export type SourceConflictErrorType = {
  name: 'SourceConflictError';
} & SfError<ConflictResponse[]>;

export class SourceConflictError extends SfError<ConflictResponse[]> implements SourceConflictErrorType {
  public readonly name: SourceConflictErrorType['name'];
  public constructor(message: string, data: ConflictResponse[]) {
    super(message);
    this.name = 'SourceConflictError';
    this.data = data;
  }
}

export type ChangeOptionType = ChangeResult | SourceComponent | string;

export type SourceMemberPollingEvent = {
  original: number;
  remaining: number;
  attempts: number;
  consecutiveEmptyResults: number;
};
export type ChangeResultWithNameAndType = ChangeResult & Required<Pick<ChangeResult, 'name' | 'type'>>;
