import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { beforeEach, afterEach, after } from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const workspace = fs.mkdtempSync("/tmp/opencode/musicapi-session-");
const unplannedNetwork = async () => {
  throw new Error("禁止未计划的网络请求");
};
globalThis.fetch = unplannedNetwork;
process.chdir(workspace);
process.env.MUSIC_U = "env-token";
process.env.REFRESH_COOKIE_NETEASE = "false";
fs.writeFileSync(".env", "MUSIC_U=env-token\nREFRESH_COOKIE_NETEASE=false\n");

// 只转译这些测试的依赖闭包；不依赖已有 dist，也不执行全项目构建。
const sources = [
  "accountManage/netease/CookieManager",
  "accountManage/netease/AccountManager",
  "sendRequest/netease/neteaseAccount",
  "sendRequest/netease/NeteaseCrypto",
  "sendRequest/netease/GetMusicPlayUrl",
  "sendRequest/index",
  "service/formatTimeAgo",
];
fs.writeFileSync("package.json", '{"type":"module"}');
fs.symlinkSync(path.join(root, "node_modules"), "node_modules", "dir");
for (const source of sources) {
  const destination = path.join(workspace, `${source}.js`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    ts.transpileModule(
      fs.readFileSync(path.join(root, "src", `${source}.ts`), "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      },
    ).outputText,
  );
}
const load = (name) =>
  import(pathToFileURL(path.join(workspace, `${name}.js`)).href);
const { CookieManager } = await load("accountManage/netease/CookieManager");
const { AccountManager } = await load("accountManage/netease/AccountManager");
const { NeteaseAccount } = await load("sendRequest/netease/neteaseAccount");
const { NeteaseCrypto } = await load("sendRequest/netease/NeteaseCrypto");
const { GetMusicPlayUrl } = await load("sendRequest/netease/GetMusicPlayUrl");

const originalTarget = CookieManager.getTargetFilePath;
let fixture;
const ip = "192.0.2.7";
const oldCookie = "MUSIC_U=old-token; __csrf=old-csrf; NMTID=old-nmtid";
const alive = {
  code: 200,
  account: { id: 1, vipType: 11 },
  profile: { userId: 1, nickname: "fixture" },
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
const headersCookie = (headers) =>
  Object.fromEntries(
    new Headers(headers)
      .get("Cookie")
      .split("; ")
      .map((item) => {
        const index = item.indexOf("=");
        return [
          item.slice(0, index),
          decodeURIComponent(item.slice(index + 1)),
        ];
      }),
  );
const readBytes = () => fs.readFileSync(fixture);
function seed(cookie = oldCookie, date = 0) {
  fs.writeFileSync(fixture, JSON.stringify({ cookie, date }, null, 2));
}
function refreshResponse(
  cookies = ["MUSIC_U=rotated-token; Path=/", "__csrf=new-csrf; Path=/"],
) {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response('{"code":200}', { headers });
}
function transport(t, handler) {
  const calls = [];
  t.mock.method(
    NeteaseAccount,
    "sendPost",
    async (url, body, headers, signal) => {
      const call = {
        url,
        body,
        headers,
        signal,
        cookie: headersCookie(headers),
      };
      calls.push(call);
      assert.equal(headers["X-Real-IP"], ip);
      assert.equal(headers["X-Forwarded-For"], ip);
      assert.ok(signal instanceof AbortSignal);
      return handler(call, calls);
    },
  );
  return calls;
}
const isRefresh = (call) => call.url.endsWith("/eapi/login/token/refresh");
function successTransport(t, response = () => refreshResponse()) {
  return transport(t, (call) => (isRefresh(call) ? response() : json(alive)));
}

beforeEach(() => {
  fixture = path.join(workspace, `fixture-${crypto.randomUUID()}.json`);
  CookieManager.getTargetFilePath = () => fixture;
  process.env.MUSIC_U = "env-token";
});
afterEach(() => {
  assert.equal(CookieManager.refreshPromise, null);
  globalThis.fetch = unplannedNetwork;
  CookieManager.getTargetFilePath = originalTarget;
});
after(() => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("即使 /mnt 持久目录存在，也只读写固定 fixture", (t) => {
  const originalExists = fs.existsSync;
  t.mock.method(
    fs,
    "existsSync",
    (name) => String(name).startsWith("/mnt") || originalExists(name),
  );
  syncBuiltinESMExports();
  try {
    assert.ok(fs.existsSync("/mnt/account/netease"));
    assert.equal(CookieManager.getTargetFilePath(), fixture);
    assert.equal(CookieManager.setCookie(oldCookie), true);
    assert.equal(CookieManager.getCookieHeader(), oldCookie);
    assert.equal(JSON.parse(readBytes()).cookie, oldCookie);
  } finally {
    fs.existsSync = originalExists;
    syncBuiltinESMExports();
  }
});

test("有效会话遵守刷新周期且保留 refreshed 兼容字段", async (t) => {
  seed(oldCookie, Date.now());
  const calls = successTransport(t);
  const result = await CookieManager.checkAndRefreshCookie(ip);
  assert.equal(result.status, "SKIPPED");
  assert.equal(result.refreshed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cookie.MUSIC_U, "old-token");
});

test("历史合并 Cookie 在末尾 Expires 后仍保留边界", () => {
  seed(
    "MUSIC_U=old-token; Expires=Fri, 01 Jan 2100 00:00:00 GMT, __csrf=old-csrf; Expires=Fri, 01 Jan 2100 00:00:00 GMT, NMTID=old-nmtid",
  );
  assert.equal(CookieManager.getCookieHeader(), oldCookie);
});

for (const separate of [true, false]) {
  test(`响应 Cookie 边界和删除语义：${separate ? "独立头" : "合并头"}`, async (t) => {
    seed(
      `${oldCookie}; zero=old; negative=old; past=old; keep=old; invalidAge=old`,
    );
    const cookies = [
      "MUSIC_U=rotated-token; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
      "__csrf=new-csrf; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
      "zero=nonempty; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
      "negative=nonempty; Max-Age=-1",
      "past=nonempty; Expires=Sat, 01 Jan 2000 00:00:00 GMT",
      "keep=new; Max-Age=60; Expires=Sat, 01 Jan 2000 00:00:00 GMT",
      "invalidAge=nonempty; Max-Age=invalid; Expires=Sat, 01 Jan 2000 00:00:00 GMT",
      "empty=; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
      "padded=a=b==; Path=/",
    ];
    successTransport(t, () => {
      const response = refreshResponse(cookies);
      Object.defineProperty(response.headers, "getSetCookie", {
        value: () => (separate ? cookies : []),
      });
      return response;
    });
    assert.equal(await CookieManager.refreshCookie(ip), true);
    const saved = CookieManager.getCookieHeader();
    assert.match(saved, /MUSIC_U=rotated-token; __csrf=new-csrf/);
    assert.doesNotMatch(saved, /(?:zero|negative|past|invalidAge)=/);
    assert.match(saved, /keep=new/);
    assert.match(saved, /empty=;/);
    assert.match(saved, /padded=a=b==/);
    assert.doesNotMatch(saved, /Expires|Max-Age|Path/);
  });
}

const accountCases = [
  ["HTTP 503", () => json({ code: 401 }, 503), "unavailable"],
  ["HTTP 401", () => json({ code: 401 }, 401), "unavailable"],
  ["无效 JSON", () => new Response("not json"), "unavailable"],
  ["缺少对象", () => json({ code: 200 }), "unavailable"],
  [
    "空对象",
    () => json({ code: 200, account: {}, profile: {} }),
    "unavailable",
  ],
  [
    "错误字段类型",
    () => json({ ...alive, account: { id: "1", vipType: 11 } }),
    "unavailable",
  ],
  [
    "缺少 profile ID",
    () => json({ ...alive, profile: { nickname: "fixture" } }),
    "unavailable",
  ],
  ["部分 null", () => json({ ...alive, profile: null }), "unavailable"],
  ["业务 503", () => json({ code: 503 }), "unavailable"],
  ["业务 429", () => json({ code: 429 }), "unavailable"],
  ["未知业务码", () => json({ code: 500 }), "unavailable"],
  [
    "明确匿名 null",
    () => json({ code: 200, account: null, profile: null }),
    "invalid",
  ],
  ["业务 301", () => json({ code: 301 }), "invalid"],
  ["业务 401", () => json({ code: 401 }), "invalid"],
];
for (const [label, response, state] of accountCases) {
  test(`账号状态分类及管理接口契约：${label}`, async (t) => {
    seed();
    const before = readBytes();
    const calls = transport(t, (call) =>
      isRefresh(call) ? json({ code: 401 }) : response(),
    );
    const status = await AccountManager.checkAccountStatus(ip);
    assert.equal(
      status.status,
      state === "invalid" ? "Account not alive" : "Account check unavailable",
    );
    assert.equal(status.account, null);
    const result = await CookieManager.checkAndRefreshCookie(ip);
    assert.equal(
      result.status,
      state === "invalid" ? "REFRESH_REJECTED" : "ACCOUNT_CHECK_UNAVAILABLE",
    );
    assert.equal(result.refreshed, false);
    const refreshes = calls.filter(isRefresh);
    assert.equal(refreshes.length, state === "invalid" ? 1 : 0);
    if (refreshes.length)
      assert.equal(refreshes[0].cookie.MUSIC_U, "env-token");
    assert.deepEqual(readBytes(), before);
  });
}

test("管理接口有效账号契约", async (t) => {
  seed();
  successTransport(t);
  const result = await AccountManager.checkAccountStatus(ip);
  assert.deepEqual(result.account, { username: "fixture", vipType: 11 });
  assert.equal(result.status, "Account is alive");
  assert.equal(typeof result.lastRefreshTime, "string");
});

test("并发手动/直接刷新共享延迟旧账号检查，读取等待新会话", async (t) => {
  seed();
  let release;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  let oldChecks = 0;
  const calls = transport(t, async (call) => {
    if (isRefresh(call)) {
      assert.equal(call.cookie.MUSIC_U, "env-token");
      assert.equal(call.cookie.NMTID, "old-nmtid");
      return refreshResponse();
    }
    if (call.cookie.MUSIC_U === "old-token") {
      oldChecks += 1;
      await delayed;
      return json({ code: 301 });
    }
    assert.equal(call.cookie.MUSIC_U, "rotated-token");
    assert.equal(call.cookie.__csrf, "new-csrf");
    return json(alive);
  });
  const first = CookieManager.checkAndRefreshCookie(ip);
  const second = CookieManager.checkAndRefreshCookie(ip);
  const direct = CookieManager.refreshCookie(ip);
  let readFinished = false;
  const reading = CookieManager.getCookie(ip).then((cookie) => {
    readFinished = true;
    return cookie;
  });
  await Promise.resolve();
  assert.equal(readFinished, false);
  release();
  const [a, b, c, cookie] = await Promise.all([first, second, direct, reading]);
  assert.equal(a, b);
  assert.equal(a.refreshed, true);
  assert.equal(c, true);
  assert.match(cookie, /MUSIC_U=rotated-token/);
  assert.equal(oldChecks, 1);
  assert.equal(calls.filter(isRefresh).length, 1);
  assert.equal(calls.length, 3);
});

test("真实传输方法保留 Cookie/设备/IP/超时和 EAPI token", async (t) => {
  const signals = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 10000);
    const signal = new AbortController().signal;
    signals.push(signal);
    return signal;
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options });
    return json(alive);
  });
  const supplied =
    "MUSIC_U=stale; __csrf=stale; NMTID=fixture; deviceId=fixture-device; os=pc";
  await NeteaseAccount.refreshCookie("csrf-new", "token-new", ip, supplied);
  await NeteaseAccount.getAccountInfo("csrf-new", "token-new", ip, supplied);
  assert.equal(
    calls[0].url,
    "https://interface.music.163.com/eapi/login/token/refresh",
  );
  assert.equal(calls[1].url, "https://music.163.com/weapi/w/nuser/account/get");
  for (const [index, call] of calls.entries()) {
    assert.equal(call.signal, signals[index]);
    assert.equal(call.method, "POST");
    assert.equal(call.headers["X-Real-IP"], ip);
    assert.equal(call.headers["X-Forwarded-For"], ip);
    const cookie = headersCookie(call.headers);
    assert.equal(cookie.MUSIC_U, "token-new");
    assert.equal(cookie.__csrf, "csrf-new");
    assert.equal(cookie.NMTID, "fixture");
  }
  const cookie = headersCookie(calls[0].headers);
  assert.equal(cookie.deviceId, "fixture-device");
  assert.ok(cookie.appver && cookie.osver && cookie.requestId);
  const encrypted = calls[0].body.get("params");
  const [uri, payload] = NeteaseCrypto.decrypt(Buffer.from(encrypted, "hex"))
    .toString()
    .split("-36cd479b6b5-");
  assert.equal(uri, "/api/login/token/refresh");
  const data = JSON.parse(payload);
  assert.equal(data.header.MUSIC_U, cookie.MUSIC_U);
  assert.equal(data.header.__csrf, cookie.__csrf);
  assert.equal(data.header.deviceId, cookie.deviceId);
  assert.equal(data.e_r, false);
  assert.equal(NeteaseCrypto.eapi(uri, data).params, encrypted);
});

