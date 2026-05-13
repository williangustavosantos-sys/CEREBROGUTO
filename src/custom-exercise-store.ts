import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { CatalogExercise, CatalogLanguage, CatalogMuscleGroup } from "../exercise-catalog";
import { validateExerciseVideoMetadata } from "./exercise-video-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type CustomExerciseStatus = "pending" | "approved" | "rejected";

export interface CustomExerciseRequest extends CatalogExercise {
  status: CustomExerciseStatus;
  requestedBy: string;
  requestedByRole: string;
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  videoValidated: boolean;
  videoMetadata: {
    fileSizeBytes: number;
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    mimeType: string;
    hasAudio?: boolean;
  };
  custom: true;
}

interface CustomExerciseStore {
  exercises: Record<string, CustomExerciseRequest>;
}

const DEFAULT_NAMES: CatalogLanguage[] = ["pt-BR", "it-IT", "en-US"];

function storePath(): string {
  return process.env.GUTO_CUSTOM_EXERCISE_FILE || path.join(__dirname, "../tmp/custom-exercises.json");
}

function ensureStoreFile(): void {
  const target = storePath();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ exercises: {} }, null, 2));
  }
}

function readStore(): CustomExerciseStore {
  try {
    ensureStoreFile();
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf-8")) as CustomExerciseStore;
    return parsed && typeof parsed === "object" && parsed.exercises ? parsed : { exercises: {} };
  } catch {
    return { exercises: {} };
  }
}

function writeStore(store: CustomExerciseStore): void {
  ensureStoreFile();
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
}

export function buildLanguageMap(name: string, raw?: unknown): Record<CatalogLanguage, string> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<Record<CatalogLanguage, unknown>>
    : {};
  return DEFAULT_NAMES.reduce((acc, language) => {
    const value = input[language];
    acc[language] = typeof value === "string" && value.trim() ? value.trim() : name;
    return acc;
  }, {} as Record<CatalogLanguage, string>);
}

export function buildAliasMap(raw?: unknown): Record<CatalogLanguage, string[]> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<Record<CatalogLanguage, unknown>>
    : {};
  return DEFAULT_NAMES.reduce((acc, language) => {
    const values = Array.isArray(input[language]) ? input[language] : [];
    acc[language] = values.map((value) => String(value).trim()).filter(Boolean);
    return acc;
  }, {} as Record<CatalogLanguage, string[]>);
}

export function readCustomExerciseRequests(): CustomExerciseRequest[] {
  return Object.values(readStore().exercises);
}

export function getCustomExerciseRequest(id: string): CustomExerciseRequest | undefined {
  return readStore().exercises[id];
}

export function saveCustomExerciseRequest(request: CustomExerciseRequest): CustomExerciseRequest {
  const store = readStore();
  store.exercises[request.id] = request;
  writeStore(store);
  return request;
}

export function getApprovedCustomCatalogExercises(): CatalogExercise[] {
  return readCustomExerciseRequests()
    .filter((exercise) => exercise.status === "approved" && exercise.videoValidated)
    .filter((exercise) => validateExerciseVideoMetadata({
      sourceFileName: exercise.sourceFileName,
      videoUrl: exercise.videoUrl,
      ...exercise.videoMetadata,
    }, { customOnly: true }).valid)
    .map((exercise) => ({
      id: exercise.id,
      canonicalNamePt: exercise.canonicalNamePt,
      namesByLanguage: exercise.namesByLanguage,
      aliasesByLanguage: exercise.aliasesByLanguage,
      muscleGroup: exercise.muscleGroup as CatalogMuscleGroup,
      videoUrl: exercise.videoUrl,
      sourceFileName: exercise.sourceFileName,
      videoProvider: "local",
      movementPattern: exercise.movementPattern,
      equipment: exercise.equipment,
      tags: [...(exercise.tags ?? []), "custom"],
    }));
}
