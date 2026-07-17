import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { AppConfigService } from "./config/app-config.service";
import { DatabaseModule } from "./database/database.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { SetupModule } from "./setup/setup.module";
import { HealthModule } from "./health/health.module";
import { AdminModule } from "./admin/admin.module";
import { LegacyModule } from "./legacy/legacy.module";
import { McpModule } from "./mcp/mcp.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({ connection: { url: config.redisUrl } })
    }),
    AuditModule,
    AuthModule,
    SetupModule,
    HealthModule,
    AdminModule,
    LegacyModule,
    McpModule
  ]
})
export class AppModule {}
