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

export type DetectionFileInfo = Readonly<{ filename: string; hash: string; basename: string }>;
export type DetectionFileInfoWithType = Readonly<
  DetectionFileInfo & { type: string; parentFullName: string; parentType: string }
>;
export type LocalChanges = Readonly<{
  added: readonly string[];
  modified: readonly string[];
  deleted: readonly string[];
}>;

import type { NamedPackageDir } from '@salesforce/core';
import type { RegistryAccess } from '@salesforce/source-deploy-retrieve';

export type ShadowRepoOptions = {
  orgId: string;
  projectPath: string;
  packageDirs: NamedPackageDir[];
  registry: RegistryAccess;
};

/** Files to record in the local tracking baseline. */
export type SyncRequest = {
  readonly deployedFiles?: readonly string[];
  readonly deletedFiles?: readonly string[];
  readonly message?: string;
  readonly needsUpdatedStatus?: boolean;
};
