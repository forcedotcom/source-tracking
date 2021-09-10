/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/member-ordering */

import * as path from 'path';
import { promises as fs, existsSync } from 'fs';
import { retryDecorator } from 'ts-retry-promise';
import { ConfigFile, Logger, Org, SfdxError, Messages } from '@salesforce/core';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { Dictionary, Optional } from '@salesforce/ts-types';
import { env, toNumber } from '@salesforce/kit';
import { RemoteSyncInput } from '../shared/types';
import { getMetadataKeyFromFileResponse } from './metadataKeys';

export type MemberRevision = {
  serverRevisionCounter: number;
  lastRetrievedFromServer: number | null;
  memberType: string;
  isNameObsolete: boolean;
};

export type SourceMember = {
  MemberType: string;
  MemberName: string;
  IsNameObsolete: boolean;
  RevisionCounter: number;
};

export type RemoteChangeElement = {
  name: string;
  type: string;
  deleted?: boolean;
  modified?: boolean;
};

// represents the contents of the config file stored in 'maxRevision.json'
interface Contents {
  serverMaxRevisionCounter: number;
  sourceMembers: Dictionary<MemberRevision>;
}

export namespace RemoteSourceTrackingService {
  // Constructor Options for RemoteSourceTrackingService.
  export interface Options extends ConfigFile.Options {
    orgId: string;
    /** only used for connecting to the org */
    username: string;
  }
}

export const getMetadataKey = (metadataType: string, metadataName: string): string => {
  return `${metadataType}__${metadataName}`;
};

/**
 * This service handles source tracking of metadata between a local project and an org.
 * Source tracking state is persisted to .sfdx/orgs/<orgId>/maxRevision.json.
 * This JSON file keeps track of `SourceMember` objects and the `serverMaxRevisionCounter`,
 * which is the highest `serverRevisionCounter` value of all the tracked elements.
 *
 * Each SourceMember object has 4 fields:
 * * serverRevisionCounter: the current RevisionCounter on the server for this object
 * * lastRetrievedFromServer: the RevisionCounter last retrieved from the server for this object
 * * memberType: the metadata name of the SourceMember
 * * isNameObsolete: `true` if this object has been deleted in the org
 *
 * ex.
 ```
 {
    serverMaxRevisionCounter: 3,
    sourceMembers: {
      ApexClass__MyClass: {
        serverRevisionCounter: 3,
        lastRetrievedFromServer: 2,
        memberType: ApexClass,
        isNameObsolete: false
      },
      CustomObject__Student__c: {
        serverRevisionCounter: 1,
        lastRetrievedFromServer: 1,
        memberType: CustomObject,
        isNameObsolete: false
      }
    }
  }
  ```
 * In this example, `ApexClass__MyClass` has been changed in the org because the `serverRevisionCounter` is different
 * from the `lastRetrievedFromServer`. When a pull is performed, all of the pulled members will have their counters set
 * to the corresponding `RevisionCounter` from the `SourceMember` of the org.
 */
// eslint-disable-next-line no-redeclare
export class RemoteSourceTrackingService extends ConfigFile<RemoteSourceTrackingService.Options> {
  private static remoteSourceTrackingServiceDictionary: Dictionary<RemoteSourceTrackingService> = {};
  protected logger!: Logger;
  private org!: Org;
  private isSourceTrackedOrg = true;

  // A short term cache (within the same process) of query results based on a revision.
  // Useful for source:pull, which makes 3 of the same queries; during status, building manifests, after pull success.
  private queryCache = new Map<number, SourceMember[]>();

  //
  //  * * * * *  P U B L I C    M E T H O D S  * * * * *
  //

  /**
   * Get the singleton instance for a given user.
   *
   * @param {RemoteSourceTrackingService.Options} options that contain the org's username
   * @returns {Promise<RemoteSourceTrackingService>} the remoteSourceTrackingService object for the given username
   */
  public static async getInstance(options: RemoteSourceTrackingService.Options): Promise<RemoteSourceTrackingService> {
    if (!this.remoteSourceTrackingServiceDictionary[options.orgId]) {
      this.remoteSourceTrackingServiceDictionary[options.orgId] = await RemoteSourceTrackingService.create(options);
    }
    return this.remoteSourceTrackingServiceDictionary[options.orgId] as RemoteSourceTrackingService;
  }

  public static getFileName(): string {
    return 'maxRevision.json';
  }

