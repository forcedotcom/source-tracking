/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * Vendored from salesforcedx-vscode/packages/eslint-local-rules/src/noExplicitEffectReturnType.ts
 * (originally Copyright (c) 2025, salesforce.com, inc., BSD-3-Clause).
 *
 * Bans explicit `: Effect.Effect<...>` return type annotations. Let TypeScript infer the
 * return type so generic inference (especially the error channel) works correctly.
 */
'use strict';

const isEffectEffectType = (typeAnnotation) => {
  if (!typeAnnotation) return false;
  const type = typeAnnotation.typeAnnotation;
  if (!type || type.type !== 'TSTypeReference') return false;

  const typeName = type.typeName;
  if (typeName.type === 'TSQualifiedName') {
    return (
      typeName.left.type === 'Identifier' &&
      typeName.left.name === 'Effect' &&
      typeName.right.type === 'Identifier' &&
      typeName.right.name === 'Effect'
    );
  }
  if (typeName.type === 'Identifier') {
    return typeName.name === 'Effect';
  }
  return false;
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
      description: 'Prevent explicit return type annotations when the return type is Effect.Effect',
    },
    fixable: 'code',
    schema: [],
    messages: {
      noExplicitEffectReturnType:
        'Do not declare explicit return types for Effect.Effect. Let TypeScript infer the return type.',
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
        if (isEffectEffectType(node.returnType)) report(node.returnType);
      },
      ArrowFunctionExpression(node) {
        if (isEffectEffectType(node.returnType)) report(node.returnType);
      },
      MethodDefinition(node) {
        if (isEffectEffectType(node.value.returnType)) report(node.value.returnType);
      },
      FunctionExpression(node) {
        if (node.parent && node.parent.type === 'MethodDefinition') return;
        if (isEffectEffectType(node.returnType)) report(node.returnType);
      },
    };
  },
};
