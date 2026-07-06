import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { LegacyController } from "./legacy.controller";
import { LegacyService } from "./legacy.service";

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [LegacyController],
  providers: [LegacyService]
})
export class LegacyModule {}
