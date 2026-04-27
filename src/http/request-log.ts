import type { Request, Response, NextFunction } from "express";

export function requestLog(req: Request, res: Response, next: NextFunction) {
  const startedAt = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const userId =
      typeof req.query.userId === "string"
        ? req.query.userId
        : typeof req.body?.profile?.userId === "string"
          ? req.body.profile.userId
          : typeof req.body?.userId === "string"
            ? req.body.userId
            : undefined;

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
