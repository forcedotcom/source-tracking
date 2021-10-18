/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as fs from 'fs';
import * as path from 'path';
import { NamedPackageDir, Logger, Org, SfdxProject } from '@salesforce/core';
import { AsyncCreatable } from '@salesforce/kit';
import {
  ComponentSet,
  MetadataResolver,
  ComponentStatus,
  SourceComponent,
  FileResponse,
} from '@salesforce/source-deploy-retrieve';

import { RemoteSourceTrackingService, RemoteChangeElement, getMetadataKey } from './shared/remoteSourceTrackingService';
import { ShadowRepo } from './shared/localShadowRepo';
import { filenamesToVirtualTree } from './shared/filenamesToVirtualTree';
import { RemoteSyncInput } from './shared/types';

export const getKeyFromObject = (element: RemoteChangeElement | ChangeResult): string => {
  if (element.type && element.name) {
    return getMetadataKey(element.type, element.name);
  }
  throw new Error(`unable to complete key from ${JSON.stringify(element)}`);
};

// external users of SDR might need to convert a fileResponse to a key
export const getKeyFromStrings = getMetadataKey;

export type ChangeOptionType = ChangeResult | SourceComponent | string;

export interface ChangeOptions {
  origin: 'local' | 'remote';
  state: 'add' | 'delete' | 'modify' | 'nondelete';
  format: 'ChangeResult' | 'SourceComponent' | 'string' | 'ChangeResultWithPaths';
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

export interface ConflictError {
  message: string;
  name: 'conflict';
  conflicts: ChangeResult[];
}

export interface SourceTrackingOptions {
  org: Org;
  project: SfdxProject;
  /** defaults to sfdxProject sourceApiVersion unless provided */
  apiVersion?: string;
}

/**
 * Manages source tracking files (remote and local)
 *
 * const tracking = await SourceTracking.create({org: this.org, project: this.project});
 *
 */
export class SourceTracking extends AsyncCreatable {
  private orgId: string;
  private projectPath: string;
  private packagesDirs: NamedPackageDir[];
  private username: string;
  private logger: Logger;
  // remote and local tracking may not exist if not initialized
  private localRepo!: ShadowRepo;
  private remoteSourceTrackingService!: RemoteSourceTrackingService;

  public constructor(options: SourceTrackingOptions) {
    super(options);
    this.orgId = options.org.getOrgId();
    this.username = options.org.getUsername() as string;
    this.projectPath = options.project.getPath();
    this.packagesDirs = options.project.getPackageDirectories();
    this.logger = Logger.childFromRoot('SourceTracking');
  }

  public async init(): Promise<void> {
    // reserved for future use.  If not, can remove asyncCreatable
  }

  public async localChangesAsComponentSet(): Promise<ComponentSet> {
    await this.ensureLocalTracking();
    const componentSet = new ComponentSet();

    const [nonDeletes, deletes] = await Promise.all([
      this.localRepo.getNonDeleteFilenames(),
      this.localRepo.getDeleteFilenames(),
    ]);
    if (nonDeletes.length === 0 && deletes.length === 0) {
      this.logger.debug('no local changes found in source tracking files');
      return componentSet;
    }
    // optimistic resolution...some files may not be possible to resolve
    const resolverForNonDeletes = new MetadataResolver();
    // we need virtual components for the deletes.
    // TODO: could we use the same for the non-deletes?
    const resolverForDeletes = new MetadataResolver(undefined, filenamesToVirtualTree(deletes));

    nonDeletes
      .flatMap((filename) => {
        try {
          return resolverForNonDeletes.getComponentsFromPath(filename);
        } catch (e) {
          this.logger.warn(`unable to resolve ${filename}`);
          return undefined;
        }
      })
      .filter(sourceComponentGuard)
      .map((component) => componentSet.add(component));

    deletes
      .flatMap((filename) => resolverForDeletes.getComponentsFromPath(filename))
      .filter(sourceComponentGuard)
      .map((component) => componentSet.add(component, true));

    return componentSet;
  }

