import http from "http";
import { URL } from "url";
import { env } from "process";

import { Router } from "./routes/router.js";
import { initMusicRoute } from "./routes/music.js";
import { initRefreshRoute } from "./routes/refresh.js";

import { CookieManager } from "./accountManage/netease/CookieManager.js";
import { IpManager } from "./service/ip.js";
import { initAccountRoute } from "./routes/account.js";
import {
  isTruthy,
  logConfigDiagnostics,
  resolvePort,
  safeErrorFields,
} from "./config/env.js";

const portConfig = resolvePort(env.PORT);
const PORT = portConfig.port;
const HOST = "0.0.0.0";

/*
 * 注册 Routes
 *
 * 注意：
 * 这里传入的是函数，不是 ip 本身
 * route 内部通过 getIp() 获取最新 IP
 */
initMusicRoute(() => IpManager.getIp());

initRefreshRoute(() => IpManager.getIp());

initAccountRoute(() => IpManager.getIp());

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  // CORS
  if (
    origin &&
    (origin === "https://iirose.com" || origin.endsWith(".iirose.com"))
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);

    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );

    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  // OPTIONS
  if (req.method === "OPTIONS") {
    res.writeHead(204);

    return res.end();
  }

  try {
    const protocol = req.headers["x-forwarded-proto"] || "http";

    const host = req.headers.host || `${HOST}:${PORT}`;

    const reqUrl = new URL(req.url ?? "", `${protocol}://${host}`);

    // 首页
    if (reqUrl.pathname === "/" || reqUrl.pathname === "") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
      });

      return res.end("Music Redirect Server Running");
    }

    // 交给 Router
    await Router.handle(req, res, reqUrl);
  } catch (error: unknown) {
    res.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8",
    });

    res.end(
      JSON.stringify(
        {
          error: "Critical Error",
          message: "Request failed",
          ...safeErrorFields(error),
        },
        null,
        2,
      ),
    );
  }
});

server.listen(PORT, HOST, async () => {
  const listeningAddress = server.address();
  const listeningPort =
    listeningAddress && typeof listeningAddress === "object"
      ? listeningAddress.port
      : PORT;
  console.log(`> Server listening at http://${HOST}:${listeningPort}`);
  await IpManager.fetchRealIp();
  logConfigDiagnostics(CookieManager.getCookieStoragePath(), portConfig);
  const refreshOnStartup = isTruthy(env.REFRESH_COOKIE_NETEASE);
  const startupResult = await CookieManager.initialize(
    IpManager.getIp(),
    refreshOnStartup,
  );
  console.log(
    `> [Startup] session status=${startupResult.status}, success=${startupResult.success}, ` +
      `refreshed=${startupResult.refreshed}, reason=${startupResult.message}`,
  );
  const address = server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : PORT;
  console.log(`> Server active at http://${HOST}:${actualPort}`);
  console.log(
    `> Local Test: http://localhost:${actualPort}/musicstreamlink/?platform=netease&id=431259256&quality=jymaster&vip=1`,
  );
});
