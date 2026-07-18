const REQUEST_URL_BASE = "http://guto.local";

export function parseRequestOriginalUrl(originalUrl: string | undefined) {
  try {
    return new URL(originalUrl || "/", REQUEST_URL_BASE);
  } catch {
    return new URL("/", REQUEST_URL_BASE);
  }
}
