/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
export type FilenameBasenameHash = { filename: string; hash: string; basename: string };
export type StringMap = Map<string, string>;
export type AddAndDeleteMaps = { addedMap: StringMap; deletedMap: StringMap }; // https://isomorphic-git.org/docs/en/statusMatrix#docsNav

export type StatusRow = [file: string, head: number, workdir: number, stage: number];
