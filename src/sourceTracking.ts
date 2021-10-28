/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as fs from 'fs';
import * as path from 'path';
import { EOL } from 'os';
import { NamedPackageDir, Logger, Org, SfdxProject } from '@salesforce/core';
import { AsyncCreatable } from '@salesforce/kit';
import { getString } from '@salesforce/ts-types';
import {
  ComponentSet,
  MetadataResolver,
  ComponentStatus,
  SourceComponent,
  FileResponse,
  ForceIgnore,
  DestructiveChangesType,
  RegistryAccess,
} from '@salesforce/source-deploy-retrieve';
import { RemoteSourceTrackingService, remoteChangeElementToChangeResult } from './shared/remoteSourceTrackingService';
import { ShadowRepo } from './shared/localShadowRepo';
import { filenamesToVirtualTree } from './shared/filenamesToVirtualTree';

import {
  RemoteSyncInput,
  StatusOutputRow,
  ChangeOptions,
  ChangeResult,
  ChangeOptionType,
  LocalUpdateOptions,
  RemoteChangeElement,
} from './shared/types';
import { stringGuard, sourceComponentGuard } from './shared/guards';
import { getKeyFromObject, getMetadataKey } from './shared/functions';

export interface SourceTrackingOptions {
  org: Org;
  project: SfdxProject;
  /** @deprecated not used defaults to sfdxProject sourceApiVersion unless provided */
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
  private project: SfdxProject;
  private projectPath: string;
  private packagesDirs: NamedPackageDir[];
  private username: string;
  private logger: Logger;
  private registry = new RegistryAccess();
  // remote and local tracking may not exist if not initialized
  private localRepo!: ShadowRepo;
  private remoteSourceTrackingService!: RemoteSourceTrackingService;
  private forceIgnore!: ForceIgnore;

  public constructor(options: SourceTrackingOptions) {
    super(options);
    this.orgId = options.org.getOrgId();
    this.username = options.org.getUsername() as string;
    this.projectPath = options.project.getPath();
    this.packagesDirs = options.project.getPackageDirectories();
    this.logger = Logger.childFromRoot('SourceTracking');
    this.project = options.project;
  }

  public async init(): Promise<void> {
    // reserved for future use
  }

  public async localChangesAsComponentSet(): Promise<ComponentSet> {
    const [projectConfig] = await Promise.all([this.project.resolveProjectConfig(), this.ensureLocalTracking()]);
    const sourceApiVersion = getString(projectConfig, 'sourceApiVersion');

    const componentSet = new ComponentSet();
    if (sourceApiVersion) {
      componentSet.sourceApiVersion = sourceApiVersion;
    }

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
      .map((component) => componentSet.add(component, DestructiveChangesType.POST));

    return componentSet;
  }

  /**
   * Does most of the work for the force:source:status command.
   * Outputs need a bit of massage since this aims to provide nice json.
   *
   * @param local you want local status
   * @param remote you want remote status
   * @returns StatusOutputRow[]
   */

  public async getStatus({ local, remote }: { local: boolean; remote: boolean }): Promise<StatusOutputRow[]> {
    let results: StatusOutputRow[] = [];
    if (local) {
      results = results.concat(await this.getLocalStatusRows());
    }
    if (remote) {
      await this.ensureRemoteTracking(true);
      const [remoteDeletes, remoteModifies] = await Promise.all([
        this.getChanges<ChangeResult>({ origin: 'remote', state: 'delete', format: 'ChangeResult' }),
        this.getChanges<ChangeResult>({ origin: 'remote', state: 'nondelete', format: 'ChangeResultWithPaths' }),
      ]);
      results = results.concat(
        (
          await Promise.all(remoteDeletes.concat(remoteModifies).map((item) => this.remoteChangesToOutputRows(item)))
        ).flat(1)
      );
    }
    if (local && remote) {
      // keys like ApexClass__MyClass.cls
      const conflictFiles = (await this.getConflicts()).flatMap((conflict) => conflict.filenames).filter(stringGuard);
      results = results.map((row) => ({
        ...row,
        conflict: !!row.filePath && conflictFiles.includes(row.filePath),
      }));
    }
    return results;
  }

