/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import path from 'node:path';
import fs from 'node:fs';
import { EOL } from 'node:os';
import { retryDecorator, NotRetryableError } from 'ts-retry-promise';
import { envVars as env, Logger, Org, Messages, Lifecycle, SfError, Connection, lockInit } from '@salesforce/core';
import { Duration, parseJsonMap } from '@salesforce/kit';
import { isString } from '@salesforce/ts-types';
import {
  ChangeResult,
  RemoteChangeElement,
  MemberRevision,
  SourceMember,
  RemoteSyncInput,
  SourceMemberPollingEvent,
} from './types';
import { getMetadataKeyFromFileResponse, mappingsForSourceMemberTypesToMetadataType } from './metadataKeys';
import { getMetadataKey } from './functions';
import { calculateExpectedSourceMembers } from './expectedSourceMembers';

/** represents the contents of the config file stored in 'maxRevision.json' */
export type Contents = {
  serverMaxRevisionCounter: number;
  sourceMembers: Record<string, MemberRevision>;
};
type MemberRevisionMapEntry = [string, MemberRevision];
type PinoLogger = ReturnType<(typeof Logger)['getRawRootLogger']>;

const FILENAME = 'maxRevision.json';

/*
 * after some results have returned, how many times should we poll for missing sourcemembers
 * even when there is a longer timeout remaining (because the deployment is very large)
 */
const POLLING_DELAY_MS = 1000;
const CONSECUTIVE_EMPTY_POLLING_RESULT_LIMIT =
  (env.getNumber('SF_SOURCE_MEMBER_POLLING_TIMEOUT') ?? 120) / Duration.milliseconds(POLLING_DELAY_MS).seconds;

