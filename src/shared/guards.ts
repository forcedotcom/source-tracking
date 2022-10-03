/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { SourceComponent, MetadataMember } from '@salesforce/source-deploy-retrieve';

export const sourceComponentGuard = (input: SourceComponent | undefined): input is SourceComponent => input instanceof SourceComponent;

export const metadataMemberGuard = (input: MetadataMember | undefined): input is MetadataMember => input !== undefined && typeof input.fullName === 'string' && typeof input.type === 'string';
