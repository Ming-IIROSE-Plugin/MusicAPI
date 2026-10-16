import { logDiagnostic, safeErrorFields } from "../config/env.js";

export class IpManager {
  private static currentIp = "127.0.0.1";

  static async fetchRealIp(): Promise<void> {
    const startedAt = Date.now();
    try {
      const res = await fetch("https://api.ip.sb/ip", {
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        this.currentIp = (await res.text()).trim();
        logDiagnostic("public-ip", {
          result: "success",
          httpStatus: res.status,
          elapsedMs: Date.now() - startedAt,
        });
      } else {
        logDiagnostic("public-ip", {
          result: "http-error",
          httpStatus: res.status,
          elapsedMs: Date.now() - startedAt,
        });
      }
    } catch (error: unknown) {
      logDiagnostic("public-ip", {
        result: "network-error",
        elapsedMs: Date.now() - startedAt,
        ...safeErrorFields(error),
      });
    }
  }

  static getIp(): string {
    return this.currentIp;
  }
}
