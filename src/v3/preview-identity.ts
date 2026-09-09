/** Operational evidence for Preview QA. Never return a DSN, password or token. */
export function previewIdentity(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_ENV !== "preview") return undefined;
  let database: { projectRef: string; schema: string } | null = null;
  try {
    const url = new URL(env.DATABASE_URL || "");
    const direct = /^db\.([a-z]{20})\.supabase\.co$/.exec(url.hostname);
    const pooled = /\.pooler\.supabase\.com$/.test(url.hostname)
      ? /\.([a-z]{20})$/.exec(decodeURIComponent(url.username))
      : null;
    const projectRef = direct?.[1] ?? pooled?.[1];
    if (projectRef) database = { projectRef, schema: "guto_v3" };
  } catch { /* Invalid configuration is reported by readiness, without its value. */ }
  const sha = env.GUTO_SOURCE_SHA || env.VERCEL_GIT_COMMIT_SHA || "";
  const deploymentHost = env.VERCEL_URL || "";
  return {
    environment: "preview" as const,
    sourceSha: /^[a-f0-9]{40}$/.test(sha) ? sha : null,
    deploymentHost: /^[a-z0-9-]+\.vercel\.app$/.test(deploymentHost) ? deploymentHost : null,
    database,
  };
}
