import { Body, Controller, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthenticatedRequest } from "../common/request.types";
import { SignupService } from "./signup.service";

type SelfServeStartBody = { name?: string; email?: string; password?: string };
type SelfServeVerifyBody = { email?: string; code?: string };
type InviteRegisterStartBody = { name?: string; password?: string };
type InviteOtpStartBody = { name?: string };
type CodeBody = { code?: string };

@Controller()
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Post("/api/auth/signup/start")
  @HttpCode(204)
  startSelfServeSignup(@Body() body: SelfServeStartBody, @Req() req: AuthenticatedRequest) {
    return this.signup.startSelfServeSignup(body.name, body.email, body.password, this.ip(req), req.get("user-agent"));
  }

  @Post("/api/auth/signup/verify")
  verifySelfServeSignup(@Body() body: SelfServeVerifyBody, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    return this.signup.verifySelfServeSignup(body.email, body.code, this.ip(req), req.get("user-agent"), req, res);
  }

  @Post("/api/invitations/:token/register/start")
  @HttpCode(204)
  startInviteRegistration(@Param("token") token: string, @Body() body: InviteRegisterStartBody, @Req() req: AuthenticatedRequest) {
    return this.signup.startInviteRegistration(token, body.name, body.password, this.ip(req), req.get("user-agent"));
  }

  @Post("/api/invitations/:token/register/verify")
  verifyInviteRegistration(@Param("token") token: string, @Body() body: CodeBody, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    return this.signup.verifyInviteRegistration(token, body.code, this.ip(req), req.get("user-agent"), req, res);
  }

  @Post("/api/invitations/:token/register/otp/start")
  @HttpCode(204)
  startInviteOtpRegistration(@Param("token") token: string, @Body() body: InviteOtpStartBody, @Req() req: AuthenticatedRequest) {
    return this.signup.startInviteOtpRegistration(token, body.name, this.ip(req), req.get("user-agent"));
  }

  @Post("/api/invitations/:token/register/otp/verify")
  verifyInviteOtpRegistration(@Param("token") token: string, @Body() body: CodeBody, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    return this.signup.verifyInviteOtpRegistration(token, body.code, this.ip(req), req.get("user-agent"), req, res);
  }

  private ip(req: AuthenticatedRequest): string {
    return req.ip ?? "";
  }
}
