import { BrainVersion } from "./contracts.js";
import type { CandidateProvider } from "./candidate-provider.js";
import type { OperationalStateStore } from "./operational-state.js";
import type { RelationshipMemoryStore } from "./relationship-memory.js";
import type { OfficialStateRepository } from "./repository.js";
import { supportsConversationState } from "./repository.js";
import { emptyConversationDecisionState } from "./conversation-state.js";
import type { ConversationDecisionState } from "./conversation-state.js";
import type { ActorContext, OfficialSnapshot, TurnEnvelope } from "./types.js";
import { withV3Span } from "./observability/tracing.js";

function messageNeedsWorkout(message: string): boolean {
  return /trein|exerc|ocupad|máquina|maquina|halter|série|serie|reps?/iu.test(message);
}

function messageNeedsDiet(message: string): boolean {
  return /diet|comid|alimento|banana|p[aã]o|refei|calori|prote[ií]na|carbo/iu.test(message);
}

export class GutoContextBuilderV3 {
  constructor(
    private readonly repository: OfficialStateRepository,
    private readonly operational: OperationalStateStore,
    private readonly relationshipMemory: RelationshipMemoryStore,
    private readonly candidates: CandidateProvider,
  ) {}

  async build(actor: ActorContext, requestId: string, message: string): Promise<{ envelope: TurnEnvelope; snapshot: OfficialSnapshot }> {
    const conversationRepository = supportsConversationState(this.repository) ? this.repository : null;
    const [snapshot, activeContext, relationshipMemories, conversation] = await Promise.all([
      withV3Span("POSTGRES_TRANSACTION", { "guto.operation": "official_snapshot" }, () => this.repository.loadOfficialSnapshot(actor)),
      withV3Span("ACTIVE_CONTEXT_LOAD", {}, () => this.operational.getActiveContext(actor)),
      withV3Span("RELATIONSHIP_MEMORY_RETRIEVAL", {}, async () => {
        try {
          return await this.relationshipMemory.search(actor, message, 5);
        } catch {
          return [];
        }
      }),
      conversationRepository
        ? withV3Span("CONVERSATION_STATE_LOAD", {}, () => conversationRepository.loadConversationDecisionState(actor))
        : Promise.resolve<ConversationDecisionState>(emptyConversationDecisionState()),
    ]);

    await withV3Span("PROFILE_LOAD", { "guto.profile_version": snapshot.profile.version }, async () => undefined);
    await withV3Span("WORKOUT_LOAD", { "guto.workout_found": Boolean(snapshot.workout) }, async () => undefined);
    await withV3Span("DIET_LOAD", { "guto.diet_found": Boolean(snapshot.diet) }, async () => undefined);

    const candidateOptions = await this.candidates.getCandidates(snapshot, activeContext, message);
    const includeWorkout = activeContext?.kind === "workout" || messageNeedsWorkout(message);
    const includeDiet = activeContext?.kind === "diet" || messageNeedsDiet(message);

    const envelope: TurnEnvelope = {
      brainVersion: BrainVersion,
      requestId,
      actor: { tenantId: actor.tenantId, userId: actor.userId, role: actor.role },
      message,
      official: {
        profile: snapshot.profile,
        goal: snapshot.goal,
        preferences: snapshot.preferences,
        healthConstraints: snapshot.healthConstraints,
        ...(includeWorkout && snapshot.workout
          ? { workout: { id: snapshot.workout.id, version: snapshot.workout.version, title: snapshot.workout.title } }
          : {}),
        ...(includeDiet && snapshot.diet
          ? {
              diet: {
                id: snapshot.diet.id,
                version: snapshot.diet.version,
                totalCalories: snapshot.diet.totalCalories,
                proteinGrams: snapshot.diet.proteinGrams,
                carbsGrams: snapshot.diet.carbsGrams,
                fatGrams: snapshot.diet.fatGrams,
              },
            }
          : {}),
      },
      activeContext,
      conversation,
      relationshipMemories,
      candidates: candidateOptions,
    };

    return withV3Span("CONTEXT_BUILD", {
      "guto.memory_version": snapshot.memoryVersion,
      "guto.active_context_version": activeContext?.version || 0,
      "guto.plan_version": activeContext?.planVersion || 0,
      "guto.relationship_memory_count": relationshipMemories.length,
      "guto.candidate_count": candidateOptions.length,
      "guto.conversation_state_version": conversation.version,
    }, async () => ({ envelope, snapshot }));
  }
}
