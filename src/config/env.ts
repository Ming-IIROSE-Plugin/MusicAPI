import path from "path";
import dotenv from "dotenv";

const cwd = process.cwd();
const dotenvPath = path.join(cwd, ".env");
const processEnvironmentKeys = new Set(Object.keys(process.env));
const dotenvResult = dotenv.config({
  path: dotenvPath,
  override: false,
  quiet: true,
});

export const runtimeConfig = {
  cwd,
  dotenvPath,
  dotenvLoaded: !dotenvResult.error,
  dotenvErrorCategory: dotenvResult.error ? dotenvResult.error.name : undefined,
  dotenvErrorCode:
    dotenvResult.error &&
    (typeof dotenvResult.error.code === "string" ||
      typeof dotenvResult.error.code === "number")
      ? dotenvResult.error.code
      : undefined,
};

const SAFE_ERROR_CATEGORIES = new Set([
  "unknown",
  "timeout",
  "network-error",
  "http-error",
  "invalid-json",
  "malformed-response",
  "business-error",
  "request-error",
  "io-error",
]);
const SAFE_ERROR_NAMES = new Map([
  ["AbortError", "timeout"],
  ["TimeoutError", "timeout"],
  ["TypeError", "network-error"],
]);
const SAFE_SYSTEM_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EROFS",
  "EIO",
  "EISDIR",
  "ENOTDIR",
  "EMFILE",
  "ENFILE",
  "EXDEV",
  "EINVAL",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

export function isTruthy(value: string | undefined): boolean {
  return ["true", "1", "t", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

export function configSource(name: string): "process" | "dotenv" | "unset" {
  if (processEnvironmentKeys.has(name)) return "process";
  if (Object.prototype.hasOwnProperty.call(dotenvResult.parsed ?? {}, name)) {
    return "dotenv";
  }
  return "unset";
}

export function debugNeteaseEnabled(): boolean {
  return isTruthy(process.env.DEBUG_NETEASE);
}

export function getCookieFilePath(): string | undefined {
  const configured = process.env.NETEASE_COOKIE_FILE?.trim();
  if (!configured) return undefined;
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(cwd, configured);
}

export function resolvePort(value = process.env.PORT): {
  port: number;
  invalid: boolean;
} {
  if (value === undefined) return { port: 9000, invalid: false };
  if (!/^\d+$/.test(value)) return { port: 9000, invalid: true };
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    return { port: 9000, invalid: true };
  }
  return { port, invalid: false };
}

export function logConfigDiagnostics(
  cookieFile: string,
  portConfig = resolvePort(),
): void {
  const dotenvFields = safeErrorFields(dotenvResult.error);
  const dotenvState = runtimeConfig.dotenvLoaded
    ? "loaded"
    : dotenvFields.errorCode === "ENOENT"
      ? "missing"
      : "error";
  const dotenvError = runtimeConfig.dotenvLoaded
    ? ""
    : ` errorCategory=${dotenvFields.errorCategory}${
        dotenvFields.errorCode ? ` errorCode=${dotenvFields.errorCode}` : ""
      }`;
  console.log(
    `> [Config] cwd=${runtimeConfig.cwd}, dotenv=${dotenvState}${dotenvError} (cwd/.env), ` +
      `process environment takes precedence, MUSIC_U=${
        process.env.MUSIC_U?.trim() ? "present" : "missing"
      } (source=${configSource("MUSIC_U")}), ` +
      `DEBUG_NETEASE=${isTruthy(process.env.DEBUG_NETEASE) ? "enabled" : "disabled"} ` +
      `(source=${configSource("DEBUG_NETEASE")}), ` +
      `refreshOnStartup=${isTruthy(process.env.REFRESH_COOKIE_NETEASE) ? "enabled" : "disabled"} ` +
      `(source=${configSource("REFRESH_COOKIE_NETEASE")}), ` +
      `port=${portConfig.port}${portConfig.invalid ? " (invalid config; defaulted)" : ""}, ` +
      `cookieFile=${cookieFile}`,
  );
}

export function logDiagnostic(
  phase: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  if (!debugNeteaseEnabled()) return;
  const safeFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.log(
    `> [NeteaseDebug] time=${new Date().toISOString()} phase=${phase}${
      safeFields ? ` ${safeFields}` : ""
    }`,
  );
}

export function safeErrorFields(error: unknown): {
  errorCategory: string;
  errno?: number;
  errorCode?: string;
  httpStatus?: number;
  businessCode?: number;
} {
  const result: {
    errorCategory: string;
    errno?: number;
    errorCode?: string;
    httpStatus?: number;
    businessCode?: number;
  } = { errorCategory: "unknown" };
  if (!error || typeof error !== "object") return result;

  let current: unknown = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === "object";
    depth += 1
  ) {
    const value = current as {
      name?: unknown;
      code?: unknown;
      errno?: unknown;
      errorCategory?: unknown;
      httpStatus?: unknown;
      businessCode?: unknown;
      cause?: unknown;
    };
    if (
      result.errorCategory === "unknown" &&
      typeof value.errorCategory === "string" &&
      SAFE_ERROR_CATEGORIES.has(value.errorCategory)
    ) {
      result.errorCategory = value.errorCategory;
    } else if (
      result.errorCategory === "unknown" &&
      typeof value.name === "string" &&
      SAFE_ERROR_NAMES.has(value.name)
    ) {
      result.errorCategory = SAFE_ERROR_NAMES.get(value.name) as string;
    }
    if (
      result.errorCode === undefined &&
      typeof value.code === "string" &&
      SAFE_SYSTEM_CODES.has(value.code)
    ) {
      result.errorCode = value.code;
    }
    if (
      result.errno === undefined &&
      typeof value.errno === "number" &&
      Number.isFinite(value.errno)
    ) {
      result.errno = value.errno;
    }
    if (
      result.httpStatus === undefined &&
      typeof value.httpStatus === "number" &&
      Number.isFinite(value.httpStatus) &&
      value.httpStatus >= 100 &&
      value.httpStatus <= 599
    ) {
      result.httpStatus = value.httpStatus;
    }
    if (
      result.businessCode === undefined &&
      typeof value.businessCode === "number" &&
      Number.isFinite(value.businessCode)
    ) {
      result.businessCode = value.businessCode;
    }
    current = value.cause;
  }
  return result;
}
