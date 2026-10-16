// types.ts

// 腾讯云 API 网关触发器的事件结构
interface SCFEvent
{
    queryString?: {
        platform?: string;
        id?: string;
        quality?: string;
    };
    headers?: Record<string, string>;
    requestContext?: unknown;
    [key: string]: unknown;
}

// 云函数返回结构
interface SCFResponse
{
    isBase64Encoded: boolean;
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}