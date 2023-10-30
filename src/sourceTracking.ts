/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as fs from 'node:fs';
import { resolve, sep, normalize } from 'node:path';
import { NamedPackageDir, Logger, Org, SfProject, Lifecycle } from '@salesforce/core';
import { AsyncCreatable } from '@salesforce/kit';
import { isString } from '@salesforce/ts-types';
import {
  ComponentSet,
  MetadataResolver,
  ComponentStatus,
  SourceComponent,
  FileResponse,
  ForceIgnore,
  VirtualTreeContainer,
  DeployResult,
  ScopedPreDeploy,
  ScopedPostRetrieve,
  ScopedPreRetrieve,
  ScopedPostDeploy,
  RetrieveResult,
  RegistryAccess,
  FileResponseSuccess,
} from '@salesforce/source-deploy-retrieve';
// this is not exported by SDR (see the comments in SDR regarding its limitations)
import { filePathsFromMetadataComponent } from '@salesforce/source-deploy-retrieve/lib/src/utils/filePathGenerator';
import { RemoteSourceTrackingService, remoteChangeElementToChangeResult } from './shared/remoteSourceTrackingService';
import { ShadowRepo } from './shared/localShadowRepo';
import { throwIfConflicts, findConflictsInComponentSet, getDedupedConflictsFromChanges } from './shared/conflicts';
import {
  RemoteSyncInput,
  StatusOutputRow,
  ChangeOptions,
  ChangeResult,
  ChangeOptionType,
  LocalUpdateOptions,
  RemoteChangeElement,
} from './shared/types';
import { sourceComponentGuard } from './shared/guards';
import { remoteChangeToMetadataMember, removeIgnored } from './shared/remoteChangeIgnoring';
import { supportsPartialDelete, pathIsInFolder, ensureRelative, deleteCustomLabels } from './shared/functions';
import { registrySupportsType } from './shared/metadataKeys';
import { populateFilePaths } from './shared/populateFilePaths';
import { populateTypesAndNames } from './shared/populateTypesAndNames';
import { getComponentSets, getGroupedFiles } from './shared/localComponentSetArray';
export interface SourceTrackingOptions {
  org: Org;
  project: SfProject;

  /** listen for the SDR scoped<Pre|Post><Deploy|Retrieve> events
   * `pre` events will check for conflicts and throw if there are any (use ignoreConflicts: true to disable)
   * `post` events will update tracking files with the results of the deploy/retrieve
   */
  subscribeSDREvents?: boolean;

  /** don't check for conflicts when responding to SDR events.
   * This property has no effect unless you also set subscribeSDREvents to true.
   */
  ignoreConflicts?: boolean;

  /** SourceTracking is caching local file statuses.
   * If you're using STL as part of a long running process (ex: vscode extensions), set this to false
   */
  ignoreLocalCache?: boolean;
}

type RemoteChangesResults = {
  componentSetFromNonDeletes: ComponentSet;
  fileResponsesFromDelete: FileResponse[];
};

/**
 * Manages source tracking files (remote and local)
 *
 * const tracking = await SourceTracking.create({org: this.org, project: this.project});
 *
 */
export class SourceTracking extends AsyncCreatable {
  private org: Org;
  private project: SfProject;
  private projectPath: string;
  private packagesDirs: NamedPackageDir[];
  private logger: Logger;
  // remote and local tracking may not exist if not initialized
  private localRepo!: ShadowRepo;
  private remoteSourceTrackingService!: RemoteSourceTrackingService;
  private forceIgnore!: ForceIgnore;
  private ignoreConflicts: boolean;
  private subscribeSDREvents: boolean;
  private ignoreLocalCache: boolean;
  private orgId: string;

  public constructor(options: SourceTrackingOptions) {
    super(options);
    this.org = options.org;
    this.orgId = this.org.getOrgId();
    this.projectPath = options.project.getPath();
    this.packagesDirs = options.project.getPackageDirectories();
    this.logger = Logger.childFromRoot('SourceTracking');
    this.project = options.project;
    this.ignoreConflicts = options.ignoreConflicts ?? false;
    this.ignoreLocalCache = options.ignoreLocalCache ?? false;
    this.subscribeSDREvents = options.subscribeSDREvents ?? false;
  }

