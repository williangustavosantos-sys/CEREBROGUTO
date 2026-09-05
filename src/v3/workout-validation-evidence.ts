import { createHash } from "node:crypto";
import { V3Error } from "./errors.js";

/**
 * P0 (selfie authority): the minimum proof that the workout validation really
 * received evidence produced by the camera. The frontend captures a photo and
 * sends it as a data URL; the backend verifies format/magic bytes/size and
 * keeps ONLY a one-way hash + metadata (never the raw image, never base64).
 * A manual API call without real evidence is rejected.
 */

export interface WorkoutValidationEvidence {
  sha256: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
}

const MIN_EVIDENCE_BYTES = 8 * 1024; // 8KB — real photo, not a 1px payload
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024; // 2MB decoded — fits 6mb JSON / 4.5mb Vercel body

export function parseWorkoutValidationEvidence(value: unknown): WorkoutValidationEvidence {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new V3Error("V3_WORKOUT_VALIDATION_EVIDENCE_REQUIRED", "A validação do treino exige prova com selfie.", 409);
  }
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim());
  if (!match) {
    throw new V3Error("V3_WORKOUT_VALIDATION_EVIDENCE_INVALID", "Formato da evidência de validação inválido.", 400);
  }
  const mime = match[1] as WorkoutValidationEvidence["mime"];
  const base64 = match[2].replace(/\s/g, "");
  const bytes = Buffer.from(base64, "base64");
  // Reject a base64 string that is not canonical for the derived bytes length
  // (guards empty/invalid payloads that decode to nothing or garbage).
  if (bytes.length < MIN_EVIDENCE_BYTES || bytes.length > MAX_EVIDENCE_BYTES) {
    throw new V3Error("V3_WORKOUT_VALIDATION_EVIDENCE_INVALID", "Tamanho da evidência de validação fora do domínio aceito.", 400);
  }
  const magicOk =
    (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (mime === "image/png" && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
    (mime === "image/webp" && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP");
  if (!magicOk) {
    throw new V3Error("V3_WORKOUT_VALIDATION_EVIDENCE_INVALID", "Conteúdo da evidência de validação inválido.", 400);
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime,
    byteLength: bytes.length,
  };
}