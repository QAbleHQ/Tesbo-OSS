import type { Request } from "express";

export function resolveClientIp(req: Pick<Request, "ip" | "get">): string {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) {
    const clientIp = forwarded.split(",")[0]?.trim();
    if (clientIp) return clientIp;
  }
  const realIp = req.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return req.ip?.trim() ?? "";
}

export function isPrivateOrInternalIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.")) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  const match = /^172\.(\d+)\./.exec(ip);
  if (match) {
    const secondOctet = Number(match[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}
