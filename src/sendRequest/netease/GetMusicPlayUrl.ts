import { CookieManager } from "../../accountManage/netease/CookieManager.js";
import { SendRequest } from "../index.js";
import { NeteaseCrypto } from "./NeteaseCrypto.js";

export class GetMusicPlayUrl extends SendRequest {
  // 辅助方法：从 Cookie 中提取特定字段
  private static getCookieValue(cookieStr: string, key: string): string {
    // 在前缀匹配中加入逗号：(?:^|[,;]\s*)
    const match = cookieStr.match(new RegExp(`(?:^|[,;]\\s*)${key}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  /**
   * 获取音乐播放链接
   * @param id 歌曲 ID
   * @param quality 音质，默认 128 (代表 128000 bps)。如果需要无损可传入 999000
   * @param ip 请求来源 IP
   */
  public static async getUrl(
    id: string | number,
    level: string = "higher",
    ip: string,
  ): Promise<string> {
    void level;
    // 1. 尝试获取本地 Cookie
    const currentCookie = (await CookieManager.getCookie(ip)) || "";

    const musicU = this.getCookieValue(currentCookie, "MUSIC_U");
    const csrf = this.getCookieValue(currentCookie, "__csrf");
    // 如果没有 MUSIC_U，其实某些免费歌曲也能获取到低音质 URL，但为了稳定建议带上
    if (!musicU) {
      console.warn(
        "警告: 本地没有有效的 MUSIC_U，获取 VIP 或无损音质可能会失败。",
      );
    }

    const url = "https://interface.music.163.com/eapi/song/enhance/player/url";
    const encryptUrl = "/api/song/enhance/player/url";

    // 2. 组装网易云所需要的完整 header 指纹对象
    const reqHeader = {
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: "2294C59A0A8CDE3E18EF2A4A349FFC3071E717A677E4B348D139", // 固定或随机 PC 指纹
      os: "pc",
      appver: "3.1.17.204416",
      versioncode: "140",
      mobilename: "",
      buildver: String(Date.now()).substring(0, 10), // 动态生成
      resolution: "1920x1080",
      __csrf: csrf,
      channel: "netease",
      requestId: `${Date.now()}_${Math.floor(Math.random() * 1000)
        .toString()
        .padStart(4, "0")}`,
      MUSIC_U: musicU,
    };

    // 3. 构建 Payload
    const payload = {
      // 注意：API 要求 ids 是一个【包含了字符串的数组】被 JSON.stringify 后的结果
      ids: JSON.stringify([String(id)]),
      br: 320000,
      //   encodeType: "flac",
      e_r: false,
      header: reqHeader,
    };

    // 4. 将 header 对象转换为 HTTP 请求头的 Cookie 字符串（双重指纹）
    const fullCookieString = Object.entries(reqHeader)
      // 看这里：直接用 [, value] 跳过第一个参数 key
      .filter(([, value]) => value !== "")
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value as string)}`,
      )
      .join("; ");

    // 5. 加密 Payload
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
      undefined,
    );
    if (!response.ok) {
      throw new Error(`获取 URL 失败，HTTP 状态码: ${response.status}`, {
        cause: {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
        },
      });
    }
    const responseData = await response.json();
    // 7. 解析返回结果
    if (
      responseData.code === 200 &&
      responseData.data &&
      responseData.data.length > 0
    ) {
      const songData = responseData.data[0];

      if (songData.url) {
        console.log(`成功获取歌曲链接 (音质: ${songData.br} bps)`);
        return songData.url;
      } else {
        // 如果 url 为 null，通常是因为无版权或需要 VIP 且当前账号无权限
        // console.error('获取成功，但网易云未返回有效播放链接 (可能需要 VIP 或无版权):', songData);
        throw new Error(
          `获取成功，但网易云未返回有效播放链接 (可能需要 VIP 或无版权).`,
          {
            cause: {
              songData,
            },
          },
        );
      }
    } else {
      console.error("获取 URL 失败，服务器返回:", responseData);
      throw new Error(`获取 URL 失败`, {
        cause: {
          responseData,
        },
      });
    }
  }
}
