// ─── GUTO Proactivity — Public API ───────────────────────────────────────────

export { buildProactivityContextBlock } from './proactivity-injector.js'
export { resolveProactiveMemoryActionFromUserReply } from './memory-action-resolver.js'
export type { ResolverResult, ResolvedAction } from './memory-action-resolver.js'
export { extractEventsFromConversation, buildPendingMemoryData } from './memory-extractor.js'
export { resolveProactiveDate, addDaysToDateKey } from './date-resolver.js'
export { enrichPendingMemories } from './memory-enricher.js'
export {
  decideFromProactiveMemory,
  buildImpactFromDecision,
  resolveEffectiveImpacts,
  getAdaptationForDate,
} from './decision-engine.js'
export { openWeeklyConversation, getWeeklyCheckResult } from './weekly-conversation.js'
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
} from './proactive-store.js'

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
} from './types.js'
