import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import http from "http";
import https from "https";
import { logDiagnostic, safeErrorFields } from "../config/env.js";

const BASE_DATA_PATH = existsSync("/mnt")
  ? "/mnt"
  : path.join(process.cwd(), "data");
const NORMAL_EXPIRE = 45 * 60 * 1000; // 普通资源 45 分钟
const VIP_EXPIRE = 20 * 60 * 1000; // VIP 资源 20 分钟
const PROBE_TIMEOUT = 3000; // 单次探测超时
const REVERIFY_INTERVAL = 15 * 1000; // 同一地址 15 秒内不重复探测
/** 这些状态码已足以判定地址失效，不再用 GET 复核 */
const CONCLUSIVE_FAILURE = new Set([401, 403, 404, 410, 451]);

/** 最近一次探测的时间，避免同一地址被反复校验 */
const lastVerifiedAt = new Map<string, number>();
/** 同一地址的并发探测合并成一次请求 */
const inFlightProbes = new Map<string, Promise<MediaProbeResult>>();

/**
 * 探测结果
 *
 * playable：地址可以播放
 * reachable：是否拿到过 HTTP 响应（false 表示网络层失败，结论不可信）
 */
export interface MediaProbeResult {
  playable: boolean;
  reachable: boolean;
}

/** 合并同一地址的并发探测，播放器连打请求时只发一次 HEAD */
function withInFlight(
  url: string,
  run: () => Promise<MediaProbeResult>,
): Promise<MediaProbeResult> {
  const existing = inFlightProbes.get(url);
  if (existing) return existing;

  const task = run().finally(() => {
    inFlightProbes.delete(url);
  });

  inFlightProbes.set(url, task);
  return task;
}

function buildCachePath(platform: string, id: string, quality: string): string {
  return path.join(
    BASE_DATA_PATH,
    "cache",
    "song",
    platform,
    `${id}_${quality}.json`,
  );
}

/**
 * 发一次请求并返回状态码，网络层失败返回 null
 */
function probe(url: string, method: "HEAD" | "GET"): Promise<number | null> {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Referer: "https://music.163.com/",
    };
    if (method === "GET") headers.Range = "bytes=0-1";

    let settled = false;
    const done = (value: number | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = client.request(
      url,
      {
        method,
        headers,
        timeout: PROBE_TIMEOUT,
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      },
      (res) => {
        const status = res.statusCode ?? null;
        // 释放响应体，避免占用连接
        res.resume();
        done(status);
      },
    );

    req.on("error", () => done(null));
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.end();
  });
}

/**
 * 探测媒体地址是否仍可播放
 *
 * 先 HEAD；只有 HEAD 结论不可信（不支持 HEAD、5xx、无响应）时才用
 * GET Range 复核，省一次请求。
 * 状态码 < 400 视为可用；403/404/410 视为失效
 * （网易云 CDN 的过期地址返回 403 + x-auth-msg: expired url）。
 */
export async function probeMediaUrl(url: string): Promise<MediaProbeResult> {
  return withInFlight(url, async () => {
    const headStatus = await probe(url, "HEAD");
    if (headStatus !== null && headStatus > 0 && headStatus < 400) {
      return { playable: true, reachable: true };
    }

    // HEAD 已给出明确否定，无需再花一次请求
    if (headStatus !== null && CONCLUSIVE_FAILURE.has(headStatus)) {
      logDiagnostic("media-probe", {
        result: "unplayable",
        headStatus,
      });
      return { playable: false, reachable: true };
    }

    const getStatus = await probe(url, "GET");
    if (getStatus !== null && getStatus > 0 && getStatus < 400) {
      return { playable: true, reachable: true };
    }

    const reachable = headStatus !== null || getStatus !== null;
    logDiagnostic("media-probe", {
      result: reachable ? "unplayable" : "unreachable",
      headStatus: headStatus ?? undefined,
      getStatus: getStatus ?? undefined,
    });

    return { playable: false, reachable };
  });
}

/**
 * 读取缓存
 *
 * 命中后仍会校验地址可用性（同址 15 秒内跳过）。
 * 明确失效（403/404 等）时删除缓存并返回 null，交由上层重新请求；
 * 网络异常导致无法判断时保留缓存，避免误删。
 */
export async function getMusicCache(
  platform: string,
  id: string,
  quality: string,
): Promise<string | null> {
  const filePath = buildCachePath(platform, id, quality);

  let cache: CacheData;
  try {
    const data = await fs.readFile(filePath, "utf-8");
    cache = JSON.parse(data) as CacheData;
  } catch {
    return null;
  }

  // 1. 检查物理过期
  if (Date.now() > cache.expireAt) {
    await fs.unlink(filePath).catch(() => {});
    lastVerifiedAt.delete(filePath);
    return null;
  }

  // 2. 软校验：最近探测过的地址直接放行
  const verifiedAt = lastVerifiedAt.get(filePath) ?? 0;
  if (Date.now() - verifiedAt < REVERIFY_INTERVAL) {
    return cache.url;
  }

  const result = await probeMediaUrl(cache.url);

  if (result.playable) {
    lastVerifiedAt.set(filePath, Date.now());
    return cache.url;
  }

  if (!result.reachable) {
    // 网络层探测失败，无法证明地址失效，保留缓存
    lastVerifiedAt.set(filePath, Date.now());
    return cache.url;
  }

  logDiagnostic("cache-probe", { result: "stale-cache-removed" });
  await fs.unlink(filePath).catch(() => {});
  lastVerifiedAt.delete(filePath);
  return null;
}

/**
 * 写入缓存
 */
export async function setMusicCache(
  platform: string,
  id: string,
  quality: string,
  url: string,
  vip: boolean,
): Promise<void> {
  const dirPath = path.join(BASE_DATA_PATH, "cache", "song", platform);
  const filePath = buildCachePath(platform, id, quality);

  try {
    await fs.mkdir(dirPath, { recursive: true });

    // 根据 VIP 状态决定过期时长
    const expireDuration = vip ? VIP_EXPIRE : NORMAL_EXPIRE;

    const cacheData: CacheData = {
      url,
      expireAt: Date.now() + expireDuration,
    };

    await fs.writeFile(filePath, JSON.stringify(cacheData), "utf-8");
    lastVerifiedAt.set(filePath, Date.now());
  } catch (error: unknown) {
    const fields = safeErrorFields(error);
    console.error(
      `[Cache Error] errorCategory=${fields.errorCategory}${
        fields.errno !== undefined ? ` errno=${fields.errno}` : ""
      }${fields.errorCode !== undefined ? ` errorCode=${fields.errorCode}` : ""}`,
    );
  }
}

/**
 * 删除缓存（地址失效或需要强制刷新时使用）
 */
export async function deleteMusicCache(
  platform: string,
  id: string,
  quality: string,
): Promise<void> {
  const filePath = buildCachePath(platform, id, quality);
  lastVerifiedAt.delete(filePath);
  await fs.unlink(filePath).catch(() => {});
}
