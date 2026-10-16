import { SendRequest } from "../index.js";
import { NeteaseCrypto } from "./NeteaseCrypto.js";
import { logDiagnostic, safeErrorFields } from "../../config/env.js";

class NeteaseAccountError extends Error {
  public readonly errorCategory:
    "http-error" | "invalid-json" | "business-error" | "malformed-response";
  public readonly httpStatus: number;
  public readonly businessCode?: number;

  public constructor(
    category: NeteaseAccountError["errorCategory"],
    httpStatus: number,
    businessCode?: number,
  ) {
    super("网易云账号请求失败");
    this.name = "NeteaseAccountError";
    this.errorCategory = category;
    this.httpStatus = httpStatus;
    this.businessCode = businessCode;
  }
}

export function classifyAccount(
  data: unknown,
): "alive" | "invalid" | "unavailable" {
  if (!data || typeof data !== "object") return "unavailable";
  const { code, account, profile } = data as Partial<NeteaseAccountInfo>;
  if (code === 301 || code === 401) return "invalid";
  if (code !== 200) return "unavailable";
  if (account === null && profile === null) return "invalid";
  if (
    !account ||
    !profile ||
    typeof account !== "object" ||
    typeof profile !== "object" ||
    !Number.isSafeInteger(account.id) ||
    account.id <= 0 ||
    !Number.isSafeInteger(profile.userId) ||
    profile.userId <= 0 ||
    typeof profile.nickname !== "string" ||
    typeof account.vipType !== "number" ||
    !Number.isFinite(account.vipType)
  )
    return "unavailable";
  return "alive";
}

export class NeteaseAccount extends SendRequest {
  private static sessionFields(cookie = ""): Record<string, string> {
    return Object.fromEntries(
      cookie.split(";").flatMap((item) => {
        const separator = item.indexOf("=");
        if (separator <= 0) return [];
        const name = item.slice(0, separator).trim();
        const value = item.slice(separator + 1).trim();
        try {
          return [[name, decodeURIComponent(value)]];
        } catch {
          return [[name, value]];
        }
      }),
    );
  }

  private static cookieHeader(fields: Record<string, string>): string {
    return Object.entries(fields)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("; ");
  }

  public static async refreshCookie(
    csrf: string,
    musicU: string,
    ip: string,
    cookie?: string,
  ): Promise<Response> {
    const url = "https://interface.music.163.com/eapi/login/token/refresh";
    const encryptUrl = "/api/login/token/refresh";

    const reqHeader = {
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: "2294C59A0A8CDE3E18EF2A4A349FFC3071E717A677E4B348D139",
      os: "pc",
      appver: "3.1.17.204416",
      versioncode: "140",
      mobilename: "",
      buildver: String(Date.now()).substring(0, 10),
      resolution: "1920x1080",
      channel: "netease",
      requestId: `${Date.now()}_${Math.floor(Math.random() * 1000)
        .toString()
        .padStart(4, "0")}`,
      ...this.sessionFields(cookie),
      MUSIC_U: musicU,
      __csrf: csrf,
    };

    const payload = {
      e_r: false,
      header: reqHeader,
    };

    const fullCookieString = this.cookieHeader(reqHeader);

    const encryptedData = NeteaseCrypto.eapi(encryptUrl, payload);
    const body = new URLSearchParams(encryptedData).toString();

    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: fullCookieString,
      Referer: "https://music.163.com/",
      "User-Agent": "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)",
      "X-Real-IP": ip,
      "X-Forwarded-For": ip,
    };

    const response = await this.sendPost(
      url,
      new URLSearchParams(body),
      headers,
      AbortSignal.timeout(10000),
    );
    return response;
  }

  public static async getAccountInfo(
    csrf: string,
    musicU: string,
    ip: string,
    cookie?: string,
  ): Promise<NeteaseAccountInfo> {
    const startedAt = Date.now();
    const url = "https://music.163.com/weapi/w/nuser/account/get";

    const data = {
      e_r: false,
      csrf_token: csrf,
    };

    const encryptedData = NeteaseCrypto.weapi(data);
    const body = new URLSearchParams(encryptedData).toString();

    const currentCookie = this.cookieHeader({
      ...this.sessionFields(cookie),
      MUSIC_U: musicU,
      __csrf: csrf,
    });

    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: currentCookie,
      Referer: "https://music.163.com/",
      "User-Agent": "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)",
      "X-Real-IP": ip,
      "X-Forwarded-For": ip,
    };

    let response: Response;
    try {
      response = await this.sendPost(
        url,
        new URLSearchParams(body),
        headers,
        AbortSignal.timeout(10000),
      );
    } catch (error: unknown) {
      logDiagnostic("account-request", {
        result: "network-error",
        ...safeErrorFields(error),
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }

    const fail = (
      category: NeteaseAccountError["errorCategory"],
      businessCode?: number,
    ): never => {
      const error = new NeteaseAccountError(
        category,
        response.status,
        businessCode,
      );
      logDiagnostic("account-request", {
        ...safeErrorFields(error),
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    };
    let responseData: unknown;
    try {
      responseData = await response.json();
    } catch {
      return fail(response.ok ? "invalid-json" : "http-error");
    }
    const businessCode =
      responseData &&
      typeof responseData === "object" &&
      typeof (responseData as { code?: unknown }).code === "number" &&
      Number.isFinite((responseData as { code: number }).code)
        ? (responseData as { code: number }).code
        : undefined;
    if (!response.ok) return fail("http-error", businessCode);
    if (classifyAccount(responseData) === "unavailable") {
      return fail(
        businessCode === undefined || businessCode === 200
          ? "malformed-response"
          : "business-error",
        businessCode,
      );
    }
    logDiagnostic("account-request", {
      result: classifyAccount(responseData),
      httpStatus: response.status,
      businessCode,
      elapsedMs: Date.now() - startedAt,
    });
    return responseData as NeteaseAccountInfo;
  }
}
