interface CacheData
{
    url: string;
    expireAt: number;
}

interface ErrorResponse
{
    error: string;
    message: string;
    platform_response?: unknown; // 替代 any，表示不确定的 API 返回
}