// musicService.ts

// 之前是: // @ts-ignore
// 现在直接引入，TS 会自动找到你刚才写的 .d.ts 文件
import { GetMusicPlayUrl } from "../sendRequest/netease/GetMusicPlayUrl.js";

export async function fetchMusicUrl(
  platform: string, // 如果你想更严谨，这里也可以改成 import { MetingServer } from ...
  id: string,
  ip: string,
  quality: string,
): Promise<string> {
  // 这里的 platform 实际上是 string，但 Meting 构造函数兼容 string
  if (platform === "netease") {
    const result = await GetMusicPlayUrl.getUrl(id, quality, ip);
    return result;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
