import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const distEntry = path.join(root, "dist", "index.js");
const token = "process-token";
const dotenvToken = "dotenv-token";

async function runStartup({
  dotenv = true,
  dotenvError = false,
  processToken = true,
  refreshOnStartup = true,
  debug = false,
  persistedCookie,
  corrupt = false,
  persistedDate = Date.now(),
  response = "success",
  expectedToken = token,
  checkMusicRoute = false,
} = {}) {
  const workspace = fs.mkdtempSync("/tmp/opencode/musicapi-startup-");
  const marker = path.join(workspace, "network-stub-marker");
  const stub = path.join(workspace, "network-stub.mjs");
  const cookieFile = path.join(workspace, "isolated", "cookie.json");
  if (dotenv) {
    fs.writeFileSync(
      path.join(workspace, ".env"),
      `MUSIC_U=${dotenvToken}\nREFRESH_COOKIE_NETEASE=${refreshOnStartup}\nDEBUG_NETEASE=${debug}\n`,
    );
  }
  if (persistedCookie !== undefined || corrupt) {
    fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
    fs.writeFileSync(
      cookieFile,
      corrupt
        ? "{invalid-secret-json"
        : JSON.stringify({ cookie: persistedCookie, date: persistedDate }),
    );
  }
  fs.writeFileSync(
    stub,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalExists = fs.existsSync;
fs.existsSync = (name) => String(name).startsWith("/mnt") ? false : originalExists(name);
const originalRead = fs.readFileSync;
fs.readFileSync = (name, ...args) => {
  if (${JSON.stringify(dotenvError)} && String(name) === process.cwd() + "/.env") {
    throw Object.assign(new Error("secret-dotenv"), {code: "EACCES", errno: -13});
  }
  return originalRead(name, ...args);
};
syncBuiltinESMExports();
const marker = process.env.NETWORK_STUB_MARKER;
const expected = ${JSON.stringify(expectedToken)};
const responseMode = ${JSON.stringify(response)};
const alive = { code: 200, account: { id: 7, vipType: 11 }, profile: { userId: 7, nickname: "fixture" } };
globalThis.fetch = async (url, options = {}) => {
  const requestUrl = String(url);
  if (requestUrl === "https://api.ip.sb/ip") return new Response("203.0.113.7");
  const cookie = Object.fromEntries(String(options.headers?.Cookie ?? "").split("; ").map(pair => {
    const i = pair.indexOf("=");
    return [pair.slice(0,i), decodeURIComponent(pair.slice(i+1))];
  }));
  if (requestUrl.endsWith("/eapi/login/token/refresh")) {
    fs.appendFileSync(marker, "refresh\\n");
    if (cookie.MUSIC_U !== expected || cookie.__csrf !== undefined || cookie.NMTID !== undefined) {
      fs.appendFileSync(marker, "mismatch\\n");
      throw new Error("candidate mismatch");
    }
    if (responseMode === "failure") return new Response(JSON.stringify({ code: 401 }));
    const headers = new Headers();
    headers.append("set-cookie", "MUSIC_U=rotated-startup; Path=/");
    headers.append("set-cookie", "__csrf=startup-csrf; Path=/");
    return new Response(JSON.stringify({ code: 200 }), { headers });
  }
  if (requestUrl === "https://music.163.com/weapi/w/nuser/account/get") {
    fs.appendFileSync(marker, "account\\n");
    const refreshed = fs.readFileSync(marker, "utf8").includes("refresh\\n");
    if (cookie.MUSIC_U !== (refreshed ? "rotated-startup" : "persisted-token") || cookie.__csrf !== (refreshed ? "startup-csrf" : "persisted-csrf")) {
      fs.appendFileSync(marker, "mismatch\\n");
      throw new Error("account candidate mismatch");
    }
    if (responseMode === "network-failure") throw new TypeError("secret upstream", { cause: {code: "ENOTFOUND", errno: -3008} });
    if (responseMode === "invalid" && !refreshed) return new Response('{"code":301}');
    return new Response(JSON.stringify(alive));
  }
  if (requestUrl === "https://interface.music.163.com/eapi/song/enhance/player/url") {
    fs.appendFileSync(marker, "play\\n");
    return new Response('{"code":200,"data":[{"url":null,"br":"secret-bitrate"}]}');
  }
  fs.appendFileSync(marker, "unexpected\\n");
  throw new Error("unexpected URL");
};
`,
  );

  const childEnv = { ...process.env };
  for (const key of [
    "MUSIC_U",
    "REFRESH_COOKIE_NETEASE",
    "DEBUG_NETEASE",
    "NETEASE_COOKIE_FILE",
    "PORT",
    "DOTENV_KEY",
    "DOTENV_CONFIG_PATH",
    "NODE_OPTIONS",
  ]) {
    delete childEnv[key];
  }
  Object.assign(childEnv, {
    ...(processToken ? { MUSIC_U: token } : {}),
    ...(dotenv && !dotenvError
      ? {}
      : {
          REFRESH_COOKIE_NETEASE: String(refreshOnStartup),
          DEBUG_NETEASE: String(debug),
        }),
    NETEASE_COOKIE_FILE: cookieFile,
    NETWORK_STUB_MARKER: marker,
    PORT: "0",
  });

  const child = spawn(process.execPath, ["--import", stub, distEntry], {
    cwd: workspace,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    const deadline = Date.now() + 10000;
    while (!/Server active at http:\/\/0\.0\.0\.0:\d+/.test(output)) {
      if (child.exitCode !== null) {
        throw new Error(
          `startup exited with code ${child.exitCode}: ${output}`,
        );
      }
      if (Date.now() > deadline) throw new Error(`startup timeout: ${output}`);
      await delay(20);
    }
    const port = Number(
      output.match(/Server active at http:\/\/0\.0\.0\.0:(\d+)/)[1],
    );
    const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootResponse.status, 200);
    if (checkMusicRoute) {
      const musicResponse = await fetch(
        `http://127.0.0.1:${port}/musicstreamlink?platform=netease&id=1&quality=higher`,
      );
      assert.equal(musicResponse.status, 500);
      assert.doesNotMatch(await musicResponse.text(), /secret-|old-token/);
      const deadline = Date.now() + 1000;
      while (!output.includes("phase=music-route") && Date.now() < deadline)
        await delay(10);
      assert.match(
        output,
        /phase=music-route result=request-error elapsedMs=\d+/,
      );
    }
    const markerText = fs.existsSync(marker)
      ? fs.readFileSync(marker, "utf8")
      : "";
    const saved = fs.existsSync(cookieFile)
      ? JSON.parse(fs.readFileSync(cookieFile, "utf8"))
      : null;
    assert.doesNotMatch(
      output,
      /process-token|dotenv-token|rotated-startup|startup-csrf|persisted-token|persisted-csrf|old-token|old-csrf|secret upstream|secret-dotenv|secret-bitrate|invalid-secret-json/,
    );
    assert.equal(output.includes("NeteaseDebug"), debug);
    assert.ok(port > 0 && port <= 65535);
    return { output, markerText, saved };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test("编译产物启动覆盖环境来源、单次失败、会话选择和动态端口", async () => {
  const processPreferred = await runStartup({ debug: true });
  assert.equal(
    processPreferred.saved.cookie,
    "MUSIC_U=rotated-startup; __csrf=startup-csrf",
  );
  assert.equal(
    processPreferred.markerText,
    "refresh\naccount\n",
    processPreferred.output,
  );
  assert.match(processPreferred.output, /dotenv=loaded/);
  assert.match(processPreferred.output, /source=process/);
  assert.match(processPreferred.output, /status=REFRESHED/);
  assert.doesNotMatch(
    processPreferred.output,
    /process-token|dotenv-token|rotated-startup|startup-csrf/,
  );

  const dotenvOnly = await runStartup({
    processToken: false,
    expectedToken: dotenvToken,
  });
  assert.equal(dotenvOnly.markerText, "refresh\naccount\n");
  assert.match(dotenvOnly.output, /source=dotenv/);
  assert.match(dotenvOnly.saved.cookie, /MUSIC_U=rotated-startup/);

  const absentDotenv = await runStartup({
    dotenv: false,
    processToken: true,
    debug: false,
  });
  assert.equal(absentDotenv.markerText, "refresh\naccount\n");
  assert.equal(
    absentDotenv.saved.cookie,
    "MUSIC_U=rotated-startup; __csrf=startup-csrf",
  );
  assert.match(absentDotenv.output, /dotenv=missing/);
  assert.doesNotMatch(absentDotenv.output, /NeteaseDebug/);

  const failure = await runStartup({
    response: "failure",
    refreshOnStartup: false,
    expectedToken: token,
  });
  assert.equal(failure.markerText, "refresh\n");
  assert.equal(failure.saved, null);
  assert.match(failure.output, /status=REFRESH_REJECTED/);

  const corrupt = await runStartup({
    corrupt: true,
    refreshOnStartup: true,
    processToken: false,
    expectedToken: dotenvToken,
    debug: true,
  });
  assert.equal(corrupt.markerText, "refresh\naccount\n");
  assert.match(corrupt.output, /phase=cookie-read result=invalid-json/);
  assert.equal(
    corrupt.saved.cookie,
    "MUSIC_U=rotated-startup; __csrf=startup-csrf",
  );

  const incomplete = await runStartup({
    persistedCookie: "__csrf=old-csrf; NMTID=old-nmtid",
    refreshOnStartup: false,
    processToken: false,
    expectedToken: dotenvToken,
  });
  assert.equal(incomplete.markerText, "refresh\naccount\n");
  assert.equal(
    incomplete.saved.cookie,
    "MUSIC_U=rotated-startup; __csrf=startup-csrf",
  );
  assert.match(incomplete.output, /reason=incomplete/);

  const valid = await runStartup({
    persistedCookie: "MUSIC_U=persisted-token; __csrf=persisted-csrf",
    persistedDate: Date.now(),
    refreshOnStartup: true,
    expectedToken: "persisted-token",
  });
  assert.equal(valid.markerText, "account\n");
  assert.equal(
    valid.saved.cookie,
    "MUSIC_U=persisted-token; __csrf=persisted-csrf",
  );
  assert.match(valid.output, /reason=alive/);
  assert.match(valid.output, /status=SKIPPED/);

  const unknown = await runStartup({
    persistedCookie: "MUSIC_U=persisted-token; __csrf=persisted-csrf",
    response: "network-failure",
    refreshOnStartup: true,
    debug: true,
    expectedToken: "persisted-token",
  });
  assert.equal(unknown.markerText, "account\n");
  const dotenvNoRefreshFlag = await runStartup({
    processToken: false,
    expectedToken: dotenvToken,
    refreshOnStartup: false,
  });
  assert.equal(dotenvNoRefreshFlag.markerText, "refresh\naccount\n");
  assert.match(dotenvNoRefreshFlag.output, /status=REFRESHED/);
  const rejectedWithFlag = await runStartup({
    response: "failure",
    debug: true,
  });
  assert.equal(rejectedWithFlag.markerText, "refresh\n");
  assert.equal(rejectedWithFlag.saved, null);
  const invalid = await runStartup({
    persistedCookie: "MUSIC_U=persisted-token; __csrf=persisted-csrf",
    response: "invalid",
    debug: true,
  });
  assert.equal(invalid.markerText, "account\nrefresh\naccount\n");
  assert.match(invalid.output, /reason=invalid, source=env/);
  assert.equal(
    invalid.saved.cookie,
    "MUSIC_U=rotated-startup; __csrf=startup-csrf",
  );
  assert.equal(
    unknown.saved.cookie,
    "MUSIC_U=persisted-token; __csrf=persisted-csrf",
  );
  assert.match(unknown.output, /status=ACCOUNT_CHECK_UNAVAILABLE/);
  assert.match(unknown.output, /errorCode=ENOTFOUND/);
  assert.doesNotMatch(
    unknown.output,
    /process-token|dotenv-token|secret upstream/,
  );
  const inaccessibleDotenv = await runStartup({
    dotenvError: true,
    debug: true,
    checkMusicRoute: true,
  });
  assert.equal(inaccessibleDotenv.markerText, "refresh\naccount\nplay\n");
  assert.match(inaccessibleDotenv.output, /dotenv=error.*errorCode=EACCES/);
  assert.match(inaccessibleDotenv.output, /phase=play-url result=missing-url/);
  const incompleteFailure = await runStartup({
    persistedCookie: "__csrf=old-csrf; NMTID=old-nmtid",
    response: "failure",
  });
  assert.equal(incompleteFailure.markerText, "refresh\n");
  assert.equal(
    incompleteFailure.saved.cookie,
    "__csrf=old-csrf; NMTID=old-nmtid",
  );
});
