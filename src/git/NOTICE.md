This module derives concepts and algorithms from isomorphic-git
(https://github.com/isomorphic-git/isomorphic-git), Copyright (c) 2017
William Hilton, MIT License. The code here is an independent reimplementation,
not a fork; no isomorphic-git source files are copied. The original project's
documentation of git internals (statusMatrix walker model, index parsing,
loose object format) informed the design of this module.

Changes from isomorphic-git's design:

- Effect-native API (Streams, tagged errors, Schema)
- Bounded global fs concurrency
- Cross-process .git/index.lock (real-git compatible)
- UNTR index extension support
- Scope limited to shadow-repo operations (no network, no packfiles)
