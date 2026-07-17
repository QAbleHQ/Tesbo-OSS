import { Body, Controller, Param, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { AuthenticatedRequest } from "../common/request.types";
import { McpService } from "./mcp.service";

/**
 * Tesbo MCP — HTTP transport.
 *
 * A single JSON-RPC 2.0 endpoint per project. Authentication is the API bearer token resolved
 * by AuthMiddleware (req.apiToken); browser-session callers are rejected because MCP is a
 * machine-client surface. The project on the URL is cross-checked against the token's own
 * project inside McpService, so a token can never drive another project's data.
 *
 * Example:
 *   POST /api/projects/<projectId>/mcp
 *   Authorization: Bearer tsbo_...
 *   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
 */
@Controller()
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post("/api/projects/:projectId/mcp")
  async handle(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: unknown
  ) {
    const principal = req.apiToken;
    if (!principal) {
      // Machine surface: must present a valid API bearer token (not a browser session).
      throw new UnauthorizedException({ error: "MCP requires a valid API token (Authorization: Bearer <token>)" });
    }
    return this.mcp.handleRequest(body, principal, projectId);
  }
}
