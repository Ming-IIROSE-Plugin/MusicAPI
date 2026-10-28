import { Router } from "./router.js";
import { fetchMusicUrl } from "../service/musicService.js";
import {
  deleteMusicCache,
  getMusicCache,
  probeMediaUrl,
  setMusicCache,
} from "../service/cacheService.js";
import { sendError } from "../utils/response.js";
import { logDiagnostic, safeErrorFields } from "../config/env.js";

/** 上游返回的地址失效时的最多尝试次数（首次 + 重试） */
const MAX_PLAY_URL_ATTEMPTS = 2;

let getIp: () => string = () => "0.0.0.0";

/**
 * 获取一个已校验可播放的地址
 *
 * 上游下发的地址可能已经被 CDN 判定失效（如 403 expired url），
 * 这时清掉缓存后重新请求，全部失败才抛错。
 */
async function fetchPlayableUrl(
  platform: string,
  id: string,
  quality: string,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_PLAY_URL_ATTEMPTS; attempt += 1) {
    try {
      const streamUrl = await fetchMusicUrl(platform, id, getIp(), quality);
      const probe = await probeMediaUrl(streamUrl);

      // 网络层探测失败时无法判断，按可用处理
      if (probe.playable || !probe.reachable) return streamUrl;

      logDiagnostic("music-route", {
        result: "play-url-unplayable",
        attempt,
      });
      lastError = new Error("获取的播放地址已失效");
    } catch (error: unknown) {
      lastError = error;
    }

    // 地址失效：不保留任何缓存，下一轮重新向上游申请
    await deleteMusicCache(platform, id, quality);
  }

  throw lastError ?? new Error("获取播放地址失败");
}

export function initMusicRoute(ipGetter: () => string): void {
  getIp = ipGetter;

  Router.get("/musicstreamlink", async (req, res, url) => {
    const startedAt = Date.now();
    const platform = url.searchParams.get("platform");

    const id = url.searchParams.get("id");

    const qualityParam = url.searchParams.get("quality");

    const vip = url.searchParams.get("vip");

    if (!platform || !id) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "Bad Request",
          message: "Missing params",
        }),
      );

      return;
    }

    if (!qualityParam) {
      throw new Error("Missing quality param");
    }

    try {
      const cachedUrl = await getMusicCache(platform, id, qualityParam);

      if (cachedUrl) {
        res.writeHead(302, {
          Location: cachedUrl,
        });

        res.end();

        return;
      }

      const streamUrl = await fetchPlayableUrl(platform, id, qualityParam);

      void setMusicCache(platform, id, qualityParam, streamUrl, vip === "1");

      res.writeHead(302, {
        Location: streamUrl,
      });

      res.end();
    } catch (error: unknown) {
      logDiagnostic("music-route", {
        result: "request-error",
        elapsedMs: Date.now() - startedAt,
        ...safeErrorFields(error),
      });
      sendError(res, 500, {
        error: "Internal Error",
        message: "Request failed",
        cause: safeErrorFields(error),
      });

      return;
    }
  });
}
