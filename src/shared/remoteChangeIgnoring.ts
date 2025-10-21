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
import { ForceIgnore, MetadataComponent, MetadataMember, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { SfError } from '@salesforce/core/sfError';
import { filePathsFromMetadataComponent } from '@salesforce/source-deploy-retrieve/lib/src/utils/filePathGenerator';
import { ChangeResult } from './types';
import { isChangeResultWithNameAndType } from './guards';
import { ChangeResultWithNameAndType } from './types';
import { forceIgnoreDenies, changeResultToMetadataComponent } from './functions';

export const removeIgnored = (
  changeResults: ChangeResult[],
  forceIgnore: ForceIgnore,
  defaultPkgDir: string,
  registry: RegistryAccess
): MetadataMember[] =>
  changeResults
    .map(ensureNameAndType)
    .map(changeResultToMetadataComponent(registry))
    .filter((mc) => !filePathsFromMetadataComponent(mc, defaultPkgDir).some(forceIgnoreDenies(forceIgnore)))
    .map(metadataComponentToMetadataMember);

const metadataComponentToMetadataMember = (mc: MetadataComponent): MetadataMember => ({
  type: mc.type.name,
  fullName: mc.fullName,
});

export const ensureNameAndType = (cr: ChangeResult): ChangeResultWithNameAndType => {
  if (isChangeResultWithNameAndType(cr)) {
    return cr;
  }
  throw new SfError(`Change Result is missing name or type: ${JSON.stringify(cr)}`);
};