/** Options for RemoteSourceTrackingService.getInstance */
export type RemoteSourceTrackingServiceOptions = {
  org: Org;
  projectPath: string;
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
export class RemoteSourceTrackingService {
  /** map of constructed, init'ed instances; key is orgId.  It's like a singleton at the org level */
  private static instanceMap = new Map<string, RemoteSourceTrackingService>();
  public readonly filePath: string;

  private logger!: PinoLogger;
  private serverMaxRevisionCounter = 0;
  private sourceMembers = new Map<string, MemberRevision>();

  private org: Org;

  // A short term cache (within the same process) of query results based on a revision.
  // Useful for source:pull, which makes 3 of the same queries; during status, building manifests, after pull success.
  private queryCache = new Map<number, SourceMember[]>();

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
    let service = this.instanceMap.get(orgId);
    if (!service) {
      service = await new RemoteSourceTrackingService(options).init();
      this.instanceMap.set(orgId, service);
    }
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
   * pass in a set of metadata keys (type__name like 'ApexClass__MyClass').\
   * it sets their last retrieved revision to the current revision counter from the server.
   */
  public async syncSpecifiedElements(elements: RemoteSyncInput[]): Promise<void> {
    if (elements.length === 0) {
      return;
    }
    const quietLogger =
      elements.length > 100 ? this.logger.silent.bind(this.logger) : this.logger.debug.bind(this.logger);
    quietLogger(`Syncing ${elements.length} Revisions by key`);

    // this can be super-repetitive on a large ExperienceBundle where there is an element for each file but only one Revision for the entire bundle
    // any item in an aura/LWC bundle needs to represent the top (bundle) level and the file itself
    // so we de-dupe via a set
    Array.from(new Set(elements.flatMap((element) => getMetadataKeyFromFileResponse(element)))).map((metadataKey) => {
      const revision = this.sourceMembers.get(metadataKey) ?? this.sourceMembers.get(decodeURI(metadataKey));
      if (!revision) {
        this.logger.warn(`found no matching revision for ${metadataKey}`);
      } else if (doesNotMatchServer(revision)) {
        quietLogger(
          `Syncing ${metadataKey} revision from ${revision.lastRetrievedFromServer ?? 'null'} to ${
            revision.serverRevisionCounter
          }`
        );
        this.setMemberRevision(metadataKey, { ...revision, lastRetrievedFromServer: revision.serverRevisionCounter });
      }
    });

    await this.write();
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
        : await this.querySourceMembersFrom({ fromRevision: 0 });

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
  public async retrieveUpdates({ sync = false, cache = true } = {}): Promise<RemoteChangeElement[]> {
    // Always track new SourceMember data, or update tracking when we sync.
    const queriedSourceMembers = await this.querySourceMembersFrom({ useCache: cache });
    if (queriedSourceMembers.length || sync) {
      await this.trackSourceMembers(queriedSourceMembers, sync);
    }

    // Look for any changed that haven't been synced.  I.e, the lastRetrievedFromServer
    // does not match the serverRevisionCounter.
    const returnElements = Array.from(this.sourceMembers.entries())
      .filter(revisionDoesNotMatch)
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
  public async pollForSourceTracking(expectedMembers: RemoteSyncInput[]): Promise<void> {
    if (env.getBoolean('SF_DISABLE_SOURCE_MEMBER_POLLING')) {
      this.logger.warn('Not polling for SourceMembers since SF_DISABLE_SOURCE_MEMBER_POLLING = true.');
      return;
    }

    if (expectedMembers.length === 0) {
      return;
    }

    const outstandingSourceMembers = calculateExpectedSourceMembers(expectedMembers);

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
      const queriedMembers = await this.querySourceMembersFrom({
        fromRevision: highestRevisionSoFar,
        quiet: pollAttempts !== 1,
        useCache: false,
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
   * Adds the given SourceMembers to the list of tracked MemberRevisions,  optionally updating
   * the lastRetrievedFromServer field (sync), and persists the changes to maxRevision.json.
   */
  private async trackSourceMembers(sourceMembers: SourceMember[], sync = false): Promise<void> {
    if (sourceMembers.length === 0) {
      return;
    }
    const quietLogger =
      sourceMembers.length > 100 ? this.logger.silent.bind(this.logger) : this.logger.debug.bind(this.logger);
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
      const sourceMember = this.getSourceMember(key) ?? {
        serverRevisionCounter: change.RevisionCounter,
        lastRetrievedFromServer: null,
        memberType: change.MemberType,
        isNameObsolete: change.IsNameObsolete,
      };
      if (sourceMember.lastRetrievedFromServer) {
        // We are already tracking this element so we'll update it
        quietLogger(`Updating ${key} to RevisionCounter: ${change.RevisionCounter}${sync ? ' and syncing' : ''}`);
        sourceMember.serverRevisionCounter = change.RevisionCounter;
        sourceMember.isNameObsolete = change.IsNameObsolete;
      } else {
        // We are not yet tracking it so we'll insert a new record
        quietLogger(`Inserting ${key} with RevisionCounter: ${change.RevisionCounter}${sync ? ' and syncing' : ''}`);
      }

      // If we are syncing changes then we need to update the lastRetrievedFromServer field to
      // match the RevisionCounter from the SourceMember.
      if (sync) {
        sourceMember.lastRetrievedFromServer = change.RevisionCounter;
      }

      // Update the state with the latest SourceMember data
      this.setMemberRevision(key, sourceMember);
    });

    await this.write();
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
      await this.write();
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
    this.sourceMembers.set(matchingKey, sourceMember);
  }

  private async querySourceMembersFrom({
    fromRevision,
    quiet = false,
    useCache = true,
  }: { fromRevision?: number; quiet?: boolean; useCache?: boolean } = {}): Promise<SourceMember[]> {
    const rev = fromRevision ?? this.serverMaxRevisionCounter;

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
    this.logger[quiet ? 'silent' : 'debug'](`Query: ${query}`);
    const queryResult = await queryFn(this.org.getConnection(), query);
    this.queryCache.set(rev, queryResult);

    return queryResult;
  }

  private async write(): Promise<void> {
    const lockResult = await lockInit(this.filePath);
    await lockResult.writeAndUnlock(
      JSON.stringify(
        {
          serverMaxRevisionCounter: this.serverMaxRevisionCounter,
          sourceMembers: Object.fromEntries(this.sourceMembers),
        },
        null,
        4
      )
    );
  }
}

/**
 * pass in an RCE, and this will return a pullable ChangeResult.
 * Useful for correcing bundle types where the files show change results with types but aren't resolvable
 */
export const remoteChangeElementToChangeResult = (rce: RemoteChangeElement): ChangeResult => ({
  ...rce,
  ...(mappingsForSourceMemberTypesToMetadataType.has(rce.type)
    ? {
        name: rce.name.split('/')[0],
        type: mappingsForSourceMemberTypesToMetadataType.get(rce.type),
      }
    : {}),
  origin: 'remote', // we know they're remote
});

const revisionToRemoteChangeElement = ([memberKey, memberRevision]: MemberRevisionMapEntry): RemoteChangeElement => ({
  type: memberRevision.memberType,
  name: memberKey.replace(`${memberRevision.memberType}__`, ''),
  deleted: memberRevision.isNameObsolete,
});

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

const getFilePath = (orgId: string): string => path.join('.sf', 'orgs', orgId, FILENAME);

const readFileContents = async (filePath: string): Promise<Contents | Record<string, never>> => {
  try {
    const contents = await fs.promises.readFile(filePath, 'utf8');
    return parseJsonMap<Contents>(contents, filePath);
  } catch (e) {
    Logger.childFromRoot('remoteSourceTrackingService:readFileContents').debug(
      `Error reading or parsing file file at ${filePath}.  Will treat as an empty file.`,
      e
    );

    return {};
  }
};

export const calculateTimeout =
  (logger: PinoLogger) =>
  (memberCount: number): Duration => {
    const overriddenTimeout = env.getNumber('SF_SOURCE_MEMBER_POLLING_TIMEOUT', 0);
    if (overriddenTimeout > 0) {
      logger.debug(`Overriding SourceMember polling timeout to ${overriddenTimeout}`);
      return Duration.seconds(overriddenTimeout);
    }

    // Calculate a polling timeout for SourceMembers based on the number of
    // member names being polled plus a buffer of 5 seconds.  This will
    // wait 50s for each 1000 components, plus 5s.
    const pollingTimeout = Math.ceil(memberCount * 0.05) + 5;
    logger.debug(`Computed SourceMember polling timeout of ${pollingTimeout}s`);
    return Duration.seconds(pollingTimeout);
  };

/** exported only for spy/mock  */
export const querySourceMembersTo = async (conn: Connection, toRevision: number): Promise<SourceMember[]> => {
  const query = `SELECT MemberType, MemberName, IsNameObsolete, RevisionCounter FROM SourceMember WHERE RevisionCounter <= ${toRevision}`;
  return queryFn(conn, query);
};

const queryFn = async (conn: Connection, query: string): Promise<SourceMember[]> => {
  try {
    return (await conn.tooling.query<SourceMember>(query, { autoFetch: true, maxFetch: 50_000 })).records.map(
      sourceMemberCorrections
    );
  } catch (error) {
    throw SfError.wrap(error);
  }
};

/** organize by type and format for warning output */
const formatSourceMemberWarnings = (outstandingSourceMembers: Map<string, RemoteSyncInput>): string => {
  // ex: CustomObject : [Foo__c, Bar__c]
  const mapByType = Array.from(outstandingSourceMembers.values()).reduce<Map<string, string[]>>((acc, value) => {
    acc.set(value.type, [...(acc.get(value.type) ?? []), value.fullName]);
    return acc;
  }, new Map());
  return Array.from(mapByType.entries())
    .map(([type, names]) => `  - ${type}: ${names.join(', ')}`)
    .join(EOL);
};

const revisionDoesNotMatch = ([, member]: MemberRevisionMapEntry): boolean => doesNotMatchServer(member);

const doesNotMatchServer = (member: MemberRevision): boolean =>
  member.serverRevisionCounter !== member.lastRetrievedFromServer;

/** A series of workarounds for server-side bugs.  Each bug should be filed against a team, with a WI, so we know when these are fixed and can be removed */
const sourceMemberCorrections = (sourceMember: SourceMember): SourceMember => {
  if (sourceMember.MemberType === 'QuickActionDefinition') {
    return { ...sourceMember, MemberType: 'QuickAction' }; // W-15837125
  }
  return sourceMember;
};
