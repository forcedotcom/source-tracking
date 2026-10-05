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

import { ShadowRepoLite } from './localShadowRepoLite';
import type { CommitRequest, ShadowRepoLike, ShadowRepoOptions, StatusRow } from './types';

export class ShadowRepo implements ShadowRepoLike {
  public gitDir: string;
  public projectPath: string;

  // The chosen backend. Constructed at getInstance().
  private readonly impl: ShadowRepoLike;

  private constructor(impl: ShadowRepoLike) {
    this.impl = impl;
    this.gitDir = impl.gitDir;
    this.projectPath = impl.projectPath;
  }

  public static async getInstance(options: ShadowRepoOptions): Promise<ShadowRepo> {
    const impl = await ShadowRepoLite.getInstance(options);
    return new ShadowRepo(impl);
  }

  public init(): Promise<void> {
    return this.impl.init();
  }
  public gitInit(): Promise<void> {
    return this.impl.gitInit();
  }
  public delete(): Promise<string> {
    return this.impl.delete();
  }
  public getStatus(noCache?: boolean): Promise<StatusRow[]> {
    return this.impl.getStatus(noCache);
  }
  public getChangedRows(): Promise<StatusRow[]> {
    return this.impl.getChangedRows();
  }
  public getChangedFilenames(): Promise<string[]> {
    return this.impl.getChangedFilenames();
  }
  public getDeletes(): Promise<StatusRow[]> {
    return this.impl.getDeletes();
  }
  public getDeleteFilenames(): Promise<string[]> {
    return this.impl.getDeleteFilenames();
  }
  public getNonDeletes(): Promise<StatusRow[]> {
    return this.impl.getNonDeletes();
  }
  public getNonDeleteFilenames(): Promise<string[]> {
    return this.impl.getNonDeleteFilenames();
  }
  public getAdds(): Promise<StatusRow[]> {
    return this.impl.getAdds();
  }
  public getAddFilenames(): Promise<string[]> {
    return this.impl.getAddFilenames();
  }
  public getModifies(): Promise<StatusRow[]> {
    return this.impl.getModifies();
  }
  public getModifyFilenames(): Promise<string[]> {
    return this.impl.getModifyFilenames();
  }
  public commitChanges(request?: CommitRequest): Promise<string | undefined> {
    return this.impl.commitChanges(request);
  }
}
