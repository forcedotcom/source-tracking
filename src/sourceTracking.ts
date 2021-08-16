/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import { NamedPackageDir, Logger, Org, SfdxProject } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import { RemoteSourceTrackingService, RemoteChangeElement, getMetadataKey } from './shared/remoteSourceTrackingService';
import { ShadowRepo } from './shared/localShadowRepo';

export const getKeyFromObject = (element: RemoteChangeElement | ChangeResult): string => {
  if (element.type && element.name) {
    return getMetadataKey(element.type, element.name);
  }
  throw new Error(`unable to complete key from ${JSON.stringify(element)}`);
};

// external users of SDR might need to convert a fileResponse to a key
export const getKeyFromStrings = getMetadataKey;

export interface MetadataKeyPair {
  type: string;
  name: string;
}

export interface ChangeOptions {
  origin?: 'local' | 'remote';
  state: 'add' | 'delete' | 'changed' | 'unchanged' | 'moved';
}

export interface LocalUpdateOptions {
  files?: string[];
  deletedFiles?: string[];
}

/**
 * Summary type that supports both local and remote change types
 */
export type ChangeResult = Partial<RemoteChangeElement> & {
  origin: 'local' | 'remote';
  filenames?: string[];
};

export class SourceTracking {
  private orgId: string;
  private projectPath: string;
  private packagesDirs: NamedPackageDir[];
  private username: string;
  private logger: Logger;

  // remote and local tracking may not exist if not initialized
  private localRepo!: ShadowRepo;
  private remoteSourceTrackingService!: RemoteSourceTrackingService;

  public constructor(options: { org: Org; project: SfdxProject }) {
    this.orgId = options.org.getOrgId();
    this.username = options.org.getUsername() as string;
    this.projectPath = options.project.getPath();
    this.packagesDirs = options.project.getPackageDirectories();
    this.logger = Logger.childFromRoot('SourceTracking');
  }

  /**
   * Get metadata changes made locally and in the org.
   *
   * @returns local and remote changed metadata
   */
  public async getChanges(options?: ChangeOptions): Promise<ChangeResult[]> {
    if (options?.origin === 'local') {
      await this.ensureLocalTracking();
      if (options.state === 'changed') {
        return (await this.localRepo.getNonDeleteFilenames()).map((filename) => ({
          filenames: [filename],
          origin: 'local',
        }));
      }
      if (options.state === 'delete') {
        return (await this.localRepo.getDeleteFilenames()).map((filename) => ({
          filenames: [filename],
          origin: 'local',
        }));
      }
      if (options.state === 'add') {
        return (await this.localRepo.getAddFilenames()).map((filename) => ({
          filenames: [filename],
          origin: 'local',
        }));
      }
    }
    if (options?.origin === 'remote') {
      await this.ensureRemoteTracking();
      const remoteChanges = await this.remoteSourceTrackingService.retrieveUpdates();
      this.logger.debug('remoteChanges', remoteChanges);
      return remoteChanges
        .filter((change) => change.deleted === (options.state === 'delete'))
        .map((change) => ({ ...change, origin: 'remote' }));
    }

    // by default return all local and remote changes
    // eslint-disable-next-line no-console
    this.logger.debug(options);
    return [];
  }

  public async getRemoteChanges(): Promise<RemoteChangeElement[]> {
    await this.ensureRemoteTracking();
    return this.remoteSourceTrackingService.retrieveUpdates();
  }
  /**
   * Update tracking for the options passed.
   *
   * @param options the files to update
   */
  public async updateLocalTracking(options: LocalUpdateOptions): Promise<void> {
    await this.ensureLocalTracking();
    await this.localRepo.commitChanges({
      deployedFiles: options.files?.map((file) => this.ensureRelative(file)),
      deletedFiles: options.deletedFiles?.map((file) => this.ensureRelative(file)),
    });
  }

  /**
   * Mark remote source tracking files that we have received to the latest version
   */
  public async updateRemoteTracking(metadataKeys: MetadataKeyPair[]): Promise<void> {
    await this.ensureRemoteTracking();
    await this.remoteSourceTrackingService.syncNamedElementsByKey(
      metadataKeys.map((input) => getKeyFromStrings(input.type, input.name))
    );
  }

