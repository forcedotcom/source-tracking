/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * eslint-plugin-local-rules expects this module to export the rules object directly
 * (not wrapped in { rules }). See node_modules/eslint-plugin-local-rules/index.js.
 */
'use strict';

module.exports = {
  'no-explicit-effect-return-type': require('./noExplicitEffectReturnType.cjs'),
};
