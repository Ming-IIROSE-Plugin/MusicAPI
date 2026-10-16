import http from "http";

export function sendError(
    res: http.ServerResponse,
    statusCode: number,
    data: {
        error: string;
        message: string;
        cause?: unknown;
    }
)
{

    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify(data, null, 2));
}