  public static getFilePath(orgId: string): string {
    return path.join('.sfdx', 'orgs', orgId, RemoteSourceTrackingService.getFileName());
  }

  public static async delete(orgId: string): Promise<string> {
    const fileToDelete = RemoteSourceTrackingService.getFilePath(orgId);
    // the file might not exist, in which case we don't need to delete it
    if (existsSync(fileToDelete)) {
      await fs.rm(fileToDelete, { recursive: true });
    }
    return path.isAbsolute(fileToDelete) ? fileToDelete : path.join(process.cwd(), fileToDelete);
  }

  /**
   * Initializes the service with existing remote source tracking data, or sets
   * the state to begin source tracking of metadata changes in the org.
   */
  public async init(): Promise<void> {
    this.org = await Org.create({ aliasOrUsername: this.options.username });
    this.logger = await Logger.child(this.constructor.name);
    this.options.filePath = path.join('orgs', this.org.getOrgId());
    this.options.filename = RemoteSourceTrackingService.getFileName();

    try {
      await super.init();
    } catch (err) {
      throw SfdxError.wrap(err as Error);
    }

    const contents = this.getTypedContents();
    // Initialize a new maxRevision.json if the file doesn't yet exist.
    if (!contents.serverMaxRevisionCounter && !contents.sourceMembers) {
      try {
        // To find out if the associated org has source tracking enabled, we need to make a query
        // for SourceMembers.  If a certain error is thrown during the query we won't try to do
        // source tracking for this org.  Calling querySourceMembersFrom() has the extra benefit
        // of caching the query so we don't have to make an identical request in the same process.
        await this.querySourceMembersFrom({ fromRevision: 0 });

        this.logger.debug('Initializing source tracking state');
        contents.serverMaxRevisionCounter = 0;
        contents.sourceMembers = {};
        await this.write();
      } catch (e) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        if (
          e instanceof SfdxError &&
          e.name === 'INVALID_TYPE' &&
          e.message.includes("sObject type 'SourceMember' is not supported")
        ) {
          // non-source-tracked org E.G. DevHub or trailhead playground
          this.isSourceTrackedOrg = false;
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * pass in a set of metadata keys (type__name like 'ApexClass__MyClass').\
   * it sets their last retrieved revision to the current revision counter from the server.
   */
  public async syncSpecifiedElements(elements: RemoteSyncInput[]): Promise<void> {
    if (elements.length === 0) {
      return;
    }
    const quiet = elements.length > 100;
    if (quiet) {
      this.logger.debug(`Syncing ${elements.length} Revisions by key`);
    }

    const revisions = this.getSourceMembers();

    // this can be super-repetitive on a large ExperienceBundle where there is an element for each file but only one Revision for the entire bundle
    // any item in an aura/LWC bundle needs to represent the top (bundle) level and the file itself
    // so we de-dupe via a set
    Array.from(new Set(elements.map((element) => getMetadataKeyFromFileResponse(element)).flat())).map(
      (metadataKey) => {
        const revision = revisions[metadataKey];
        if (revision && revision.lastRetrievedFromServer !== revision.serverRevisionCounter) {
          if (!quiet) {
            this.logger.debug(
              `Syncing ${metadataKey} revision from ${revision.lastRetrievedFromServer} to ${revision.serverRevisionCounter}`
            );
          }
          revision.lastRetrievedFromServer = revision.serverRevisionCounter;
          this.setMemberRevision(metadataKey, revision);
        } else {
          this.logger.warn(`found no matching revision for ${metadataKey}`);
        }
      }
    );

    await this.write();
  }

  /**
   * Returns the `ChangeElement` currently being tracked given a metadata key,
   * or `undefined` if not found.
   *
   * @param key string of the form, `<type>__<name>` e.g.,`ApexClass__MyClass`
   */
  public getTrackedElement(key: string): RemoteChangeElement | undefined {
    const memberRevision = this.getSourceMembers()[key];
    if (memberRevision) {
      return RemoteSourceTrackingService.convertRevisionToChange(key, memberRevision);
    }
  }

  /**
   * Returns an array of `ChangeElements` currently being tracked.
   */
  public getTrackedElements(): RemoteChangeElement[] {
    return Object.keys(this.getSourceMembers())
      .map((key) => this.getTrackedElement(key))
      .filter(Boolean) as RemoteChangeElement[];
  }

  /**
   * Resets source tracking state by first clearing all tracked data, then
   * queries and synchronizes SourceMembers from the associated org.
   *
   * If a toRevision is passed, it will query for all `SourceMembers` with
   * a `RevisionCounter` less than or equal to the provided revision number.
   *
   * When no toRevision is passed, it will query and sync all `SourceMembers`.
   *
   * @param toRevision The `RevisionCounter` number to sync to.
   */
  public async reset(toRevision?: number): Promise<string[]> {
    // Called during a source:tracking:reset
    this.setServerMaxRevision(0);
    this.initSourceMembers();

    let members: SourceMember[];
    if (toRevision != null) {
      members = await this.querySourceMembersTo(toRevision);
    } else {
      members = await this.querySourceMembersFrom({ fromRevision: 0 });
    }

    await this.trackSourceMembers(members, true);
    return members.map((member) => getMetadataKey(member.MemberType, member.MemberName));
  }

  //
  //  * * * * *  P R I V A T E    M E T H O D S  * * * * *
  //

  private static convertRevisionToChange(memberKey: string, memberRevision: MemberRevision): RemoteChangeElement {
    return {
      type: memberRevision.memberType,
      name: memberKey.replace(`${memberRevision.memberType}__`, ''),
      deleted: memberRevision.isNameObsolete,
    };
  }

  private getServerMaxRevision(): number {
    return (this['contents'] as Contents).serverMaxRevisionCounter;
  }

  private setServerMaxRevision(revision = 0): void {
    (this['contents'] as Contents).serverMaxRevisionCounter = revision;
  }

  private getSourceMembers(): Dictionary<MemberRevision> {
    return (this['contents'] as Contents).sourceMembers;
  }

  private initSourceMembers(): void {
    (this['contents'] as Contents).sourceMembers = {};
  }

  // Return a tracked element as MemberRevision data.
  private getSourceMember(key: string): Optional<MemberRevision> {
    return this.getSourceMembers()[key];
  }

  private setMemberRevision(key: string, sourceMember: MemberRevision): void {
    this.getTypedContents().sourceMembers[key] = sourceMember;
  }

  private getTypedContents(): Contents {
    return this.getContents() as unknown as Contents;
  }
  // Adds the given SourceMembers to the list of tracked MemberRevisions, optionally updating
  // the lastRetrievedFromServer field (sync), and persists the changes to maxRevision.json.
  public async trackSourceMembers(sourceMembers: SourceMember[], sync = false): Promise<void> {
    if (sourceMembers.length === 0) {
      return;
    }
    const quiet = sourceMembers.length > 100;
    if (quiet) {
      this.logger.debug(`Upserting ${sourceMembers.length} SourceMembers to maxRevision.json`);
    }

    let serverMaxRevisionCounter = this.getServerMaxRevision();
    sourceMembers.forEach((change) => {
      // try accessing the sourceMembers object at the index of the change's name
      // if it exists, we'll update the fields - if it doesn't, we'll create and insert it
      const key = getMetadataKey(change.MemberType, change.MemberName);
      let sourceMember = this.getSourceMember(key);
      if (sourceMember) {
        // We are already tracking this element so we'll update it
        if (!quiet) {
          let msg = `Updating ${key} to RevisionCounter: ${change.RevisionCounter}`;
          if (sync) {
            msg += ' and syncing';
          }
          this.logger.debug(msg);
        }
        sourceMember.serverRevisionCounter = change.RevisionCounter;
        sourceMember.isNameObsolete = change.IsNameObsolete;
      } else {
        // We are not yet tracking it so we'll insert a new record
        if (!quiet) {
          let msg = `Inserting ${key} with RevisionCounter: ${change.RevisionCounter}`;
          if (sync) {
            msg += ' and syncing';
          }
          this.logger.debug(msg);
        }
        sourceMember = {
          serverRevisionCounter: change.RevisionCounter,
          lastRetrievedFromServer: null,
          memberType: change.MemberType,
          isNameObsolete: change.IsNameObsolete,
        };
      }

      // If we are syncing changes then we need to update the lastRetrievedFromServer field to
      // match the RevisionCounter from the SourceMember.
      if (sync) {
        sourceMember.lastRetrievedFromServer = change.RevisionCounter;
      }
      // Keep track of the highest RevisionCounter for setting the serverMaxRevisionCounter
      if (change.RevisionCounter > serverMaxRevisionCounter) {
        serverMaxRevisionCounter = change.RevisionCounter;
      }
      // Update the state with the latest SourceMember data
      this.setMemberRevision(key, sourceMember);
    });
    // Update the serverMaxRevisionCounter to the highest RevisionCounter
    this.setServerMaxRevision(serverMaxRevisionCounter);
    this.logger.debug(`Updating serverMaxRevisionCounter to ${serverMaxRevisionCounter}`);

    await this.write();
  }

  /**
   * Queries the org for any new, updated, or deleted metadata and updates
   * source tracking state.  All `ChangeElements` not in sync with the org
   * are returned.
   */

  // Internal implementation of the public `retrieveUpdates` function that adds the ability
  // to sync the retrieved SourceMembers; meaning it will update the lastRetrievedFromServer
  // field to the SourceMember's RevisionCounter, and update the serverMaxRevisionCounter
  // to the highest RevisionCounter.
  public async retrieveUpdates({ sync = false, cache = true } = {}): Promise<RemoteChangeElement[]> {
    // Always track new SourceMember data, or update tracking when we sync.
    const queriedSourceMembers = await this.querySourceMembersFrom({ useCache: cache });
    if (queriedSourceMembers.length || sync) {
      await this.trackSourceMembers(queriedSourceMembers, sync);
    }

    // Look for any changed that haven't been synced.  I.e, the lastRetrievedFromServer
    // does not match the serverRevisionCounter.
    const trackedRevisions = this.getSourceMembers();
    const returnElements: RemoteChangeElement[] = [];

    for (const key of Object.keys(trackedRevisions)) {
      const member = trackedRevisions[key];
      if (member && member.serverRevisionCounter !== member.lastRetrievedFromServer) {
        returnElements.push(RemoteSourceTrackingService.convertRevisionToChange(key, member));
      }
    }

    if (returnElements.length) {
      this.logger.debug(`Found ${returnElements.length} elements not synced with org`);
    } else {
      this.logger.debug('Remote source tracking is up to date');
    }

    return returnElements;
  }

  /**
   * Polls the org for SourceMember objects matching the provided metadata member names,
   * stopping when all members have been matched or the polling timeout is met or exceeded.
   * NOTE: This can be removed when the Team Dependency (TD-0085369) for W-7737094 is delivered.
   *
   * @param expectedMemberNames Array of metadata names to poll
   * @param pollingTimeout maximum amount of time in seconds to poll for SourceMembers
   */
  public async pollForSourceTracking(expectedMembers: RemoteSyncInput[]): Promise<void> {
    if (env.getBoolean('SFDX_DISABLE_SOURCE_MEMBER_POLLING', false)) {
      this.logger.warn('Not polling for SourceMembers since SFDX_DISABLE_SOURCE_MEMBER_POLLING = true.');
      return;
    }

    if (expectedMembers.length === 0) {
      // Don't bother polling if we're not matching SourceMembers
      return;
    }
    const adjustedExpectedMembers = expectedMembers.filter(
      (fileResponse) =>
        // unchanged files will never be in the sourceMembers.  Not really sure why SDR returns them.
        fileResponse.state !== ComponentStatus.Unchanged &&
        // aura meta.xml aren't tracked as SourceMembers
        !(
          fileResponse.filePath?.startsWith('AuraDefinition') &&
          fileResponse.filePath?.endsWith('.cmp-meta.xml') &&
          // if a listView is the only change inside an object, the object won't have a sourceMember change.  We won't wait for those to be found
          fileResponse.type !== 'CustomObject'
        )
    );
    const fromRevision = this.getServerMaxRevision();
    const pollingTimeout = this.calculateTimeout(adjustedExpectedMembers.length);
    this.logger.debug(
      `Polling for ${adjustedExpectedMembers.length} SourceMembers from revision ${fromRevision} with timeout of ${pollingTimeout}s`
    );

    const outstandingSourceMembers = new Map();

    // filter known Source tracking issues
    adjustedExpectedMembers.map((member) => {
      getMetadataKeyFromFileResponse(member).map((key) => outstandingSourceMembers.set(key, member));
    });

    let pollAttempts = 0;
    const poll = async (): Promise<void> => {
      pollAttempts += 1; // not used to stop polling, but for debug logging

      // get sourceMembers since maxRevision
      const queriedMembers = await this.querySourceMembersFrom({
        fromRevision,
        quiet: pollAttempts !== 1,
        useCache: false,
      });

      // remove anything returned from the query list
      queriedMembers.map((member) => {
        outstandingSourceMembers.delete(getMetadataKey(member.MemberType, member.MemberName));
      });

      this.logger.debug(
        `[${pollAttempts}] Found ${adjustedExpectedMembers.length - outstandingSourceMembers.size} of ${
          adjustedExpectedMembers.length
        } SourceMembers`
      );

      // update but don't sync
      await this.trackSourceMembers(queriedMembers, false);

      // exit if all have returned
      if (outstandingSourceMembers.size === 0) {
        return;
      }

      if (outstandingSourceMembers.size < 20) {
        this.logger.debug(
          outstandingSourceMembers.size < 20
            ? `Still looking for SourceMembers: ${Array.from(outstandingSourceMembers.keys()).join(',')}`
            : `Still looking for ${outstandingSourceMembers.size} Source Members`
        );
      }
      throw new Error();
    };
    const pollingFunction = retryDecorator(poll, {
      timeout: pollingTimeout * 1000,
      delay: 1000,
      retries: 'INFINITELY',
    });
    try {
      await pollingFunction();
      this.logger.debug(`Retrieved all SourceMember data after ${pollAttempts} attempts`);
    } catch {
      this.logger.warn(`Polling for SourceMembers timed out after ${pollAttempts} attempts`);
      if (outstandingSourceMembers.size < 51) {
        this.logger.debug(
          `Could not find ${outstandingSourceMembers.size} SourceMembers: ${Array.from(outstandingSourceMembers).join(
            ','
          )}`
        );
      } else {
        this.logger.debug(`Could not find SourceMembers for ${outstandingSourceMembers.size} components`);
      }
    }
  }

  private calculateTimeout(memberCount: number): number {
    const overriddenTimeout = toNumber(env.getString('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT', '0'));
    if (overriddenTimeout > 0) {
      this.logger.debug(`Overriding SourceMember polling timeout to ${overriddenTimeout}`);
      return overriddenTimeout;
    }

    // Calculate a polling timeout for SourceMembers based on the number of
    // member names being polled plus a buffer of 5 seconds.  This will
    // wait 50s for each 1000 components, plus 5s.
    const pollingTimeout = Math.ceil(memberCount * 0.05) + 5;
    this.logger.debug(`Computed SourceMember polling timeout of ${pollingTimeout}s`);
    return pollingTimeout;
  }

  private async querySourceMembersFrom({
    fromRevision,
    quiet = false,
    useCache = true,
  }: { fromRevision?: number; quiet?: boolean; useCache?: boolean } = {}): Promise<SourceMember[]> {
    const rev = fromRevision != null ? fromRevision : this.getServerMaxRevision();

    if (useCache) {
      // Check cache first and return if found.
      const cachedQueryResult = this.queryCache.get(rev);
      if (cachedQueryResult) {
        this.logger.debug(`Using cache for SourceMember query for revision ${rev}`);
        return cachedQueryResult;
      }
    }

    // because `serverMaxRevisionCounter` is always updated, we need to select > to catch the most recent change
    const query = `SELECT MemberType, MemberName, IsNameObsolete, RevisionCounter FROM SourceMember WHERE RevisionCounter > ${rev}`;
    const queryResult = await this.query<SourceMember>(query, quiet);
    this.queryCache.set(rev, queryResult);

    return queryResult;
  }

  private async querySourceMembersTo(toRevision: number, quiet = false): Promise<SourceMember[]> {
    const query = `SELECT MemberType, MemberName, IsNameObsolete, RevisionCounter FROM SourceMember WHERE RevisionCounter <= ${toRevision}`;
    return this.query<SourceMember>(query, quiet);
  }

  private async query<T>(query: string, quiet = false): Promise<T[]> {
    if (!this.isSourceTrackedOrg) {
      Messages.importMessagesDirectory(__dirname);
      this.messages = Messages.loadMessages('@salesforce/source-tracking', 'source');
      throw SfdxError.create('@salesforce/source-tracking', 'source', 'NonSourceTrackedOrgError');
    }
    if (!quiet) {
      this.logger.debug(query);
    }

    try {
      const results = await this.org.getConnection().tooling.autoFetchQuery<T>(query);
      return results.records;
    } catch (error) {
      throw SfdxError.wrap(error as Error);
    }
  }
}
