const EXERCISE_VIDEO_PREFIX = "/exercise/visuals/";
const CUSTOM_EXERCISE_VIDEO_PREFIX = "/exercise/visuals/custom/";
const MAX_FILE_SIZE_BYTES = 12 * 1024 * 1024;
const MIN_DURATION_SECONDS = 3;
const MAX_DURATION_SECONDS = 30;
const MAX_LONG_SIDE_PX = 1280;
const MAX_SHORT_SIDE_PX = 720;
const MAX_FPS = 30;

export type ExerciseVideoValidationCode =
  | "EXERCISE_VIDEO_REQUIRED"
  | "EXERCISE_VIDEO_INVALID_FORMAT"
  | "EXERCISE_VIDEO_TOO_SHORT"
  | "EXERCISE_VIDEO_TOO_LONG"
  | "EXERCISE_VIDEO_TOO_LARGE"
  | "EXERCISE_VIDEO_RESOLUTION_TOO_HIGH"
  | "EXERCISE_VIDEO_FPS_TOO_HIGH"
  | "EXERCISE_VIDEO_EXTERNAL_URL_NOT_ALLOWED"
  | "EXERCISE_VIDEO_METADATA_REQUIRED"
  | "EXERCISE_VIDEO_AUDIO_NOT_ALLOWED"
  | "EXERCISE_VIDEO_PATH_NOT_ALLOWED";

export interface ExerciseVideoMetadata {
  fileName?: unknown;
  sourceFileName?: unknown;
  videoUrl?: unknown;
  fileSizeBytes?: unknown;
  durationSeconds?: unknown;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
  mimeType?: unknown;
  hasAudio?: unknown;
}

export interface ExerciseVideoValidationIssue {
  code: ExerciseVideoValidationCode;
  message: string;
  field?: string;
  suggestedFileName?: string;
}

export interface ExerciseVideoValidationResult {
  valid: boolean;
  errors: ExerciseVideoValidationIssue[];
  normalized?: {
    sourceFileName: string;
    videoUrl: string;
    fileSizeBytes: number;
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    mimeType: string;
    hasAudio?: boolean;
  };
}

export class ExerciseVideoValidationError extends Error {
  readonly status = 400;
  readonly code: ExerciseVideoValidationCode;
  readonly issues: ExerciseVideoValidationIssue[];

  constructor(issues: ExerciseVideoValidationIssue[]) {
    const first = issues[0];
    super(first?.message || "Exercise video metadata is invalid.");
    this.name = "ExerciseVideoValidationError";
    this.code = first?.code || "EXERCISE_VIDEO_METADATA_REQUIRED";
    this.issues = issues;
  }
}

