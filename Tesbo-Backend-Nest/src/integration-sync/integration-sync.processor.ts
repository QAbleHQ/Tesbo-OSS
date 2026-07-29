import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { createHash } from "crypto";
import type { Job } from "bullmq";
import { DatabaseService } from "../database/database.service";
import { RagIngestionService } from "../rag/rag-ingestion.service";
import { IntegrationSyncClient } from "./integration-sync.client";
import { IntegrationSyncDecisions } from "./integration-sync-decisions";
import { IntegrationSyncDocumentBuilder } from "./integration-sync-document.builder";
import { IntegrationSyncService } from "./integration-sync.service";
import {
  INTEGRATION_SYNC_CONCURRENCY,
  INTEGRATION_SYNC_QUEUE,
  INTEGRATION_SYNC_RUN_JOB,
  INTEGRATION_SYNC_TICKET_JOB,
  MAX_TICKETS_PER_RUN,
  PROVIDER_FOLDER_NAMES
} from "./integration-sync.constants";
import { RemoteComment, RemoteTicket, SyncProvider, SyncRunJobPayload, SyncTicketJobPayload } from "./integration-sync.types";

type Row = Record<string, any>;

/**
 * Per-provider column names. Jira and Linear keep separate ticket tables (their APIs and units of
 * work differ enough that forcing one shape on both was rejected in V47), so the shared pipeline
 * parameterises the column names instead. Every value here is a compile-time constant — never
 * user input — so interpolating them into SQL is safe.
 */
const TICKET_TABLES: Record<SyncProvider, {
  table: string;
  connectionCol: string;
  issueIdCol: string;
  issueKeyCol: string;
  createdCol: string;
  updatedCol: string;
  urlCol: string;
  conflict: string;
  mappingSql: string;
}> = {
  jira: {
    table: "jira_tickets",
    connectionCol: "jira_connection_id",
    issueIdCol: "jira_issue_id",
    issueKeyCol: "jira_issue_key",
    createdCol: "jira_created_at",
    updatedCol: "jira_updated_at",
    urlCol: "jira_url",
    conflict: "(jira_connection_id, jira_issue_id, project_id)",
    mappingSql: `SELECT jira_project_id AS remote_id, jira_project_key AS remote_key, jira_project_name AS remote_name
                 FROM jira_project_mappings WHERE project_id = $1 AND enabled = true LIMIT 1`
  },
  linear: {
    table: "linear_tickets",
    connectionCol: "integration_connection_id",
    issueIdCol: "linear_issue_id",
    issueKeyCol: "linear_issue_key",
    createdCol: "linear_created_at",
    updatedCol: "linear_updated_at",
    urlCol: "linear_url",
    conflict: "(integration_connection_id, linear_issue_id)",
    mappingSql: `SELECT linear_team_id AS remote_id, linear_team_key AS remote_key, linear_team_name AS remote_name
                 FROM linear_project_mappings WHERE project_id = $1 AND enabled = true LIMIT 1`
  }
};

