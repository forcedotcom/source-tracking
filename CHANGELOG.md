# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.4.2](https://github.com/forcedotcom/source-tracking/compare/v0.4.1...v0.4.2) (2021-10-28)

### [0.4.1](https://github.com/forcedotcom/source-tracking/compare/v0.4.0...v0.4.1) (2021-10-28)


### Bug Fixes

* better conflict handling (can match filenames or type/name) ([4441a0a](https://github.com/forcedotcom/source-tracking/commit/4441a0abd70c7f8f315e1c638b4cef7fcf3e2e68))
* gitignore stashing location ([5145545](https://github.com/forcedotcom/source-tracking/commit/5145545eeee6c800986014327479d20e943143e5))
* polling exclusion logic for aura meta.xml was wrong ([2d40b2e](https://github.com/forcedotcom/source-tracking/commit/2d40b2ef65ef9a3145d0c75cd4943e4325d5745c))

## 0.4.0 (2021-10-22)


### ⚠ BREAKING CHANGES

* remove retrieve simplifier

### Features

* add commitlint and sample circleci config ([43e7fa4](https://github.com/forcedotcom/source-tracking/commit/43e7fa4a44dbcb9da37d21618678687f4edda644))
* add new tests and upadte readme ([6a7ad54](https://github.com/forcedotcom/source-tracking/commit/6a7ad542f42ce75275ebacc78d50ee4dc0ab6f32))
* add option to get remoteChanges with filePaths, use for Conflicts ([350a0d6](https://github.com/forcedotcom/source-tracking/commit/350a0d60599cfce2c432c223f4523c25a4f53c81))
* basic using isogit ([f39e6c5](https://github.com/forcedotcom/source-tracking/commit/f39e6c5e305fcb2fdb6a27b343d9dc20800202c9))
* conflict detection ([3e22774](https://github.com/forcedotcom/source-tracking/commit/3e22774d8949a1aa4302e62d8580b69c4b35aab5))
* consolidate conflict handling, return data in error ([45178c7](https://github.com/forcedotcom/source-tracking/commit/45178c7b13ed61e657f9a07ea5b40f49f73f651a))
* delete handling public for pull ([eb87eb7](https://github.com/forcedotcom/source-tracking/commit/eb87eb7dfa81ba5256735af7f2b8bc29dfb1e16b))
* finish status, add clear/reset ([c71e66f](https://github.com/forcedotcom/source-tracking/commit/c71e66f7f7a3dc20d2c965349b5e01e15edabf36))
* handle status ignore marking from STL ([2ec6fad](https://github.com/forcedotcom/source-tracking/commit/2ec6fad4b4f4f2e124da7e4f53cf8e534354d342))
* ignorewarnings flag for push ([b13fd05](https://github.com/forcedotcom/source-tracking/commit/b13fd0534930fb063075c39e6f75ea46ab9d3be8))
* migrate messages/descriptions ([8fea6e5](https://github.com/forcedotcom/source-tracking/commit/8fea6e5242c50865dd635412d7592164ab57fec4))
* most of sourceStatus logic, code cleanup ([f100cb8](https://github.com/forcedotcom/source-tracking/commit/f100cb83f220b3724284ae69301712a08b14376d))
* non-delete push works ([487a20e](https://github.com/forcedotcom/source-tracking/commit/487a20e48c428a02ef315b58db24b714d2de0416))
* push supporting bundle types ([639d459](https://github.com/forcedotcom/source-tracking/commit/639d459101cd4990fa217f657b99d64517611383))
* remote and conflicts ([f98ecf1](https://github.com/forcedotcom/source-tracking/commit/f98ecf17fc6cbe386d8edae6994500388b7e0ed6))
* remote tracknig with UT ([cb805e5](https://github.com/forcedotcom/source-tracking/commit/cb805e5745020be9a266a261f584979713e4b351))
* source tracking from toolbelt ([6c2ebb4](https://github.com/forcedotcom/source-tracking/commit/6c2ebb444ce5518eaa81402b685fe00f1090e437))
* sourcemember polling like toolbelt ([abdd7b3](https://github.com/forcedotcom/source-tracking/commit/abdd7b3ad275ea4739673a6e1b1a99853f1de2da))
* spinners while waiting on pull ([dfe5aea](https://github.com/forcedotcom/source-tracking/commit/dfe5aeae0a5f9a30eddfe96852e0dab025972e1e))
* status result sorting ([b7b109c](https://github.com/forcedotcom/source-tracking/commit/b7b109cf3e7bcad60507618099873c717ff31f61))
* sync customObj when their fields sync ([3ded96d](https://github.com/forcedotcom/source-tracking/commit/3ded96dbd7a7ea45cb8f97719b98bae294905c05))
* throws if "old" source files are present ([4b868d8](https://github.com/forcedotcom/source-tracking/commit/4b868d8232769eec5e227052bf823a35baedd288))
* typed push ([6e76812](https://github.com/forcedotcom/source-tracking/commit/6e7681263b81d3b692d002a3ce5deb8ef00bbd13))
* virtualTree for deletes ([b425d77](https://github.com/forcedotcom/source-tracking/commit/b425d77b4fca5c6fbab2faab7490e3516bf3f547))


### Bug Fixes

* again with the promises ([ad9dec5](https://github.com/forcedotcom/source-tracking/commit/ad9dec50336c61996456d48ee489426393c62329))
* another attempt at node12 support ([c8736d0](https://github.com/forcedotcom/source-tracking/commit/c8736d0bbe53756d1b5572e00402e55af94003c1))
* case of empty orgId dir ([1cb6333](https://github.com/forcedotcom/source-tracking/commit/1cb6333d14cfcee02b27711b6db273d5db31fc8e))
* case on formatter filename ([02adf22](https://github.com/forcedotcom/source-tracking/commit/02adf22419d2bf81fb070d7d7d90f7d996bd1ada))
* casing on imports ([d4425d9](https://github.com/forcedotcom/source-tracking/commit/d4425d9ee2ad77c4e28d32333025e59a3c7e3af9))
* correct statusCommand description ([b834a2f](https://github.com/forcedotcom/source-tracking/commit/b834a2fa0213fbc72dbc6dc3a563cd92f413d222))
* don't commit empty changelists ([67b9772](https://github.com/forcedotcom/source-tracking/commit/67b9772eccd6d2d4850322eb80f5a6113aac18e6))
* export compatibility ([c6e5f7c](https://github.com/forcedotcom/source-tracking/commit/c6e5f7cba68ed6a7739b237adb027fda2442e8c4))
* fix vscode image in readme ([441c15f](https://github.com/forcedotcom/source-tracking/commit/441c15f79dbaf4a97c84d9d6ddc923eae59bca34))
* handle org:create's single tracking file ([008793d](https://github.com/forcedotcom/source-tracking/commit/008793d0fa15210ffb263cc5d179a0be8dcb05ff))
* handle stash failures ([09dacc9](https://github.com/forcedotcom/source-tracking/commit/09dacc9484e48f3cba4813f3d733c66d2a30cd6b))
* leif .yml merge [skip-validate-pr] ([ff10f84](https://github.com/forcedotcom/source-tracking/commit/ff10f84ec15757df55657ba73cc6976c5892595c))
* local ST uses graceful via core2 ([3ba883f](https://github.com/forcedotcom/source-tracking/commit/3ba883ff2b02e27b0eb01a709f6c1e03ef91bb73))
* match server subfiles with forward slash ([c2489a6](https://github.com/forcedotcom/source-tracking/commit/c2489a62c244a64fe0938e0eecdc087f4529b5ad))
* normalize windows paths on commit, too ([4339e46](https://github.com/forcedotcom/source-tracking/commit/4339e46a1cb9cbeb4cc652572e340b60e3b5bc68))
* one more fs/promises fixed for node12 ([71bafcf](https://github.com/forcedotcom/source-tracking/commit/71bafcf7738e60d8b86150199ef8d0687167a010))
* path normalizing for metadata keys ([6190590](https://github.com/forcedotcom/source-tracking/commit/6190590df2c2e7cc9a25eab0fa8891e3b8df9057))
* path normalizing from iso-git ([b8cddaf](https://github.com/forcedotcom/source-tracking/commit/b8cddaf40930bedd18f3edec578a030220454627))
* status output on windows uses backslash ([78ac398](https://github.com/forcedotcom/source-tracking/commit/78ac3988d3d04e956f17f35c67de4d1144062fcb))
* support windows path on commits with \\ ([5712af4](https://github.com/forcedotcom/source-tracking/commit/5712af4447ee03e30d7a5a769fc5ba58f6913552))
* there could be nested LWC templates ([d833981](https://github.com/forcedotcom/source-tracking/commit/d8339810bf76c0ab75824faee7aef59ff9a2d89e))
* turns bundle parts of SourceMembers into real MDtypes ([5646042](https://github.com/forcedotcom/source-tracking/commit/564604269be7d56499963699b51920b81227297f))
* use correct var name ([0708312](https://github.com/forcedotcom/source-tracking/commit/0708312c5b4f11cb94539416d0a10b5432850310))


* remove retrieve simplifier ([bd71eef](https://github.com/forcedotcom/source-tracking/commit/bd71eef784bc7c7efd1999ba11193e632aef3d47))
