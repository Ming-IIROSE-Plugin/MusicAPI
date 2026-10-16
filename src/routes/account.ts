import { Router } from "./router.js";
import { sendError } from "../utils/response.js";
import { AccountManager } from "../accountManage/netease/AccountManager.js";
import { safeErrorFields } from "../config/env.js";

let getIp: () => string = () => "0.0.0.0";

export function initAccountRoute(ipGetter: () => string): void {
  getIp = ipGetter;
  Router.get("/netease/account/status", async (_req, res) => {
    try {
      const result = await AccountManager.checkAccountStatus(getIp());

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(result, null, 2));

      return;
    } catch (error: unknown) {
      sendError(res, 500, {
        error: "Internal Error",
        message: "Request failed",
        cause: safeErrorFields(error),
      });

      return;
    }
  });
}
