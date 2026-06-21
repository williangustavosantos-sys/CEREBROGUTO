// ─── GUTO Proactivity — Public API ───────────────────────────────────────────

export { buildProactivityContextBlock } from './proactivity-injector'
export { resolveProactiveMemoryActionFromUserReply } from './memory-action-resolver'
export type { ResolverResult, ResolvedAction } from './memory-action-resolver'
export { extractEventsFromConversation, buildPendingMemoryData } from './memory-extractor'
export { resolveProactiveDate, addDaysToDateKey } from './date-resolver'
export { enrichPendingMemories } from './memory-enricher'
export {
  decideFromProactiveMemory,
  buildImpactFromDecision,
  resolveEffectiveImpacts,
  getAdaptationForDate,
} from './decision-engine'
export { openWeeklyConversation, getWeeklyCheckResult } from './weekly-conversation'
export {
  getProactiveMemories,
  getProactiveMemoriesByStatus,
  hasMatchingProactiveMemory,
  buildProactiveEventKey,
  upsertProactiveMemory,
  addProactiveMemory,
  updateProactiveMemory,
  discardProactiveMemory,
  requestDiscardProactiveMemory,
  cancelDiscardRequest,
  markWeeklyConversationDone,
  markPastActiveMemoriesPendingValidation,
  getDateKey,
  getWeekKey,
} from './proactive-store'

export type {
  ProactiveMemory,
  ProactiveMemoryStatus,
  ProactiveMemoryStage,
  ProactiveMemoryType,
  ProactiveDecision,
  ProactiveImpact,
  ProactiveImpactStatus,
  ProactiveImpactSurface,
  ProactivePrompt,
  ProactivePromptKind,
  WeeklyConversation,
  ProactivityContext,
} from './types'
