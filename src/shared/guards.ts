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
import { FileResponse, ComponentStatus, FileResponseSuccess } from '@salesforce/source-deploy-retrieve';
import { ChangeResult } from './types';
import { ChangeResultWithNameAndType } from './types';

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

export const isChangeResultWithNameAndType = (cr?: ChangeResult): cr is ChangeResultWithNameAndType =>
  typeof cr === 'object' && typeof cr.name === 'string' && typeof cr.type === 'string';

export const isDefined = <T>(x: T | undefined): x is T => x !== undefined;
