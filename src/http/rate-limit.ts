import type { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  resetAt: number;
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
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.status(429).json({ message: "GUTO recebeu chamadas demais deste cliente. Espera um minuto e volta direto." });
      return;
    }

    next();
  };
}
