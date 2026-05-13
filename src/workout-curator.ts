/**
 * GUTO Workout Curator
 *
 * Filosofia: o código garante apenas 2 coisas — exercícios do catálogo (com vídeo)
 * e grupo muscular correto. Tudo o resto (qual exercício escolher, quantas séries,
 * reps, descanso, observação, progressão, adaptação para patologia, etc.) é decisão
 * do GUTO — leitura do contexto do aluno feita por uma IA com prompt pesado, como
 * um personal real faz.
 *
 * O usuário não precisa atualizar nada manualmente. GUTO observa o histórico e o
 * feedback semanal e ajusta a dose.
 */

import { ValidatedExerciseCatalog, type CatalogExercise, type CatalogMuscleGroup } from "../exercise-catalog.js";
import { config } from "./config.js";

export type WorkoutFocus =
  | "chest_triceps"
  | "back_biceps"
  | "legs_core"
  | "shoulders_abs"
  | "full_body";

export type LocationMode = "gym" | "home" | "park";

// Mapeamento foco → grupos musculares permitidos.
// Aquecimento sempre é incluído (1 exercício no início).
const FOCUS_TO_MUSCLES: Record<WorkoutFocus, CatalogMuscleGroup[]> = {
  chest_triceps: ["peito", "bracos"],
  back_biceps: ["costas", "bracos"],
  legs_core: ["pernas", "abdomen"],
  shoulders_abs: ["ombro", "abdomen"],
  full_body: ["peito", "costas", "ombro", "bracos", "pernas", "abdomen"],
};

// Equipamentos que NÃO existem no parque (filtra exercícios incompatíveis).
const PARK_INCOMPATIBLE = new Set([
  "halter", "haltere", "maquina", "polia", "barra-livre", "banco",
  "bike", "esteira", "escada", "eliptico", "leg-press",
  "dumbbell", "machine", "cable", "barbell", "bench",
]);

// Equipamentos que NÃO existem em casa (filtra exercícios incompatíveis).
// Casa típica: corpo livre + alguma mochila/garrafa improvisada. Nada de máquina.
const HOME_INCOMPATIBLE = new Set([
  "maquina", "polia", "leg-press", "esteira", "escada", "eliptico",
  "machine", "cable", "treadmill",
]);

function isCompatibleWithLocation(equipment: string | undefined, location: LocationMode): boolean {
  if (!equipment) return true; // exercício sem equipamento (corpo livre) sempre passa
  const eq = equipment.toLowerCase();
  if (location === "park" && PARK_INCOMPATIBLE.has(eq)) return false;
  if (location === "home" && HOME_INCOMPATIBLE.has(eq)) return false;
  return true; // gym aceita tudo
}

/**
 * Retorna a pool de exercícios candidatos para um foco + local.
 * SEMPRE inclui exercícios de aquecimento compatíveis com o local.
 */
export function getCandidatePool(
  focus: WorkoutFocus,
  location: LocationMode
): CatalogExercise[] {
  const allowedGroups = FOCUS_TO_MUSCLES[focus];
  return ValidatedExerciseCatalog.filter((ex) => {
    const isWarmup = ex.muscleGroup === "aquecimento";
    const isInAllowedGroup = allowedGroups.includes(ex.muscleGroup);
    return (isWarmup || isInAllowedGroup) && isCompatibleWithLocation(ex.equipment, location);
  });
}

/**
 * Verifica se TODOS os exercícios escolhidos pertencem a grupos musculares válidos
 * para o foco do dia. Esta é a segunda garantia do código (a primeira é "exercício
 * está no catálogo").
 */
export function validateMuscleGroupsForFocus(
  exerciseIds: string[],
  focus: WorkoutFocus
): { valid: boolean; offending: string[] } {
  const allowedGroups = new Set<CatalogMuscleGroup>([...FOCUS_TO_MUSCLES[focus], "aquecimento"]);
  const offending: string[] = [];
  for (const id of exerciseIds) {
    const entry = ValidatedExerciseCatalog.find((ex) => ex.id === id);
    if (!entry) {
      offending.push(`${id} (não está no catálogo)`);
      continue;
    }
    if (!allowedGroups.has(entry.muscleGroup)) {
      offending.push(`${id} (grupo "${entry.muscleGroup}" não bate com foco "${focus}")`);
    }
  }
  return { valid: offending.length === 0, offending };
}

