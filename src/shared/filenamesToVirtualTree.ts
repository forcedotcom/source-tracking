/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import { VirtualTreeContainer, VirtualDirectory } from '@salesforce/source-deploy-retrieve';

/**
 * Designed for recreating virtual files from deleted files where the only information we have is the file's former location
 * Any use of MetadataResolver was trying to access the non-existent files and throwing
 *
 * @param filenames full paths to files
 * @returns VirtualTreeContainer to use with MetadataResolver
 */
export const filenamesToVirtualTree = (filenames: string[]): VirtualTreeContainer => {
  const virtualDirectoryByFullPath = new Map<string, VirtualDirectory>();
  filenames.map((filename) => {
    const splits = filename.split(path.sep);
    for (let i = 0; i < splits.length - 1; i++) {
      const fullPathSoFar = splits.slice(0, i + 1).join(path.sep);
      if (virtualDirectoryByFullPath.has(fullPathSoFar)) {
        const existing = virtualDirectoryByFullPath.get(fullPathSoFar) as VirtualDirectory;
        // only add to children if we don't already have it
        if (!existing.children.includes(splits[i + 1])) {
          virtualDirectoryByFullPath.set(fullPathSoFar, {
            dirPath: existing.dirPath,
            children: [...existing.children, splits[i + 1]],
          });
        }
      } else {
        virtualDirectoryByFullPath.set(fullPathSoFar, {
          dirPath: fullPathSoFar,
          children: [splits[i + 1]],
        });
      }
    }
  });
  return new VirtualTreeContainer(Array.from(virtualDirectoryByFullPath.values()));
};
