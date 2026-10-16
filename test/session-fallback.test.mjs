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
  "config/env",
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
const { safeErrorFields, resolvePort, logConfigDiagnostics } =
  await load("config/env");

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
  process.env.DEBUG_NETEASE = "false";
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
      assert.equal(call.cookie.__csrf, undefined);
      assert.equal(call.cookie.NMTID, undefined);
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

test("读取等待失败中的刷新后不重复发起刷新", async (t) => {
  seed("MUSIC_U=old-token");
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const calls = transport(t, async (call) => {
    assert.equal(isRefresh(call), true);
    await blocked;
    throw Object.assign(new Error("fixture network"), { code: "ENOTFOUND" });
  });
  const refreshing = CookieManager.initialize(ip, true);
  await Promise.resolve();
  const reading = CookieManager.getCookie(ip);
  release();
  assert.equal((await refreshing).success, false);
  assert.equal(await reading, "MUSIC_U=old-token");
  assert.equal(calls.filter(isRefresh).length, 1);
});

test("错误诊断只保留允许的分类、系统码和有限 cause", () => {
  const result = safeErrorFields({
    name: "secret-name",
    code: "secret-code",
    errno: "secret-errno",
    cause: {
      name: "TypeError",
      code: "ENOTFOUND",
      errno: -3008,
      cause: { name: "CustomSecret", code: "another-secret" },
    },
  });
  assert.deepEqual(result, {
    errorCategory: "network-error",
    errorCode: "ENOTFOUND",
    errno: -3008,
  });
  assert.deepEqual(
    safeErrorFields({ name: "secret", code: "secret", errno: Infinity }),
    { errorCategory: "unknown" },
  );
  const cycle = { name: "secret", cause: null };
  cycle.cause = cycle;
  assert.deepEqual(safeErrorFields(cycle), { errorCategory: "unknown" });
  assert.deepEqual(
    safeErrorFields(
      new TypeError("secret", { cause: { code: "ECONNREFUSED", errno: -111 } }),
    ),
    {
      errorCategory: "network-error",
      errorCode: "ECONNREFUSED",
      errno: -111,
    },
  );
});

test("端口只接受范围内的纯数字，包括动态端口 0", (t) => {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  logConfigDiagnostics(fixture, resolvePort("secret-port"));
  assert.match(logs.join("\n"), /invalid config; defaulted/);
  assert.doesNotMatch(logs.join("\n"), /secret-port/);
  for (const value of [
    "9000junk",
    "65536",
    "99999999999999999999",
    "-1",
    " 9000",
    "",
    "1.5",
  ]) {
    assert.deepEqual(resolvePort(value), { port: 9000, invalid: true });
  }
  for (const value of ["0", "9000", "65535"]) {
    assert.deepEqual(resolvePort(value), {
      port: Number(value),
      invalid: false,
    });
  }
});

test("环境 token 与持久 token 相同也按实际分支记录来源", async (t) => {
  seed();
  process.env.MUSIC_U = "old-token";
  process.env.DEBUG_NETEASE = "true";
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  const calls = successTransport(t);
  assert.equal(await CookieManager.refreshCookie(ip), true);
  assert.equal(calls.find(isRefresh).cookie.__csrf, "old-csrf");
  assert.match(logs.join("\n"), /candidate=persisted/);
  assert.doesNotMatch(logs.join("\n"), /candidate=env/);
});

test("账号请求诊断区分 HTTP、业务和 JSON 响应", async (t) => {
  process.env.DEBUG_NETEASE = "true";
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  const cases = [
    [
      "http-business",
      json({ code: 401, message: "secret-body" }, 503),
      "http-error",
      503,
      401,
    ],
    ["http", new Response("{}", { status: 503 }), "http-error", 503, undefined],
    ["json", new Response("invalid"), "invalid-json", 200, undefined],
    ["business", json({ code: 503 }), "business-error", 200, 503],
    ["shape", json({ code: 200 }), "malformed-response", 200, 200],
  ];
  let currentResponse;
  t.mock.method(NeteaseAccount, "sendPost", async () => currentResponse);
  for (const [, response, category, status, businessCode] of cases) {
    currentResponse = response;
    await assert.rejects(
      NeteaseAccount.getAccountInfo("csrf", "token", ip, "MUSIC_U=token"),
      (error) => {
        const fields = safeErrorFields(error);
        assert.equal(fields.errorCategory, category);
        assert.equal(fields.httpStatus, status);
        assert.equal(fields.businessCode, businessCode);
        return true;
      },
    );
    assert.match(logs.at(-1), /phase=account-request.*elapsedMs=\d+/);
    assert.doesNotMatch(logs.at(-1), /secret-body/);
  }
});

