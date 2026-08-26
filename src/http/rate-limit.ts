import type { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export function resolveRateLimitKey(req: Request): string {
  if (req.gutoV3Auth?.principal.actor.userId) return `v3-user:${req.gutoV3Auth.principal.actor.userId}`;
  if (req.gutoUser?.userId) return `user:${req.gutoUser.userId}`;
  return `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

export function createRateLimit({
  windowMs,
  maxRequests,
}: {
  windowMs: number;
  maxRequests: number;
}) {
  const buckets = new Map<string, Bucket>();

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = resolveRateLimitKey(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const message = "GUTO recebeu chamadas demais deste cliente. Espera um minuto e volta direto.";
      const requestUrl = req.originalUrl || req.url || "";
      const isV3Request = req.baseUrl === "/guto/v3" || req.baseUrl?.startsWith("/guto/v3/") ||
        requestUrl === "/guto/v3" || requestUrl.startsWith("/guto/v3?") || requestUrl.startsWith("/guto/v3/");
      if (isV3Request) {
        res.status(429).json({ error: "V3_RATE_LIMITED", message, brainVersion: "guto-cerebro-v3" });
      } else {
        res.status(429).json({ message });
      }
      return;
    }

    next();
  };
}
