process.env.GUTO_DISABLE_LISTEN = "1";

let appPromise: Promise<((req: unknown, res: unknown) => void)> | null = null;

async function getApp() {
  appPromise ??= import("../server.js").then(({ app }) => app as (req: unknown, res: unknown) => void);
  return appPromise;
}

export default async function handler(req: unknown, res: unknown) {
  const app = await getApp();
  return app(req, res);
}
