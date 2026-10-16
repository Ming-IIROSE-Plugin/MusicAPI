import http from "http";

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => void | Promise<void>;

export class Router {
  private static routes = new Map<string, RouteHandler>();

  static get(path: string, handler: RouteHandler): void {
    this.routes.set(`GET:${path}`, handler);
  }

  static post(path: string, handler: RouteHandler): void {
    this.routes.set(`POST:${path}`, handler);
  }

  static async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname.replace(/\/$/, "") || "/";

    const key = `${req.method}:${pathname}`;

    const handler = this.routes.get(key);

    if (!handler) {
      res.writeHead(404, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "Not Found",
        }),
      );

      return;
    }

    await handler(req, res, url);
  }
}