function issue(
  code: ExerciseVideoValidationCode,
  message: string,
  field?: string,
  suggestedFileName?: string
): ExerciseVideoValidationIssue {
  return { code, message, field, suggestedFileName };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function filenameFromUrl(videoUrl: string): string {
  return videoUrl.split("?")[0].split("#")[0].split("/").filter(Boolean).pop() || "";
}

export function suggestSafeExerciseVideoFileName(value: unknown): string {
  const raw = asString(value).replace(/\.[a-z0-9]+$/i, "");
  const slug = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return `${slug || "exercicio-customizado"}.mp4`;
}

function hasSafeCustomFileName(fileName: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*\.mp4$/.test(fileName);
}

function isExternalUrl(videoUrl: string): boolean {
  return /^(https?:)?\/\//i.test(videoUrl);
}

export function validateExerciseVideoMetadata(
  video: ExerciseVideoMetadata | null | undefined,
  options: { customOnly?: boolean } = {}
): ExerciseVideoValidationResult {
  if (!video || typeof video !== "object") {
    return {
      valid: false,
      errors: [
        issue(
          "EXERCISE_VIDEO_METADATA_REQUIRED",
          "Metadados técnicos do vídeo são obrigatórios."
        ),
      ],
    };
  }

  const errors: ExerciseVideoValidationIssue[] = [];
  const sourceFileName = asString(video.sourceFileName) || asString(video.fileName);
  const videoUrl = asString(video.videoUrl);
  const fileNameFromPath = filenameFromUrl(videoUrl);
  const effectiveFileName = sourceFileName || fileNameFromPath;
  const suggestedFileName = suggestSafeExerciseVideoFileName(effectiveFileName);
  const mimeType = asString(video.mimeType).toLowerCase();
  const fileSizeBytes = asFiniteNumber(video.fileSizeBytes);
  const durationSeconds = asFiniteNumber(video.durationSeconds);
  const width = asFiniteNumber(video.width);
  const height = asFiniteNumber(video.height);
  const fps = asFiniteNumber(video.fps);
  const hasAudio = typeof video.hasAudio === "boolean" ? video.hasAudio : undefined;

  if (!videoUrl) {
    errors.push(issue("EXERCISE_VIDEO_REQUIRED", "videoUrl é obrigatório.", "videoUrl"));
  } else if (isExternalUrl(videoUrl)) {
    errors.push(
      issue(
        "EXERCISE_VIDEO_EXTERNAL_URL_NOT_ALLOWED",
        "Links externos não são permitidos para vídeos de exercício.",
        "videoUrl"
      )
    );
  } else if (
    !videoUrl.startsWith(options.customOnly ? CUSTOM_EXERCISE_VIDEO_PREFIX : EXERCISE_VIDEO_PREFIX) ||
    videoUrl.includes("..") ||
    /\s/.test(videoUrl)
  ) {
    errors.push(
      issue(
        "EXERCISE_VIDEO_PATH_NOT_ALLOWED",
        `Use caminho interno ${options.customOnly ? CUSTOM_EXERCISE_VIDEO_PREFIX : EXERCISE_VIDEO_PREFIX}.`,
        "videoUrl"
      )
    );
  }

  if (!effectiveFileName) {
    errors.push(
      issue(
        "EXERCISE_VIDEO_METADATA_REQUIRED",
        "sourceFileName/fileName é obrigatório.",
        "sourceFileName",
        suggestedFileName
      )
    );
  } else if (!hasSafeCustomFileName(effectiveFileName)) {
    errors.push(
      issue(
        "EXERCISE_VIDEO_INVALID_FORMAT",
        "Nome do arquivo deve ser lowercase, sem acento, sem espaço e com hífen.",
        "sourceFileName",
        suggestedFileName
      )
    );
  }

  if (sourceFileName && fileNameFromPath && sourceFileName !== fileNameFromPath) {
    errors.push(
      issue(
        "EXERCISE_VIDEO_PATH_NOT_ALLOWED",
        "sourceFileName precisa bater com o final do videoUrl.",
        "sourceFileName",
        suggestedFileName
      )
    );
  }

  if (!effectiveFileName.toLowerCase().endsWith(".mp4") || (mimeType && mimeType !== "video/mp4")) {
    errors.push(
      issue(
        "EXERCISE_VIDEO_INVALID_FORMAT",
        "Vídeo de exercício precisa ser MP4.",
        "mimeType",
        suggestedFileName
      )
    );
  }

  if (fileSizeBytes === null || durationSeconds === null || width === null || height === null || fps === null) {
    errors.push(
      issue(
        "EXERCISE_VIDEO_METADATA_REQUIRED",
        "fileSizeBytes, durationSeconds, width, height e fps são obrigatórios.",
        "metadata"
      )
    );
  } else {
    if (fileSizeBytes <= 0 || durationSeconds <= 0 || width <= 0 || height <= 0 || fps <= 0) {
      errors.push(issue("EXERCISE_VIDEO_METADATA_REQUIRED", "Metadados técnicos precisam ser positivos.", "metadata"));
    }
    if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      errors.push(issue("EXERCISE_VIDEO_TOO_LARGE", "Vídeo acima de 12 MB.", "fileSizeBytes"));
    }
    if (durationSeconds < MIN_DURATION_SECONDS) {
      errors.push(issue("EXERCISE_VIDEO_TOO_SHORT", "Vídeo abaixo de 3 segundos.", "durationSeconds"));
    }
    if (durationSeconds > MAX_DURATION_SECONDS) {
      errors.push(issue("EXERCISE_VIDEO_TOO_LONG", "Vídeo acima de 30 segundos.", "durationSeconds"));
    }
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    if (longSide > MAX_LONG_SIDE_PX || shortSide > MAX_SHORT_SIDE_PX) {
      errors.push(issue("EXERCISE_VIDEO_RESOLUTION_TOO_HIGH", "Resolução acima de 720p.", "resolution"));
    }
    if (fps > MAX_FPS) {
      errors.push(issue("EXERCISE_VIDEO_FPS_TOO_HIGH", "FPS acima de 30.", "fps"));
    }
  }

  if (hasAudio === true) {
    errors.push(issue("EXERCISE_VIDEO_AUDIO_NOT_ALLOWED", "Vídeo de exercício não pode ter áudio.", "hasAudio"));
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    normalized: {
      sourceFileName: effectiveFileName,
      videoUrl,
      fileSizeBytes: fileSizeBytes!,
      durationSeconds: durationSeconds!,
      width: width!,
      height: height!,
      fps: fps!,
      mimeType: mimeType || "video/mp4",
      ...(hasAudio !== undefined ? { hasAudio } : {}),
    },
  };
}

export function assertValidExerciseVideoMetadata(
  video: ExerciseVideoMetadata | null | undefined,
  options: { customOnly?: boolean } = {}
): NonNullable<ExerciseVideoValidationResult["normalized"]> {
  const result = validateExerciseVideoMetadata(video, options);
  if (!result.valid || !result.normalized) throw new ExerciseVideoValidationError(result.errors);
  return result.normalized;
}

export function isExerciseVideoValidationError(error: unknown): error is ExerciseVideoValidationError {
  return error instanceof ExerciseVideoValidationError;
}
