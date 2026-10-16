"""只读检查指定云函数；不打印配置原文、环境值或代码下载链接。"""

import base64
import io
import hashlib
import json
import os
import re
import urllib.request
import zipfile

from tencentcloud.common import credential
from tencentcloud.common.exception.tencent_cloud_sdk_exception import (
    TencentCloudSDKException,
)
from tencentcloud.common.profile.client_profile import ClientProfile
from tencentcloud.common.profile.http_profile import HttpProfile
from tencentcloud.scf.v20180416 import models, scf_client

TARGET = {"FunctionName": "MusicAPI", "Namespace": "default"}


def emit(section, value):
    print(
        json.dumps({"section": section, "data": value}, ensure_ascii=True), flush=True
    )


def request(client, action, extra=None):
    req = getattr(models, action + "Request")()
    req.from_json_string(json.dumps({**TARGET, **(extra or {})}))
    return json.loads(getattr(client, action)(req).to_json_string())


def inspect_archive(client):
    data = request(client, "GetFunctionAddress")
    code_hash = data.get("CodeSha256")
    if isinstance(code_hash, str):
        emit(
            "code_hash",
            {
                "value": code_hash.lower()
                if re.fullmatch(r"[A-Fa-f0-9]{64}", code_hash)
                else code_hash
            },
        )
    # 代码包仅在内存中检查，无解压、无上传产物、无打印签名 URL。
    with urllib.request.urlopen(data["Url"], timeout=30) as response:
        archive = response.read(50 * 1024 * 1024 + 1)
    if len(archive) > 50 * 1024 * 1024:
        emit("package", {"inspection": "size-limit"})
        return
    emit(
        "package_hash",
        {
            "sha256_hex": hashlib.sha256(archive).hexdigest(),
            "sha256_base64": base64.b64encode(hashlib.sha256(archive).digest()).decode(
                "ascii"
            ),
        },
    )
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        names = set(bundle.namelist())
        result = {
            name: name in names
            for name in (
                "scf_bootstrap",
                "index.js",
                "dist/index.js",
                "package.json",
                ".env",
            )
        }
        result["node_modules_present"] = any(
            n.startswith("node_modules/") for n in names
        )
        if ".env" in names and bundle.getinfo(".env").file_size < 65536:
            text = bundle.read(".env").decode("utf-8", errors="replace")
            emit(
                "packaged_environment_presence",
                {
                    name: bool(
                        re.search(r"(?m)^\s*(?:export\s+)?" + name + r"\s*=\s*\S", text)
                    )
                    for name in (
                        "MUSIC_U",
                        "REFRESH_COOKIE_NETEASE",
                        "DEBUG_NETEASE",
                        "NETEASE_COOKIE_FILE",
                        "PORT",
                    )
                },
            )
        if "scf_bootstrap" in names:
            info = bundle.getinfo("scf_bootstrap")
            result["bootstrap_executable"] = bool((info.external_attr >> 16) & 0o111)
            if info.file_size < 65536:
                text = bundle.read(info).decode("utf-8", errors="replace")
                result["bootstrap_uses_dist_index"] = bool(
                    re.search(r"\bdist/index\.js\b", text)
                )
                result["bootstrap_uses_root_index"] = bool(
                    re.search(r"(?<![\w/])index\.js\b", text)
                )
                result["bootstrap_uses_npm_start"] = bool(
                    re.search(r"\bnpm\s+(?:run\s+)?start\b", text)
                )
                result["node_binary_paths"] = sorted(
                    set(re.findall(r"/var/lang/node[0-9.]*/bin/node\b", text))
                )
        emit("package", result)


def main():
    keys = [
        os.environ.get(name, "") for name in ("TENCENT_SECRET_ID", "TENCENT_SECRET_KEY")
    ]
    if not all(keys):
        emit("error", {"code": "MissingGitHubSecrets"})
        return 1
    profile = ClientProfile()
    profile.httpProfile = HttpProfile()
    profile.httpProfile.reqTimeout = 30
    client = scf_client.ScfClient(credential.Credential(*keys), "ap-hongkong", profile)
    config = request(client, "GetFunction", {"ShowCode": "FALSE"})
    emit(
        "function",
        {
            key: config.get(key)
            for key in (
                "FunctionName",
                "Namespace",
                "Type",
                "Runtime",
                "Status",
                "Qualifier",
                "Timeout",
                "InitTimeout",
                "MemorySize",
                "CodeSize",
                "InstallDependency",
            )
        },
    )
    variables = (config.get("Environment") or {}).get("Variables") or []
    emit(
        "environment_presence",
        {
            name: any(v.get("Key") == name and bool(v.get("Value")) for v in variables)
            for name in (
                "MUSIC_U",
                "REFRESH_COOKIE_NETEASE",
                "DEBUG_NETEASE",
                "NETEASE_COOKIE_FILE",
                "PORT",
            )
        },
    )
    mounts = (config.get("CfsConfig") or {}).get("CfsInsList") or []
    emit("storage", [{"LocalMountDir": mount.get("LocalMountDir")} for mount in mounts])
    emit(
        "network",
        {
            "vpc_configured": bool((config.get("VpcConfig") or {}).get("VpcId")),
            "public_network": (config.get("PublicNetConfig") or {}).get(
                "PublicNetStatus"
            ),
        },
    )
    failed = False
    for action, collection in (
        ("ListAliases", "Aliases"),
        ("ListTriggers", "Triggers"),
    ):
        try:
            offset = 0
            while True:
                extra = (
                    {"Offset": str(offset), "Limit": "100"}
                    if action == "ListAliases"
                    else {"Offset": offset, "Limit": 100}
                )
                data = request(client, action, extra)
                items = data.get(collection) or []
                fields = (
                    ("Name", "FunctionVersion", "RoutingConfig")
                    if action == "ListAliases"
                    else ("Type", "Qualifier", "Enable", "AvailableStatus")
                )
                emit(
                    collection,
                    [{key: item.get(key) for key in fields} for item in items],
                )
                if action == "ListTriggers":
                    for item in items:
                        try:
                            desc = json.loads(item.get("TriggerDesc") or "{}")
                        except (ValueError, TypeError):
                            continue
                        # 只输出公开端点的 origin，不输出查询参数或鉴权配置。
                        from urllib.parse import urlsplit

                        urls = []

                        def collect(value):
                            if isinstance(value, dict):
                                for entry in value.values():
                                    collect(entry)
                            elif isinstance(value, list):
                                for entry in value:
                                    collect(entry)
                            elif isinstance(value, str) and value.startswith(
                                "https://"
                            ):
                                parsed = urlsplit(value)
                                if parsed.hostname and parsed.hostname.endswith(
                                    ".tencentscf.com"
                                ):
                                    urls.append("https://" + parsed.hostname)

                        collect(desc)
                        emit("function_url_origins", sorted(set(urls)))
                if len(items) < 100:
                    break
                offset += len(items)
                if offset >= 1000:
                    raise ValueError("PaginationLimit")
        except TencentCloudSDKException as error:
            emit(action, {"error_code": error.get_code()})
            failed = True
    if config.get("Runtime") != "CustomImage":
        try:
            inspect_archive(client)
        except TencentCloudSDKException as error:
            emit("package", {"error_code": error.get_code()})
            failed = True
        except Exception:
            emit("package", {"inspection": "failed-no-raw-error-logged"})
            failed = True
    return int(failed)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except TencentCloudSDKException as error:
        emit("error", {"code": error.get_code()})
        raise SystemExit(1) from None
    except Exception:
        emit("error", {"code": "InspectionFailed"})
        raise SystemExit(1) from None