  public async init(): Promise<void> {
    await this.maybeSubscribeLifecycleEvents();
  }

  /**
   *
   * @param byPackageDir if true, returns a ComponentSet for each packageDir that has any changes
   * * if false, returns an array containing one ComponentSet with all changes
   * * if not specified, this method will follow what sfdx-project.json says
   * @returns ComponentSet[]
   */
  public async localChangesAsComponentSet(byPackageDir?: boolean): Promise<ComponentSet[]> {
    const [projectConfig] = await Promise.all([
      this.project.resolveProjectConfig() as {
        sourceApiVersion?: string;
        pushPackageDirectoriesSequentially?: boolean;
      },
      this.ensureLocalTracking(),
    ]);
    const sourceApiVersion = projectConfig.sourceApiVersion;

    const [nonDeletes, deletes] = await Promise.all([
      this.localRepo.getNonDeleteFilenames(),
      this.localRepo.getDeleteFilenames(),
    ]);

    // it'll be easier to filter filenames and work with smaller component sets than to filter SourceComponents
    const groupings = getGroupedFiles(
      {
        packageDirs: this.packagesDirs,
        nonDeletes,
        deletes,
      },
      byPackageDir ?? Boolean(projectConfig.pushPackageDirectoriesSequentially)
    ); // if the users specified true or false for the param, that overrides the project config
    this.logger.debug(`will build array of ${groupings.length} componentSet(s)`);

    return getComponentSets(groupings, sourceApiVersion);
  }

