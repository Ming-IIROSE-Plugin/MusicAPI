// routes/refresh.ts

import { Router } from "./router.js";
import { CookieManager } from "../accountManage/netease/CookieManager.js";
import { sendError } from "../utils/response.js";
import { safeErrorFields } from "../config/env.js";

let getIp: () => string = () => "0.0.0.0";

export function initRefreshRoute(ipGetter: () => string): void {
  getIp = ipGetter;
  Router.get("/refresh/login", async (_req, res) => {
    try {
      const result = await CookieManager.checkAndRefreshCookie(getIp());

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });

      res.end(JSON.stringify(result, null, 2));

      return;
    } catch (innerError: unknown) {
      sendError(res, 500, {
        error: "Internal Error 1",
        message: "Request failed",
        cause: safeErrorFields(innerError),
      });

      return;
    }
  });
}