// ─── GUTO Curator (Gemini) ───────────────────────────────────────────────────

export interface CuratedExercise {
  id: string;
  sets: number;
  reps: string;
  rest: string;
  cue: string;
  note: string;
}

export interface CuratedWorkout {
  focus: WorkoutFocus;
  exercises: CuratedExercise[];
  summary: string;
  progressionNote?: string;
}

export interface CuratorContext {
  // Permanente
  name: string;
  age?: number;
  heightCm?: number;
  weightKg?: number;
  pathology?: string;
  foodRestrictions?: string;
  // Atualizado semanalmente
  goal?: string;
  level?: string;
  lastWeekFeedback?: string;
  // Contexto do treino
  focus: WorkoutFocus;
  location: LocationMode;
  // Histórico recente para anti-repetição e progressão
  recentTrainingHistory?: Array<{
    date: string;
    exerciseIds: string[];
    sets?: Array<{ id: string; sets: number; reps: string }>;
  }>;
  // Idioma do prompt de saída
  language?: "pt-BR" | "en-US" | "it-IT";
}

function buildCuratorPrompt(ctx: CuratorContext, pool: CatalogExercise[]): string {
  const langLabel = ctx.language === "en-US" ? "English (US)"
    : ctx.language === "it-IT" ? "Italiano"
    : "Português do Brasil";

  // Pool resumida — só o que o curator precisa pra escolher
  const poolList = pool.map((ex) => {
    const aliases = ex.aliasesByLanguage["pt-BR"]?.slice(0, 2).join(", ");
    return `- ${ex.id} | ${ex.canonicalNamePt} | grupo: ${ex.muscleGroup} | equip: ${ex.equipment ?? "corpo livre"}${aliases ? ` | aliases: ${aliases}` : ""}`;
  }).join("\n");

  // Histórico recente de exercícios (últimos 14 dias) para evitar repetição
  const recentExercises = (ctx.recentTrainingHistory ?? [])
    .slice(0, 14)
    .map((h) => `- ${h.date}: ${h.exerciseIds.join(", ")}`)
    .join("\n") || "(sem treinos recentes registrados)";

  return `Você é o cérebro de treino do GUTO. Sua tarefa: montar o treino de hoje para o aluno usando APENAS exercícios da lista de candidatos abaixo.

═══ ALUNO ═══
Nome: ${ctx.name}
Idade: ${ctx.age ?? "?"} | Altura: ${ctx.heightCm ?? "?"}cm | Peso: ${ctx.weightKg ?? "?"}kg
Patologia/limitação: ${ctx.pathology || "nenhuma"}
Restrições alimentares: ${ctx.foodRestrictions || "nenhuma"}
Objetivo declarado: ${ctx.goal || "consistência geral"}
Nível atual: ${ctx.level || "iniciante"}
Feedback da semana passada: ${ctx.lastWeekFeedback || "(sem feedback ainda)"}

═══ TREINO DE HOJE ═══
Foco: ${ctx.focus}
Local: ${ctx.location}

═══ HISTÓRICO RECENTE (últimos 14 dias) ═══
${recentExercises}

═══ POOL DE EXERCÍCIOS DISPONÍVEIS (use SOMENTE estes IDs) ═══
${poolList}

═══ REGRAS ═══
1. Use EXCLUSIVAMENTE os IDs listados acima. Nunca invente IDs.
2. Comece com 1 exercício do grupo "aquecimento" (sempre).
3. Depois, monte 4-5 exercícios principais que cubram o foco do dia.
4. NÃO repita o mesmo exercício do treino de ontem. Evite repetir um exercício usado nos últimos 4 dias se houver alternativa.
5. Adapte volume/intensidade ao nível e ao feedback. Se aluno disse "tava fácil" ou "pega mais firme", aumente. Se disse "tava pesado" ou "tô morto", suavize.
6. Se aluno tem patologia, REMOVA exercícios que carregam a articulação afetada. Use seu critério como personal real — não precisa de lista, leia o texto.
7. Para cada exercício, defina sets, reps, rest, cue (instrução técnica curta) e note (porque está usando esse exercício hoje).
8. Escreva tudo em ${langLabel}.

═══ FORMATO DE SAÍDA (JSON estrito) ═══
{
  "exercises": [
    { "id": "string-do-catalogo", "sets": 3, "reps": "10-12", "rest": "60s", "cue": "...", "note": "..." }
  ],
  "summary": "Frase de 1 linha explicando o treino do dia para o aluno (em ${langLabel})",
  "progressionNote": "Frase opcional explicando o que mudou em relação aos treinos anteriores. Vazio se for primeiro treino."
}`;
}

