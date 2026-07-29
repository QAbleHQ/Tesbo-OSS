import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { DatabaseService } from "../database/database.service";
import { PlanLimitsService } from "./plan-limits.service";

/**
 * Enforces the read-only lock on projects beyond the Launch allowance, once a former Pro
 * workspace's grace window has closed.
 *
 * Applied globally rather than at each call site: there are ~67 mutating routes under
 * /api/projects/:id, and a per-handler check would be forgotten by the next route added. A guard
 * covers all of them and any future ones by construction.
 *
 * Deliberately narrow:
 *   - Safe methods pass untouched, so locked projects stay fully READABLE. Customers can always see
 *     and export their data; this restricts changes, it never withholds anything.
 *   - DELETE on the project itself passes, because that archives it (see deleteProject) and archived
 *     projects don't count toward the limit. Without this exemption the advice to "archive another
 *     project" would be impossible to follow — the lock would be inescapable without paying.
 */
const PROJECT_PATH = /^\/api\/projects\/([0-9a-fA-F-]{36})(\/.*)?$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class ProjectWriteLockGuard implements CanActivate {
  constructor(
    private readonly db: DatabaseService,
    private readonly planLimits: PlanLimitsService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const path = (req.path ?? req.url ?? "").split("?")[0];
    const match = PROJECT_PATH.exec(path);
    if (!match) return true;

    const [, projectId, rest] = match;
    // Archiving the project is the documented way out of the lock — never block it.
    if (req.method === "DELETE" && (!rest || rest === "/")) return true;

    const res = await this.db.query<{ organization_id: string }>(
      "SELECT organization_id FROM projects WHERE id = $1 AND archived_at IS NULL",
      [projectId]
    );
    const organizationId = res.rows[0]?.organization_id;
    // Unknown or archived project: let the handler produce its own 404 rather than a confusing
    // plan-limit error.
    if (!organizationId) return true;

    await this.planLimits.assertProjectWritable(organizationId, projectId);
    return true;
  }
}
