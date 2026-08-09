import { V3Error } from "./errors.js";
import type { ActorContext, RelationshipMemory } from "./types.js";

export interface RelationshipFactCandidate {
  classification: "RELATIONSHIP";
  fact: string;
  evidence: string;
}

export interface RelationshipMemoryStore {
  configured(): boolean;
  health(): Promise<{ ok: boolean; configured: boolean }>;
  search(actor: ActorContext, query: string, limit?: number): Promise<RelationshipMemory[]>;
  submit(actor: ActorContext, candidates: RelationshipFactCandidate[], requestId: string): Promise<void>;
}

function mem0UserId(actor: ActorContext): string {
  return `${actor.tenantId}:${actor.userId}`;
}

export class Mem0RelationshipMemoryStore implements RelationshipMemoryStore {
  constructor(
    private readonly apiKey = process.env.MEM0_API_KEY || "",
    private readonly baseUrl = (process.env.MEM0_BASE_URL || "https://api.mem0.ai").replace(/\/+$/, ""),
  ) {}

  configured(): boolean { return Boolean(this.apiKey); }

  async health(): Promise<{ ok: boolean; configured: boolean }> {
    return { ok: this.configured(), configured: this.configured() };
  }

  async search(actor: ActorContext, query: string, limit = 5): Promise<RelationshipMemory[]> {
    if (!this.apiKey) return [];
    const response = await fetch(`${this.baseUrl}/v3/memories/search/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        filters: { user_id: mem0UserId(actor) },
        top_k: Math.max(1, Math.min(limit, 10)),
        threshold: 0.2,
        rerank: false,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new V3Error("V3_MEM0_SEARCH_FAILED", "Falha ao consultar memória relacional.", 503, { status: response.status });
    }
    const body = (await response.json()) as {
      results?: Array<{ id?: string; memory?: string; score?: number }>;
    };
    return (body.results || [])
      .filter((item): item is { id: string; memory: string; score?: number } => Boolean(item.id && item.memory))
      .map((item) => ({ id: item.id, text: item.memory, score: item.score }));
  }

  async submit(actor: ActorContext, candidates: RelationshipFactCandidate[], requestId: string): Promise<void> {
    if (!this.apiKey || candidates.length === 0) return;
    const safeCandidates = candidates.filter((candidate) => candidate.classification === "RELATIONSHIP");
    if (safeCandidates.length === 0) return;
    const response = await fetch(`${this.baseUrl}/v3/memories/add/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: mem0UserId(actor),
        messages: safeCandidates.map((candidate) => ({ role: "user", content: candidate.fact })),
        metadata: {
          classification: "RELATIONSHIP",
          source: "guto-cerebro-v3",
          request_id: requestId,
        },
        custom_instructions: "Store relationship preferences and stable interaction patterns only. Do not infer medical, identity, plan, XP, or completion facts.",
        infer: true,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new V3Error("V3_MEM0_WRITE_FAILED", "Falha ao registrar memória relacional.", 503, { status: response.status });
    }
  }
}

export class InMemoryRelationshipMemoryStore implements RelationshipMemoryStore {
  private readonly memories = new Map<string, RelationshipMemory[]>();
  configured(): boolean { return true; }
  async health(): Promise<{ ok: boolean; configured: boolean }> { return { ok: true, configured: true }; }
  async search(actor: ActorContext, query: string, limit = 5): Promise<RelationshipMemory[]> {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return (this.memories.get(mem0UserId(actor)) || [])
      .filter((memory) => terms.some((term) => memory.text.toLocaleLowerCase().includes(term)))
      .slice(0, limit);
  }
  async submit(actor: ActorContext, candidates: RelationshipFactCandidate[]): Promise<void> {
    const key = mem0UserId(actor);
    const current = this.memories.get(key) || [];
    for (const candidate of candidates) {
      current.push({ id: `memory-${current.length + 1}`, text: candidate.fact, score: 1 });
    }
    this.memories.set(key, current);
  }
}