  /**
   * If the local tracking shadowRepo doesn't exist, it will be created.
   * Does nothing if it already exists.
   * Useful before parallel operations
   */
  public async ensureLocalTracking(): Promise<void> {
    if (this.localRepo) {
      return;
    }
    this.localRepo = await ShadowRepo.create({
      orgId: this.orgId,
      projectPath: this.projectPath,
      packageDirs: this.packagesDirs,
    });
    // loads the status from file so that it's cached
    await this.localRepo.getStatus();
  }

  /**
   * If the remote tracking shadowRepo doesn't exist, it will be created.
   * Does nothing if it already exists.
   * Useful before parallel operations
   */
  public async ensureRemoteTracking(): Promise<void> {
    if (this.remoteSourceTrackingService) {
      return;
    }
    this.remoteSourceTrackingService = await RemoteSourceTrackingService.getInstance({
      username: this.username,
      orgId: this.orgId,
    });
    // loads the status from file so that it's cached
    await this.remoteSourceTrackingService.init();
  }

  /**
   * uses SDR to translate remote metadata records into local file paths
   */
  // public async populateFilePaths(elements: ChangeResult[]): Promise<ChangeResult[]> {
  public populateFilePaths(elements: ChangeResult[]): ChangeResult[] {
    if (elements.length === 0) {
      return [];
    }

    this.logger.debug('populateFilePaths for change elements', elements);
    // component set generated from an array of ComponentLike from all the remote changes
    const remoteChangesAsComponentLike = elements.map((element) => ({
      type: element?.type as string,
      fullName: element?.name as string,
    }));
    const remoteChangesAsComponentSet = new ComponentSet(remoteChangesAsComponentLike);

    this.logger.debug(` the generated component set has ${remoteChangesAsComponentSet.size.toString()} items`);
    if (remoteChangesAsComponentSet.size < elements.length) {
      throw new Error(
        `unable to generate complete component set for ${elements
          .map((element) => `${element.name}(${element.type})`)
          .join(',')}`
      );
    }

    const matchingLocalSourceComponentsSet = ComponentSet.fromSource({
      fsPaths: this.packagesDirs.map((dir) => dir.path),
      include: remoteChangesAsComponentSet,
    });
    this.logger.debug(
      ` local source-backed component set has ${matchingLocalSourceComponentsSet.size.toString()} items from remote`
    );

    // make it simpler to find things later
    const elementMap = new Map<string, ChangeResult>();
    elements.map((element) => {
      elementMap.set(getKeyFromObject(element), element);
    });

    // iterates the local components and sets their filenames
    for (const matchingComponent of matchingLocalSourceComponentsSet.getSourceComponents().toArray()) {
      if (matchingComponent.fullName && matchingComponent.type.name) {
        this.logger.debug(
          `${matchingComponent.fullName}|${matchingComponent.type.name} matches ${
            matchingComponent.xml
          } and maybe ${matchingComponent.walkContent().toString()}`
        );
        const key = getKeyFromStrings(matchingComponent.type.name, matchingComponent.fullName);
        elementMap.set(key, {
          ...(elementMap.get(key) as ChangeResult),
          modified: true,
          filenames: [matchingComponent.xml as string, ...matchingComponent.walkContent()].filter(
            (filename) => filename
          ),
        });
      }
    }

    return Array.from(elementMap.values());
  }

  public async getConflicts(): Promise<ChangeResult[]> {
    // we're going to need have both initialized
    await Promise.all([this.ensureRemoteTracking(), this.ensureLocalTracking()]);

    const localChanges = (
      await Promise.all([
        this.getChanges({ state: 'changed', origin: 'local' }),
        this.getChanges({ state: 'add', origin: 'local' }),
      ])
    ).flat();
    // remote adds won't have a filename
    const remoteChanges = this.populateFilePaths(await this.getChanges({ origin: 'remote', state: 'changed' }));

    // index them by filename
    const fileNameIndex = new Map<string, ChangeResult>();
    remoteChanges.map((change) => {
      change.filenames?.map((filename) => {
        fileNameIndex.set(filename, change);
      });
    });

    const conflicts = new Set<ChangeResult>();

    localChanges.map((change) => {
      change.filenames?.map((filename) => {
        if (fileNameIndex.has(filename)) {
          conflicts.add({ ...(fileNameIndex.get(filename) as ChangeResult) });
        }
      });
    });
    // deeply de-dupe
    return [...conflicts];
  }

  private ensureRelative(filePath: string): string {
    return path.isAbsolute(filePath) ? path.relative(this.projectPath, filePath) : filePath;
  }
}
