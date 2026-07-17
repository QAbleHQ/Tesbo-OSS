import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Response, NextFunction } from "express";
import { AppConfigService } from "../config/app-config.service";
import { AuthenticatedRequest } from "../common/request.types";
import { ApiTokenService } from "./api-token.service";
import { OtpService } from "./otp.service";

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly config: AppConfigService,
    private readonly otpService: OtpService,
    private readonly apiTokens: ApiTokenService
  ) {}

  async use(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
    // Primary path: browser session cookie.
    const sessionToken = req.cookies?.[this.config.sessionCookieName];
    req.userId = sessionToken ? await this.otpService.resolveSession(sessionToken) : null;
    req.apiToken = null;

    // Secondary path: API bearer token for machine clients (e.g. the MCP server).
    // Only consulted when there is no valid browser session, so the same API
    // serves both the frontend and token-authenticated automation.
    if (!req.userId) {
      const bearer = this.extractBearerToken(req.headers?.authorization);
      if (bearer) {
        const principal = await this.apiTokens.authenticate(bearer);
        if (principal) {
          req.userId = principal.userId;
          req.apiToken = {
            tokenId: principal.tokenId,
            userId: principal.userId,
            projectId: principal.projectId,
            scopes: principal.scopes
          };
        }
      }
    }

    next();
  }

  private extractBearerToken(header: string | string[] | undefined): string | null {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match ? match[1].trim() : null;
  }
}
