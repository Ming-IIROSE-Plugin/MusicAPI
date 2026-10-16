import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import http from "http";
import https from "https";

const BASE_DATA_PATH = existsSync("/mnt")
  ? "/mnt"
  : path.join(process.cwd(), "data");
const NORMAL_EXPIRE = 45 * 60 * 1000; // 普通资源 45 分钟
const VIP_EXPIRE = 20 * 60 * 1000; // VIP 资源 20 分钟
/**
 * 验证 URL 是否有效 (HEAD 请求)
 */
async function checkUrlAlive(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.request(
      url,
      { method: "HEAD", timeout: 3000 },
      (res) => {
        // 只要状态码是 2xx 或 3xx，说明 URL 依然有效
        resolve(!!(res.statusCode && res.statusCode < 400));
      },
    );

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function getMusicCache(
  platform: string,
  id: string,
  quality: string,
  vip: boolean,
): Promise<string | null> {
  const filePath = path.join(
    BASE_DATA_PATH,
    "cache",
    "song",
    platform,
    `${id}_${quality}.json`,
  );

  try {
    const data = await fs.readFile(filePath, "utf-8");
    const cache: CacheData = JSON.parse(data);
    const now = Date.now();

    // 1. 检查物理过期
    if (now > cache.expireAt) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    // 2. 软校验：如果是 VIP 资源，因为有效期短，跳过 HEAD 验证直接返回
    // 如果是普通资源，超过 30 分钟则验证有效性
    if (!vip) {
      const ageInMs = NORMAL_EXPIRE - (cache.expireAt - now);
      if (ageInMs > 30 * 60 * 1000) {
        const isAlive = await checkUrlAlive(cache.url);
        if (!isAlive) {
          await fs.unlink(filePath).catch(() => {});
          return null;
        }
      }
    }

    return cache.url;
  } catch {
    return null;
  }
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
  const filePath = path.join(dirPath, `${id}_${quality}.json`);

  try {
    await fs.mkdir(dirPath, { recursive: true });

    // 根据 VIP 状态决定过期时长
    const expireDuration = vip ? VIP_EXPIRE : NORMAL_EXPIRE;

    const cacheData: CacheData = {
      url,
      expireAt: Date.now() + expireDuration,
    };

    await fs.writeFile(filePath, JSON.stringify(cacheData), "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Cache Error] ${message}`);
  }
}
