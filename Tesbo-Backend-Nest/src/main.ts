import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import { json, urlencoded } from "express";
import type { Request, Response, NextFunction } from "express";
import { AppModule } from "./app.module";
import { AppConfigService } from "./config/app-config.service";
import { HttpExceptionFilter } from "./common/http-exception.filter";
import { assertEncryptionKeyConfigured } from "./common/crypto.util";
import type { AuthenticatedRequest } from "./common/request.types";

async function bootstrap() {
  assertEncryptionKeyConfigured();
  // bodyParser disabled here so we can raise the limit above Nest's 100kb default (see maxRequestBodySize below)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: false, bodyParser: false });
  const config = app.get(AppConfigService);

  // Trust the immediate reverse proxy (nginx, see deploy/nginx) so req.ip reflects the
  // real client from X-Forwarded-For instead of the proxy's own address — used for the
  // OTP rate limiter and for detecting the buyer's country at checkout (billing module).
  app.set("trust proxy", 1);

  app.use(
    json({
      limit: config.maxRequestBodySize,
      // Stripe webhook signatures are verified against the exact bytes received, which the
      // JSON parser below would otherwise discard after parsing — stash them for BillingController.
      verify: (req, _res, buf) => {
        (req as AuthenticatedRequest).rawBody = buf;
      }
    })
  );
  app.use(urlencoded({ extended: true, limit: config.maxRequestBodySize }));
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Request-Id", randomUUID());
    const forwardedProto = req.header("x-forwarded-proto");
    const secure = req.secure || forwardedProto?.trim().toLowerCase() === "https";
    if (secure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.enableCors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      const normalized = config.normalizeCorsOrigin(origin);
      callback(null, config.corsAllowedOrigins.has(normalized));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "Accept-Language", "X-Request-Id"],
    exposedHeaders: ["X-Total-Count"],
    maxAge: 86400
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(config.port, "0.0.0.0");
  console.log(`Nest backend running on http://localhost:${config.port}`);
}

void bootstrap();
