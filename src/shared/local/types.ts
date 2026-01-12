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

export type DetectionFileInfo = Readonly<{ filename: string; hash: string; basename: string }>;
export type DetectionFileInfoWithType = Readonly<
  DetectionFileInfo & { type: string; parentFullName: string; parentType: string }
>;
export type StringMap = Map<string, string>;
export type AddAndDeleteMaps = { addedMap: StringMap; deletedMap: StringMap }; // https://isomorphic-git.org/docs/en/statusMatrix#docsNav

export type StatusRow = [file: string, head: number, workdir: number, stage: number];