for (const phase of ["account", "refresh"]) {
  test(`超时释放共享任务：${phase}`, async (t) => {
    seed();
    const before = readBytes();
    const controllers = [];
    t.mock.method(AbortSignal, "timeout", (ms) => {
      assert.equal(ms, 10000);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    let entered;
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async (url, options) => {
        if (phase === "refresh" && url.includes("/weapi/")) return json(alive);
        entered();
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          ),
        );
      },
    );
    const pending = CookieManager.checkAndRefreshCookie(ip);
    const follower = CookieManager.refreshCookie(ip);
    await reached;
    controllers
      .at(-1)
      .abort(new DOMException("fixture timeout", "TimeoutError"));
    const result = await pending;
    assert.equal(await follower, false);
    assert.equal(
      result.status,
      phase === "account"
        ? "ACCOUNT_CHECK_UNAVAILABLE"
        : "REFRESH_RESPONSE_INVALID",
    );
    assert.deepEqual(readBytes(), before);
    assert.equal(CookieManager.refreshPromise, null);
    fetchMock.mock.mockImplementation(async (url) =>
      url.includes("/weapi/") ? json(alive) : refreshResponse(),
    );
    assert.equal(await CookieManager.refreshCookie(ip), true);
  });
}

test("原子重命名失败保留精确旧字节并清理临时文件", async (t) => {
  seed();
  const before = readBytes();
  successTransport(t);
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", () => {
    throw new Error("fixture rename failure");
  });
  syncBuiltinESMExports();
  try {
    const result = await CookieManager.checkAndRefreshCookie(ip);
    assert.equal(result.status, "REFRESH_RESPONSE_INVALID");
    assert.equal(result.refreshed, false);
    assert.deepEqual(readBytes(), before);
    assert.deepEqual(
      fs.readdirSync(workspace).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

for (const cookie of [undefined, "MUSIC_U=only-token", "__csrf=only-csrf"]) {
  test(`缺失或不完整会话不伪造成功：${cookie ?? "missing"}`, async () => {
    if (cookie) seed(cookie);
    const before = cookie ? readBytes() : null;
    const result = await CookieManager.checkAndRefreshCookie(ip);
    assert.equal(result.status, "NEEDS_SESSION_IMPORT");
    assert.equal(result.refreshed, false);
    assert.equal(await CookieManager.getCookie(ip), cookie ?? null);
    assert.equal(
      (await AccountManager.checkAccountStatus(ip)).status,
      "Needs session import",
    );
    if (before) assert.deepEqual(readBytes(), before);
    else assert.equal(fs.existsSync(fixture), false);
  });
}

for (const [label, response, afterResponse] of [
  ["刷新业务拒绝", () => json({ code: 401 })],
  ["缺少 Set-Cookie", () => json({ code: 200 })],
  ["刷新无效 JSON", () => new Response("invalid")],
  ["刷新错误 code 类型", () => json({ code: "sensitive-fixture" })],
  ["二次账号检查失效", () => refreshResponse(), () => json({ code: 301 })],
  ["二次账号检查不可用", () => refreshResponse(), () => json({ code: 503 })],
  ["删除必要 Cookie", () => refreshResponse(["MUSIC_U=nonempty; Max-Age=0"])],
]) {
  test(`失败保留原文件：${label}`, async (t) => {
    seed();
    const before = readBytes();
    let refreshed = false;
    const logs = [];
    t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
    transport(t, (call) => {
      if (isRefresh(call)) {
        refreshed = true;
        return response();
      }
      return refreshed && afterResponse ? afterResponse() : json(alive);
    });
    assert.equal(await CookieManager.refreshCookie(ip), false);
    assert.deepEqual(readBytes(), before);
    assert.doesNotMatch(logs.join(" "), /sensitive-fixture|old-token/);
  });
}

test("播放调用向 Cookie 初始化和传输层传递实际 IP", async (t) => {
  let receivedIp;
  t.mock.method(CookieManager, "getCookie", async (value) => {
    receivedIp = value;
    return oldCookie;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(
      url,
      "https://interface.music.163.com/eapi/song/enhance/player/url",
    );
    assert.equal(options.headers["X-Real-IP"], ip);
    assert.equal(options.headers["X-Forwarded-For"], ip);
    assert.equal(headersCookie(options.headers).MUSIC_U, "old-token");
    return json({
      code: 200,
      data: [{ url: "https://audio.invalid/fixture", br: 320000 }],
    });
  });
  assert.equal(
    await GetMusicPlayUrl.getUrl("1", "higher", ip),
    "https://audio.invalid/fixture",
  );
  assert.equal(receivedIp, ip);
});
