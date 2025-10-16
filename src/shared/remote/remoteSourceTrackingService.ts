/*
 * Copyright 2025, Salesforce, Inc.
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

import path from 'node:path';
import { EOL } from 'node:os';
import { retryDecorator, NotRetryableError } from 'ts-retry-promise';
import { envVars as env, Logger, Org, Messages, Lifecycle, SfError, fs } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { isString } from '@salesforce/ts-types';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ChangeResult, RemoteChangeElement, RemoteSyncInput, SourceMemberPollingEvent } from '../types.js';
import { getMetadataKeyFromFileResponse, getMappingsForSourceMemberTypesToMetadataType } from '../metadataKeys.js';
import { getMetadataKey } from '../functions.js';
import { calculateExpectedSourceMembers } from './expectedSourceMembers.js';
import { SourceMember } from './types.js';
import { MemberRevision } from './types.js';
import {
  FILENAME,
  getFilePath,
  readFileContents,
  revisionToRemoteChangeElement,
  writeTrackingFile,
} from './fileOperations.js';
import { calculateTimeout, querySourceMembersFrom, querySourceMembersTo } from './orgQueries.js';

export type PinoLogger = ReturnType<(typeof Logger)['getRawRootLogger']>;

/*
 * after some results have returned, how many times should we poll for missing sourcemembers
 * even when there is a longer timeout remaining (because the deployment is very large)
 */
const POLLING_DELAY_MS = 1000;
const CONSECUTIVE_EMPTY_POLLING_RESULT_LIMIT =
  (env.getNumber('SF_SOURCE_MEMBER_POLLING_TIMEOUT') ?? 120) / Duration.milliseconds(POLLING_DELAY_MS).seconds;

/** if a cached instance is older than this, it will be purged */
const MAX_INSTANCE_CACHE_TTL = 1000 * 60 * 60 * 1; // 1 hour

/** Options for RemoteSourceTrackingService.getInstance */
type RemoteSourceTrackingServiceOptions = {
  org: Org;
  projectPath: string;
};

/**
 * This service handles source tracking of metadata between a local project and an org.
 * Source tracking state is persisted to .sfdx/orgs/<orgId>/maxRevision.json.
 * This JSON file keeps track of `SourceMember` objects and the `serverMaxRevisionCounter`,
 * which is the highest `RevisionCounter` value of all the tracked elements.
 *
 * See @MemberRevision for the structure of the `MemberRevision` object.  It's SourceMember (the tooling sobject) with the additional lastRetrievedFromServer field
 ```
 {
    fileVersion: 1,
    serverMaxRevisionCounter: 3,
    sourceMembers: {
      ApexClass###MyClass: {
        RevisionCounter: 3,
        MemberType: ApexClass,
        ...,
        lastRetrievedFromServer: 2,
      },
      CustomObject###Student__c: {
        RevisionCounter: 1,
        MemberType: CustomObject,
        ...,
        lastRetrievedFromServer: 1,
      }
    }
  }
  ```
 * In this example, `ApexClass###MyClass` has been changed in the org because the `serverRevisionCounter` is different
 * from the `lastRetrievedFromServer`. When a pull is performed, all of the pulled members will have their counters set
 * to the corresponding `RevisionCounter` from the `SourceMember` of the org.
 *
 * Tracking files are written to the older format described in `MemberRevisionLegacy`
 * if the environment variable CURRENT_FILE_VERSION_ENV is not set to 1
 *
 * The "in memorgy" storage is in MemberRevision format.
 */
type CachedInstance = {
  service: RemoteSourceTrackingService;
  lastUsed: number;
};

export class RemoteSourceTrackingService {
  /** map of constructed, init'ed instances; key is orgId.  It's like a singleton at the org level */
  private static instanceMap = new Map<string, CachedInstance>();
  public readonly filePath: string;

  private logger!: PinoLogger;
  private serverMaxRevisionCounter = 0;
  private sourceMembers = new Map<string, MemberRevision>();

  private org: Org;

  // A short term cache (within the same process) of query results based on a revision.
  // Useful for source:pull, which makes 3 of the same queries; during status, building manifests, after pull success.
  private queryCache = new Map<number, SourceMember[]>();
  private userQueryCache = new Map<string, string>();

