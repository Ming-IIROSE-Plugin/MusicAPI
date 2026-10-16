import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import dotenv from "dotenv";
import { env } from "process";
import {
  classifyAccount,
  NeteaseAccount,
} from "../../sendRequest/netease/neteaseAccount.js";

dotenv.config();

interface CookieData {
  cookie: string;
  date: number;
}

type AccountState = "alive" | "invalid" | "incomplete" | "unavailable";

interface AccountCheckResult {
  state: AccountState;
  code?: number;
}

export type RefreshStatus =
  | "REFRESHED"
  | "REFRESH_REJECTED"
  | "REFRESH_RESPONSE_INVALID"
  | "NEEDS_LOGIN"
  | "NEEDS_SESSION_IMPORT"
  | "ACCOUNT_CHECK_UNAVAILABLE"
  | "SKIPPED"
  | "IN_PROGRESS";

export interface RefreshResult {
  success: boolean;
  refreshed: boolean;
  status: RefreshStatus;
  message: string;
  nextRefreshIn?: string;
}

const COOKIE_ATTRIBUTES = new Set([
  "domain",
  "expires",
  "max-age",
  "path",
  "samesite",
  "secure",
  "httponly",
]);

export class CookieManager {
  private static refreshPromise: Promise<RefreshResult> | null = null;

  private static getTargetFilePath(): string {
    const mntDir = path.join("/mnt", "account", "netease");
    const localDir = path.join(process.cwd(), "data", "account", "netease");
    const targetDir = fs.existsSync(mntDir) ? mntDir : localDir;
    return path.join(targetDir, "cookie.json");
  }

  private static getCookiePairs(cookie: string): Map<string, string> {
    const pairs = new Map<string, string>();

    // 兼容请求 Cookie（`;` 分隔）和历史上直接落盘的合并 Set-Cookie
    // （Cookie 之间可能以逗号分隔，同时 Expires 自身也包含逗号）。
    for (const setCookie of this.splitSetCookieHeader(cookie)) {
      for (const item of setCookie.split(";")) {
        const separator = item.indexOf("=");
        if (separator <= 0) continue;

        const name = item.slice(0, separator).trim();
        const value = item.slice(separator + 1).trim();
        if (name && !COOKIE_ATTRIBUTES.has(name.toLowerCase())) {
          pairs.set(name, value);
        }
      }
    }

    return pairs;
  }