@Processor(INTEGRATION_SYNC_QUEUE, { concurrency: INTEGRATION_SYNC_CONCURRENCY })
export class IntegrationSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(IntegrationSyncProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly runs: IntegrationSyncService,
    private readonly client: IntegrationSyncClient,
    private readonly builder: IntegrationSyncDocumentBuilder,
    private readonly decisions: IntegrationSyncDecisions,
    private readonly ragIngestion: RagIngestionService
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === INTEGRATION_SYNC_RUN_JOB) return this.processRun(job.data as SyncRunJobPayload);
    if (job.name === INTEGRATION_SYNC_TICKET_JOB) return this.processTicket(job.data as SyncTicketJobPayload);
    this.logger.warn(`Unknown integration-sync job name: ${job.name}`);
  }

  // ── Coordinator: page the provider, upsert tickets, fan out document jobs ──

  private async processRun(payload: SyncRunJobPayload): Promise<void> {
    const { runId, organizationId, projectId, provider, triggeredBy } = payload;
    const config = TICKET_TABLES[provider];

    try {
      await this.runs.markRunning(runId, "connecting");

      const connection = await this.client.loadConnection(organizationId, provider);
      if (!connection) {
        await this.runs.failRun(runId, `${PROVIDER_FOLDER_NAMES[provider]} is no longer connected to this workspace.`);
        return;
      }

      const mapping = await this.db.query<{ remote_id: string; remote_key: string; remote_name: string }>(config.mappingSql, [projectId]);
      const remote = mapping.rows[0];
      if (!remote) {
        await this.runs.failRun(runId, `No ${PROVIDER_FOLDER_NAMES[provider]} project is mapped to this project yet.`);
        return;
      }
      await this.db.query("UPDATE integration_sync_runs SET remote_project_key = $2, updated_at = now() WHERE id = $1", [runId, remote.remote_key]);

      // Created before any ticket lands, so the folder exists by the time the first document
      // needs a home — and only ever for projects that actually ran a sync.
      const folderId = await this.runs.ensureProviderFolder(organizationId, projectId, provider, triggeredBy);

      await this.runs.setStage(runId, "fetching_tickets");
      const queued: SyncTicketJobPayload[] = [];
      const onPage = async (tickets: RemoteTicket[]) => {
        for (const ticket of tickets) {
          const ticketId = await this.upsertTicket(projectId, String(connection.id), provider, ticket);
          queued.push({ runId, organizationId, projectId, provider, ticketId, issueId: ticket.issueId, issueKey: ticket.issueKey, folderId, triggeredBy });
        }
        // Published per page so the UI's "found N tickets" climbs while a large backlog is still
        // being pulled, instead of sitting at zero for a minute.
        await this.runs.setTotals(runId, queued.length);
      };

      const { truncated } = provider === "jira"
        ? await this.client.fetchJiraTickets(connection, remote.remote_key, onPage)
        : await this.client.fetchLinearTickets(connection, remote.remote_id, onPage);

      await this.runs.setTotals(runId, queued.length);

      if (!queued.length) {
        await this.runs.finishRun(runId, `No tickets found in ${remote.remote_key}.`);
        return;
      }

      await this.runs.setStage(runId, "building_documents");
      await this.runs.enqueueTicketJobs(queued);

      if (truncated) {
        // Recorded now rather than at finish, so the cap is visible in the UI while the run is
        // still building documents. finishRun's COALESCE keeps it.
        await this.db.query("UPDATE integration_sync_runs SET error = $2, updated_at = now() WHERE id = $1", [
          runId,
          `Stopped at the ${MAX_TICKETS_PER_RUN}-ticket limit for one sync. The most recently updated ${MAX_TICKETS_PER_RUN} tickets were synced; run Sync again to continue.`
        ]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Sync run ${runId} failed: ${message}`);
      await this.runs.failRun(runId, message);
    }
  }

  private async upsertTicket(projectId: string, connectionId: string, provider: SyncProvider, ticket: RemoteTicket): Promise<string> {
    const c = TICKET_TABLES[provider];
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO ${c.table} (
         project_id, ${c.connectionCol}, ${c.issueIdCol}, ${c.issueKeyCol}, summary, description,
         issue_type, status, priority, assignee, reporter, labels, ${c.createdCol}, ${c.updatedCol}, ${c.urlCol}, synced_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       ON CONFLICT ${c.conflict} DO UPDATE SET
         ${c.issueKeyCol} = EXCLUDED.${c.issueKeyCol},
         summary = EXCLUDED.summary,
         description = EXCLUDED.description,
         issue_type = EXCLUDED.issue_type,
         status = EXCLUDED.status,
         priority = EXCLUDED.priority,
         assignee = EXCLUDED.assignee,
         reporter = EXCLUDED.reporter,
         labels = EXCLUDED.labels,
         ${c.createdCol} = EXCLUDED.${c.createdCol},
         ${c.updatedCol} = EXCLUDED.${c.updatedCol},
         ${c.urlCol} = EXCLUDED.${c.urlCol},
         synced_at = now()
       RETURNING id`,
      [
        projectId,
        connectionId,
        ticket.issueId,
        ticket.issueKey,
        ticket.summary,
        ticket.description,
        ticket.issueType,
        ticket.status,
        ticket.priority,
        ticket.assignee,
        ticket.reporter,
        ticket.labels,
        ticket.createdAt,
        ticket.updatedAt,
        ticket.url
      ]
    );
    return res.rows[0].id;
  }

  // ── Per-ticket: comments -> decisions -> Knowledge Base document ──

  private async processTicket(payload: SyncTicketJobPayload): Promise<void> {
    const { runId, organizationId, projectId, provider, ticketId, issueId, folderId, triggeredBy } = payload;
    const c = TICKET_TABLES[provider];

    const ticketRes = await this.db.query<Row>(`SELECT * FROM ${c.table} WHERE id = $1 AND project_id = $2`, [ticketId, projectId]);
    const row = ticketRes.rows[0];
    if (!row) {
      // Ticket vanished between fan-out and execution. Count it so the run can still finish.
      await this.runs.recordTicketResult(runId, { processed: 1 });
      return;
    }

    const ticket: RemoteTicket = {
      issueId: String(row[c.issueIdCol] || issueId),
      issueKey: String(row[c.issueKeyCol] || ""),
      summary: String(row.summary || ""),
      description: String(row.description || ""),
      issueType: String(row.issue_type || ""),
      status: String(row.status || ""),
      priority: String(row.priority || ""),
      assignee: String(row.assignee || ""),
      reporter: String(row.reporter || ""),
      labels: String(row.labels || ""),
      createdAt: row[c.createdCol] ? new Date(row[c.createdCol]).toISOString() : null,
      updatedAt: row[c.updatedCol] ? new Date(row[c.updatedCol]).toISOString() : null,
      url: String(row[c.urlCol] || "")
    };

    const connection = await this.client.loadConnection(organizationId, provider);
    if (!connection) throw new Error(`${provider} connection disappeared mid-run`);

    // Comment fetch failures are tolerated: a document with a stale (or absent) Comments section
    // still beats failing the ticket and leaving nothing in the Knowledge Base.
    let comments: RemoteComment[] = [];
    let commentsFetched = true;
    try {
      comments = await this.client.fetchComments(connection, provider, ticket.issueId);
    } catch (err) {
      commentsFetched = false;
      comments = this.storedComments(row);
      this.logger.warn(`Comment fetch failed for ${ticket.issueKey}, reusing cached: ${err instanceof Error ? err.message : err}`);
    }

    const commentsHash = createHash("sha256").update(JSON.stringify(comments)).digest("hex");
    const commentsChanged = commentsFetched && commentsHash !== String(row.comments_hash || "");
    if (commentsChanged) {
      await this.db.query(
        `UPDATE ${c.table} SET comments_json = $2::jsonb, comments_count = $3, comments_hash = $4 WHERE id = $1`,
        [ticketId, JSON.stringify(comments), comments.length, commentsHash]
      );
    }

    // The summary is keyed to the comment hash that produced it, so an unchanged thread never
    // pays for a second AI call — the single most expensive step in the pipeline.
    let decisionSummary: string | null = row.decision_summary ? String(row.decision_summary) : null;
    let summarized = false;
    if (!comments.length) {
      decisionSummary = null;
    } else if (commentsHash !== String(row.decision_summary_hash || "")) {
      const allocation = await this.decisions.resolveAllocation(projectId);
      if (allocation) {
        decisionSummary = await this.decisions.summarize(allocation, ticket, comments);
        summarized = true;
        await this.db.query(`UPDATE ${c.table} SET decision_summary = $2, decision_summary_hash = $3 WHERE id = $1`, [
          ticketId,
          decisionSummary,
          commentsHash
        ]);
      }
    }

    const mirror = this.builder.buildMirror(ticket, comments, decisionSummary);
    const upserted = await this.db.query<{ id: string; inserted: boolean }>(
      `INSERT INTO knowledge_documents (
         organization_id, project_id, folder_id, title, content_text, content_html, document_type, status,
         source_provider, source_external_id, source_role, source_url, source_synced_by, source_synced_at, is_read_only
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'requirement_note', 'published', $7, $8, 'mirror', $9, $10, now(), true)
       ON CONFLICT (project_id, source_provider, source_external_id, source_role) WHERE source_provider IS NOT NULL AND is_deleted = false
       DO UPDATE SET
         title = EXCLUDED.title,
         content_text = EXCLUDED.content_text,
         content_html = EXCLUDED.content_html,
         source_url = EXCLUDED.source_url,
         source_synced_by = EXCLUDED.source_synced_by,
         source_synced_at = now(),
         is_read_only = true,
         -- Re-parents documents mirrored into "Requirements" before V72 into the provider folder.
         folder_id = EXCLUDED.folder_id,
         updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [organizationId, projectId, folderId, mirror.title, mirror.markdown, mirror.html, provider, ticket.issueId, ticket.url, triggeredBy]
    );
    // Human input on a synced ticket goes to the document's comment thread
    // (knowledge_document_comments, V73), not to a sibling document — comments live on the
    // document being discussed and survive the body being rewritten here.
    const mirrorDoc = upserted.rows[0];

    if (mirrorDoc?.id) {
      void this.ragIngestion
        .enqueueEmbedding({ organizationId, projectId, sourceType: "document", sourceId: mirrorDoc.id, reason: "updated" })
        .catch(() => undefined);
    }

    await this.runs.recordTicketResult(runId, {
      processed: 1,
      created: mirrorDoc?.inserted ? 1 : 0,
      updated: mirrorDoc?.inserted ? 0 : 1,
      comments: comments.length,
      decisions: summarized && decisionSummary ? 1 : 0
    });
  }

  private storedComments(row: Row): RemoteComment[] {
    const raw = row.comments_json;
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? (parsed as RemoteComment[]) : [];
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job | undefined): Promise<void> {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts || 1)) return;

    const message = String(job.failedReason || "Unknown error").slice(0, 500);
    if (job.name === INTEGRATION_SYNC_RUN_JOB) {
      await this.runs.failRun(String((job.data as SyncRunJobPayload).runId), message).catch(() => undefined);
      return;
    }
    if (job.name === INTEGRATION_SYNC_TICKET_JOB) {
      const data = job.data as SyncTicketJobPayload;
      this.logger.warn(`Ticket ${data.issueKey} permanently failed in run ${data.runId}: ${message}`);
      // Counted as failed so the run can reach its total and settle on 'partial' rather than
      // hanging at 99%.
      await this.runs.recordTicketResult(data.runId, { failed: 1 }).catch(() => undefined);
    }
  }
}