interface GeminiCallOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export async function curateWorkout(
  ctx: CuratorContext,
  options: GeminiCallOptions
): Promise<CuratedWorkout | null> {
  const pool = getCandidatePool(ctx.focus, ctx.location);
  if (pool.length === 0) {
    console.warn(`[curator] empty pool for focus=${ctx.focus} location=${ctx.location}`);
    return null;
  }

  const prompt = buildCuratorPrompt(ctx, pool);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent?key=${options.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[curator] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!raw) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return null;
      }
    }

    if (!Array.isArray(parsed?.exercises) || parsed.exercises.length === 0) {
      return null;
    }

    // Validação mínima: cada exercício escolhido tem que ter id no catálogo
    // E tem que pertencer a um grupo muscular válido para o foco
    const exerciseIds = parsed.exercises.map((e: any) => String(e.id || ""));
    const muscleCheck = validateMuscleGroupsForFocus(exerciseIds, ctx.focus);
    if (!muscleCheck.valid) {
      console.warn(`[curator] muscle group validation failed:`, muscleCheck.offending);
      return null;
    }

    // Coerce types
    const exercises: CuratedExercise[] = parsed.exercises.map((e: any) => ({
      id: String(e.id),
      sets: Number(e.sets) || 3,
      reps: String(e.reps || "10"),
      rest: String(e.rest || "60s"),
      cue: String(e.cue || ""),
      note: String(e.note || ""),
    }));

    return {
      focus: ctx.focus,
      exercises,
      summary: String(parsed.summary || ""),
      progressionNote: parsed.progressionNote ? String(parsed.progressionNote) : undefined,
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("[curator] timeout");
    } else {
      console.warn("[curator] error:", err?.message || err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hidrata os exercícios curados com os dados completos do catálogo
 * (videoUrl, sourceFileName, namesByLanguage, etc) para retornar um
 * WorkoutExercise pronto pra UI.
 */
export function hydrateCuratedExercises(
  curated: CuratedExercise[],
  language: "pt-BR" | "en-US" | "it-IT" = "pt-BR"
): Array<{
  id: string;
  name: string;
  canonicalNamePt: string;
  muscleGroup: string;
  sets: number;
  reps: string;
  rest: string;
  cue: string;
  note: string;
  videoUrl: string;
  videoProvider: "local";
  sourceFileName: string;
}> {
  const result = [];
  for (const ex of curated) {
    const entry = ValidatedExerciseCatalog.find((c) => c.id === ex.id);
    if (!entry) continue; // skip se não estiver no catálogo (já validado antes, mas safety net)
    result.push({
      id: entry.id,
      name: entry.namesByLanguage[language] ?? entry.canonicalNamePt,
      canonicalNamePt: entry.canonicalNamePt,
      muscleGroup: entry.muscleGroup,
      sets: ex.sets,
      reps: ex.reps,
      rest: ex.rest,
      cue: ex.cue,
      note: ex.note,
      videoUrl: entry.videoUrl,
      videoProvider: entry.videoProvider,
      sourceFileName: entry.sourceFileName,
    });
  }
  return result;
}
