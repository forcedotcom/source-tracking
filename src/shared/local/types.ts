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
export type StringMap = Map<string, string>;
export type AddAndDeleteMaps = { addedMap: StringMap; deletedMap: StringMap }; // https://isomorphic-git.org/docs/en/statusMatrix#docsNav

export type StatusRow = [file: string, head: number, workdir: number, stage: number];

import type { NamedPackageDir } from '@salesforce/core';
import type { RegistryAccess } from '@salesforce/source-deploy-retrieve';

export type ShadowRepoOptions = {
  orgId: string;
  projectPath: string;
  packageDirs: NamedPackageDir[];
  registry: RegistryAccess;
};

/** CommitRequest passed to ShadowRepo.commitChanges. Both implementations share this shape. */
export type CommitRequest = {
  deployedFiles?: string[];
  deletedFiles?: string[];
  message?: string;
  needsUpdatedStatus?: boolean;
};

/**
 * Public surface of a shadow repo. Iso (isomorphic-git) and lite (src/git)
 * implementations both satisfy this; the ShadowRepo factory picks one at
 * getInstance() time based on the SF_SOURCE_TRACKING_USE_LITE_GIT flag.
 */
export type ShadowRepoLike = {
  readonly gitDir: string;
  readonly projectPath: string;
  init(): Promise<void>;
  gitInit(): Promise<void>;
  delete(): Promise<string>;
  getStatus(noCache?: boolean): Promise<StatusRow[]>;
  getChangedRows(): Promise<StatusRow[]>;
  getChangedFilenames(): Promise<string[]>;
  getDeletes(): Promise<StatusRow[]>;
  getDeleteFilenames(): Promise<string[]>;
  getNonDeletes(): Promise<StatusRow[]>;
  getNonDeleteFilenames(): Promise<string[]>;
  getAdds(): Promise<StatusRow[]>;
  getAddFilenames(): Promise<string[]>;
  getModifies(): Promise<StatusRow[]>;
  getModifyFilenames(): Promise<string[]>;
  commitChanges(request?: CommitRequest): Promise<string | undefined>;
};
