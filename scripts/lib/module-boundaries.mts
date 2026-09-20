import path from 'node:path'
import type { Rule } from 'eslint'

/** Small pilot: type-only edges are allowed; runtime imports are checked after path normalization. */
export function boundaryViolation(filename: string, specifier: string, typeOnly = false): string | null {
  const normalized = filename.replaceAll('\\', '/')
  const marker = Math.max(normalized.lastIndexOf('/src/'), normalized.lastIndexOf('/server/'))
  if (marker < 0) return null
  const source = normalized.slice(marker + 1)
  const target = specifier.startsWith('@/') ? path.posix.normalize('src/' + specifier.slice(2))
    : specifier.startsWith('/src/') ? path.posix.normalize(specifier.slice(1))
    : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier))
    : specifier
  if (/^photoswipe(?:\/|$)/.test(target) && source !== 'src/components/gallery/PhotoSwipeStage.vue') {
    return 'PhotoSwipe is private to PhotoSwipeStage; business code uses artwork identities and adapter events.'
  }
  if (source.startsWith('server/generation/') && (/^express(?:\/|$)/.test(target)
    || /^routes\/[^/]+(?:\.ts|\.js)?$/.test(target) && !/^routes\/superres(?:\.ts|\.js)?$/.test(target))) {
    // Validation is the only request adapter; the service cannot import HTTP handlers.
    if (!(source === 'server/generation/validation.ts' && typeOnly && target === 'express')) {
      return 'Generation services depend on engine services, never HTTP routers or Express.'
    }
  }
  if (typeOnly) return null
  if (source === 'src/stores/promptBuilderStore.ts' && (/^src\/(?:storage|api|application)\//.test(target)
    || /^src\/composables\/(?:useImageStore|useKVStore)(?:\.|$)/.test(target))) {
    return 'The workbench store delegates persistence to its artwork/draft adapters.'
  }
  if (/^src\/composables\/prompt\/usePrompt(?:Draft|SceneFilters)\.ts$/.test(source)
    && /^src\/(?:stores|storage|api|application)\//.test(target)) {
    return 'Drafts and scene filters receive explicit state; they cannot load the workbench or artwork services.'
  }
  const pure = source.startsWith('src/types/') || [
    'src/utils/historyRecipe.ts', 'src/utils/generationTask.ts', 'src/utils/promptPolicy.ts', 'src/utils/promptCatalog.ts',
  ].includes(source)
  if (pure && (/^src\/(?:views|components|stores|composables|storage|api)\//.test(target) || /^(?:vue|pinia)(?:\/|$)/.test(target))) {
    return 'Pure history/prompt modules must not load UI, state instances or browser services.'
  }
  if (source.startsWith('src/storage/') && /^src\/(?:views|components|stores)\//.test(target)) {
    return 'Storage must not depend on pages or Pinia stores.'
  }
  return null
}

export const moduleBoundaries: Rule.RuleModule = {
  meta: { type: 'problem', schema: [], messages: { boundary: '{{reason}}' } },
  create(context) {
    // ESLint's ESTree types omit TypeScript importKind and TSImportEqualsDeclaration.
    const check = (node: Rule.Node, value: unknown, typeOnly = false) => {
      if (typeof value !== 'string') {
        const filename = context.filename.replaceAll('\\', '/')
        if (/\/src\/(?:types|storage)\//.test(filename) || /\/src\/utils\/(?:historyRecipe|generationTask|promptPolicy|promptCatalog)\.ts$/.test(filename)
          || /\/server\/generation\//.test(filename) || /\/src\/stores\/promptBuilderStore\.ts$/.test(filename)
          || /\/src\/composables\/prompt\/usePrompt(?:Draft|SceneFilters)\.ts$/.test(filename)) {
          context.report({ node, messageId: 'boundary', data: { reason: 'Pilot boundary imports must use a literal path.' } })
        }
        return
      }
      const reason = boundaryViolation(context.filename, value, typeOnly)
      if (reason) context.report({ node, messageId: 'boundary', data: { reason } })
    }
    type ImportNode = Rule.Node & { source?: { value?: unknown }; importKind?: string; exportKind?: string; specifiers?: Array<{ importKind?: string }> }
    const declaration = (node: Rule.Node) => {
      const edge = node as ImportNode
      if (edge.source) check(node, edge.source.value, edge.importKind === 'type' || edge.exportKind === 'type'
        || Boolean(edge.specifiers?.length && edge.specifiers.every(s => s.importKind === 'type')))
    }
    return {
      ImportDeclaration: declaration, ExportNamedDeclaration: declaration, ExportAllDeclaration: declaration,
      ImportExpression(node) { check(node, node.source.type === 'Literal' ? node.source.value : undefined) },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const arg = node.arguments[0]
          check(node, arg?.type === 'Literal' ? arg.value : undefined)
        }
      },
      TSImportEqualsDeclaration(node: Rule.Node) {
        const edge = node as Rule.Node & { importKind?: string; moduleReference?: { expression?: { value?: unknown } } }
        check(node, edge.moduleReference?.expression?.value, edge.importKind === 'type')
      },
    }
  },
}