  /** reads tracking files for remote changes.  It DOES NOT consider the effects of .forceignore unless told to */
  public async remoteNonDeletesAsComponentSet({
    applyIgnore = false,
  }: { applyIgnore?: boolean } = {}): Promise<ComponentSet> {
    if (applyIgnore) {
      this.forceIgnore ??= ForceIgnore.findAndCreate(this.project.getDefaultPackage().path);
    }
    const [changeResults, sourceBackedComponents, projectConfig] = await Promise.all([
      // all changes based on remote tracking
      this.getChanges({
        origin: 'remote',
        state: 'nondelete',
        format: 'ChangeResult',
      }),
      // only returns source-backed components (SBC)
      this.getChanges({
        origin: 'remote',
        state: 'nondelete',
        format: 'SourceComponent',
      }),
      this.project.resolveProjectConfig() as {
        sourceApiVersion?: string;
      },
    ]);
    const componentSet = new ComponentSet(
      applyIgnore
        ? sourceBackedComponents.filter((sc) => ![sc.content, sc.xml].some((f) => f && this.forceIgnore.denies(f)))
        : sourceBackedComponents
    );
    // there may be remote adds not in the SBC.  So we add those manually
    (applyIgnore
      ? removeIgnored(changeResults, this.forceIgnore, this.project.getDefaultPackage().fullPath)
      : changeResults.map(remoteChangeToMetadataMember)
    ).forEach((mm) => {
      componentSet.add(mm);
    });

    if (projectConfig.sourceApiVersion) {
      componentSet.sourceApiVersion = projectConfig.sourceApiVersion;
    }
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
        this.getChanges({ origin: 'remote', state: 'delete', format: 'ChangeResult' }),
        this.getChanges({ origin: 'remote', state: 'nondelete', format: 'ChangeResultWithPaths' }),
      ]);
      results = results.concat(
        (
          await Promise.all(remoteDeletes.concat(remoteModifies).map((item) => this.remoteChangesToOutputRows(item)))
        ).flat(1)
      );
    }
    if (local && remote) {
      // keys like ApexClass__MyClass.cls
      const conflictFiles = (await this.getConflicts()).flatMap((conflict) => conflict.filenames).filter(isString);
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
  // you should use one of these
  public async getChanges(options: ChangeOptions & { format: 'string' }): Promise<string[]>;
  public async getChanges(options: ChangeOptions & { format: 'SourceComponent' }): Promise<SourceComponent[]>;
  public async getChanges(options: ChangeOptions & { format: 'ChangeResult' }): Promise<ChangeResult[]>;
  // these following three are deprecated, but remain for backward compatibility
  /**
   * @deprecated omit the type parameter <string>.
   */
  public async getChanges<T extends string>(options: ChangeOptions & { format: 'string' }): Promise<T[]>;
  /**
   * @deprecated omit the type parameter <SourceComponent>.
   */
  public async getChanges<T extends SourceComponent>(
    options: ChangeOptions & { format: 'SourceComponent' }
  ): Promise<T[]>;
  /**
   * @deprecated omit the type parameter <ChangeResult>.
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures
  public async getChanges<T extends ChangeResult>(options: ChangeOptions & { format: 'ChangeResult' }): Promise<T[]>;
  public async getChanges(
    options: ChangeOptions & { format: 'ChangeResultWithPaths' }
  ): Promise<Array<ChangeResult & { filename: string[] }>>;
  public async getChanges(options?: ChangeOptions): Promise<ChangeOptionType[]> {
    if (options?.origin === 'local') {
      await this.ensureLocalTracking();
      const filenames: string[] = await this.getLocalChangesAsFilenames(options.state);
      if (options.format === 'string') {
        return filenames;
      }
      if (options.format === 'ChangeResult' || options.format === 'ChangeResultWithPaths') {
        return filenames.map((filename) => ({
          filenames: [filename],
          origin: 'local',
        }));
      }
      if (options.format === 'SourceComponent') {
        const resolver =
          options.state === 'delete'
            ? new MetadataResolver(undefined, VirtualTreeContainer.fromFilePaths(filenames))
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
          .filter(sourceComponentGuard);
      }
    }

    if (options?.origin === 'remote') {
      await this.ensureRemoteTracking();
      const remoteChanges = await this.remoteSourceTrackingService.retrieveUpdates();
      this.logger.debug('remoteChanges', remoteChanges);
      const filteredChanges = remoteChanges
        .filter(remoteFilterByState[options.state])
        // skip any remote types not in the registry.  Will emit warnings
        .filter((rce) => registrySupportsType(rce.type));
      if (options.format === 'ChangeResult') {
        return filteredChanges.map((change) => remoteChangeElementToChangeResult(change));
      }
      if (options.format === 'ChangeResultWithPaths') {
        return populateFilePaths(
          filteredChanges.map((change) => remoteChangeElementToChangeResult(change)),
          this.project.getPackageDirectories().map((pkgDir) => pkgDir.path)
        );
      }
      // turn it into a componentSet to resolve filenames
      const remoteChangesAsComponentSet = new ComponentSet(
        filteredChanges.map((element) => ({
          type: element?.type,
          fullName: element?.name,
        }))
      );
      const matchingLocalSourceComponentsSet = ComponentSet.fromSource({
        fsPaths: this.packagesDirs.map((dir) => resolve(dir.fullPath)),
        include: remoteChangesAsComponentSet,
      });
      if (options.format === 'string') {
        return matchingLocalSourceComponentsSet
          .getSourceComponents()
          .toArray()
          .flatMap((component) => [component.xml as string, ...component.walkContent()].filter((filename) => filename));
      } else if (options.format === 'SourceComponent') {
        return matchingLocalSourceComponentsSet.getSourceComponents().toArray();
      }
    }
    throw new Error(`unsupported options: ${JSON.stringify(options)}`);
  }

  /**
   *
   * Convenience method to reduce duplicated steps required to do a fka pull
   * It's full of side effects: retrieving remote deletes, deleting those files locall, and then updating tracking files
   * Most bizarrely, it then returns a ComponentSet of the remote nonDeletes and the FileResponses from the delete
   *
   * @returns the ComponentSet for what you would retrieve now that the deletes are done, and optionally, a FileResponses array for the deleted files
   */
  public async maybeApplyRemoteDeletesToLocal(returnDeleteFileResponses: true): Promise<RemoteChangesResults>;
  public async maybeApplyRemoteDeletesToLocal(returnDeleteFileResponses?: false): Promise<ComponentSet>;
  public async maybeApplyRemoteDeletesToLocal(
    returnDeleteFileResponses?: boolean
  ): Promise<ComponentSet | RemoteChangesResults> {
    const changesToDelete = await this.getChanges({ origin: 'remote', state: 'delete', format: 'SourceComponent' });
    const fileResponsesFromDelete = await this.deleteFilesAndUpdateTracking(changesToDelete);
    return returnDeleteFileResponses
      ? {
          componentSetFromNonDeletes: await this.remoteNonDeletesAsComponentSet({ applyIgnore: true }),
          fileResponsesFromDelete,
        }
      : this.remoteNonDeletesAsComponentSet({ applyIgnore: true });
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

    // calculate what to return before we delete any files and .walkContent is no longer valid
    const changedToBeDeleted = changesToDelete.flatMap((component) =>
      [...component.walkContent(), component.xml].map(
        (file): FileResponseSuccess => ({
          state: ComponentStatus.Deleted,
          filePath: file,
          type: component.type.name,
          fullName: component.fullName,
        })
      )
    );

    const filenames = Array.from(sourceComponentByFileName.keys());
    // delete the files
    await Promise.all(
      filenames.map(async (filename) => {
        if (sourceComponentByFileName.get(filename)?.type.id === 'customlabel') {
          await deleteCustomLabels(
            filename,
            changesToDelete.filter((c) => c.type.id === 'customlabel')
          );
        } else {
          return fs.promises.unlink(filename);
        }
      })
    );

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
    return changedToBeDeleted;
  }

  /**
   * Update tracking for the options passed.
   *
   * @param options the files to update
   */
  public async updateLocalTracking(options: LocalUpdateOptions): Promise<void> {
    await this.ensureLocalTracking();

    // relative paths make smaller trees AND isogit wants them relative
    const relativeOptions = {
      files: (options.files ?? []).map((file) => ensureRelative(file, this.projectPath)),
      deletedFiles: (options.deletedFiles ?? []).map((file) => ensureRelative(file, this.projectPath)),
    };
    // plot twist: if you delete a member of a bundle (ex: lwc/foo/foo.css) and push, it'll not be in the fileResponses (deployedFiles) or deletedFiles
    // what got deleted?  Any local changes NOT in the fileResponses but part of a successfully deployed bundle
    const deployedFilesAsVirtualComponentSet = ComponentSet.fromSource({
      // resolve from highest possible level.  TODO: can we use [.]
      fsPaths: relativeOptions.files.length ? [relativeOptions.files[0].split(sep)[0]] : [],
      tree: VirtualTreeContainer.fromFilePaths(relativeOptions.files),
    });
    // these are top-level bundle paths like lwc/foo
    const bundlesWithDeletedFiles = (
      await this.getChanges({ origin: 'local', state: 'delete', format: 'SourceComponent' })
    )
      .filter(supportsPartialDelete)
      .filter((cmp) => deployedFilesAsVirtualComponentSet.has({ type: cmp.type, fullName: cmp.fullName }))
      .map((cmp) => cmp.content)
      .filter(isString);

    await this.localRepo.commitChanges({
      deployedFiles: relativeOptions.files,
      deletedFiles: relativeOptions.deletedFiles.concat(
        (
          await this.localRepo.getDeleteFilenames()
        ).filter(
          (deployedFile) =>
            bundlesWithDeletedFiles.some((bundlePath) => pathIsInFolder(deployedFile, bundlePath)) &&
            !relativeOptions.files.includes(deployedFile)
        )
      ),
    });
  }

  /**
   * Mark remote source tracking files so say that we have received the latest version from the server
   * Optional skip polling for the SourceMembers to exist on the server and be updated in local files
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

  public async reReadLocalTrackingCache(): Promise<void> {
    await this.localRepo.getStatus(true);
  }
  /**
   * If the local tracking shadowRepo doesn't exist, it will be created.
   * Does nothing if it already exists, unless you've instantiate SourceTracking to not cache local status, in which case it'll re-read your files
   * Useful before parallel operations
   */
  public async ensureLocalTracking(): Promise<void> {
    if (this.localRepo) {
      if (this.ignoreLocalCache) {
        await this.localRepo.getStatus(true);
      }
      return;
    }
    this.localRepo = await ShadowRepo.getInstance({
      orgId: this.orgId,
      projectPath: normalize(this.projectPath),
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
      org: this.org,
      projectPath: this.projectPath,
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
    const localChanges = await this.getChanges({
      state: 'nondelete',
      origin: 'local',
      format: 'ChangeResult',
    });
    if (localChanges.length === 0) {
      return [];
    }
    const remoteChanges = await this.getChanges({
      origin: 'remote',
      state: 'nondelete',
      // remote adds won't have a filename, so we ask for it to be resolved
      format: 'ChangeResultWithPaths',
    });
    if (remoteChanges.length === 0) {
      return [];
    }
    this.forceIgnore ??= ForceIgnore.findAndCreate(this.project.getDefaultPackage().path);

    return getDedupedConflictsFromChanges({
      localChanges,
      remoteChanges,
      projectPath: this.projectPath,
      forceIgnore: this.forceIgnore,
    });
  }

  /**
   * handles both remote and local tracking
   *
   * @param result FileResponse[]
   */
  public async updateTrackingFromDeploy(deployResult: DeployResult): Promise<void> {
    const successes = deployResult
      .getFileResponses()
      .filter((fileResponse) => fileResponse.state !== ComponentStatus.Failed && fileResponse.filePath);
    if (!successes.length) {
      return;
    }

    await Promise.all([
      this.updateLocalTracking({
        // assertions allowed because filtered above
        files: successes
          .filter((fileResponse) => fileResponse.state !== ComponentStatus.Deleted)
          .map((fileResponse) => fileResponse.filePath as string),
        deletedFiles: successes
          .filter((fileResponse) => fileResponse.state === ComponentStatus.Deleted)
          .map((fileResponse) => fileResponse.filePath as string),
      }),
      this.updateRemoteTracking(
        successes.map(({ state, fullName, type, filePath }) => ({ state, fullName, type, filePath }))
      ),
    ]);
  }

  /**
   * handles both remote and local tracking
   *
   * @param result FileResponse[]
   */
  public async updateTrackingFromRetrieve(retrieveResult: RetrieveResult): Promise<void> {
    const successes = retrieveResult
      .getFileResponses()
      .filter((fileResponse) => fileResponse.state !== ComponentStatus.Failed);
    if (!successes.length) {
      return;
    }

    await Promise.all([
      this.updateLocalTracking({
        // assertion allowed because it's filtering out undefined
        files: successes
          .filter((fileResponse) => fileResponse.state !== ComponentStatus.Deleted)
          .map((fileResponse) => fileResponse.filePath as string)
          .filter(Boolean),
        deletedFiles: successes
          .filter((fileResponse) => fileResponse.state === ComponentStatus.Deleted)
          .map((fileResponse) => fileResponse.filePath as string)
          .filter(Boolean),
      }),
      this.updateRemoteTracking(
        successes.map(({ state, fullName, type, filePath }) => ({ state, fullName, type, filePath })),
        true // retrieves don't need to poll for SourceMembers
      ),
    ]);
  }

  /**
   * If you've already got an instance of STL, but need to change the conflicts setting
   * normally you set this on instantiation
   *
   * @param value true/false
   */
  public setIgnoreConflicts(value: boolean): void {
    this.ignoreConflicts = value;
  }

  private async maybeSubscribeLifecycleEvents(): Promise<void> {
    if (this.subscribeSDREvents && (await this.org.tracksSource())) {
      const lifecycle = Lifecycle.getInstance();
      // the only thing STL uses pre events for is to check conflicts.  So if you don't care about conflicts, don't listen!
      if (!this.ignoreConflicts) {
        this.logger.debug('subscribing to predeploy/retrieve events');
        // subscribe to SDR `pre` events to handle conflicts before deploy/retrieve
        lifecycle.on(
          'scopedPreDeploy',
          async (e: ScopedPreDeploy) => {
            this.logger.debug('received scopedPreDeploy event');
            if (e.orgId === this.orgId) {
              throwIfConflicts(findConflictsInComponentSet(e.componentSet, await this.getConflicts()));
            }
          },
          `stl#scopedPreDeploy-${this.orgId}`
        );
        lifecycle.on(
          'scopedPreRetrieve',
          async (e: ScopedPreRetrieve) => {
            this.logger.debug('received scopedPreRetrieve event');
            if (e.orgId === this.orgId) {
              throwIfConflicts(findConflictsInComponentSet(e.componentSet, await this.getConflicts()));
            }
          },
          `stl#scopedPreRetrieve-${this.orgId}`
        );
      }
      // subscribe to SDR post-deploy event
      this.logger.debug('subscribing to postdeploy/retrieve events');

      // yes, the post hooks really have different payloads!
      lifecycle.on(
        'scopedPostDeploy',
        async (e: ScopedPostDeploy) => {
          this.logger.debug('received scopedPostDeploy event');
          if (e.orgId === this.orgId && e.deployResult.response.success) {
            await this.updateTrackingFromDeploy(e.deployResult);
          }
        },
        `stl#scopedPostDeploy-${this.orgId}`
      );
      lifecycle.on(
        'scopedPostRetrieve',
        async (e: ScopedPostRetrieve) => {
          this.logger.debug('received scopedPostRetrieve event');
          if (e.orgId === this.orgId && e.retrieveResult.response.success) {
            await this.updateTrackingFromRetrieve(e.retrieveResult);
          }
        },
        `stl#scopedPostRetrieve-${this.orgId}`
      );
    }
  }

  private async getLocalStatusRows(): Promise<StatusOutputRow[]> {
    await this.ensureLocalTracking();

    let results: StatusOutputRow[] = [];
    const localDeletes = populateTypesAndNames({
      elements: await this.getChanges({ origin: 'local', state: 'delete', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      resolveDeleted: true,
      projectPath: this.projectPath,
    });

    const localAdds = populateTypesAndNames({
      elements: await this.getChanges({ origin: 'local', state: 'add', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      projectPath: this.projectPath,
    });

    const localModifies = populateTypesAndNames({
      elements: await this.getChanges({ origin: 'local', state: 'modify', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      projectPath: this.projectPath,
    });

    results = results.concat(
      localAdds.flatMap((item) => this.localChangesToOutputRow(item, 'add')),
      localModifies.flatMap((item) => this.localChangesToOutputRow(item, 'modify')),
      localDeletes.flatMap((item) => this.localChangesToOutputRow(item, 'delete'))
    );
    return results;
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
    this.forceIgnore ??= ForceIgnore.findAndCreate(this.project.getDefaultPackage().path);

    if (input.filenames) {
      return input.filenames.map((filename) => ({
        type: input.type ?? '',
        state: localType,
        fullName: input.name ?? '',
        filePath: filename,
        origin: 'local',
        ignored: this.forceIgnore.denies(filename),
      }));
    }
    throw new Error('no filenames found for local ChangeResult');
  }

  // reserve the right to do something more sophisticated in the future
  // via async for figuring out hypothetical filenames (ex: getting default packageDir)
  // eslint-disable-next-line @typescript-eslint/require-await
  private async remoteChangesToOutputRows(
    input: ChangeResult,
    registry = new RegistryAccess()
  ): Promise<StatusOutputRow[]> {
    this.logger.debug('converting ChangeResult to a row', input);
    this.forceIgnore ??= ForceIgnore.findAndCreate(this.project.getDefaultPackage().path);
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
    // SDR can generate the hypothetical place it *would* go and check that
    if (input.name && input.type) {
      return [
        {
          ...baseObject,
          ignored: filePathsFromMetadataComponent({
            fullName: input.name,
            type: registry.getTypeByName(input.type),
          }).some((hypotheticalFilePath) => this.forceIgnore.denies(hypotheticalFilePath)),
        },
      ];
    }
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
