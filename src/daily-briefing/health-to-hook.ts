/**
 * Health & Diet Proactive Hooks
 *
 * Gera hooks proativos baseados no perfil do usuário (patologia e restrição alimentar).
 * NÃO usa palavras-chave — lê os campos resolvidos do perfil.
 * Se o campo estiver vazio ou indicar "livre", não gera nada.
 * Se o usuário já respondeu que melhorou, o perfil é atualizado e o hook não é mais gerado.
 */

import { readMemoryStoreAsync } from "../memory-store";
import { DailyHook } from "./types";

export interface HealthProfile {
  trainingPathology?: string;
  foodRestrictions?: string;
  trainingGoal?: string;
}

/**
 * Checks if a pathology/restriction text indicates "none" or "free"
 * Uses semantic check — if the field is empty, "nenhuma", "livre", "nada", "sem", "none", "no", "nessuna", "ninguna"
 * we consider it as no limitation.
 */
function hasActiveLimitation(text: string | undefined | null): boolean {
  if (!text || text.trim().length === 0) return false;

  const lower = text.trim().toLowerCase();
  const freeIndicators = [
    "nenhum", "nada", "livre", "sem ", "saudável", "bem",
    "none", "no ", "free", "nothing", "healthy", "good",
    "nessuna", "nessun", "niente", "libera", "libero",
    "ninguna", "nada", "libre", "bien", "sano",
  ];

  // If the text is very short and matches a free indicator, it's not a limitation
  if (lower.length < 15) {
    for (const indicator of freeIndicators) {
      if (lower === indicator.trim() || lower.startsWith(indicator)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Build a health protection hook based on the user's training pathology.
 * Returns null if no active limitation is found.
 */
export function buildHealthProtectionHook(
  userId: string,
  profile: HealthProfile,
  now: string
): DailyHook | null {
  if (!hasActiveLimitation(profile.trainingPathology)) {
    return null;
  }

  const d = new Date(now);
  d.setUTCHours(23, 59, 59, 999);
  const endOfDay = d.toISOString();

  // Add 3 days cooldown so we don't ask every day
  const cooldownDate = new Date(now);
  cooldownDate.setUTCDate(cooldownDate.getUTCDate() + 3);
  const cooldownUntil = cooldownDate.toISOString();

  const pathology = profile.trainingPathology ?? "";

  return {
    id: `hook_health_${userId}_${now.slice(0, 10)}`,
    userId,
    category: "health_protection",
    title: "Health Protection",
    content: `O treino de hoje foi pensado para cuidar da sua limitação: ${pathology}. Me avisa como foi depois.`,
    actionImpact: "high",
    objective: "protect_consistency",
    mustMention: [pathology, "adaptar treino", "cuidado"],
    mustAvoid: [
      "falar como se fosse médico",
      "dar diagnóstico",
      "usar termos técnicos",
      "assumir que a dor continua igual",
    ],
    source: {
      type: "manual",
      checkedAt: now,
    },
    createdAt: now,
    peakUntil: endOfDay,
    staleAfter: endOfDay,
    meta: {
      pathology,
      cooldownUntil,
    },
  };
}

/**
 * Build a diet awareness hook based on the user's food restrictions.
 * Returns null if no active restriction is found.
 * Only generates this hook at most once per week (cooldown 7 days).
 */
export function buildDietAwarenessHook(
  userId: string,
  profile: HealthProfile,
  now: string
): DailyHook | null {
  if (!hasActiveLimitation(profile.foodRestrictions)) {
    return null;
  }

  const d = new Date(now);
  d.setUTCHours(23, 59, 59, 999);
  const endOfDay = d.toISOString();

  // Diet hook only once per week
  const cooldownDate = new Date(now);
  cooldownDate.setUTCDate(cooldownDate.getUTCDate() + 7);
  const cooldownUntil = cooldownDate.toISOString();

  const restriction = profile.foodRestrictions ?? "";

  return {
    id: `hook_diet_${userId}_${now.slice(0, 10)}`,
    userId,
    category: "diet_awareness",
    title: "Diet Awareness",
    content: `A dieta da semana foi pensada respeitando sua restrição: ${restriction}. Bora organizar?`,
    actionImpact: "medium",
    objective: "protect_consistency",
    mustMention: [restriction, "dieta", "adaptação"],
    mustAvoid: [
      "falar como nutricionista",
      "dar diagnóstico",
      "substituir alimento sem saber",
      "assumir que a restrição mudou",
    ],
    source: {
      type: "manual",
      checkedAt: now,
    },
    createdAt: now,
    peakUntil: endOfDay,
    staleAfter: endOfDay,
    meta: {
      foodRestriction: restriction,
      cooldownUntil,
    },
  };
}

/**
 * Load health profile from memory store.
 */
export async function loadHealthProfile(userId: string): Promise<HealthProfile> {
  const memory = await readMemoryStoreAsync();
  const userMemory = memory[userId] as Record<string, any>;
  if (!userMemory) return {};

  return {
    trainingPathology: userMemory.trainingPathology as string | undefined,
    foodRestrictions: userMemory.foodRestrictions as string | undefined,
    trainingGoal: userMemory.trainingGoal as string | undefined,
  };
}
