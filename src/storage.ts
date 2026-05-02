import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";

const UPLOADS_DIR = path.join(process.cwd(), "tmp", "validation-images");
const URL_PREFIX = "/uploads/validation-images";

export function initStorage(): void {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export async function uploadImage(buffer: Buffer, filename: string): Promise<string> {
  const filePath = path.join(UPLOADS_DIR, filename);
  writeFileSync(filePath, buffer);
  return `${URL_PREFIX}/${filename}`;
}

export async function deleteImage(url: string): Promise<void> {
  const filename = url.replace(`${URL_PREFIX}/`, "");
  const resolved = path.resolve(UPLOADS_DIR, filename);
  // Guard against path traversal
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) return;
  if (existsSync(resolved)) {
    unlinkSync(resolved);
  }
}
