import { Router } from "express";
import { z } from "zod";
import { validate } from "../../../middleware/validate";
import type { AuthorizationService } from "../application/AuthorizationService";
import { CopilotError } from "../domain/contracts";

export function createAuthorizationRouter(service: AuthorizationService): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/accounts/github-copilot", async (_req, res, next) => {
    try { res.json({ success: true, data: await service.summary() }); } catch (error) { next(error); }
  });
  router.post("/accounts/github-copilot/login-sessions", validate({ body: z.object({
    idempotencyKey: z.string().min(8).max(128), replaceAccount: z.boolean().default(false),
  }).strict() }), async (req, res, next) => {
    try {
      res.json({ success: true, data: await service.start(req.body.idempotencyKey, req.body.replaceAccount) });
    } catch (error) { next(error); }
  });
  router.get("/login-sessions/:id", async (req, res, next) => {
    try { res.json({ success: true, data: service.session(req.params.id as string) }); } catch (error) { next(error); }
  });
  router.post("/login-sessions/:id/cancel", async (req, res, next) => {
    try { res.json({ success: true, data: service.cancel(req.params.id as string) }); } catch (error) { next(error); }
  });
  router.post("/accounts/github-copilot/logout", validate({ body: z.object({
    credentialRevision: z.number().int().nonnegative(),
  }).strict() }), async (req, res, next) => {
    try {
      await service.logout(req.body.credentialRevision);
      res.json({ success: true, data: await service.summary() });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (!(error instanceof CopilotError)) { next(error); return; }
    res.status(error.statusCode).json({ success: false, code: error.code, error: error.message });
  });
  return router;
}
