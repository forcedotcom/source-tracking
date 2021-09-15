/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as fs from 'fs';
import * as path from 'path';
import { Org, SfdxError } from '@salesforce/core';

const newTopic = 'beta'; // change to 'force' when plugin-source becomes default
const oldTopic = 'force'; // change to 'legacy' when plugin-source becomes default

type TrackingFileVersion = 'plugin-source' | 'toolbelt' | 'none';
/**
 * A project can have "old" (toolbelt), "new" (plugin-source) or "none" tracking files
 *
 */
export const getTrackingFileVersion = (org: Org, projectPath: string): TrackingFileVersion => {
  const orgsDir = path.join(projectPath, '.sfdx', 'orgs');
  // has new tracking files based on orgId
  if (fs.existsSync(path.join(orgsDir, org.getOrgId()))) {
    return 'plugin-source';
  }
  const username = org.getUsername();
  if (typeof username === 'string') {
    if (
      // has one of the old files
      fs.existsSync(path.join(orgsDir, username, 'sourcePathInfos.json')) ||
      fs.existsSync(path.join(orgsDir, username, 'maxRevision.json'))
    ) {
      return 'toolbelt';
    }
  }
  return 'none';
};

/**
 * Convenient wrapper for throwing errors with helpful messages so commands don't have to
 *
 * @param org: an Org, typically from a command's this.org
 * @param project: the project path, typically from this.project.
 * @param toValidate: whether your command lives in 'toolbelt' or 'plugin-source'
 * @param command: the command itself including all flags.  Echoed with modification for the user
 */
export const throwIfInvalid = ({
  org,
  projectPath,
  toValidate,
  command,
}: {
  org: Org;
  projectPath: string;
  toValidate: Omit<TrackingFileVersion, 'none'>;
  command: string;
}): void => {
  const trackingFileVersion = getTrackingFileVersion(org, projectPath);
  if (trackingFileVersion === 'none' || trackingFileVersion === toValidate) {
    return;
  }

  // We expected it to be the toolbelt version but it is using the new tracking files
  if (toValidate === 'toolbelt') {
    throw new SfdxError(
      'This command uses a new version of source tracking files.',
      'SourceTrackingFileVersionMismatch',
      [
        `Use the new version of the command ${command.replace(oldTopic, newTopic)} (preserve the tracking files)`,
        `Clear the tracking files by running "sfdx ${newTopic}:source:tracking:clear"`,
      ]
    );
  }
  // We expected it to be the plugin-source version but it is using the old tracking files
  if (toValidate === 'plugin-source') {
    throw new SfdxError(
      'This command uses the old version of source tracking files.',
      'SourceTrackingFileVersionMismatch',
      [
        `Use the old version of the command ${command.replace(newTopic, oldTopic)} (preserve the tracking files)`,
        `Clear the tracking files by running "sfdx ${oldTopic}:source:tracking:clear"`,
      ]
    );
  }
};
