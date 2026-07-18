import type { Request, Response, NextFunction } from "express";
import { parseRequestOriginalUrl } from "./request-url.js";

export function resolveRequestLogUserId(
  req: Pick<Request, "originalUrl" | "body">
) {
  return (
    parseRequestOriginalUrl(req.originalUrl).searchParams.get("userId") ??
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
  const requestUrl = parseRequestOriginalUrl(req.originalUrl);
  const userId = resolveRequestLogUserId(req);

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;

    console.log(
      JSON.stringify({
        event: "http_request",
        method: req.method,
        path: requestUrl.pathname,
        status: res.statusCode,
        durationMs,
        userId,
      })
    );
  });

  next();
}
