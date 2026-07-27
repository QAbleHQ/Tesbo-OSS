import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import * as XLSX from "xlsx";
import { AuthenticatedRequest } from "../common/request.types";
import { LegacyService } from "./legacy.service";
import { CustomFieldsService } from "../custom-fields/custom-fields.service";

const TESTCASE_EXPORT_BASE_HEADERS = [
  "externalId",
  "title",
  "description",
  "preconditions",
  "steps",
  "testData",
  "priority",
  "severity",
  "type",
  "status",
  "suite",
  "component"
];

@Controller()
export class LegacyController {
  constructor(
    private readonly legacy: LegacyService,
    private readonly customFields: CustomFieldsService
  ) {}

  private csvEscape(value: unknown): string {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  private rowsToCsv(headers: string[], rows: Record<string, unknown>[]): string {
    return [
      headers.join(","),
      ...rows.map((row) => headers.map((header) => this.csvEscape(row[header])).join(","))
    ].join("\n");
  }

  private sendWorkbook(res: Response, fileName: string, sheetName: string, rows: Record<string, unknown>[]) {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  }

  @Post("/api/onboarding/workspace")
  createWorkspace(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createWorkspace(req.userId, body);
  }

  @Post("/api/onboarding/org-and-project")
  createOrgAndProject(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createOrgAndProject(req.userId, body);
  }

  @Get("/api/workspace")
  workspace(@Req() req: AuthenticatedRequest) {
    return this.legacy.workspace(req.userId);
  }

  @Get("/api/workspaces")
  listWorkspaces(@Req() req: AuthenticatedRequest) {
    return this.legacy.listWorkspaces(req.userId);
  }

  @Post("/api/workspaces")
  createAdditionalWorkspace(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createWorkspace(req.userId, body);
  }

  @Post("/api/workspaces/:id/switch")
  switchWorkspace(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.switchWorkspace(req.userId, id);
  }

  @Patch("/api/workspace")
  updateWorkspace(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.updateWorkspace(req.userId, body);
  }

  @Get("/api/workspace/analytics")
  async workspaceAnalytics(@Req() req: AuthenticatedRequest) {
    const workspace = await this.legacy.workspace(req.userId);
    return this.legacy.analytics(undefined, workspace.id);
  }

  @Get("/api/workspace/members")
  workspaceMembers(@Req() req: AuthenticatedRequest) {
    return this.legacy.workspaceMembers(req.userId);
  }

  @Post("/api/workspace/members")
  addWorkspaceMember(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.addWorkspaceMember(req.userId, body);
  }

  @Delete("/api/workspace/members/:userId")
  removeWorkspaceMember(@Req() req: AuthenticatedRequest, @Param("userId") userId: string) {
    return this.legacy.removeWorkspaceMember(req.userId, userId);
  }

  @Get("/api/workspace/project-access")
  async projectAccess(@Req() req: AuthenticatedRequest) {
    const projects = await this.legacy.listProjects(req.userId);
    const members = await this.legacy.workspaceMembers(req.userId);
    return { projects, members: members.map((m) => ({ ...m, projectRoles: {} })) };
  }

  @Put("/api/workspace/project-access")
  setProjectAccess(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.addProjectMember(req.userId, body.projectId, { userId: body.userId, role: body.role });
  }

  @Delete("/api/workspace/project-access")
  removeProjectAccess(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.removeProjectMember(req.userId, body.projectId, body.userId);
  }

  @Get("/api/workspace/ai-keys")
  aiKeys(@Req() req: AuthenticatedRequest) {
    return this.legacy.aiKeys(req.userId);
  }

  @Post("/api/workspace/ai-keys")
  createAiKey(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createAiKey(req.userId, body);
  }

  @Delete("/api/workspace/ai-keys/:keyId")
  deleteAiKey(@Req() req: AuthenticatedRequest, @Param("keyId") keyId: string) {
    return this.legacy.deleteAiKey(req.userId, keyId);
  }

  @Post("/api/workspace/ai-keys/allocations")
  allocateAiKey(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.allocateAiKey(req.userId, body);
  }

  @Post("/api/workspace/members/role")
  changeWorkspaceMemberRole(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.changeWorkspaceMemberRole(req.userId, body.userId, body.role);
  }

  @Get("/api/workspace/invitations")
  listInvitations(@Req() req: AuthenticatedRequest) {
    return this.legacy.listInvitations(req.userId);
  }

  @Post("/api/workspace/invitations")
  createInvitation(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createInvitation(req.userId, body);
  }

  @Delete("/api/workspace/invitations/:id")
  cancelInvitation(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.cancelInvitation(req.userId, id);
  }

  @Post("/api/workspace/invitations/:id/resend")
  resendInvitation(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.resendInvitation(req.userId, id);
  }

  @Get("/api/invitations/:token")
  getInvitation(@Param("token") token: string) {
    return this.legacy.getInvitationByToken(token);
  }

  @Post("/api/invitations/:token/accept")
  acceptInvitation(@Req() req: AuthenticatedRequest, @Param("token") token: string) {
    return this.legacy.acceptInvitation(req.userId, token);
  }

  @Post("/api/invitations/:token/register")
  registerFromInvitation(@Param("token") token: string, @Body() body: Record<string, any>) {
    return this.legacy.registerFromInvitation(token, body);
  }

  @Get("/api/projects")
  listProjects(@Req() req: AuthenticatedRequest) {
    return this.legacy.listProjects(req.userId);
  }

  @Post("/api/projects")
  createProject(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createProject(req.userId, body);
  }

  @Get("/api/projects/:id")
  getProject(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.getProjectForUser(req.userId, id);
  }

  @Patch("/api/projects/:id")
  updateProject(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: Record<string, any>) {
    return this.legacy.updateProjectForUser(req.userId, id, body);
  }

  @Delete("/api/projects/:id")
  deleteProject(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.deleteProjectForUser(req.userId, id);
  }

  @Get("/api/projects/:id/members")
  projectMembers(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.projectMembers(req.userId, id);
  }

  @Post("/api/projects/:id/members")
  addProjectMember(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: Record<string, any>) {
    return this.legacy.addProjectMember(req.userId, id, body);
  }

  @Delete("/api/projects/:id/members/:userId")
  removeProjectMember(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("userId") userId: string) {
    return this.legacy.removeProjectMember(req.userId, id, userId);
  }

  @Get("/api/projects/:id/apikeys")
  apiKeys(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.listApiKeys(req.userId, id);
  }

  @Post("/api/projects/:id/apikeys")
  createApiKey(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: Record<string, any>) {
    return this.legacy.createApiKey(req.userId, id, body);
  }

  @Delete("/api/projects/:id/apikeys/:keyId")
  revokeApiKey(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("keyId") keyId: string) {
    return this.legacy.revokeApiKey(req.userId, id, keyId);
  }

  @Get("/api/projects/:projectId/suites")
  listSuites(@Param("projectId") projectId: string) {
    return this.legacy.listSuites(projectId);
  }

  @Post("/api/projects/:projectId/suites")
  createSuite(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createSuite(projectId, body);
  }

  @Patch("/api/suites/:suiteId")
  updateSuite(@Param("suiteId") suiteId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateSuite(suiteId, body);
  }

  @Delete("/api/suites/:suiteId")
  deleteSuite(@Param("suiteId") suiteId: string, @Query("mode") mode?: string) {
    return this.legacy.deleteSuite(suiteId, mode);
  }

  @Get("/api/projects/:projectId/testcases")
  async listTestCases(@Param("projectId") projectId: string, @Query() query: Record<string, any>, @Res() res: Response) {
    const result = await this.legacy.listTestCases(projectId, query);
    res.setHeader("X-Total-Count", String(result.total));
    res.json(result.rows);
  }

  @Post("/api/projects/:projectId/testcases")
  createTestCase(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createTestCase(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/testcases/linked-jira-keys")
  linkedJiraKeys(@Param("projectId") projectId: string) {
    return this.legacy.linkedJiraKeys(projectId);
  }

  @Get("/api/projects/:projectId/testcases/linked-linear-keys")
  linkedLinearKeys(@Param("projectId") projectId: string) {
    return this.legacy.linkedLinearKeys(projectId);
  }

  @Get("/api/projects/:projectId/testcases/:testcaseId")
  getTestCase(@Param("testcaseId") testcaseId: string) {
    return this.legacy.getTestCase(testcaseId);
  }

  @Put("/api/projects/:projectId/testcases/:testcaseId")
  updateTestCase(@Req() req: AuthenticatedRequest, @Param("testcaseId") testcaseId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateTestCase(testcaseId, req.userId, body);
  }

  @Delete("/api/projects/:projectId/testcases/:testcaseId")
  deleteTestCase(@Req() req: AuthenticatedRequest, @Param("testcaseId") testcaseId: string) {
    return this.legacy.deleteTestCase(testcaseId, req.userId);
  }

  @Post("/api/projects/:projectId/testcases/:testcaseId/duplicate")
  duplicateTestCase(@Req() req: AuthenticatedRequest, @Param("testcaseId") testcaseId: string) {
    return this.legacy.duplicateTestCase(testcaseId, req.userId);
  }

  @Post("/api/projects/:projectId/testcases/bulk-update")
  bulkUpdate(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.bulkUpdateTestCases(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/testcases/bulk-delete")
  bulkDelete(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.bulkDeleteTestCases(projectId, req.userId, body.testcaseIds || []);
  }

  @Get("/api/projects/:projectId/plans")
  listPlans(@Param("projectId") projectId: string) {
    return this.legacy.listPlans(projectId);
  }

  @Post("/api/projects/:projectId/plans")
  createPlan(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createPlan(projectId, body);
  }

  @Get("/api/plans/:planId")
  getPlan(@Param("planId") planId: string) {
    return this.legacy.getPlan(planId);
  }

  @Patch("/api/plans/:planId")
  updatePlan(@Param("planId") planId: string, @Body() body: Record<string, any>) {
    return this.legacy.updatePlan(planId, body);
  }

  @Delete("/api/plans/:planId")
  deletePlan(@Param("planId") planId: string) {
    return this.legacy.deletePlan(planId);
  }

  @Get("/api/plans/:planId/items")
  planItems(@Param("planId") planId: string) {
    return this.legacy.planItems(planId);
  }

  @Post("/api/plans/:planId/items")
  addPlanItem(@Param("planId") planId: string, @Body() body: Record<string, any>) {
    return this.legacy.addPlanItem(planId, body);
  }

  @Delete("/api/plans/:planId/items/:itemId")
  removePlanItem(@Param("itemId") itemId: string) {
    return this.legacy.deletePlanItem(itemId);
  }

  @Get("/api/plans/:planId/runs")
  planRuns(@Param("planId") planId: string) {
    return this.legacy.planRuns(planId);
  }

  @Get("/api/plans/:planId/progress")
  planProgress(@Param("planId") planId: string) {
    return this.legacy.planProgress(planId);
  }

  @Get("/api/projects/:projectId/cycles")
  listCycles(@Param("projectId") projectId: string) {
    return this.legacy.listCycles(projectId);
  }

  @Post("/api/projects/:projectId/cycles")
  createCycle(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycle(projectId, body);
  }

  @Post("/api/projects/:projectId/cycles/from-plan")
  createCycleFromPlan(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycle(projectId, body);
  }

  @Post("/api/projects/:projectId/cycles/from-cases")
  createCycleFromCases(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycle(projectId, body);
  }

  @Get("/api/cycles/:cycleId")
  getCycle(@Param("cycleId") cycleId: string) {
    return this.legacy.getCycle(cycleId);
  }

  @Patch("/api/cycles/:cycleId")
  updateCycle(@Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateCycle(cycleId, body);
  }

  @Delete("/api/cycles/:cycleId")
  deleteCycle(@Param("cycleId") cycleId: string) {
    return this.legacy.deleteCycle(cycleId);
  }

  @Post("/api/cycles/:cycleId/testcases")
  addCycleCases(@Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.addCycleTestCases(cycleId, body);
  }

  @Delete("/api/cycles/:cycleId/testcases/:testcaseId")
  removeCycleCase(@Param("cycleId") cycleId: string, @Param("testcaseId") testcaseId: string) {
    return this.legacy.removeCycleTestCase(cycleId, testcaseId);
  }

  @Get("/api/cycles/:cycleId/executions")
  executions(@Param("cycleId") cycleId: string) {
    return this.legacy.executions(cycleId);
  }

  @Patch("/api/cycles/:cycleId/executions/:executionId")
  updateExecution(@Req() req: AuthenticatedRequest, @Param("executionId") executionId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateExecution(executionId, req.userId, body);
  }

  @Post("/api/cycles/:cycleId/executions/:executionId/attachments")
  @UseInterceptors(FilesInterceptor("files", 10, { limits: { fileSize: LegacyService.KB_MAX_UPLOAD_SIZE } }))
  uploadExecutionAttachments(
    @Req() req: AuthenticatedRequest,
    @Param("cycleId") cycleId: string,
    @Param("executionId") executionId: string,
    @UploadedFiles() files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    return this.legacy.uploadExecutionAttachments(cycleId, req.userId, executionId, files);
  }

  @Get("/api/cycles/:cycleId/executions/:executionId/attachments")
  listExecutionAttachments(@Param("executionId") executionId: string) {
    return this.legacy.listExecutionAttachments(executionId);
  }

  @Post("/api/cycles/:cycleId/executions/bulk-assign")
  bulkAssign() {}

  @Post("/api/cycles/:cycleId/executions/bulk-status")
  bulkStatus() {}

  @Post("/api/cycles/:cycleId/share")
  shareCycle(@Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.shareCycle(cycleId, body);
  }

  @Get("/api/projects/:projectId/cycles/schedules")
  schedules() {
    return [];
  }

  @Post("/api/projects/:projectId/cycles/schedules")
  createSchedule(@Body() body: Record<string, any>) {
    return { id: "local-schedule", ...body };
  }

  @Patch("/api/cycles/schedules/:scheduleId")
  updateSchedule() {}

  @Delete("/api/cycles/schedules/:scheduleId")
  deleteSchedule() {}

  @Get("/api/public/shared-runs/:token")
  publicRun(@Param("token") token: string) {
    return this.legacy.publicCycle(token);
  }

  @Get("/api/public/shared-runs/:token/executions")
  publicExecutions(@Param("token") token: string) {
    return this.legacy.publicCycleExecutions(token);
  }

  @Get("/api/projects/:projectId/bugs")
  listBugs(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listBugs(projectId, query);
  }

  @Post("/api/projects/:projectId/bugs")
  createBug(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createBug(projectId, req.userId, body);
  }

  @Get("/api/bugs/:bugId")
  getBug(@Param("bugId") bugId: string) {
    return this.legacy.getBug(bugId);
  }

  @Patch("/api/bugs/:bugId")
  updateBug(@Param("bugId") bugId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateBug(bugId, body);
  }

  @Delete("/api/bugs/:bugId")
  deleteBug(@Param("bugId") bugId: string) {
    return this.legacy.deleteBug(bugId);
  }

  @Post("/api/bugs/:bugId/links")
  addBugLink(@Param("bugId") bugId: string, @Body() body: Record<string, any>) {
    return this.legacy.addBugLink(bugId, body);
  }

  @Delete("/api/bugs/:bugId/links/:linkId")
  removeBugLink(@Param("bugId") bugId: string, @Param("linkId") linkId: string) {
    return this.legacy.removeBugLink(bugId, linkId);
  }

  @Post("/api/projects/:projectId/bugs/:bugId/attachments")
  @UseInterceptors(FilesInterceptor("files", 10, { limits: { fileSize: LegacyService.KB_MAX_UPLOAD_SIZE } }))
  uploadBugAttachments(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("bugId") bugId: string,
    @UploadedFiles() files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    return this.legacy.uploadBugAttachments(projectId, req.userId, bugId, files);
  }

  @Get("/api/projects/:projectId/bugs/attachments/:attachmentId/download")
  async downloadBugAttachment(@Res() res: Response, @Param("attachmentId") attachmentId: string) {
    const access = await this.legacy.getBugAttachmentAccess(attachmentId, false);
    if ("redirectUrl" in access) return res.redirect(302, access.redirectUrl);
    res.setHeader("Content-Type", access.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(access.originalFileName)}"`);
    if ("buffer" in access && access.buffer) return res.send(access.buffer);
    if ("localPath" in access && access.localPath) return res.sendFile(access.localPath);
    throw new Error("Attachment content unavailable");
  }

  @Delete("/api/bugs/attachments/:attachmentId")
  deleteBugAttachment(@Param("attachmentId") attachmentId: string) {
    return this.legacy.deleteBugAttachment(attachmentId);
  }

  @Get("/api/projects/:projectId/testcases/export/csv")
  async exportCsv(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Res() res: Response) {
    const definitions = await this.customFields.listActiveDefinitionsForColumns(req.userId, projectId);
    const rows = await this.legacy.exportTestCases(projectId, definitions);
    const headers = [...TESTCASE_EXPORT_BASE_HEADERS, ...definitions.map((d) => `cf_${d.key}`)];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="testcases.csv"');
    res.send(this.rowsToCsv(headers, rows));
  }

  @Get("/api/projects/:projectId/testcases/export/xlsx")
  async exportXlsx(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Res() res: Response) {
    const definitions = await this.customFields.listActiveDefinitionsForColumns(req.userId, projectId);
    const rows = await this.legacy.exportTestCases(projectId, definitions);
    this.sendWorkbook(res, "testcases.xlsx", "Test Cases", rows);
  }

  @Get("/api/projects/:projectId/testcases/import/template")
  template(@Query("format") format: string | undefined, @Res() res: Response) {
    const rows = [
      {
        title: "Example login test",
        description: "Verify a valid user can sign in.",
        preconditions: "User account exists.",
        // "action => expected result" per step, separated by " | " — the expected result after
        // "=>" is optional but importing it this way carries it into each step's Expected Result.
        steps: "Open login page => Login form is displayed | Enter valid credentials => Fields accept the input | Submit the form => User is redirected to the dashboard",
        testData: "user@example.com",
        priority: "P2",
        severity: "Medium",
        type: "Functional",
        status: "Draft",
        suite: "Authentication",
        component: "Login"
      }
    ];
    if (format === "xlsx") {
      this.sendWorkbook(res, "testcase-import-template.xlsx", "Test Cases", rows);
      return;
    }
    const headers = Object.keys(rows[0]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="testcase-import-template.csv"');
    res.send(this.rowsToCsv(headers, rows));
  }

  @Post("/api/projects/:projectId/testcases/import/preview")
  previewImport() {
    return { uploadId: "local-upload", headers: [], previewRows: [], totalRows: 0 };
  }

  @Post("/api/projects/:projectId/testcases/import")
  executeImport() {
    return { imported: 0, errors: [] };
  }

  @Get("/api/cycles/:cycleId/export/csv")
  async exportCycle(@Param("cycleId") cycleId: string, @Res() res: Response) {
    const rows = await this.legacy.executions(cycleId);
    const headers = ["externalId", "title", "status", "priority", "type", "actualResult", "executedAt", "defectKey", "defectUrl"];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="test-run.csv"');
    res.send(this.rowsToCsv(headers, rows));
  }

  @Get("/api/projects/:projectId/analytics")
  projectAnalytics(@Param("projectId") projectId: string) {
    return this.legacy.analytics(projectId);
  }

  @Get("/api/projects/:projectId/dashboard")
  projectDashboard(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.projectDashboardSummary(req.userId, projectId);
  }

  @Get("/api/cycles/:cycleId/report/summary")
  cycleSummary() {
    return { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 0 };
  }

  @Get("/api/projects/:projectId/reports/execution")
  executionReport(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.executionReport(projectId, query);
  }

  @Get("/api/projects/:projectId/reports/requirement-matrix")
  matrix(@Param("projectId") projectId: string) {
    return this.legacy.requirementMatrix(projectId);
  }

  @Get("/api/projects/:projectId/reports/repository-summary")
  repositorySummary(@Param("projectId") projectId: string) {
    return this.legacy.repositorySummary(projectId);
  }

  @Get("/api/projects/:projectId/reports/overview")
  reportsOverview(@Param("projectId") projectId: string) {
    return this.legacy.reportsOverview(projectId);
  }

  @Get("/api/projects/:projectId/reports/insights")
  reportsInsights(@Param("projectId") projectId: string) {
    return this.legacy.reportsInsights(projectId);
  }

  @Get("/api/projects/:projectId/reports/trends")
  reportsTrends(@Param("projectId") projectId: string) {
    return this.legacy.reportsTrends(projectId);
  }

  @Post("/api/projects/:projectId/ai/generate-testcases")
  generateAi(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.aiGenerate(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/ai/review-script")
  reviewScript() {
    return { status: "passed", summary: "", categories: [], validatedSteps: [] };
  }

  @Get("/api/projects/:projectId/ai/generation-history")
  aiHistory(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.aiHistory(projectId, query);
  }

  @Post("/api/projects/:projectId/ai/generation-history/:requestId/save")
  aiSave(@Param("projectId") projectId: string, @Param("requestId") requestId: string, @Body() body: Record<string, any>) {
    return this.legacy.aiSave(projectId, requestId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra")
  zyraAgent(@Param("projectId") projectId: string) {
    return this.legacy.zyraAgent(projectId);
  }

  @Get("/api/projects/:projectId/agents/zyra/test")
  testZyraConnection(@Param("projectId") projectId: string) {
    return this.legacy.testZyraAiConnection(projectId);
  }

  @Patch("/api/projects/:projectId/agents/zyra/settings")
  updateZyraSettings(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateZyraSettings(projectId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/chat/sessions")
  zyraChatSessions(@Param("projectId") projectId: string) {
    return this.legacy.zyraChatSessions(projectId);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions")
  createZyraChatSession(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createZyraChatSession(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId")
  zyraChatSession(@Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.legacy.zyraChatSession(projectId, sessionId);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId/messages")
  sendZyraChatMessage(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.sendZyraChatMessage(projectId, req.userId, sessionId, body);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId/stop-plan")
  stopZyraChatPlan(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string
  ) {
    return this.legacy.stopZyraChatPlan(projectId, req.userId, sessionId);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId/resume-plan")
  resumeZyraChatPlan(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string
  ) {
    return this.legacy.resumeZyraChatPlan(projectId, req.userId, sessionId);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks")
  createZyraTask(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.aiGenerate(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/tasks/:taskId")
  getZyraTask(@Param("projectId") projectId: string, @Param("taskId") taskId: string) {
    return this.legacy.zyraTask(projectId, taskId);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks/:taskId/feedback")
  feedbackZyraTask(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("taskId") taskId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.zyraFeedback(projectId, req.userId, taskId, body);
  }

  @Delete("/api/projects/:projectId/agents/zyra/tasks/:taskId/drafts/:draftIndex")
  deleteZyraDraft(@Param("projectId") projectId: string, @Param("taskId") taskId: string, @Param("draftIndex") draftIndex: string) {
    return this.legacy.zyraDeleteDraft(projectId, taskId, Number(draftIndex));
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks/:taskId/close")
  closeZyraTask(@Param("projectId") projectId: string, @Param("taskId") taskId: string) {
    return this.legacy.zyraCloseTask(projectId, taskId);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks/:taskId/save")
  saveZyraTask(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("taskId") taskId: string, @Body() body: Record<string, any>) {
    return this.legacy.zyraSave(projectId, req.userId, taskId, body);
  }

  // ─── Knowledge Base v2 (folders / documents / files) ────────────────────────
  // NOTE: these routes must stay ABOVE the legacy /knowledge-base/:itemId routes
  // below, since literal segments like "folders"/"search" would otherwise be
  // captured by that older single-param route.

  @Post("/api/projects/:projectId/knowledge-base/folders")
  createKnowledgeFolder(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createKnowledgeFolder(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/knowledge-base/folders/tree")
  getKnowledgeFolderTree(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.getKnowledgeFolderTree(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/knowledge-base/summary")
  getKnowledgeBaseSummary(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.knowledgeBaseSummary(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/knowledge-base/folders/:folderId/export")
  async exportKnowledgeFolder(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("folderId") folderId: string
  ) {
    const { buffer, filename } = await this.legacy.exportKnowledgeFolder(projectId, req.userId, folderId);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(buffer);
  }

  @Get("/api/projects/:projectId/knowledge-base/folders/:folderId")
  getKnowledgeFolder(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("folderId") folderId: string) {
    return this.legacy.getKnowledgeFolder(projectId, req.userId, folderId);
  }

  @Get("/api/projects/:projectId/knowledge-base/folders/:folderId/items")
  listKnowledgeFolderItems(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("folderId") folderId: string,
    @Query() query: Record<string, any>
  ) {
    return this.legacy.listKnowledgeFolderItems(projectId, req.userId, folderId, query);
  }

  @Patch("/api/projects/:projectId/knowledge-base/folders/:folderId/move")
  moveKnowledgeFolder(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("folderId") folderId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.moveKnowledgeFolder(projectId, req.userId, folderId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/folders/:folderId/restore")
  restoreKnowledgeFolder(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("folderId") folderId: string) {
    return this.legacy.restoreKnowledgeFolder(projectId, req.userId, folderId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/folders/:folderId")
  updateKnowledgeFolder(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("folderId") folderId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateKnowledgeFolder(projectId, req.userId, folderId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/folders/:folderId")
  deleteKnowledgeFolder(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("folderId") folderId: string) {
    return this.legacy.deleteKnowledgeFolder(projectId, req.userId, folderId);
  }

  @Get("/api/projects/:projectId/knowledge-base/search")
  searchKnowledgeBase(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.searchKnowledgeBase(projectId, req.userId, query);
  }

  @Get("/api/projects/:projectId/knowledge-base/documents")
  listKnowledgeDocuments(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listKnowledgeDocuments(projectId, req.userId, query);
  }

  @Post("/api/projects/:projectId/knowledge-base/documents")
  createKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createKnowledgeDocument(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/knowledge-base/documents/:documentId/versions")
  listKnowledgeDocumentVersions(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.listKnowledgeDocumentVersions(projectId, req.userId, documentId);
  }

  @Post("/api/projects/:projectId/knowledge-base/documents/:documentId/restore-version")
  restoreKnowledgeDocumentVersion(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.restoreKnowledgeDocumentVersion(projectId, req.userId, documentId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId/approve-ai-memory")
  approveAiMemory(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.approveAiMemory(projectId, req.userId, documentId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId/reject-ai-memory")
  rejectAiMemory(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.rejectAiMemory(projectId, req.userId, documentId);
  }

  @Get("/api/projects/:projectId/knowledge-base/documents/:documentId")
  getKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.getKnowledgeDocument(projectId, req.userId, documentId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId/move")
  moveKnowledgeDocument(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.moveKnowledgeDocument(projectId, req.userId, documentId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId/restore")
  restoreKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.restoreKnowledgeDocument(projectId, req.userId, documentId);
  }

  @Post("/api/projects/:projectId/knowledge-base/documents/:documentId/duplicate")
  duplicateKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.duplicateKnowledgeDocument(projectId, req.userId, documentId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId")
  updateKnowledgeDocument(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateKnowledgeDocument(projectId, req.userId, documentId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/documents/:documentId")
  deleteKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.deleteKnowledgeDocument(projectId, req.userId, documentId);
  }

  @Post("/api/projects/:projectId/knowledge-base/files/upload")
  @UseInterceptors(FilesInterceptor("files", 10, { limits: { fileSize: LegacyService.KB_MAX_UPLOAD_SIZE } }))
  uploadKnowledgeFiles(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: Record<string, any>,
    @UploadedFiles() files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    return this.legacy.uploadKnowledgeFiles(projectId, req.userId, body.folderId, files);
  }

  @Get("/api/projects/:projectId/knowledge-base/files/:fileId/download")
  async downloadKnowledgeFile(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("fileId") fileId: string
  ) {
    const access = await this.legacy.getKnowledgeFileAccess(projectId, req.userId, fileId, false);
    if ("redirectUrl" in access) return res.redirect(302, access.redirectUrl);
    res.setHeader("Content-Type", access.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(access.originalFileName)}"`);
    if ("buffer" in access && access.buffer) return res.send(access.buffer);
    if ("localPath" in access && access.localPath) return res.sendFile(access.localPath);
    throw new Error("Knowledge file content unavailable");
  }

  @Get("/api/projects/:projectId/knowledge-base/files/:fileId/preview")
  async previewKnowledgeFile(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("fileId") fileId: string
  ) {
    const access = await this.legacy.getKnowledgeFileAccess(projectId, req.userId, fileId, true);
    if ("redirectUrl" in access) return res.redirect(302, access.redirectUrl);
    res.setHeader("Content-Type", access.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(access.originalFileName)}"`);
    if ("buffer" in access) return res.send(access.buffer);
    res.sendFile(access.localPath);
  }

  @Get("/api/projects/:projectId/knowledge-base/files/:fileId")
  getKnowledgeFile(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("fileId") fileId: string) {
    return this.legacy.getKnowledgeFile(projectId, req.userId, fileId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/files/:fileId/move")
  moveKnowledgeFile(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("fileId") fileId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.moveKnowledgeFile(projectId, req.userId, fileId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/files/:fileId/restore")
  restoreKnowledgeFile(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("fileId") fileId: string) {
    return this.legacy.restoreKnowledgeFile(projectId, req.userId, fileId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/files/:fileId")
  updateKnowledgeFile(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("fileId") fileId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateKnowledgeFile(projectId, req.userId, fileId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/files/:fileId")
  deleteKnowledgeFile(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("fileId") fileId: string) {
    return this.legacy.deleteKnowledgeFile(projectId, req.userId, fileId);
  }

  // ─── Knowledge Base v1 (legacy flat notes/files — superseded by v2 above) ────

  @Get("/api/projects/:projectId/knowledge-base")
  knowledge(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listKnowledge(projectId, query);
  }

  @Post("/api/projects/:projectId/knowledge-base")
  createKnowledge(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createKnowledge(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/knowledge-base/upload")
  uploadKnowledge() {
    return { error: "File uploads are not enabled in this endpoint yet" };
  }

  @Get("/api/projects/:projectId/knowledge-base/:itemId")
  getKnowledge(@Param("itemId") itemId: string) {
    return this.legacy.getKnowledge(itemId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/:itemId")
  updateKnowledge(@Param("itemId") itemId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateKnowledge(itemId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/:itemId")
  deleteKnowledge(@Param("itemId") itemId: string) {
    return this.legacy.deleteKnowledge(itemId);
  }

  @Get("/api/projects/:projectId/knowledge-base/:itemId/file")
  knowledgeFile() {
    return {};
  }

  // ── Workspace-scoped app integrations (Jira, Linear) ──
  // Connecting/configuring an app is workspace-wide; see the project-scoped mapping/sync/ticket
  // routes further below for picking which remote project/team feeds a given Tesbo project.

  @Get("/api/workspace/integrations/:provider/auth-url")
  integrationAuthUrl(@Req() req: AuthenticatedRequest, @Param("provider") provider: string) {
    return this.legacy.integrationAuthUrl(req.userId, provider);
  }

  @Get("/api/workspace/integrations/:provider/config")
  integrationConfig(@Req() req: AuthenticatedRequest, @Param("provider") provider: string) {
    return this.legacy.integrationConfigStatus(req.userId, provider);
  }

  @Patch("/api/workspace/integrations/:provider/config")
  updateIntegrationConfig(@Req() req: AuthenticatedRequest, @Param("provider") provider: string, @Body() body: Record<string, any>) {
    return this.legacy.updateIntegrationConfig(req.userId, provider, body);
  }

  @Post("/api/workspace/integrations/:provider/callback")
  integrationCallback(@Req() req: AuthenticatedRequest, @Param("provider") provider: string, @Body() body: Record<string, any>) {
    return this.legacy.integrationCallback(req.userId, provider, body);
  }

  @Post("/api/workspace/integrations/:provider/connect-token")
  connectIntegrationToken(@Req() req: AuthenticatedRequest, @Param("provider") provider: string, @Body() body: Record<string, any>) {
    return this.legacy.connectIntegrationWithToken(req.userId, provider, body);
  }

  @Delete("/api/workspace/integrations/:provider/disconnect")
  integrationDisconnect(@Req() req: AuthenticatedRequest, @Param("provider") provider: string) {
    return this.legacy.integrationDisconnect(req.userId, provider);
  }

  @Get("/api/workspace/integrations/:provider/status")
  integrationStatus(@Req() req: AuthenticatedRequest, @Param("provider") provider: string) {
    return this.legacy.integrationStatus(req.userId, provider);
  }

  // ── Project-scoped Jira mapping/sync/tickets ──

  @Get("/api/projects/:projectId/jira/status")
  jiraStatus(@Param("projectId") projectId: string) {
    return this.legacy.jiraStatus(projectId);
  }

  @Get("/api/projects/:projectId/jira/projects")
  jiraProjects(@Param("projectId") projectId: string) {
    return this.legacy.jiraProjects(projectId);
  }

  @Post("/api/projects/:projectId/jira/projects")
  connectJiraProjects(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.connectJiraProjects(projectId, body);
  }

  @Post("/api/projects/:projectId/jira/sync")
  syncJira(@Param("projectId") projectId: string) {
    return this.legacy.syncJira(projectId);
  }

  @Get("/api/projects/:projectId/jira/tickets")
  jiraTickets(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.jiraTickets(projectId, query);
  }

  @Post("/api/projects/:projectId/jira/comment")
  jiraComment(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.jiraComment(projectId, body);
  }

  @Get("/api/projects/:projectId/jira/search-issues")
  jiraSearchIssues(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.jiraSearchIssues(projectId, query);
  }

  // ── Project-scoped Linear mapping/sync/tickets ──

  @Get("/api/projects/:projectId/linear/status")
  linearStatus(@Param("projectId") projectId: string) {
    return this.legacy.linearStatus(projectId);
  }

  @Get("/api/projects/:projectId/linear/teams")
  linearTeams(@Param("projectId") projectId: string) {
    return this.legacy.linearTeams(projectId);
  }

  @Post("/api/projects/:projectId/linear/teams")
  connectLinearTeams(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.connectLinearTeams(projectId, body);
  }

  @Post("/api/projects/:projectId/linear/sync")
  syncLinear(@Param("projectId") projectId: string) {
    return this.legacy.syncLinear(projectId);
  }

  @Get("/api/projects/:projectId/linear/tickets")
  linearTickets(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.linearTickets(projectId, query);
  }

  @Post("/api/projects/:projectId/linear/comment")
  linearComment(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.linearComment(projectId, body);
  }

  @Get("/api/projects/:projectId/linear/search-issues")
  linearSearchIssues(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.linearSearchIssues(projectId, query);
  }

  // ── Requirements page: cross-source (Jira + Linear) aggregates ──

  @Get("/api/projects/:projectId/tickets/summary")
  requirementsSummary(@Param("projectId") projectId: string) {
    return this.legacy.requirementsSummary(projectId);
  }

  @Get("/api/projects/:projectId/tickets")
  allTickets(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.allTickets(projectId, query);
  }

  @Get("/api/projects/:projectId/activity")
  activity(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listActivityForUser(req.userId, projectId, query);
  }

  @Get("/api/projects/:projectId/activity/summary")
  activitySummary(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.activitySummaryForUser(req.userId, projectId);
  }

  @Get("/api/workspace/activity")
  workspaceActivity(@Req() req: AuthenticatedRequest, @Query() query: Record<string, any>) {
    return this.legacy.workspaceActivity(req.userId, query);
  }

  @Get("/api/workspace/activity/summary")
  workspaceActivitySummary(@Req() req: AuthenticatedRequest) {
    return this.legacy.workspaceActivitySummaryForUser(req.userId);
  }

  @Get("/api/notifications")
  notifications() {
    return [];
  }

  @Post("/api/notifications/:id/read")
  readNotification() {}

  @Get("/api/admin/customers")
  customers(@Req() req: AuthenticatedRequest) {
    return this.legacy.adminCustomers(req.userId);
  }

  @Get("/api/admin/admins")
  admins(@Req() req: AuthenticatedRequest) {
    return this.legacy.adminList(req.userId);
  }

  @Get("/api/branding")
  branding() {
    return this.legacy.publicBranding();
  }

  @Get("/api/admin/branding")
  adminBranding(@Req() req: AuthenticatedRequest) {
    return this.legacy.adminBranding(req.userId);
  }

  @Patch("/api/admin/branding")
  updateAdminBranding(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.updateAdminBranding(req.userId, body);
  }

  @Post("/api/admin/admins")
  addAdmin(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.addAdmin(req.userId, body);
  }

  @Delete("/api/admin/admins/:adminId")
  removeAdmin(@Req() req: AuthenticatedRequest, @Param("adminId") adminId: string) {
    return this.legacy.deleteAdmin(req.userId, adminId);
  }

  @Get("/api/projects/:projectId/tesbo-reports/runs")
  tesboRuns() {
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/specs")
  tesboSpecs() {
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/tests")
  tesboTests() {
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/analytics")
  tesboAnalytics() {
    return { totalRuns: 0, totalTests: 0, passRate: 0, byStatus: {}, runsByDay: [] };
  }

  @Get("/api/projects/:projectId/tesbo-reports/alerts")
  tesboAlerts() {
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/settings")
  tesboSettings() {
    return { keepTrace: true, traceRetentionDays: 14, ingestionApiKey: "", alertsEnabled: false, shareByDefault: false };
  }
}
