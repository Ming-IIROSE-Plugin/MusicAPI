import {
  classifyAccount,
  NeteaseAccount,
} from "../../sendRequest/netease/neteaseAccount.js";
import { formatTimeAgo } from "../../service/formatTimeAgo.js";
import { CookieManager } from "./CookieManager.js";

interface AccountInfo {
  account: {
    username: string;
    vipType: number;
  } | null;
  lastRefreshTime: string | null;
  status: string;
}

export class AccountManager {
  public static async checkAccountStatus(ip: string): Promise<AccountInfo> {
    const cookiedata = CookieManager.getCookieData();
    const cookie = CookieManager.getCookieHeader();
    const musicU: string = CookieManager.getCookieValue("MUSIC_U");
    const csrf = CookieManager.getCookieValue("__csrf");

    if (!musicU || !csrf) {
      return {
        account: null,
        lastRefreshTime: null,
        status: "Needs session import",
      };
    }

    let data: NeteaseAccountInfo;
    try {
      data = await NeteaseAccount.getAccountInfo(csrf, musicU, ip, cookie);
    } catch {
      return {
        account: null,
        lastRefreshTime: null,
        status: "Account check unavailable",
      };
    }

    if (!cookiedata) {
      return {
        account: null,
        lastRefreshTime: null,
        status: "Cookie not found",
      };
    }

    const state = classifyAccount(data);
    if (state !== "alive") {
      return {
        account: null,
        lastRefreshTime: null,
        status:
          state === "invalid"
            ? "Account not alive"
            : "Account check unavailable",
      };
    }

    const date = new Date(cookiedata.date);

    const accountInfo: AccountInfo = {
      account: {
        username: data.profile!.nickname,
        vipType: data.account!.vipType,
      },
      lastRefreshTime: formatTimeAgo(date),
      status: "Account is alive",
    };

    return accountInfo;
  }
}
