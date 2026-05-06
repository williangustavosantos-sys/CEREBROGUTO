export type GutoEvolutionStage = "baby" | "teen" | "adult" | "elite";

export const GUTO_EVOLUTION_THRESHOLDS: Array<{ stage: GutoEvolutionStage; minXp: number }> = [
  { stage: "baby", minXp: 0 },
  { stage: "teen", minXp: 1500 },
  { stage: "adult", minXp: 5000 },
  { stage: "elite", minXp: 12000 },
];

export function getGutoEvolutionStage(totalXp: number): GutoEvolutionStage {
  const xp = Number.isFinite(totalXp) ? Math.max(0, Math.floor(totalXp)) : 0;
  let current: GutoEvolutionStage = "baby";

  for (const { stage, minXp } of GUTO_EVOLUTION_THRESHOLDS) {
    if (xp >= minXp) current = stage;
  }

  return current;
}

export function getNextGutoEvolutionXp(totalXp: number): number | null {
  const xp = Number.isFinite(totalXp) ? Math.max(0, Math.floor(totalXp)) : 0;
  const next = GUTO_EVOLUTION_THRESHOLDS.find(({ minXp }) => minXp > xp);
  return next?.minXp ?? null;
}
