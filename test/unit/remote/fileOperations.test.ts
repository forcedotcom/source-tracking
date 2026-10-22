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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import fs from 'graceful-fs';
import sinon from 'sinon';
import { SfError } from '@salesforce/core';
import * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { readFileContents, writeTrackingFile } from '../../../src/shared/remote/fileOperations.js';
import { ContentsJsonSchema, type MemberRevision } from '../../../src/shared/remote/types.js';

const FILE_VERSION_ENV = 'SF_SOURCE_TRACKING_FILE_VERSION';

const member: MemberRevision = {
  MemberType: 'ApexClass',
  MemberName: 'MyClass',
  IsNameObsolete: false,
  IsNewMember: false,
  RevisionCounter: 3,
  MemberIdOrName: 'MyClass',
  ChangedBy: '00e000000000001',
  LastModifiedDate: '2026-01-01T00:00:00.000Z',
  lastRetrievedFromServer: 2,
};

describe('remote tracking file operations', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'source-tracking-remote-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    delete process.env[FILE_VERSION_ENV];
  });

  it('writes and reads the current Schema format', async () => {
    process.env[FILE_VERSION_ENV] = '1';
    const filePath = path.join(directory, 'maxRevision.json');

    await Effect.runPromise(
      writeTrackingFile({ filePath, maxCounter: 3, members: new Map([['ApexClass###MyClass', member]]) })
    );

    const fileContents = Schema.decodeUnknownSync(ContentsJsonSchema)(await readFile(filePath, 'utf8'));
    expect(fileContents).to.deep.equal({
      fileVersion: 1,
      serverMaxRevisionCounter: 3,
      sourceMembers: { 'ApexClass###MyClass': member },
    });
    expect(await Effect.runPromise(readFileContents(filePath))).to.deep.equal(fileContents);
  });

  it('reads and upgrades the legacy Schema format to the current in-memory format', async () => {
    delete process.env[FILE_VERSION_ENV];
    const filePath = path.join(directory, 'maxRevision.json');

    await Effect.runPromise(
      writeTrackingFile({ filePath, maxCounter: 3, members: new Map([['ApexClass###MyClass', member]]) })
    );

    const fileContents = Schema.decodeUnknownSync(ContentsJsonSchema)(await readFile(filePath, 'utf8'));
    expect(fileContents).to.deep.equal({
      fileVersion: 0,
      serverMaxRevisionCounter: 3,
      sourceMembers: {
        ['ApexClass__MyClass']: {
          memberType: 'ApexClass',
          serverRevisionCounter: 3,
          lastRetrievedFromServer: 2,
          isNameObsolete: false,
        },
      },
    });
    const upgradedContents = await Effect.runPromise(readFileContents(filePath));
    expect(upgradedContents).to.deep.equal({
      fileVersion: 1,
      serverMaxRevisionCounter: 3,
      sourceMembers: {
        'ApexClass###MyClass': {
          MemberType: 'ApexClass',
          MemberName: 'MyClass',
          IsNameObsolete: false,
          RevisionCounter: 3,
          lastRetrievedFromServer: 2,
          ChangedBy: 'unknown',
          MemberIdOrName: 'unknown',
          LastModifiedDate: 'unknown',
        },
      },
    });
    expect(Schema.decodeUnknownSync(ContentsJsonSchema)(JSON.stringify(upgradedContents))).to.deep.equal(
      upgradedContents
    );
  });

  it('merges concurrent snapshots under the file lock instead of losing either update', async () => {
    const filePath = path.join(directory, 'maxRevision.json');
    await Effect.runPromise(writeTrackingFile({ filePath, maxCounter: 0, members: new Map() }));

    await Effect.runPromise(
      Effect.all(
        [
          writeTrackingFile({
            filePath,
            maxCounter: 1,
            baseMaxCounter: 0,
            members: new Map([['ApexClass###First', { ...member, MemberName: 'First', RevisionCounter: 1 }]]),
          }),
          writeTrackingFile({
            filePath,
            maxCounter: 2,
            baseMaxCounter: 0,
            members: new Map([['ApexClass###Second', { ...member, MemberName: 'Second', RevisionCounter: 2 }]]),
          }),
        ],
        { concurrency: 'unbounded' }
      )
    );

    const contents = await Effect.runPromise(readFileContents(filePath));
    expect(contents).to.have.property('serverMaxRevisionCounter', 2);
    expect(contents).to.have.nested.property('sourceMembers.ApexClass###First');
    expect(contents).to.have.nested.property('sourceMembers.ApexClass###Second');
  });

  it('holds the lock during interruption until the underlying write settles', async () => {
    const filePath = path.join(directory, 'maxRevision.json');
    const started = Deferred.makeUnsafe<void>();
    const finish = Deferred.makeUnsafe<void>();
    const writeFile = fs.promises.writeFile;
    const stub = sinon.stub(fs.promises, 'writeFile').callsFake(async (...args) => {
      Deferred.doneUnsafe(started, Effect.void);
      await Effect.runPromise(finish.pipe(Deferred.await));
      return writeFile(...args);
    });
    const controller = new AbortController();
    const completed = Effect.runPromiseExit(
      writeTrackingFile({ filePath, maxCounter: 3, members: new Map([['ApexClass###MyClass', member]]) }),
      { signal: controller.signal }
    );
    try {
      await Effect.runPromise(started.pipe(Deferred.await));
      controller.abort();
      const settled = await Promise.race([
        completed.then(() => true),
        Effect.runPromise(Effect.sleep('25 millis').pipe(Effect.as(false))),
      ]);
      expect(settled).to.equal(false);
      expect(fs.existsSync(`${filePath}.lock`)).to.equal(true);
    } finally {
      Deferred.doneUnsafe(finish, Effect.void);
      await completed;
      stub.restore();
    }
    const exit = await completed;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).to.equal(true);
    expect(fs.existsSync(`${filePath}.lock`)).to.equal(false);
    expect(await Effect.runPromise(readFileContents(filePath))).to.have.property('serverMaxRevisionCounter', 3);
  });

  it('preserves SfError and releases the lock when writing fails', async () => {
    const filePath = path.join(directory, 'maxRevision.json');
    const stub = sinon.stub(fs.promises, 'writeFile').rejects(new Error('write failed'));
    try {
      const exit = await Effect.runPromiseExit(writeTrackingFile({ filePath, maxCounter: 3, members: new Map() }));
      expect(Exit.isFailure(exit)).to.equal(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).to.equal(true);
        if (Option.isSome(error)) {
          expect(error.value).to.be.instanceOf(SfError);
          expect(error.value.message).to.equal('write failed');
        }
      }
      expect(fs.existsSync(`${filePath}.lock`)).to.equal(false);
    } finally {
      stub.restore();
    }
  });

  it('preserves a completed sync when an older snapshot commits concurrently', async () => {
    const filePath = path.join(directory, 'maxRevision.json');
    const unsynced = { ...member, lastRetrievedFromServer: undefined };
    const synced = { ...member, lastRetrievedFromServer: member.RevisionCounter };
    await Effect.runPromise(
      writeTrackingFile({ filePath, maxCounter: 3, members: new Map([['ApexClass###MyClass', unsynced]]) })
    );

    await Effect.runPromise(
      Effect.all(
        [
          writeTrackingFile({
            filePath,
            maxCounter: 3,
            baseMaxCounter: 3,
            members: new Map([['ApexClass###MyClass', synced]]),
          }),
          writeTrackingFile({
            filePath,
            maxCounter: 3,
            baseMaxCounter: 3,
            members: new Map([['ApexClass###MyClass', unsynced]]),
          }),
        ],
        { concurrency: 'unbounded' }
      )
    );

    const contents = await Effect.runPromise(readFileContents(filePath));
    expect(contents).to.have.nested.property('sourceMembers.ApexClass###MyClass.lastRetrievedFromServer', 3);
  });

  it('ignores a stale operation that finishes after a tracking reset', async () => {
    const filePath = path.join(directory, 'maxRevision.json');
    await Effect.runPromise(
      writeTrackingFile({
        filePath,
        maxCounter: 5,
        members: new Map([['ApexClass###BeforeReset', { ...member, MemberName: 'BeforeReset', RevisionCounter: 5 }]]),
      })
    );
    await Effect.runPromise(
      writeTrackingFile({
        filePath,
        maxCounter: 3,
        replace: true,
        members: new Map([['ApexClass###AtReset', { ...member, MemberName: 'AtReset', RevisionCounter: 3 }]]),
      })
    );
    await Effect.runPromise(
      writeTrackingFile({
        filePath,
        maxCounter: 6,
        baseMaxCounter: 5,
        members: new Map([['ApexClass###StaleQuery', { ...member, MemberName: 'StaleQuery', RevisionCounter: 6 }]]),
      })
    );

    const contents = await Effect.runPromise(readFileContents(filePath));
    expect(contents).to.have.property('serverMaxRevisionCounter', 3);
    expect(contents).to.have.nested.property('sourceMembers.ApexClass###AtReset');
    expect(contents).not.to.have.nested.property('sourceMembers.ApexClass###StaleQuery');
  });
});
