import { ForbiddenException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

export type Plan = "launch" | "pro";

export interface PlanUsageSummary {
  plan: Plan;
  projectCount: number;
  projectLimit: number | null;
  storageUsedBytes: number;
  storageLimitBytes: number;
}

// Per-workspace ceilings for Tesbo Cloud plans (see pricing doc: "per workspace", not per seat).
// Pro's project count is unlimited (null); its storage is generous but still capped at 5GB.
const PROJECT_LIMITS: Record<Plan, number | null> = { launch: 2, pro: null };
const STORAGE_LIMITS_BYTES: Record<Plan, number> = {
  launch: 500 * 1024 * 1024,
  pro: 5 * 1024 * 1024 * 1024
};

// Launch includes Jira only; every other integration (Linear, and anything added later) is Pro-only.
const LAUNCH_ALLOWED_INTEGRATIONS = new Set(["jira"]);

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

@Injectable()
export class PlanLimitsService {
  constructor(private readonly db: DatabaseService) {}

  private async getPlan(organizationId: string): Promise<Plan> {
    const res = await this.db.query<{ plan: string }>("SELECT plan FROM organizations WHERE id = $1", [organizationId]);
    return res.rows[0]?.plan === "pro" ? "pro" : "launch";
  }

  private async getProjectCount(organizationId: string): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM projects WHERE organization_id = $1 AND archived_at IS NULL",
      [organizationId]
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  private async getStorageUsedBytes(organizationId: string): Promise<number> {
    const res = await this.db.query<{ total: string }>(
      `SELECT
         COALESCE((SELECT SUM(file_size) FROM knowledge_files WHERE organization_id = $1 AND is_deleted = false), 0) +
         COALESCE((SELECT SUM(a.file_size) FROM attachments a JOIN projects p ON p.id = a.project_id WHERE p.organization_id = $1), 0)
         AS total`,
      [organizationId]
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  async assertCanCreateProject(organizationId: string): Promise<void> {
    const plan = await this.getPlan(organizationId);
    const limit = PROJECT_LIMITS[plan];
    if (limit == null) return;
    const count = await this.getProjectCount(organizationId);
    if (count >= limit) {
      throw new ForbiddenException({
        error: `The Launch plan is limited to ${limit} projects. Upgrade to Pro for unlimited projects.`
      });
    }
  }

  async assertStorageAvailable(organizationId: string, incomingBytes: number): Promise<void> {
    const plan = await this.getPlan(organizationId);
    const limit = STORAGE_LIMITS_BYTES[plan];
    const used = await this.getStorageUsedBytes(organizationId);
    if (used + incomingBytes > limit) {
      const upgradeHint = plan === "launch" ? " Upgrade to Pro for 5GB of storage." : "";
      throw new ForbiddenException({
        error: `This upload would exceed your workspace's ${formatBytes(limit)} storage limit.${upgradeHint}`
      });
    }
  }

  async assertCustomFieldsEnabled(organizationId: string): Promise<void> {
    const plan = await this.getPlan(organizationId);
    if (plan !== "pro") {
      throw new ForbiddenException({
        error: "Custom fields are a Pro plan feature. Upgrade to Pro to create and manage custom fields."
      });
    }
  }

  async assertIntegrationAllowed(organizationId: string, provider: string): Promise<void> {
    const plan = await this.getPlan(organizationId);
    if (plan === "pro" || LAUNCH_ALLOWED_INTEGRATIONS.has(provider)) return;
    throw new ForbiddenException({
      error: `${provider[0].toUpperCase()}${provider.slice(1)} is a Pro plan integration. The Launch plan includes Jira only — upgrade to Pro to connect it.`
    });
  }

  async getUsageSummary(organizationId: string): Promise<PlanUsageSummary> {
    const plan = await this.getPlan(organizationId);
    const [projectCount, storageUsedBytes] = await Promise.all([
      this.getProjectCount(organizationId),
      this.getStorageUsedBytes(organizationId)
    ]);
    return {
      plan,
      projectCount,
      projectLimit: PROJECT_LIMITS[plan],
      storageUsedBytes,
      storageLimitBytes: STORAGE_LIMITS_BYTES[plan]
    };
  }
}
