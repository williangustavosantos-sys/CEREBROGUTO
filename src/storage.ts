import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { createHmac, timingSafeEqual } from "crypto";
import { config } from "./config.js";

const UPLOADS_DIR = path.join(process.cwd(), "tmp", "validation-images");
const URL_PREFIX = "/uploads/validation-images";

// As selfies de validação são dado pessoal sensível. Elas vivem em disco local
// (beta) e são servidas por URL ASSINADA (HMAC): a assinatura vai na query, então
// funciona com <img src> (que não manda Authorization) ao mesmo tempo que mata o
// acesso público/enumerável que existia com express.static. A assinatura é
// viewer-agnóstica (img tags não carregam identidade) mas é infalsificável sem o
// segredo e expira. Follow-up: storage persistente (S3/Cloudinary) + assinatura
// curta por request.
const SIGN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180d — tmp é efêmero, isso limita a janela de URL vazada

function imageSignature(filename: string, exp: number): string {
  return createHmac("sha256", config.jwtSecret).update(`${filename}:${exp}`).digest("base64url");
}

/** Anexa token assinado+expirante a uma URL de selfie para servir a <img> sem expor publicamente. */
export function signImageUrl(bareUrl: string, ttlMs: number = SIGN_TTL_MS): string {
  if (!bareUrl) return bareUrl;
  const filename = bareUrl.startsWith(`${URL_PREFIX}/`)
    ? bareUrl.slice(URL_PREFIX.length + 1).split("?")[0]
    : bareUrl.split("?")[0];
  const exp = Date.now() + ttlMs;
  const sig = imageSignature(filename, exp);
  return `${URL_PREFIX}/${filename}?exp=${exp}&sig=${sig}`;
}

/** Valida exp+sig de um request de imagem. Falha fechada (qualquer dúvida → false). */
export function verifyImageSignature(filename: string, exp: unknown, sig: unknown): boolean {
  const expNum = typeof exp === "string" ? Number(exp) : typeof exp === "number" ? exp : NaN;
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  if (typeof sig !== "string" || !sig) return false;
  const expected = imageSignature(filename, expNum);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

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
  // URLs agora podem carregar ?exp&sig — tira a query antes de resolver o arquivo.
  const filename = url.replace(`${URL_PREFIX}/`, "").split("?")[0];
  const resolved = path.resolve(UPLOADS_DIR, filename);
  // Guard against path traversal
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) return;
  if (existsSync(resolved)) {
    unlinkSync(resolved);
  }
}
