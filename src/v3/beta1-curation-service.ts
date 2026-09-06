import {
  assertCuratedMemoryCandidate,
  assertMemoryProvenance,
  memoryCategoriesForQuery,
  resolveCuratedMemoryCandidates,
  RELEVANT_MEMORY_LIMIT,
  type CuratedMemoryCandidate,
  type MemorySourceType,
  type PersistedMemory,
  type RelevantMemorySnapshot,
} from "./beta1-memory.js";
import type { ActorContext } from "./types.js";

/**
 * BETA1 curation flow: user turn → deterministic candidates → strict schema →
 * policy validation → persistence. The LLM never writes memory directly; the
 * repository is the only writer and Postgres the only authority.
 * The user is the authority over their declared facts: a new declaration on
 * the same category+key SUPERSEDES the previous ACTIVE memory (transactional,
 * history preserved, never two simultaneous truths).
 */

export interface MemoryRepositoryPort {
  persistCuratedMemory(input: {
    actor: ActorContext;
    requestId: string;
    candidate: CuratedMemoryCandidate;
    sourceType: MemorySourceType;
  }): Promise<PersistedMemory>;
  loadRelevantMemories(input: {
    actor: ActorContext;
    categories: string[];
    limit: number;
  }): Promise<Array<Pick<PersistedMemory, "id" | "category" | "key" | "value" | "status" | "sourceType" | "updatedAt">>>;
}

export class Beta1CurationService {
  constructor(private readonly repository: MemoryRepositoryPort) {}

  /**
   * Called after a user turn: extracts explicit declarations deterministically
   * and persists each candidate with provenance. Supersession is handled by
   * the repository. Vague phrases never reach persistence (parser filters).
   */
  async curateFromTurn(actor: ActorContext, requestId: string, message: string, sourceType: MemorySourceType = "conversation"): Promise<PersistedMemory[]> {
    const candidates = resolveCuratedMemoryCandidates(message);
    const persisted: PersistedMemory[] = [];
    for (const candidate of candidates) {
      assertCuratedMemoryCandidate(candidate);
      assertMemoryProvenance(sourceType, requestId);
      persisted.push(await this.repository.persistCuratedMemory({ actor, requestId, candidate, sourceType }));
    }
    return persisted;
  }

  /** Deterministic, bounded, category-scoped retrieval (never whole memory). */
  async buildRelevantMemorySnapshot(actor: ActorContext, queryKind: RelevantMemorySnapshot["queryKind"]): Promise<RelevantMemorySnapshot> {
    const memories = await this.repository.loadRelevantMemories({
      actor,
      categories: memoryCategoriesForQuery(queryKind),
      limit: RELEVANT_MEMORY_LIMIT,
    });
    return { queryKind, memories };
  }
}
