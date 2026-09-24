import { renderPromptPlan as renderCorePlan } from './promptCompilerCore.ts'
import type { PromptFamily, PromptPlan } from '../types/prompt'
import type { ModelProfile } from './promptPolicy.ts'
import { resolveDrawCapabilities } from './drawCapabilities.ts'
import { escapedLiteralExactTokens, escapeKnownLiteralTags } from './promptLiteralTags.ts'

export * from './promptCompilerCore.ts'

/**
 * Public compiler boundary: keep source identity tags raw and escape their literal parentheses
 * only for Anima's weighted-text backend. The core retains the existing engine and caption rules.
 * Identity and exact-token lists are both needed: some catalogue identities use a different alias
 * from exactTokens. Do not infer literal names from arbitrary manual prompt text.
 */
export function renderPromptPlan(plan: PromptPlan, family: PromptFamily, profile?: ModelProfile | null): { prompt: string; negative: string } {
  if (resolveDrawCapabilities(family, profile).promptFormat !== 'anima-tags') {
    return renderCorePlan(plan, family, profile)
  }
  const exact = [...plan.preserveTokens, ...(profile?.exact_tokens || [])]
  const protectedPlan: PromptPlan = {
    ...plan,
    preserveTokens: [...new Set([...plan.preserveTokens, ...escapedLiteralExactTokens(exact)])],
  }
  const rendered = renderCorePlan(protectedPlan, family, profile)
  // The core emits a newline between tags and caption. Natural-language captions remain untouched.
  const newline = rendered.prompt.indexOf('\n')
  const tags = newline < 0 ? rendered.prompt : rendered.prompt.slice(0, newline)
  const caption = newline < 0 ? '' : rendered.prompt.slice(newline)
  return {
    ...rendered,
    prompt: escapeKnownLiteralTags(tags, [...plan.identity, ...exact]) + caption,
  }
}
