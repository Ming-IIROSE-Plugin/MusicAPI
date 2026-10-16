import { Router } from "./router.js";
import { fetchMusicUrl } from "../service/musicService.js";
import { getMusicCache, setMusicCache } from "../service/cacheService.js";
import { sendError } from "../utils/response.js";
import { logDiagnostic, safeErrorFields } from "../config/env.js";

let getIp: () => string = () => "0.0.0.0";

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
      const cachedUrl = await getMusicCache(
        platform,
        id,
        qualityParam,
        vip === "1",
      );

      if (cachedUrl) {
        res.writeHead(302, {
          Location: cachedUrl,
        });

        res.end();

        return;
      }

      const streamUrl = await fetchMusicUrl(
        platform,
        id,
        getIp(),
        qualityParam,
      );

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