test("Cookie 文件诊断区分缺失、JSON、结构和保存阶段失败", async (t) => {
  process.env.DEBUG_NETEASE = "true";
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  assert.equal(CookieManager.getCookieData(), null);
  fs.writeFileSync(fixture, "invalid");
  assert.equal(CookieManager.getCookieData(), null);
  fs.writeFileSync(fixture, JSON.stringify({ cookie: 1, date: "bad" }));
  assert.equal(CookieManager.getCookieData(), null);
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", () => {
    throw Object.assign(new Error("fixture io"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  try {
    assert.equal(CookieManager.setCookie(oldCookie), false);
  } finally {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  }
  assert.match(logs.join("\n"), /result=missing/);
  assert.match(logs.join("\n"), /result=invalid-json/);
  assert.match(logs.join("\n"), /result=invalid-shape/);
  assert.match(logs.join("\n"), /phase=cookie-save/);
  assert.match(logs.join("\n"), /operation=open/);
  assert.match(logs.join("\n"), /errorCode=EACCES/);
  assert.doesNotMatch(logs.join("\n"), /fixture io|old-token/);
});

test("Cookie 读取 I/O 错误保留 errno，null JSON 是结构错误", (t) => {
  process.env.DEBUG_NETEASE = "true";
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  fs.writeFileSync(fixture, "null");
  assert.equal(CookieManager.getCookieData(), null);
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", () => {
    throw Object.assign(new Error("secret-file"), {
      code: "EACCES",
      errno: -13,
    });
  });
  syncBuiltinESMExports();
  try {
    assert.equal(CookieManager.getCookieData(), null);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.match(logs.join("\n"), /result=invalid-shape/);
  assert.match(
    logs.join("\n"),
    /result=io-error.*errno=-13.*errorCode=EACCES|result=io-error.*errorCode=EACCES.*errno=-13/,
  );
  assert.doesNotMatch(logs.join("\n"), /secret-file/);
});

test("播放日志覆盖网络、JSON、空地址和恶意 br，不输出原文", async (t) => {
  process.env.DEBUG_NETEASE = "true";
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  t.mock.method(CookieManager, "getCookie", async () => oldCookie);
  let response;
  t.mock.method(globalThis, "fetch", async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  for (const [value, reason] of [
    [
      new TypeError("secret-error", { cause: { code: "ENOTFOUND" } }),
      "network-error",
    ],
    [new Response("secret-json"), "invalid-json"],
    [
      json({ code: 200, data: [{ url: null, br: "secret-br" }] }),
      "missing-url",
    ],
    [json({ code: "secret-code" }), "business-error"],
  ]) {
    response = value;
    await assert.rejects(GetMusicPlayUrl.getUrl("1", "higher", ip));
    assert.match(logs.at(-1), new RegExp(`result=${reason}.*elapsedMs=\\d+`));
  }
  response = json({
    code: 200,
    data: [{ url: "https://audio.invalid/secret-audio", br: "secret-br" }],
  });
  assert.equal(
    await GetMusicPlayUrl.getUrl("1", "higher", ip),
    "https://audio.invalid/secret-audio",
  );
  assert.doesNotMatch(logs.join("\n"), /secret-|old-token|old-csrf/);
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
  test(`缺失或不完整会话使用环境 token 尝试刷新：${cookie ?? "missing"}`, async (t) => {
    if (cookie) seed(cookie);
    const before = cookie ? readBytes() : null;
    const calls = successTransport(t);
    const result = await CookieManager.checkAndRefreshCookie(ip);
    assert.equal(result.status, "REFRESHED");
    assert.equal(result.refreshed, true);
    const refreshes = calls.filter(isRefresh);
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].cookie.MUSIC_U, "env-token");
    assert.equal(refreshes[0].cookie.__csrf, undefined);
    assert.equal(refreshes[0].cookie.NMTID, undefined);
    assert.match(await CookieManager.getCookie(ip), /MUSIC_U=rotated-token/);
    if (before) assert.notDeepEqual(readBytes(), before);
    else assert.ok(fs.existsSync(fixture));
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
