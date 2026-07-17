import type { DatabaseService } from "../database/database.service";
import type { LegacyService } from "../legacy/legacy.service";

/**
 * Tesbo MCP — protocol types.
 *
 * The "Tesbo MCP" card ships an MCP (Model Context Protocol) server as an in-process
 * module inside Tesbo-Backend-Nest, exposed over an HTTP transport (see mcp.controller.ts).
 * MCP is JSON-RPC 2.0; this file defines the small slice of the wire format we implement
 * (initialize / tools/list / tools/call / ping) plus the internal tool-registry shape.
 *
 * Design note: this is a dependency-free implementation of the JSON-RPC/MCP surface rather
 * than a wrapper around @modelcontextprotocol/sdk. The protocol layer is tiny and keeping it
 * in-tree makes the whole thing unit-testable without a running app or DB — which matters
 * because the Playwright e2e suite cannot boot in the build sandbox.
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "tesbo-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

/** The well-known agent slug MCP-driven writes are attributed to (seeded in V65). */
export const MCP_AGENT_SLUG = "tesbo-mcp";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** JSON-RPC / MCP error codes. Negatives follow the JSON-RPC spec; we add app codes >= -32000. */
export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Authenticated token is not scoped to the project it is trying to act on. */
  ProjectScopeDenied: -32001,
  /** Authenticated token lacks the scope (read/write) a tool requires. */
  ScopeDenied: -32002,
  /** Tool executed but the underlying operation failed (bad args, not found, etc.). */
  ToolExecutionError: -32003
} as const;

/** A protocol-aware error the engine maps straight onto a JSON-RPC error response. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "McpError";
  }
}

export type TokenScope = "read" | "write";

/**
 * Everything a tool handler needs. `projectId` is always the token's own project (scope is
 * enforced before a handler runs), `actorId` is the dedicated MCP agent actor used for
 * actor-column attribution, and `userId` is the token's creating human (used where a column
 * references users(id) rather than actors(id), e.g. bugs.reported_by).
 */
export interface McpToolContext {
  projectId: string;
  actorId: string | null;
  userId: string | null;
  scopes: TokenScope[];
  legacy: LegacyService;
  db: DatabaseService;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema advertised to clients via tools/list. */
  inputSchema: Record<string, unknown>;
  /** Minimum token scope required to call this tool. */
  requiredScope: TokenScope;
  handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown>;
}
