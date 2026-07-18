import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { createHmac, timingSafeEqual } from "crypto";
import { v2 as cloudinary } from "cloudinary";
import { Redis } from "@upstash/redis";
import { config } from "./config.js";

const UPLOADS_DIR = process.env.VERCEL
  ? path.join("/tmp", "guto", "validation-images")
  : path.join(process.cwd(), "tmp", "validation-images");
const URL_PREFIX = "/uploads/validation-images";

// As selfies de validação são dado pessoal sensível.
//
// Três backends, mesma interface:
//  • PERSISTENTE (produção) — Cloudinary, quando há credenciais. Os ativos sobem
//    como `type:"authenticated"` (privados) e são entregues por URL ASSINADA
//    (infalsificável sem o segredo do Cloudinary), que funciona em <img src> e
//    NÃO some no redeploy do Render. Este é o caminho de produção (fecha o B02).
//  • PERSISTENTE (Vercel sem Cloudinary) — Redis já soberano no produto. Os bytes
//    ficam numa chave separada com TTL e continuam privados pela mesma URL HMAC.
//  • LOCAL (dev/teste/beta-sem-infra) — disco em tmp/, servido pela rota interna
//    com URL assinada por HMAC (ver signImageUrl/verifyImageSignature). O disco do
//    Render é EFÊMERO: este caminho NÃO deve ser usado em produção.
//
// O driver é decidido por chamada a partir do ambiente — sem credenciais
// Cloudinary, cai no disco local automaticamente. Falha de upload propaga o erro
// (a rota de validação faz rollback e NÃO credita XP — nunca finge sucesso).
const SIGN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const REDIS_TTL_SECONDS = Math.floor(SIGN_TTL_MS / 1000);
const REDIS_KEY_PREFIX = "guto:validation-image:v1:";

type ImageRedisClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options?: { ex: number }) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
};

let imageRedisClient: ImageRedisClient | null = null;
let imageRedisClientOverrideForTests: ImageRedisClient | null | undefined;

function imageRedisKey(filename: string): string {
  return `${REDIS_KEY_PREFIX}${encodeURIComponent(filename)}`;
}

function getImageRedisClient(): ImageRedisClient | null {
  if (imageRedisClientOverrideForTests !== undefined) return imageRedisClientOverrideForTests;
  if (process.env.NODE_ENV === "test" || !process.env.VERCEL) return null;
  if (imageRedisClient) return imageRedisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  imageRedisClient = new Redis({ url, token }) as unknown as ImageRedisClient;
  return imageRedisClient;
}

export function setImageStorageRedisClientForTests(client: ImageRedisClient | null | undefined): void {
  if (process.env.NODE_ENV !== "test" && process.env.GUTO_DISABLE_REDIS_FOR_TESTS !== "1") {
    throw new Error("Image Redis test override is only available in tests.");
  }
  imageRedisClientOverrideForTests = client;
}

const CLOUDINARY_FOLDER = (process.env.CLOUDINARY_FOLDER || "guto/validation").replace(/^\/+|\/+$/g, "");

interface CloudinaryCreds {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Parse de `cloudinary://<api_key>:<api_secret>@<cloud_name>` (formato do CLOUDINARY_URL). */
function parseCloudinaryUrl(url: string): CloudinaryCreds | null {
  const match = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec((url || "").trim());
  if (!match) return null;
  return { apiKey: match[1], apiSecret: match[2], cloudName: match[3] };
}

/** Lê as credenciais do ambiente AO VIVO (vars discretas têm precedência sobre CLOUDINARY_URL). */
function readCloudinaryCreds(): CloudinaryCreds {
  const fromUrl = parseCloudinaryUrl(process.env.CLOUDINARY_URL || "");
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || fromUrl?.cloudName || "",
    apiKey: process.env.CLOUDINARY_API_KEY || fromUrl?.apiKey || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || fromUrl?.apiSecret || "",
  };
}

/** True quando há credenciais Cloudinary completas — então o storage é persistente. */
export function isCloudinaryEnabled(): boolean {
  const { cloudName, apiKey, apiSecret } = readCloudinaryCreds();
  return Boolean(cloudName && apiKey && apiSecret);
}

function configureCloudinary(): void {
  const { cloudName, apiKey, apiSecret } = readCloudinaryCreds();
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

/** `${id}-photo.jpg` → `guto/validation/${id}-photo` (public_id do Cloudinary, sem extensão). */
function cloudinaryPublicId(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, "");
  return `${CLOUDINARY_FOLDER}/${base}`;
}