  /**
   * Get metadata changes made locally and in the org.
   *
   * @returns local and remote changed metadata
   *
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
        return filteredChanges.map((change) => remoteChangeElementToChangeResult(change)) as T[];
      }
      if (options.format === 'ChangeResultWithPaths') {
        return this.populateFilePaths(
          filteredChanges.map((change) => remoteChangeElementToChangeResult(change))
        ) as T[];
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
   * Compares local and remote changes to detect conflicts
   */
  public async getConflicts(): Promise<ChangeResult[]> {
    // we're going to need have both initialized
    await Promise.all([this.ensureRemoteTracking(), this.ensureLocalTracking()]);

    // Strategy: check local changes first (since it'll be faster) to avoid callout
    // early return if either local or remote is empty
    const localChanges = await this.getChanges<ChangeResult>({
      state: 'nondelete',
      origin: 'local',
      format: 'ChangeResult',
    });
    if (localChanges.length === 0) {
      return [];
    }
    const remoteChanges = await this.getChanges<ChangeResult>({
      origin: 'remote',
      state: 'nondelete',
      // remote adds won't have a filename, so we ask for it to be resolved
      format: 'ChangeResultWithPaths',
    });
    if (remoteChanges.length === 0) {
      return [];
    }
    // index the remoteChanges by filename
    const fileNameIndex = new Map<string, ChangeResult>();
    const metadataKeyIndex = new Map<string, ChangeResult>();
    remoteChanges.map((change) => {
      if (change.name && change.type) {
        metadataKeyIndex.set(getMetadataKey(change.name, change.type), change);
      }
      change.filenames?.map((filename) => {
        fileNameIndex.set(filename, change);
      });
    });

    const conflicts = new Set<ChangeResult>();

    this.populateTypesAndNames({ elements: localChanges, excludeUnresolvable: true }).map((change) => {
      const metadataKey = getMetadataKey(change.name as string, change.type as string);
      // option 1: name and type match
      if (metadataKeyIndex.has(metadataKey)) {
        conflicts.add({ ...(metadataKeyIndex.get(metadataKey) as ChangeResult) });
      } else {
        // option 2: some of the filenames match
        change.filenames?.map((filename) => {
          if (fileNameIndex.has(filename)) {
            conflicts.add({ ...(fileNameIndex.get(filename) as ChangeResult) });
          }
        });
      }
    });
    // deeply de-dupe
    return Array.from(conflicts);
  }

