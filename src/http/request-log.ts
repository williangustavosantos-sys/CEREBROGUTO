import type { Request, Response, NextFunction } from "express";

function queryUserId(originalUrl: string | undefined) {
  if (!originalUrl) return undefined;

  try {
    return new URL(originalUrl, "http://guto.local").searchParams.get("userId") || undefined;
  } catch {
    return undefined;
  }
}

export function resolveRequestLogUserId(
  req: Pick<Request, "originalUrl" | "body">
) {
  return (
    queryUserId(req.originalUrl) ??
    (typeof req.body?.profile?.userId === "string"
      ? req.body.profile.userId
      : typeof req.body?.userId === "string"
        ? req.body.userId
        : undefined)
  );
}

export function requestLog(req: Request, res: Response, next: NextFunction) {
  const startedAt = Date.now();
  // Express' req.query getter reaches req.url. In Vercel's Node 24 runtime that
  // getter currently delegates to legacy url.parse(), producing DEP0169 as an
  // application error. originalUrl is already materialized by Express, so parse
  // it with the WHATWG API once while the request is active.
  const userId = resolveRequestLogUserId(req);

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;

    console.log(
      JSON.stringify({
        event: "http_request",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        userId,
      })
    );
  });

  next();
}