  private static getCookieValueFromString(cookie: string, key: string): string {
    const value = this.getCookiePairs(cookie).get(key) || "";
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private static normalizeCookie(cookie: string): string {
    return Array.from(this.getCookiePairs(cookie).entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private static encodeCookieValue(value: string): string {
    return encodeURIComponent(value);
  }

  private static mergeCookies(
    originalCookie: string,
    setCookieHeaders: string[],
    candidateMusicU: string,
  ): string {
    const merged = this.getCookiePairs(originalCookie);

    // 环境 MUSIC_U 只在候选阶段写入；响应中的 MUSIC_U 随后覆盖它。
    if (candidateMusicU) {
      merged.set("MUSIC_U", this.encodeCookieValue(candidateMusicU));
    }

    for (const cookie of setCookieHeaders.flatMap((header) =>
      this.splitSetCookieHeader(header),
    )) {
      const separator = cookie.indexOf("=");
      if (separator <= 0) continue;

      const name = cookie.slice(0, separator).trim();
      const value = cookie
        .slice(separator + 1)
        .split(";", 1)[0]
        .trim();
      if (!name || COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;

      const attributes = new Map(
        cookie
          .split(";")
          .slice(1)
          .map((attribute) => {
            const separator = attribute.indexOf("=");
            return [
              attribute.slice(0, separator).trim().toLowerCase(),
              attribute.slice(separator + 1).trim(),
            ];
          }),
      );
      const maxAge = attributes.get("max-age");
      const hasMaxAge = maxAge !== undefined && /^-?\d+$/.test(maxAge);
      const expired = hasMaxAge
        ? Number(maxAge) <= 0
        : Date.parse(attributes.get("expires") ?? "") <= Date.now();
      if (expired) {
        merged.delete(name);
      } else {
        // 服务端返回值优先，包含轮换后的 MUSIC_U。
        merged.set(name, value);
      }
    }

    return Array.from(merged.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private static splitSetCookieHeader(header: string): string[] {
    // 只有后面紧跟 Cookie 名称和等号的逗号才是边界，日期中的逗号保留。
    return header
      .split(/,(?=\s*[!#$%&'*+\-.^_`|~\da-zA-Z]+=)/)
      .map((cookie) => cookie.trim())
      .filter(Boolean);
  }

  private static getSetCookieHeaders(response: Response): string[] {
    const headers = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const setCookies = headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) return setCookies;

    const combined = response.headers.get("set-cookie");
    return combined ? [combined] : [];
  }

  private static getCookieFingerprint(value: string): string {
    if (!value) return "missing";
    const digest = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 12);
    return `present(length=${value.length}, fingerprint=${digest})`;
  }

  private static logSession(cookie: string, source: string): void {
    const musicU = this.getCookieValueFromString(cookie, "MUSIC_U");
    const csrf = this.getCookieValueFromString(cookie, "__csrf");
    console.log(
      `> [CookieManager] 会话来源=${source}, MUSIC_U=${this.getCookieFingerprint(
        musicU,
      )}, __csrf=${this.getCookieFingerprint(csrf)}, NMTID=${
        this.getCookiePairs(cookie).has("NMTID") ? "present" : "missing"
      }`,
    );
  }

  public static setCookie(cookie: string): boolean {
    const targetFile = this.getTargetFilePath();
    const targetDir = path.dirname(targetFile);
    const tempFile = `${targetFile}.${process.pid}.${Date.now()}.tmp`;
    const dataToSave: CookieData = {
      cookie: this.normalizeCookie(cookie),
      date: Date.now(),
    };

    try {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      const fileDescriptor = fs.openSync(tempFile, "w", 0o600);
      try {
        fs.writeFileSync(fileDescriptor, JSON.stringify(dataToSave, null, 2));
        fs.fsyncSync(fileDescriptor);
      } finally {
        fs.closeSync(fileDescriptor);
      }
      fs.renameSync(tempFile, targetFile);
      try {
        const directoryDescriptor = fs.openSync(targetDir, "r");
        try {
          fs.fsyncSync(directoryDescriptor);
        } finally {
          fs.closeSync(directoryDescriptor);
        }
      } catch {
        // 文件已经原子替换；部分文件系统不支持目录 fsync，不影响本次保存结果。
      }
      console.log("> [CookieManager] Cookie 已原子保存。");
      return true;
    } catch {
      console.error("> [CookieManager] Cookie 原子保存失败。");
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // 临时文件不存在时无需处理。
      }
      return false;
    }
  }

  public static getCookieData(): CookieData | null {
    const targetFile = this.getTargetFilePath();
    try {
      if (!fs.existsSync(targetFile)) return null;
      const parsedData = JSON.parse(
        fs.readFileSync(targetFile, "utf-8"),
      ) as Partial<CookieData>;
      if (
        typeof parsedData.cookie !== "string" ||
        typeof parsedData.date !== "number" ||
        !Number.isFinite(parsedData.date)
      ) {
        return null;
      }
      return { cookie: parsedData.cookie, date: parsedData.date };
    } catch {
      return null;
    }
  }

  public static getCookieHeader(): string {
    return this.normalizeCookie(this.getCookieData()?.cookie || "");
  }

  public static async getCookie(ip = "127.0.0.1"): Promise<string | null> {
    if (this.refreshPromise) await this.refreshPromise;
    const cookieData = this.getCookieData();
    const cookie = cookieData?.cookie || "";
    const hasRequiredFields =
      Boolean(this.getCookieValueFromString(cookie, "MUSIC_U")) &&
      Boolean(this.getCookieValueFromString(cookie, "__csrf"));

    if (!cookieData || !hasRequiredFields) {
      await this.refreshCookie(ip);
    }

    const currentCookie = this.getCookieHeader();
    if (currentCookie) this.logSession(currentCookie, "persisted");
    return currentCookie || null;
  }

  public static getCookieValue(key: string): string {
    return this.getCookieValueFromString(
      this.getCookieData()?.cookie || "",
      key,
    );
  }

  private static async checkAccount(
    cookie: string,
    ip: string,
  ): Promise<AccountCheckResult> {
    const musicU = this.getCookieValueFromString(cookie, "MUSIC_U");
    const csrf = this.getCookieValueFromString(cookie, "__csrf");
    if (!musicU || !csrf) return { state: "incomplete" };

    try {
      const data = await NeteaseAccount.getAccountInfo(
        csrf,
        musicU,
        ip,
        this.normalizeCookie(cookie),
      );
      return { state: classifyAccount(data), code: data.code };
    } catch {
      // 网络、HTTP 或 JSON 异常不能触发环境凭证兜底。
      return { state: "unavailable" };
    }
  }

  private static result(
    status: RefreshStatus,
    message: string,
    success = false,
  ): RefreshResult {
    return { success, refreshed: success, status, message };
  }

  private static async performRefresh(
    ip: string,
    respectSchedule: boolean,
  ): Promise<RefreshResult> {
    const cookieData = this.getCookieData();
    const persistedCookie = cookieData?.cookie || "";
    const persistedMusicU = this.getCookieValueFromString(
      persistedCookie,
      "MUSIC_U",
    );
    const envMusicU = env.MUSIC_U?.trim() || "";

    let candidateCookie = persistedCookie;
    let candidateMusicU = persistedMusicU;
    const persistedStatus = await this.checkAccount(persistedCookie, ip);

    const age = cookieData ? Date.now() - cookieData.date : Infinity;
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (
      respectSchedule &&
      persistedStatus.state === "alive" &&
      age >= 0 &&
      age < oneDayMs
    ) {
      const totalMinutes = Math.floor((oneDayMs - age) / (1000 * 60));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return {
        ...this.result("SKIPPED", "当前会话有效，未到刷新时间。"),
        nextRefreshIn:
          hours > 0
            ? `${hours}小时${minutes ? `${minutes}分钟` : ""}`
            : `${minutes}分钟`,
      };
    }

    if (persistedStatus.state === "unavailable") {
      return this.result(
        "ACCOUNT_CHECK_UNAVAILABLE",
        "账号校验网络异常，保留当前会话。",
      );
    }

    if (persistedStatus.state === "incomplete") {
      return this.result(
        "NEEDS_SESSION_IMPORT",
        "当前 Cookie 缺少 MUSIC_U 或 __csrf，需要导入完整会话。",
      );
    }

    if (persistedStatus.state === "invalid") {
      if (!envMusicU) {
        return this.result(
          "NEEDS_LOGIN",
          "持久化会话已失效，未配置环境 MUSIC_U，需要重新登录。",
        );
      }

      candidateMusicU = envMusicU;
      candidateCookie = this.mergeCookies(persistedCookie, [], candidateMusicU);
      this.logSession(candidateCookie, "env.MUSIC_U candidate");
    }

    if (!candidateMusicU) {
      return this.result(
        "NEEDS_SESSION_IMPORT",
        "缺少可刷新的 MUSIC_U，需要导入完整会话。",
      );
    }

    try {
      const response = await NeteaseAccount.refreshCookie(
        this.getCookieValueFromString(candidateCookie, "__csrf"),
        candidateMusicU,
        ip,
        this.normalizeCookie(candidateCookie),
      );
      if (!response.ok) {
        console.error(
          `> [CookieManager] 刷新被 HTTP ${response.status} 拒绝。`,
        );
        return this.result("REFRESH_REJECTED", "网易云拒绝了会话刷新。");
      }

      let responseData: { code: number };
      try {
        const data = await response.json();
        if (
          !data ||
          typeof data.code !== "number" ||
          !Number.isFinite(data.code)
        ) {
          throw new Error("刷新响应结构无效");
        }
        responseData = data;
      } catch {
        return this.result(
          "REFRESH_RESPONSE_INVALID",
          "刷新响应不是可解析的 JSON，保留当前会话。",
        );
      }
      if (responseData.code !== 200) {
        console.error(
          `> [CookieManager] 刷新业务状态=${String(responseData.code)}。`,
        );
        return this.result("REFRESH_REJECTED", "网易云返回了失败业务状态。");
      }

      const setCookieHeaders = this.getSetCookieHeaders(response);
      if (setCookieHeaders.length === 0) {
        return this.result(
          "REFRESH_RESPONSE_INVALID",
          "刷新响应缺少 Set-Cookie，保留当前会话。",
        );
      }

      const mergedCookie = this.mergeCookies(
        candidateCookie,
        setCookieHeaders,
        candidateMusicU,
      );
      const refreshedMusicU = this.getCookieValueFromString(
        mergedCookie,
        "MUSIC_U",
      );
      const refreshedCsrf = this.getCookieValueFromString(
        mergedCookie,
        "__csrf",
      );
      if (!refreshedMusicU || !refreshedCsrf) {
        return this.result(
          "NEEDS_SESSION_IMPORT",
          "刷新响应缺少必要 Cookie，保留当前会话。",
        );
      }

      this.logSession(mergedCookie, "refresh response");
      const refreshedStatus = await this.checkAccount(mergedCookie, ip);
      if (refreshedStatus.state === "unavailable") {
        return this.result(
          "REFRESH_RESPONSE_INVALID",
          "刷新后的账号校验网络异常，保留当前会话。",
        );
      }
      if (refreshedStatus.state !== "alive") {
        return this.result(
          "NEEDS_LOGIN",
          "刷新后的会话未通过账号校验，需要重新登录。",
        );
      }

      if (!this.setCookie(mergedCookie)) {
        return this.result(
          "REFRESH_RESPONSE_INVALID",
          "刷新后的会话保存失败，保留当前会话。",
        );
      }

      return this.result(
        "REFRESHED",
        "Cookie 已刷新并通过二次账号校验。",
        true,
      );
    } catch {
      console.error("> [CookieManager] 刷新网络异常，保留当前会话。");
      return this.result(
        "REFRESH_RESPONSE_INVALID",
        "刷新网络异常，保留当前会话。",
      );
    }
  }

  private static refreshCookieResult(
    ip: string,
    respectSchedule = false,
  ): Promise<RefreshResult> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh(ip, respectSchedule).finally(
        () => {
          this.refreshPromise = null;
        },
      );
    }
    return this.refreshPromise;
  }

  public static async refreshCookie(ip: string): Promise<boolean> {
    return (await this.refreshCookieResult(ip)).success;
  }

  public static async checkAndRefreshCookie(
    ip: string,
  ): Promise<RefreshResult> {
    return this.refreshCookieResult(ip, true);
  }
}