  /**
   * Initializes the service with existing remote source tracking data, or sets
   * the state to begin source tracking of metadata changes in the org.
   */
  private constructor(options: RemoteSourceTrackingServiceOptions) {
    this.org = options.org;
    this.filePath = path.join(options.projectPath, '.sf', 'orgs', this.org.getOrgId(), FILENAME);
  }

  /**
   * Get the singleton instance for a given user.
   *
   * @param {RemoteSourceTrackingService.Options} options that contain the org
   * @returns {Promise<RemoteSourceTrackingService>} the remoteSourceTrackingService object for the given username
   */
  public static async getInstance(options: RemoteSourceTrackingServiceOptions): Promise<RemoteSourceTrackingService> {
    const orgId = options.org.getOrgId();
    const service = this.instanceMap.get(orgId)?.service ?? (await new RemoteSourceTrackingService(options).init());
    this.instanceMap.set(orgId, { service, lastUsed: Date.now() });
    // when we get an instance, we make sure old ones are not accumulating.  Important in multitenant environments
    purgeOldInstances(this.instanceMap);

    // even if there was already an instance around, its queries might no longer be accurate (ex: missing new changes but queryFrom would return stale results)
    service.queryCache.clear();
    service.userQueryCache.clear();
    service.org = options.org;
    return service;
  }

  /**
   * Delete the RemoteSourceTracking for a given org.
   *
   * @param orgId
   * @returns the path of the deleted source tracking file
   */
  public static async delete(orgId: string): Promise<string> {
    const fileToDelete = getFilePath(orgId);
    // the file might not exist, in which case we don't need to delete it
    if (fs.existsSync(fileToDelete)) {
      await fs.promises.unlink(fileToDelete);
    }
    return path.isAbsolute(fileToDelete) ? fileToDelete : path.join(process.cwd(), fileToDelete);
  }

