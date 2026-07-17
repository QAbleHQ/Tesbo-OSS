import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LegacyModule } from "../legacy/legacy.module";
import { McpController } from "./mcp.controller";
import { McpService } from "./mcp.service";

/**
 * Tesbo MCP module: the in-process MCP server exposed over HTTP.
 * Reuses LegacyService for all data operations and the shared AuthMiddleware (via AuthModule)
 * for bearer-token resolution.
 */
@Module({
  imports: [LegacyModule, AuthModule],
  controllers: [McpController],
  providers: [McpService]
})
export class McpModule {}