  /**
   * Get metadata changes made locally and in the org.
   *
   * @returns local and remote changed metadata
   */
  public async getChanges<T extends ChangeOptionType>(options?: ChangeOptions): Promise<T[]> {
    if (options?.origin === 'local') {
      await this.ensureLocalTracking();
      const filenames: string[] = await this.getLocalChangesAsFilenames(options.state);
      if (options.format === 'string') {
        return filenames as T[];
      }
      if (options.format === 'ChangeResult' || options.format === 'ChangeResultWithPaths') {
        return filenames.map((filename) => ({
          filenames: [filename],
          origin: 'local',
        })) as T[];
      }
      if (options.format === 'SourceComponent') {
        const resolver =
          options.state === 'delete'
            ? new MetadataResolver(undefined, filenamesToVirtualTree(filenames))
            : new MetadataResolver();

        return filenames
          .flatMap((filename) => {
            try {
              return resolver.getComponentsFromPath(filename);
            } catch (e) {
              this.logger.warn(`unable to resolve ${filename}`);
              return undefined;
            }
          })
          .filter(sourceComponentGuard) as T[];
      }
    }

    if (options?.origin === 'remote') {
      await this.ensureRemoteTracking();
      const remoteChanges = await this.remoteSourceTrackingService.retrieveUpdates();
      this.logger.debug('remoteChanges', remoteChanges);
      const filteredChanges = remoteChanges.filter(remoteFilterByState[options.state]);
      if (options.format === 'ChangeResult') {
        return filteredChanges.map((change) => ({ ...change, origin: 'remote' })) as T[];
      }
      if (options.format === 'ChangeResultWithPaths') {
        return this.populateFilePaths(filteredChanges.map((change) => ({ ...change, origin: 'remote' }))) as T[];
      }
      // turn it into a componentSet to resolve filenames
      const remoteChangesAsComponentSet = new ComponentSet(
        filteredChanges.map((element) => ({
          type: element?.type,
          fullName: element?.name,
        }))
      );
      const matchingLocalSourceComponentsSet = ComponentSet.fromSource({
        fsPaths: this.packagesDirs.map((dir) => dir.path),
        include: remoteChangesAsComponentSet,
      });
      if (options.format === 'string') {
        return matchingLocalSourceComponentsSet
          .getSourceComponents()
          .toArray()
          .flatMap((component) =>
            [component.xml as string, ...component.walkContent()].filter((filename) => filename)
          ) as T[];
      } else if (options.format === 'SourceComponent') {
        return matchingLocalSourceComponentsSet.getSourceComponents().toArray() as T[];
      }
    }
    throw new Error(`unsupported options: ${JSON.stringify(options)}`);
  }