  /**
   * uses SDR to translate remote metadata records into local file paths (which only typically have the filename).
   *
   * @input elements: ChangeResult[]
   * @input excludeUnresolvables: boolean Filter out components where you can't get the name and type (that is, it's probably not a valid source component)
   * @input resolveDeleted: constructs a virtualTree instead of the actual filesystem--useful when the files no longer exist
   * @input useFsForceIgnore: (default behavior) use forceIgnore from the filesystem.  If false, uses the base forceIgnore from SDR
   */
  private populateTypesAndNames({
    elements,
    excludeUnresolvable = false,
    resolveDeleted = false,
    useFsForceIgnore = true,
  }: {
    elements: ChangeResult[];
    excludeUnresolvable?: boolean;
    resolveDeleted?: boolean;
    useFsForceIgnore?: boolean;
  }): ChangeResult[] {
    if (elements.length === 0) {
      return [];
    }

    this.logger.debug(`populateTypesAndNames for ${elements.length} change elements`);
    const filenames = elements.flatMap((element) => element.filenames).filter(stringGuard);

    // component set generated from the filenames on all local changes
    const resolver = new MetadataResolver(
      undefined,
      resolveDeleted ? filenamesToVirtualTree(filenames) : undefined,
      useFsForceIgnore
    );
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
        // Set the ignored status at the component level so it can apply to all its files, some of which may not match the ignoreFile (ex: ApexClass)
        this.forceIgnore = this.forceIgnore ?? ForceIgnore.findAndCreate(this.project.getDefaultPackage().path);
        const ignored = filenamesFromMatchingComponent
          .filter(stringGuard)
          .filter((filename) => !filename.includes('__tests__'))
          .some((filename) => this.forceIgnore.denies(filename));
        filenamesFromMatchingComponent.map((filename) => {
          if (filename && elementMap.has(filename)) {
            // add the type/name from the componentSet onto the element
            elementMap.set(filename, {
              origin: 'remote',
              ...elementMap.get(filename),
              type: matchingComponent.type.name,
              name: matchingComponent.fullName,
              ignored,
            });
          }
        });
      }
    });
    return excludeUnresolvable
      ? Array.from(new Set(elementMap.values())).filter((changeResult) => changeResult.name && changeResult.type)
      : Array.from(new Set(elementMap.values()));
  }

  private async getLocalStatusRows(): Promise<StatusOutputRow[]> {
    await this.ensureLocalTracking();
    let results: StatusOutputRow[] = [];
    const localDeletes = this.populateTypesAndNames({
      elements: await this.getChanges<ChangeResult>({ origin: 'local', state: 'delete', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      resolveDeleted: true,
      useFsForceIgnore: false,
    });

    const localAdds = this.populateTypesAndNames({
      elements: await this.getChanges<ChangeResult>({ origin: 'local', state: 'add', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      useFsForceIgnore: false,
    });

    const localModifies = this.populateTypesAndNames({
      elements: await this.getChanges<ChangeResult>({ origin: 'local', state: 'modify', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      useFsForceIgnore: false,
    });

    results = results.concat(
      localAdds.flatMap((item) => this.localChangesToOutputRow(item, 'add')),
      localModifies.flatMap((item) => this.localChangesToOutputRow(item, 'modify')),
      localDeletes.flatMap((item) => this.localChangesToOutputRow(item, 'delete'))
    );
    return results;
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
    // but exclude the ones that aren't in the registry
    const remoteChangesAsComponentLike = elements
      .filter((element) => element?.type && element.name && this.registry.getTypeByName(element.type))
      .map((element) => ({
        type: element.type as string,
        fullName: element?.name as string,
      }));
    const remoteChangesAsComponentSet = new ComponentSet(remoteChangesAsComponentLike);

    this.logger.debug(` the generated component set has ${remoteChangesAsComponentSet.size.toString()} items`);
    if (remoteChangesAsComponentSet.size < elements.length) {
      // iterate the elements to see which ones didn't make it into the component set
      throw new Error(
        `unable to generate complete component set for ${elements
          .filter(
            (element) =>
              !remoteChangesAsComponentSet.has({ type: element?.type as string, fullName: element?.name as string })
          )
          .map((element) => `${element.name} (${element.type})`)
          .join(EOL)}`
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
        const key = getMetadataKey(matchingComponent.type.name, matchingComponent.fullName);
        elementMap.set(key, {
          ...elementMap.get(key),
          modified: true,
          origin: 'remote',
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

  private localChangesToOutputRow(input: ChangeResult, localType: 'delete' | 'modify' | 'add'): StatusOutputRow[] {
    this.logger.debug('converting ChangeResult to a row', input);

    const baseObject = {
      type: input.type ?? '',
      origin: 'local',
      state: localType,
      fullName: input.name ?? '',
      // ignored property will be set in populateTypesAndNames
      ignored: input.ignored ?? false,
    };

    if (input.filenames) {
      return input.filenames.map((filename) => ({
        ...baseObject,
        filePath: filename,
        origin: 'local',
      }));
    }
    throw new Error('no filenames found for local ChangeResult');
  }

  // this will eventually have async call to figure out the target file locations for remote changes
  // eslint-disable-next-line @typescript-eslint/require-await
  private async remoteChangesToOutputRows(input: ChangeResult): Promise<StatusOutputRow[]> {
    this.logger.debug('converting ChangeResult to a row', input);
    this.forceIgnore = this.forceIgnore ?? ForceIgnore.findAndCreate(this.project.getDefaultPackage().path);
    const baseObject: StatusOutputRow = {
      type: input.type ?? '',
      origin: input.origin,
      state: stateFromChangeResult(input),
      fullName: input.name ?? '',
    };
    // it's easy to check ignores if the filePaths exist locally
    if (input.filenames?.length) {
      return input.filenames.map((filename) => ({
        ...baseObject,
        filePath: filename,
        ignored: this.forceIgnore.denies(filename),
      }));
    }
    // when the file doesn't exist locally, there are no filePaths
    // So we can't say whether it's ignored or not
    return [baseObject];
  }
}

const remoteFilterByState = {
  add: (change: RemoteChangeElement): boolean => !change.deleted && !change.modified,
  modify: (change: RemoteChangeElement): boolean => change.modified === true,
  delete: (change: RemoteChangeElement): boolean => change.deleted === true,
  nondelete: (change: RemoteChangeElement): boolean => !change.deleted,
};

const stateFromChangeResult = (input: ChangeResult): 'add' | 'delete' | 'modify' => {
  if (input.deleted) {
    return 'delete';
  }
  if (input.modified) {
    return 'modify';
  }
  return 'add';
};
