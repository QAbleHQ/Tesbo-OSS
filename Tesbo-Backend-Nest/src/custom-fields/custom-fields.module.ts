import { forwardRef, Module } from "@nestjs/common";
import { LegacyModule } from "../legacy/legacy.module";
import { CustomFieldsController } from "./custom-fields.controller";
import { CustomFieldsService } from "./custom-fields.service";

@Module({
  imports: [forwardRef(() => LegacyModule)],
  controllers: [CustomFieldsController],
  providers: [CustomFieldsService],
  exports: [CustomFieldsService]
})
export class CustomFieldsModule {}