  /**
   * pass in a series of SDR FilResponses .\
   * it sets their last retrieved revision to the current revision counter from the server.
   */
  public async syncSpecifiedElements(elements: RemoteSyncInput[], registry: RegistryAccess): Promise<void> {
    if (elements.length === 0) {
      return;
    }
    const quietLogger =
      elements.length > 100
        ? this.logger.silent?.bind(this.logger) ?? ((): void => {})
        : this.logger.debug.bind(this.logger);
    quietLogger(`Syncing ${elements.length} Revisions by key`);

    // this can be super-repetitive on a large ExperienceBundle where there is an element for each file but only one Revision for the entire bundle
    // any item in an aura/LWC bundle needs to represent the top (bundle) level and the file itself
    // so we de-dupe via a set
    Array.from(new Set(elements.flatMap((element) => getMetadataKeyFromFileResponse(registry)(element)))).map(
      (metadataKey) => {
        const revision = this.sourceMembers.get(metadataKey) ?? this.sourceMembers.get(decodeURI(metadataKey));
        if (!revision) {
          this.logger.warn(`found no matching revision for ${metadataKey}`);
        } else if (doesNotMatchServer(revision)) {
          quietLogger(
            `Syncing ${metadataKey} revision from ${revision.lastRetrievedFromServer ?? 'null'} to ${
              revision.RevisionCounter
            }`
          );
          this.setMemberRevision(metadataKey, {
            ...revision,
            lastRetrievedFromServer: revision.RevisionCounter,
          });
        }
      }
    );

    await writeTrackingFile({
      filePath: this.filePath,
      maxCounter: this.serverMaxRevisionCounter,
      members: this.sourceMembers,
    });
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
    this.serverMaxRevisionCounter = 0;
    this.sourceMembers = new Map<string, MemberRevision>();

    const members =
      toRevision !== undefined && toRevision !== null
        ? await querySourceMembersTo(this.org.getConnection(), toRevision)
        : await querySourceMembersFrom({
            fromRevision: 0,
            logger: this.logger,
            userQueryCache: this.userQueryCache,
            queryCache: this.queryCache,
            conn: this.org.getConnection(),
          });

    await this.trackSourceMembers(members, true);
    return members.map((member) => getMetadataKey(member.MemberType, member.MemberName));
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
  public async retrieveUpdates(): Promise<RemoteChangeElement[]> {
    // Always track new SourceMember data, or update tracking when we sync.
    const queriedSourceMembers = await querySourceMembersFrom({
      fromRevision: this.serverMaxRevisionCounter,
      logger: this.logger,
      userQueryCache: this.userQueryCache,
      queryCache: this.queryCache,
      conn: this.org.getConnection(),
    });
    await this.trackSourceMembers(queriedSourceMembers);

    // Look for any changed that haven't been synced.  I.e, the lastRetrievedFromServer
    // does not match the serverRevisionCounter.
    const returnElements = Array.from(this.sourceMembers.values())
      .filter(doesNotMatchServer)
      .map(revisionToRemoteChangeElement);

    this.logger.debug(
      returnElements.length
        ? `Found ${returnElements.length} elements not synced with org`
        : 'Remote source tracking is up to date'
    );

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
  public async pollForSourceTracking(registry: RegistryAccess, expectedMembers: RemoteSyncInput[]): Promise<void> {
    if (env.getBoolean('SF_DISABLE_SOURCE_MEMBER_POLLING')) {
      return this.logger.warn('Not polling for SourceMembers since SF_DISABLE_SOURCE_MEMBER_POLLING = true.');
    }

    if (expectedMembers.length === 0) {
      return;
    }

    const outstandingSourceMembers = calculateExpectedSourceMembers(registry, expectedMembers);

    const originalOutstandingSize = outstandingSourceMembers.size;
    // this will be the absolute timeout from the start of the poll.  We can also exit early if it doesn't look like more results are coming in
    let highestRevisionSoFar = this.serverMaxRevisionCounter;
    const pollingTimeout = calculateTimeout(this.logger)(outstandingSourceMembers.size);
    let pollAttempts = 0;
    let consecutiveEmptyResults = 0;
    let someResultsReturned = false;
    /** we weren't expecting these SourceMembers, based on the deployment results  */
    const bonusTypes = new Set<string>();

    this.logger.debug(
      `Polling for ${outstandingSourceMembers.size} SourceMembers from revision ${highestRevisionSoFar} with timeout of ${pollingTimeout.seconds}s`
    );

    const poll = async (): Promise<void> => {
      pollAttempts += 1; // not used to stop polling, but for debug logging

      // get sourceMembers added since our most recent max
      // use the "new highest" revision from the last poll that returned results
      const queriedMembers = await querySourceMembersFrom({
        conn: this.org.getConnection(),
        fromRevision: highestRevisionSoFar,
        logger: pollAttempts > 1 ? undefined : this.logger,
      });

      if (queriedMembers.length) {
        queriedMembers.map((member) => {
          // remove anything returned from the query list
          const metadataKey = getMetadataKey(member.MemberType, member.MemberName);
          const deleted = outstandingSourceMembers.delete(metadataKey);
          if (!deleted) {
            bonusTypes.add(metadataKey);
          }
          highestRevisionSoFar = Math.max(highestRevisionSoFar, member.RevisionCounter);
        });
        consecutiveEmptyResults = 0;
        // flips on the first batch of results
        someResultsReturned = true;
      } else {
        consecutiveEmptyResults++;
      }

      await Lifecycle.getInstance().emit('sourceMemberPollingEvent', {
        original: originalOutstandingSize,
        remaining: outstandingSourceMembers.size,
        attempts: pollAttempts,
        consecutiveEmptyResults,
      } satisfies SourceMemberPollingEvent);

      this.logger.debug(
        `[${pollAttempts}] Found ${
          originalOutstandingSize - outstandingSourceMembers.size
        } of ${originalOutstandingSize} expected SourceMembers`
      );

      // update but don't sync
      await this.trackSourceMembers(queriedMembers, false);

      // exit if all have returned
      if (outstandingSourceMembers.size === 0) {
        return;
      }

      if (someResultsReturned && consecutiveEmptyResults >= CONSECUTIVE_EMPTY_POLLING_RESULT_LIMIT) {
        throw new NotRetryableError(`Polling found no results for ${consecutiveEmptyResults} consecutive attempts`);
      }

      this.logger.debug(
        outstandingSourceMembers.size < 20
          ? `Still looking for SourceMembers: ${Array.from(outstandingSourceMembers.keys()).join(',')}`
          : `Still looking for ${outstandingSourceMembers.size} Source Members`
      );

      throw new Error();
    };
    const pollingFunction = retryDecorator(poll, {
      timeout: pollingTimeout.milliseconds,
      delay: POLLING_DELAY_MS,
      retries: 'INFINITELY',
    });
    const lc = Lifecycle.getInstance();
    try {
      await pollingFunction();
      this.logger.debug(`Retrieved all SourceMember data after ${pollAttempts} attempts`);
      // find places where the expectedSourceMembers might be too pruning too aggressively
      if (bonusTypes.size) {
        void lc.emitTelemetry({
          eventName: 'sourceMemberBonusTypes',
          library: 'SourceTracking',
          deploymentSize: expectedMembers.length,
          bonusTypes: Array.from(bonusTypes).sort().join(','),
        });
      }
    } catch {
      await Promise.all([
        lc.emitWarning(
          `Polling for ${
            outstandingSourceMembers.size
          } SourceMembers timed out after ${pollAttempts} attempts (last ${consecutiveEmptyResults} were empty).

Missing SourceMembers:
${formatSourceMemberWarnings(outstandingSourceMembers)}`
        ),
        lc.emitTelemetry({
          eventName: 'sourceMemberPollingTimeout',
          library: 'SourceTracking',
          timeoutSeconds: pollingTimeout.seconds,
          attempts: pollAttempts,
          consecutiveEmptyResults,
          missingQuantity: outstandingSourceMembers.size,
          deploymentSize: expectedMembers.length,
          bonusTypes: Array.from(bonusTypes).sort().join(','),
          types: [...new Set(Array.from(outstandingSourceMembers.values()).map((member) => member.type))]
            .sort()
            .join(','),
          members: Array.from(outstandingSourceMembers.keys()).join(','),
        }),
      ]);
    }
  }

  /**
   * Adds the given SourceMembers to the list of tracked MemberRevisions, optionally updating
   * the lastRetrievedFromServer field (sync), and persists the changes to maxRevision.json.
   */
  private async trackSourceMembers(sourceMembers: SourceMember[], sync = false): Promise<void> {
    if (sourceMembers.length === 0) {
      return;
    }
    const quietLogger =
      sourceMembers.length > 100
        ? this.logger.silent?.bind(this.logger) ?? ((): void => {})
        : this.logger.debug.bind(this.logger);
    quietLogger(`Upserting ${sourceMembers.length} SourceMembers to maxRevision.json`);

    // Update the serverMaxRevisionCounter to the highest RevisionCounter
    this.serverMaxRevisionCounter = Math.max(
      this.serverMaxRevisionCounter,
      ...sourceMembers.map((m) => m.RevisionCounter)
    );
    this.logger.debug(`Updating serverMaxRevisionCounter to ${this.serverMaxRevisionCounter}`);

    sourceMembers.map((change) => {
      // try accessing the sourceMembers object at the index of the change's name
      // if it exists, we'll update the fields - if it doesn't, we'll create and insert it
      const key = getMetadataKey(change.MemberType, change.MemberName);
      const sourceMemberFromTracking = this.getSourceMember(key);

      quietLogger(
        `${sourceMemberFromTracking ? `Updating ${key} to` : `Inserting ${key} with`} RevisionCounter: ${
          change.RevisionCounter
        }${sync ? ' and syncing' : ''}`
      );
      this.setMemberRevision(key, {
        ...change,
        // If we are syncing changes then we need to update the lastRetrievedFromServer field to
        // match the RevisionCounter from the SourceMember.
        lastRetrievedFromServer: sync ? change.RevisionCounter : sourceMemberFromTracking?.lastRetrievedFromServer,
      });
    });

    await writeTrackingFile({
      filePath: this.filePath,
      maxCounter: this.serverMaxRevisionCounter,
      members: this.sourceMembers,
    });
  }

  /** reads the tracking file and inits the logger and contents */
  private async init(): Promise<RemoteSourceTrackingService> {
    if (!(await this.org.supportsSourceTracking())) {
      Messages.importMessagesDirectory(__dirname);
      const messages = Messages.loadMessages('@salesforce/source-tracking', 'source');
      throw new SfError(messages.getMessage('NonSourceTrackedOrgError'), 'NonSourceTrackedOrgError');
    }
    this.logger = Logger.getRawRootLogger().child({ name: this.constructor.name });
    if (fs.existsSync(this.filePath)) {
      // read the file contents and turn it into the map
      const rawContents = await readFileContents(this.filePath);
      if (rawContents.serverMaxRevisionCounter && rawContents.sourceMembers) {
        this.serverMaxRevisionCounter = rawContents.serverMaxRevisionCounter;
        this.sourceMembers = new Map(Object.entries(rawContents.sourceMembers ?? {}));
      }
    } else {
      // we need to init the file
      await writeTrackingFile({
        filePath: this.filePath,
        maxCounter: this.serverMaxRevisionCounter,
        members: this.sourceMembers,
      });
    }
    return this;
  }

  /** Return a tracked element as MemberRevision data.*/
  private getSourceMember(key: string): MemberRevision | undefined {
    return (
      this.sourceMembers.get(key) ??
      this.sourceMembers.get(
        getDecodedKeyIfSourceMembersHas({ sourceMembers: this.sourceMembers, key, logger: this.logger })
      )
    );
  }

  private setMemberRevision(key: string, sourceMember: MemberRevision): void {
    const sourceMembers = this.sourceMembers;
    const matchingKey = sourceMembers.get(key)
      ? key
      : getDecodedKeyIfSourceMembersHas({ sourceMembers, key, logger: this.logger });
    this.sourceMembers.set(matchingKey, { ...sourceMember, MemberName: decodeURIComponent(sourceMember.MemberName) });
  }
}

/**
 * pass in an RCE, and this will return a pullable ChangeResult.
 * Useful for correcing bundle types where the files show change results with types but aren't resolvable
 */
export const remoteChangeElementToChangeResult = (
  registry: RegistryAccess
): ((rce: RemoteChangeElement) => ChangeResult) => {
  const mappings = getMappingsForSourceMemberTypesToMetadataType(registry);
  return (rce: RemoteChangeElement): ChangeResult => ({
    ...rce,
    ...(mappings.has(rce.type)
      ? {
          // SNOWFLAKE: EmailTemplateFolder is treated as an alias for EmailFolder so it has a mapping.
          // The name must be handled differently than with bundle types.
          name: rce.type === 'EmailTemplateFolder' ? rce.name : rce.name.split('/')[0],
          type: mappings.get(rce.type),
        }
      : {}),
    origin: 'remote', // we know they're remote
  });
};

/**
 *
 * iterate SourceMember keys and compare their decoded value with the decoded key.
 * if there's a match, return the matching decoded key, otherwise, return the original key
 */
const getDecodedKeyIfSourceMembersHas = ({
  key,
  sourceMembers,
  logger,
}: {
  sourceMembers: Map<string, MemberRevision>;
  key: string;
  logger: PinoLogger;
}): string => {
  try {
    const originalKeyDecoded = decodeURIComponent(key);
    const match = Array.from(sourceMembers.keys()).find(
      (memberKey) => decodeURIComponent(memberKey) === originalKeyDecoded
    );
    if (match) {
      logger.debug(`${match} matches already tracked member: ${key}`);
      return match;
    }
  } catch (e: unknown) {
    // Log the error and the key
    const errMsg = e instanceof Error ? e.message : isString(e) ? e : 'unknown';
    logger.debug(`Could not decode metadata key: ${key} due to: ${errMsg}`);
  }
  return key;
};

/** organize by type and format for warning output */
const formatSourceMemberWarnings = (outstandingSourceMembers: Map<string, RemoteSyncInput>): string => {
  // TODO: use Map.groupBy when we node22 is minimum
  // ex: CustomObject : [Foo__c, Bar__c]
  const mapByType = Array.from(outstandingSourceMembers.values()).reduce<Map<string, string[]>>((acc, value) => {
    acc.set(value.type, [...(acc.get(value.type) ?? []), value.fullName]);
    return acc;
  }, new Map());
  return Array.from(mapByType.entries())
    .map(([type, names]) => `  - ${type}: ${names.join(', ')}`)
    .join(EOL);
};

const doesNotMatchServer = (member: MemberRevision): boolean =>
  member.RevisionCounter !== member.lastRetrievedFromServer;

const purgeOldInstances = (instances: Map<string, CachedInstance>): void => {
  const now = Date.now();
  Array.from(instances.entries())
    .filter(([, { lastUsed }]) => now - lastUsed > MAX_INSTANCE_CACHE_TTL)
    .map(([orgId]) => {
      instances.delete(orgId);
    });
};
