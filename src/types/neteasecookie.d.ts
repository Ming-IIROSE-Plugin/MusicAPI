interface CookieStorage
{
    cookie: string;
    expireAt: string; // ISOString 格式方便存储和比较
}

interface LoadCookieResult
{
    cookie: string | null;
    isExpired: boolean;
}