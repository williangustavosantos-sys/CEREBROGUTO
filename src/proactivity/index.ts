// ─── GUTO Proactivity — Public API ───────────────────────────────────────────

export { buildProactivityContextBlock } from './proactivity-injector'
export { resolveProactiveMemoryActionFromUserReply } from './memory-action-resolver'
export type { ResolverResult, ResolvedAction } from './memory-action-resolver'
export { extractEventsFromConversation, buildPendingMemoryData } from './memory-extractor'
export { enrichPendingMemories } from './memory-enricher'
export { openWeeklyConversation, getWeeklyCheckResult } from './weekly-conversation'
export {
  getProactiveMemories,
  getProactiveMemoriesByStatus,
  hasMatchingProactiveMemory,
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
  ProactiveMemoryType,
  WeeklyConversation,
  ProactivityContext,
} from './types'