  /**
   *
   * returns immediately if there are no changesToDelete
   *
   * @param changesToDelete array of SourceComponent
   */
  public async deleteFilesAndUpdateTracking(changesToDelete: SourceComponent[]): Promise<FileResponse[]> {
    if (changesToDelete.length === 0) {
      return [];
    }

    const sourceComponentByFileName = new Map<string, SourceComponent>();
    changesToDelete.flatMap((component) =>
      [component.xml as string, ...component.walkContent()]
        .filter((filename) => filename)
        .map((filename) => sourceComponentByFileName.set(filename, component))
    );
    const filenames = Array.from(sourceComponentByFileName.keys());
    // delete the files
    await Promise.all(filenames.map((filename) => fs.promises.unlink(filename)));

    // update the tracking files.  We're simulating SDR-style fileResponse
    await Promise.all([
      this.updateLocalTracking({ deletedFiles: filenames }),
      this.updateRemoteTracking(
        changesToDelete.map((component) => ({
          type: component.type.name,
          fullName: component.fullName,
          state: ComponentStatus.Deleted,
        })),
        true // skip polling because it's a pull
      ),
    ]);
    return filenames.map(
      (filename) =>
        ({
          state: 'Deleted',
          filename,
          type: sourceComponentByFileName.get(filename)?.type.name,
          fullName: sourceComponentByFileName.get(filename)?.fullName,
        } as unknown as FileResponse)
    );
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
   * Mark remote source tracking files so say that we have received the latest version from the server
   * Optionall skip polling for the SourceMembers to exist on the server and be updated in local files
   */
  public async updateRemoteTracking(fileResponses: RemoteSyncInput[], skipPolling = false): Promise<void> {
    // false to explicitly NOT query until we do the polling
    await this.ensureRemoteTracking(false);
    if (!skipPolling) {
      // poll to make sure we have the updates before syncing the ones from metadataKeys
      await this.remoteSourceTrackingService.pollForSourceTracking(fileResponses);
    }
    await this.remoteSourceTrackingService.syncSpecifiedElements(fileResponses);
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
    this.localRepo = await ShadowRepo.getInstance({
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
  public async ensureRemoteTracking(initializeWithQuery = false): Promise<void> {
    if (this.remoteSourceTrackingService) {
      this.logger.debug('ensureRemoteTracking: remote tracking already exists');
      return;
    }
    this.logger.debug('ensureRemoteTracking: remote tracking does not exist yet; getting instance');
    this.remoteSourceTrackingService = await RemoteSourceTrackingService.getInstance({
      username: this.username,
      orgId: this.orgId,
    });
    if (initializeWithQuery) {
      await this.remoteSourceTrackingService.retrieveUpdates();
    }
  }

  /**
   * Deletes the local tracking shadowRepo
   * return the list of files that were in it
   */
  public async clearLocalTracking(): Promise<string> {
    await this.ensureLocalTracking();
    return this.localRepo.delete();
  }

  /**
   * Commits all the local changes so that no changes are present in status
   */
  public async resetLocalTracking(): Promise<string[]> {
    await this.ensureLocalTracking();
    const [deletes, nonDeletes] = await Promise.all([
      this.localRepo.getDeleteFilenames(),
      this.localRepo.getNonDeleteFilenames(),
    ]);
    await this.localRepo.commitChanges({
      deletedFiles: deletes,
      deployedFiles: nonDeletes,
      message: 'via resetLocalTracking',
    });
    return [...deletes, ...nonDeletes];
  }

  /**
   * Deletes the remote tracking files
   */
  public async clearRemoteTracking(): Promise<string> {
    return RemoteSourceTrackingService.delete(this.orgId);
  }

  /**
   * Sets the files to max revision so that no changes appear
   */
  public async resetRemoteTracking(serverRevision?: number): Promise<number> {
    await this.ensureRemoteTracking();
    const resetMembers = await this.remoteSourceTrackingService.reset(serverRevision);
    return resetMembers.length;
  }

  /**
   * uses SDR to translate remote metadata records into local file paths (which only typically have the filename).
   *
   * @input elements: ChangeResult[]
   * @input excludeUnresolvables: boolean Filter out components where you can't get the name and type (that is, it's probably not a valid source component)
   */
  public populateTypesAndNames({
    elements,
    excludeUnresolvable = false,
    resolveDeleted = false,
  }: {
    elements: ChangeResult[];
    excludeUnresolvable?: boolean;
    resolveDeleted?: boolean;
  }): ChangeResult[] {
    if (elements.length === 0) {
      return [];
    }

    this.logger.debug(`populateTypesAndNames for ${elements.length} change elements`);
    const filenames = elements.flatMap((element) => element.filenames).filter(stringGuard);

    // component set generated from the filenames on all local changes
    const resolver = new MetadataResolver(undefined, resolveDeleted ? filenamesToVirtualTree(filenames) : undefined);
    const sourceComponents = filenames
      .flatMap((filename) => {
        try {
          return resolver.getComponentsFromPath(filename);
        } catch (e) {
          this.logger.warn(`unable to resolve ${filename}`);
          return undefined;
        }
      })
      .filter(sourceComponentGuard);

    this.logger.debug(` matching SourceComponents have ${sourceComponents.length} items from local`);

    // make it simpler to find things later
    const elementMap = new Map<string, ChangeResult>();
    elements.map((element) => {
      element.filenames?.map((filename) => {
        elementMap.set(this.ensureRelative(filename), element);
      });
    });

    // iterates the local components and sets their filenames
    sourceComponents.map((matchingComponent) => {
      if (matchingComponent?.fullName && matchingComponent?.type.name) {
        const filenamesFromMatchingComponent = [matchingComponent.xml, ...matchingComponent.walkContent()];
        filenamesFromMatchingComponent.map((filename) => {
          if (filename && elementMap.has(filename)) {
            // add the type/name from the componentSet onto the element
            elementMap.set(filename, {
              ...(elementMap.get(filename) as ChangeResult),
              type: matchingComponent.type.name,
              name: matchingComponent.fullName,
            });
          }
        });
      }
    });
    return excludeUnresolvable
      ? Array.from(new Set(elementMap.values())).filter((changeResult) => changeResult.name && changeResult.type)
      : Array.from(new Set(elementMap.values()));
  }

  public async getConflicts(): Promise<ChangeResult[]> {
    // we're going to need have both initialized
    await Promise.all([this.ensureRemoteTracking(), this.ensureLocalTracking()]);

    const localChanges = await this.getChanges<ChangeResult>({
      state: 'nondelete',
      origin: 'local',
      format: 'ChangeResult',
    });

    const remoteChanges = await this.getChanges<ChangeResult>({
      origin: 'remote',
      state: 'nondelete',
      // remote adds won't have a filename, so we ask for it to be resolved
      format: 'ChangeResultWithPaths',
    });

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
    return Array.from(conflicts);
  }

  /**
   * uses SDR to translate remote metadata records into local file paths
   */
  private populateFilePaths(elements: ChangeResult[]): ChangeResult[] {
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

  private ensureRelative(filePath: string): string {
    return path.isAbsolute(filePath) ? path.relative(this.projectPath, filePath) : filePath;
  }

  private async getLocalChangesAsFilenames(state: ChangeOptions['state']): Promise<string[]> {
    if (state === 'modify') {
      return this.localRepo.getModifyFilenames();
    }
    if (state === 'nondelete') {
      return this.localRepo.getNonDeleteFilenames();
    }
    if (state === 'delete') {
      return this.localRepo.getDeleteFilenames();
    }
    if (state === 'add') {
      return this.localRepo.getAddFilenames();
    }
    throw new Error(`unable to get local changes for state ${state as string}`);
  }
}

export const stringGuard = (input: string | undefined): input is string => {
  return typeof input === 'string';
};

const sourceComponentGuard = (input: SourceComponent | undefined): input is SourceComponent => {
  return input instanceof SourceComponent;
};

const remoteFilterByState = {
  add: (change: RemoteChangeElement): boolean => !change.deleted && !change.modified,
  modify: (change: RemoteChangeElement): boolean => change.modified === true,
  delete: (change: RemoteChangeElement): boolean => change.deleted === true,
  nondelete: (change: RemoteChangeElement): boolean => !change.deleted,
};
