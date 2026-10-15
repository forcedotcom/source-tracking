/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * Vendored from salesforcedx-vscode/packages/eslint-local-rules/src/noExplicitEffectReturnType.ts
 * (originally Copyright (c) 2025, salesforce.com, inc., BSD-3-Clause).
 *
 * Bans explicit `: Effect.Effect<...>` and `: Effect.fn.Return<...>` return type annotations.
 * Let TypeScript infer the return type so generic inference (especially the error channel) works correctly.
 */
'use strict';

const getTypeName = (typeName) => {
  if (typeName.type === 'Identifier') return typeName.name;
  if (typeName.type === 'TSQualifiedName') return `${getTypeName(typeName.left)}.${typeName.right.name}`;
  return '';
};

const isExplicitEffectReturnType = (typeAnnotation) => {
  if (!typeAnnotation) return false;
  const type = typeAnnotation.typeAnnotation;
  if (!type || type.type !== 'TSTypeReference') return false;

  return ['Effect', 'Effect.Effect', 'Effect.fn.Return'].includes(getTypeName(type.typeName));
};

const createFix = (sourceCode, returnTypeNode) => (fixer) => {
  if (!returnTypeNode.range) return null;
  const beforeToken = sourceCode.getTokenBefore(returnTypeNode);
  if (!beforeToken) return null;
  return fixer.removeRange([beforeToken.range[1], returnTypeNode.range[1]]);
};

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent explicit return type annotations for Effect functions',
    },
    fixable: 'code',
    schema: [],
    messages: {
      noExplicitEffectReturnType: 'Do not declare explicit Effect return types. Let TypeScript infer the return type.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const report = (returnType) => {
      context.report({
        node: returnType,
        messageId: 'noExplicitEffectReturnType',
        fix: createFix(sourceCode, returnType),
      });
    };
    return {
      FunctionDeclaration(node) {
        if (isExplicitEffectReturnType(node.returnType)) report(node.returnType);
      },
      ArrowFunctionExpression(node) {
        if (isExplicitEffectReturnType(node.returnType)) report(node.returnType);
      },
      MethodDefinition(node) {
        if (isExplicitEffectReturnType(node.value.returnType)) report(node.value.returnType);
      },
      FunctionExpression(node) {
        if (node.parent && node.parent.type === 'MethodDefinition') return;
        if (isExplicitEffectReturnType(node.returnType)) report(node.returnType);
      },
    };
  },
};
