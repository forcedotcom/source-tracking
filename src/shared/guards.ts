/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import {
  SourceComponent,
  MetadataMember,
  FileResponse,
  ComponentStatus,
  FileResponseFailure,
  FileResponseSuccess,
} from '@salesforce/source-deploy-retrieve';
import { ChangeResult } from './types';
import { ChangeResultWithNameAndType } from './types';

export const sourceComponentGuard = (input: SourceComponent | undefined): input is SourceComponent =>
  input instanceof SourceComponent;

export const metadataMemberGuard = (
  input: MetadataMember | undefined | Partial<MetadataMember>
): input is MetadataMember =>
  input !== undefined && typeof input.fullName === 'string' && typeof input.type === 'string';

export const isSdrFailure = (fileResponse: FileResponse): fileResponse is FileResponseFailure =>
  fileResponse.state === ComponentStatus.Failed;

export const isSdrSuccess = (fileResponse: FileResponse): fileResponse is FileResponseSuccess =>
  fileResponse.state !== ComponentStatus.Failed;

export const FileResponseIsDeleted = (fileResponse: FileResponse): boolean =>
  fileResponse.state === ComponentStatus.Deleted;

export const FileResponseIsNotDeleted = (fileResponse: FileResponse): boolean =>
  fileResponse.state !== ComponentStatus.Deleted;

export const FileResponseHasPath = (
  fileResponse: FileResponseSuccess
): fileResponse is FileResponseSuccess & Required<Pick<FileResponseSuccess, 'filePath'>> =>
  fileResponse.filePath !== undefined;

export const isChangeResultWithNameAndType = (cr: ChangeResult): cr is ChangeResultWithNameAndType =>
  typeof cr.name === 'string' && typeof cr.type === 'string';