/** Extrai o public_id de uma URL de entrega autenticada do Cloudinary (para deletar). */
export function cloudinaryPublicIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/\bcloudinary\.com$/i.test(parsed.hostname)) return null;
    // /<cloud>/image/authenticated/s--SIG--/v123/guto/validation/<id>-photo.jpg
    const afterDelivery = parsed.pathname.replace(/^.*\/image\/(?:authenticated|upload)\//, "");
    const segments = afterDelivery.split("/").filter(Boolean);
    if (segments[0] && /^s--.+--$/.test(segments[0])) segments.shift(); // assinatura
    if (segments[0] && /^v\d+$/.test(segments[0])) segments.shift(); // versão
    if (!segments.length) return null;
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.[a-z0-9]+$/i, "");
    return segments.join("/");
  } catch {
    return null;
  }
}

function imageSignature(filename: string, exp: number): string {
  return createHmac("sha256", config.jwtSecret).update(`${filename}:${exp}`).digest("base64url");
}

/**
 * Anexa token assinado+expirante a uma URL de selfie LOCAL para servir a <img> sem
 * expor publicamente. URLs absolutas (Cloudinary) já vêm assinadas na entrega →
 * passam direto, sem re-assinar.
 */
export function signImageUrl(bareUrl: string, ttlMs: number = SIGN_TTL_MS): string {
  if (!bareUrl) return bareUrl;
  if (/^https?:\/\//i.test(bareUrl)) return bareUrl; // Cloudinary: já assinada
  const filename = bareUrl.startsWith(`${URL_PREFIX}/`)
    ? bareUrl.slice(URL_PREFIX.length + 1).split("?")[0]
    : bareUrl.split("?")[0];
  const exp = Date.now() + ttlMs;
  const sig = imageSignature(filename, exp);
  return `${URL_PREFIX}/${filename}?exp=${exp}&sig=${sig}`;
}

/** Valida exp+sig de um request de imagem LOCAL. Falha fechada (qualquer dúvida → false). */
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
  if (isCloudinaryEnabled()) {
    configureCloudinary();
    return;
  }
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

/**
 * Persiste uma imagem e devolve a URL para gravar no registro.
 *  • Cloudinary: sobe como autenticado e devolve a URL de entrega ASSINADA (durável).
 *  • Local: grava em tmp/ e devolve a URL nua (signImageUrl a assina depois).
 * Falha de persistência PROPAGA (a rota faz rollback e não credita XP).
 */
export async function uploadImage(buffer: Buffer, filename: string): Promise<string> {
  if (isCloudinaryEnabled()) {
    configureCloudinary();
    const publicId = cloudinaryPublicId(filename);
    const dataUri = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    await cloudinary.uploader.upload(dataUri, {
      public_id: publicId,
      type: "authenticated",
      resource_type: "image",
      overwrite: true,
      format: "jpg",
    });
    // URL de entrega autenticada e assinada — funciona em <img>, infalsificável sem o segredo.
    return cloudinary.url(publicId, {
      type: "authenticated",
      sign_url: true,
      secure: true,
      resource_type: "image",
      format: "jpg",
    });
  }

  const redis = getImageRedisClient();
  if (redis) {
    await redis.set(imageRedisKey(filename), buffer.toString("base64"), { ex: REDIS_TTL_SECONDS });
    return `${URL_PREFIX}/${filename}`;
  }

  const filePath = path.join(UPLOADS_DIR, filename);
  writeFileSync(filePath, buffer);
  return `${URL_PREFIX}/${filename}`;
}

/** Recupera uma imagem privada persistida no Redis serverless. */
export async function readStoredImage(filename: string): Promise<Buffer | null> {
  const redis = getImageRedisClient();
  if (!redis) return null;
  const encoded = await redis.get(imageRedisKey(filename));
  if (typeof encoded !== "string" || !encoded) return null;
  return Buffer.from(encoded, "base64");
}

export async function deleteImage(url: string): Promise<void> {
  if (!url) return;
  // Cloudinary (URL absoluta) — destrói o ativo autenticado.
  if (/^https?:\/\//i.test(url)) {
    if (!isCloudinaryEnabled()) return;
    const publicId = cloudinaryPublicIdFromUrl(url);
    if (!publicId) return;
    configureCloudinary();
    await cloudinary.uploader
      .destroy(publicId, { type: "authenticated", resource_type: "image", invalidate: true })
      .catch(() => undefined);
    return;
  }
  // Local — remove o arquivo do disco.
  const filename = url.replace(`${URL_PREFIX}/`, "").split("?")[0];
  const redis = getImageRedisClient();
  if (redis) await redis.del(imageRedisKey(filename));
  const resolved = path.resolve(UPLOADS_DIR, filename);
  // Guard against path traversal
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) return;
  if (existsSync(resolved)) {
    unlinkSync(resolved);
  }
}
