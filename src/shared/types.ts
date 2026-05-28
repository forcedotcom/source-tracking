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

import * as Schema from 'effect/Schema';
import type { FileResponse, SourceComponent } from '@salesforce/source-deploy-retrieve';
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
  lastModifiedDate: string;
  /** the ID of the metadata that was changed.  Each metadata type has a different 3-char prefix */
  memberIdOrName: string;
};

/**
 * Effect Schema for ChangeResult. The public type below is derived from this
 * schema, so anything we want to do internally (structural Equal/Hash via
 * `Data.struct`, parse/encode, etc.) stays consistent with what consumers see.
 *
 * `Schema.Data(Schema.Array(...))` enables deep-equality on `filenames` so two
 * structurally-identical ChangeResults hash the same in a HashSet.
 */
const ChangeResultSchema = Schema.Struct({
  origin: Schema.Literal('local', 'remote'),
  filenames: Schema.optional(Schema.Data(Schema.Array(Schema.String))),
  ignored: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
  modified: Schema.optional(Schema.Boolean),
  changedBy: Schema.optional(Schema.String),
  revisionCounter: Schema.optional(Schema.Number),
  lastModifiedDate: Schema.optional(Schema.String),
  memberIdOrName: Schema.optional(Schema.String),
});

/**
 * Summary type that supports both local and remote change types. Derived from
 * `ChangeResultSchema`.
 */
export type ChangeResult = Schema.Schema.Type<typeof ChangeResultSchema>;

export type ConflictResponse = {
  state: 'Conflict';
  fullName: string;
  type: string;
  filePath: string;
};

// this and the related class are not enforced but a convention of this library.
// This helps the consumers get correct typing--if the error name matches SourceConflictError,
// there will be a data property of type ConflictResponse[]
type SourceConflictErrorType = {
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
