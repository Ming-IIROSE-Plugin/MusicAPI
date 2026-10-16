#!/usr/bin/env python3
"""Safely update code for the already existing MusicAPI SCF function.

The module keeps cloud calls injectable so all validation can be tested offline.
It deliberately has no UpdateFunctionConfiguration or alias/trigger mutation path.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


TARGET = {"FunctionName": "MusicAPI", "Namespace": "default"}
EXPECTED_RUNTIME = "Nodejs24.11"
EXPECTED_TYPE = "HTTP"
EXPECTED_MOUNT = "/mnt/"
EXPECTED_ALIAS = "$DEFAULT"
EXPECTED_VERSION = "$LATEST"
EXPECTED_TRIGGER_TYPE = "http"
MAX_ARCHIVE_BYTES = 3 * 1024 * 1024
EXPECTED_HEALTH_TEXT = "Music Redirect Server Running"
Call = Callable[[Any, str, dict[str, Any]], dict[str, Any]]


class DeploymentError(RuntimeError):
    pass


def sdk_call(client: Any, action: str, payload: dict[str, Any]) -> dict[str, Any]:
    from tencentcloud.scf.v20180416 import models

    request = getattr(models, action + "Request")()
    request.from_json_string(json.dumps(payload))
    response = getattr(client, action)(request)
    return json.loads(response.to_json_string())


def api(client: Any, action: str, extra: dict[str, Any], call: Call) -> dict[str, Any]:
    return call(client, action, {**TARGET, **extra})


def read_api(
    client: Any,
    action: str,
    extra: dict[str, Any],
    call: Call,
    attempts: int = 3,
) -> dict[str, Any]:
    """Retry bounded read calls only; update calls are never retried."""
    for attempt in range(attempts):
        try:
            return api(client, action, extra, call)
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def emit(section: str, data: Any) -> None:
    print(json.dumps({"section": section, "data": data}, ensure_ascii=True), flush=True)


def error_code(error: BaseException) -> str:
    getter = getattr(error, "get_code", None)
    if callable(getter):
        value = getter()
        if isinstance(value, str) and re.fullmatch(
            r"[A-Za-z][A-Za-z0-9.]{0,95}", value
        ):
            return value
    return type(error).__name__


def _items(data: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value = data.get(key) or []
    return value if isinstance(value, list) else []


def trigger_origins(trigger: dict[str, Any] | None) -> set[str]:
    origins: set[str] = set()
    try:
        description = (trigger or {}).get("TriggerDesc")
        if isinstance(description, str):
            description = json.loads(description)
    except (ValueError, TypeError):
        return origins

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, str):
            try:
                parsed = urlsplit(value)
                if (
                    parsed.scheme == "https"
                    and parsed.hostname
                    and parsed.hostname.endswith(".tencentscf.com")
                    and parsed.port in (None, 443)
                    and parsed.username is None
                ):
                    origins.add("https://" + parsed.hostname)
            except ValueError:
                pass

    collect(description)
    return origins


def summary(text: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as output:
            output.write(text + "\n")


def preflight(client: Any, call: Call = sdk_call) -> dict[str, Any]:
    config = read_api(client, "GetFunction", {"ShowCode": "FALSE"}, call)
    old_hash = code_hash(client, call)
    checks: dict[str, bool] = {
        "target": config.get("FunctionName") == TARGET["FunctionName"]
        and config.get("Namespace") == TARGET["Namespace"],
        "type": config.get("Type") == EXPECTED_TYPE,
        "runtime": config.get("Runtime") == EXPECTED_RUNTIME,
        "active": config.get("Status") == "Active",
        "config_migrated": os.environ.get("SCF_CONFIG_MIGRATED") == "true",
    }
    variables = (config.get("Environment") or {}).get("Variables") or []
    checks["cloud_music_u"] = any(
        item.get("Key") == "MUSIC_U"
        and isinstance(item.get("Value"), str)
        and bool(item["Value"].strip())
        for item in variables
        if isinstance(item, dict)
    )
    mounts = (config.get("CfsConfig") or {}).get("CfsInsList") or []
    checks["mount"] = any(
        item.get("LocalMountDir") == EXPECTED_MOUNT
        for item in mounts
        if isinstance(item, dict)
    )

    default_alias = read_api(client, "GetAlias", {"Name": EXPECTED_ALIAS}, call)
    routing = default_alias.get("RoutingConfig")
    checks["default_alias"] = (
        bool(default_alias) and default_alias.get("FunctionVersion") == EXPECTED_VERSION
    )
    checks["no_routing_weights"] = isinstance(routing, dict) and all(
        key in {"AdditionalVersionWeights", "AddtionVersionMatchs"} and value == []
        for key, value in routing.items()
    )

    triggers = read_api(client, "ListTriggers", {"Offset": 0, "Limit": 100}, call)
    http_trigger = next(
        (
            item
            for item in _items(triggers, "Triggers")
            if item.get("Type") == EXPECTED_TRIGGER_TYPE
            and item.get("Qualifier") == EXPECTED_ALIAS
            and type(item.get("Enable")) is int
            and item["Enable"] == 1
        ),
        None,
    )
    checks["http_trigger"] = http_trigger is not None
    origins = trigger_origins(http_trigger)
    checks["trigger_url_discovered"] = bool(origins)
    try:
        validate_health_url(
            os.environ.get("SCF_HEALTH_URL", "").strip(),
            os.environ.get("SCF_HEALTH_TRUSTED_ORIGIN", "").strip(),
            origins,
        )
        checks["health_target"] = True
    except (DeploymentError, ValueError):
        checks["health_target"] = False

    result = {
        "target": TARGET,
        "runtime": config.get("Runtime"),
        "type": config.get("Type"),
        "status": config.get("Status"),
        "environment": {"MUSIC_U": checks["cloud_music_u"]},
        "mount": [
            item.get("LocalMountDir") for item in mounts if isinstance(item, dict)
        ],
        "alias": {
            "name": (default_alias or {}).get("Name"),
            "version": (default_alias or {}).get("FunctionVersion"),
            "routing_weights": not checks["no_routing_weights"],
        },
        "http_trigger": bool(http_trigger),
        "checks": checks,
        "ready": all(checks.values()),
        "old_code_sha256": old_hash,
    }
    emit("preflight", result)
    summary(
        f"- preflight ready: `{str(result['ready']).lower()}`\n"
        f"- failed conditions: `{', '.join(key for key, ok in checks.items() if not ok) or 'none'}`"
    )
    result["_health_origins"] = origins
    return result


def code_hash(client: Any, call: Call) -> str:
    # Discard the signed URL immediately; never emit or persist this response.
    value = read_api(client, "GetFunctionAddress", {"Qualifier": "$LATEST"}, call).get(
        "CodeSha256"
    )
    if not isinstance(value, str) or not (
        re.fullmatch(r"[a-fA-F0-9]{64}", value)
        or re.fullmatch(r"[A-Za-z0-9+/]{43}=", value)
    ):
        raise DeploymentError("InvalidCodeHash")
    return value.lower() if re.fullmatch(r"[a-fA-F0-9]{64}", value) else value


def package_hash(path: Path) -> tuple[str, str]:
    digest = hashlib.sha256(path.read_bytes()).digest()
    return base64.b64encode(digest).decode("ascii"), digest.hex()


def wait_for_code(
    client: Any,
    expected_hashes: set[str],
    call: Call = sdk_call,
    timeout: float = 180,
    interval: float = 5,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    latest: dict[str, Any] = {}
    while time.monotonic() <= deadline:
        latest = read_api(client, "GetFunction", {"ShowCode": "FALSE"}, call)
        current_hash = code_hash(client, call)
        if latest.get("Status") == "Active" and current_hash in expected_hashes:
            emit("readiness", {"status": "Active", "code_hash_matched": True})
            return latest
        time.sleep(min(interval, max(0, deadline - time.monotonic())))
    emit("readiness", {"status": latest.get("Status"), "code_hash_matched": False})
    raise DeploymentError("ReadinessTimeout")


def validate_health_url(
    value: str, trusted_origin: str = "", origins: set[str] | None = None
) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.query
        or parsed.fragment
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.port not in (None, 443)
    ):
        raise DeploymentError("InvalidHealthUrl")
    trusted = urlsplit(trusted_origin) if trusted_origin else None
    if not origins:
        raise DeploymentError("MissingTargetTriggerUrl")
    allowed = "https://" + parsed.hostname in origins
    if (
        trusted
        and trusted.scheme == "https"
        and trusted.netloc == parsed.netloc
        and trusted.path in ("", "/")
        and not trusted.query
        and not trusted.fragment
        and trusted.username is None
        and trusted.password is None
        and not parsed.hostname.endswith(".tencentscf.com")
    ):
        allowed = True
    if not allowed:
        raise DeploymentError("UntrustedHealthOrigin")
    return value


def health_check(
    url: str,
    trusted_origin: str = "",
    timeout: float = 90,
    origins: set[str] | None = None,
) -> None:
    url = validate_health_url(url, trusted_origin, origins)

    class RejectRedirectHandler(HTTPRedirectHandler):
        def redirect_request(self, request, *args, **kwargs):
            raise DeploymentError("HealthCheckRedirect")

    opener = build_opener(RejectRedirectHandler())
    request = Request(url, method="GET")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with opener.open(
                request, timeout=min(10, max(0.1, deadline - time.monotonic()))
            ) as response:
                body = response.read(4096).decode("utf-8")
                if response.status != 200 or body != EXPECTED_HEALTH_TEXT:
                    raise DeploymentError("HealthCheckFailed")
            emit("health", {"status": "passed"})
            return
        except HTTPError as error:
            if not 500 <= error.code < 600:
                emit("health", {"status": "failed"})
                raise DeploymentError("HealthCheckFailed") from None
        except (URLError, TimeoutError, ConnectionError):
            pass
        except (DeploymentError, UnicodeDecodeError):
            emit("health", {"status": "failed"})
            raise DeploymentError("HealthCheckFailed") from None
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    emit("health", {"status": "failed", "error_code": "HealthCheckTimeout"})
    raise DeploymentError("HealthCheckTimeout")


def deploy(
    client: Any, archive: Path, call: Call = sdk_call, enabled: bool = False
) -> bool:
    preflight_result = preflight(client, call)
    if not enabled:
        summary(
            "- code update: `skipped` (SCF_DEPLOY_ENABLED != true)\n- HTTP health: `unchecked`"
        )
        emit("deployment", {"status": "disabled", "updated": False})
        return False
    if not preflight_result["ready"]:
        raise DeploymentError("PreflightFailed")
    health_url = os.environ.get("SCF_HEALTH_URL", "").strip()
    trusted_origin = os.environ.get("SCF_HEALTH_TRUSTED_ORIGIN", "").strip()
    validate_health_url(health_url, trusted_origin, preflight_result["_health_origins"])
    with archive.open("rb") as source:
        content = source.read(MAX_ARCHIVE_BYTES + 1)
    if not content or len(content) > MAX_ARCHIVE_BYTES:
        raise DeploymentError("PackageSizeLimit")
    digest = hashlib.sha256(content).digest()
    expected_b64, expected_hex = base64.b64encode(digest).decode("ascii"), digest.hex()
    old_hash = preflight_result["old_code_sha256"]
    response = api(
        client,
        "UpdateFunctionCode",
        {
            "ZipFile": base64.b64encode(content).decode("ascii"),
            "InstallDependency": "FALSE",
            "Publish": "FALSE",
        },
        call,
    )
    emit(
        "update",
        {
            "status": "requested",
            "function_version": response.get("FunctionVersion"),
            "old_code_sha256": old_hash,
            "expected_code_sha256": expected_b64,
        },
    )
    wait_for_code(client, {expected_b64, expected_hex}, call)
    health_check(
        health_url, trusted_origin, origins=preflight_result["_health_origins"]
    )
    emit(
        "deployment",
        {"status": "succeeded", "updated": True, "health_checked": bool(health_url)},
    )
    return True


def make_client() -> Any:
    secret_id = os.environ.get("TENCENT_SECRET_ID", "").strip()
    secret_key = os.environ.get("TENCENT_SECRET_KEY", "").strip()
    if not secret_id or not secret_key:
        raise DeploymentError("MissingGitHubSecrets")
    from tencentcloud.common import credential
    from tencentcloud.common.profile.client_profile import ClientProfile
    from tencentcloud.common.profile.http_profile import HttpProfile
    from tencentcloud.scf.v20180416 import scf_client

    profile = ClientProfile()
    profile.httpProfile = HttpProfile()
    profile.httpProfile.reqTimeout = 30
    return scf_client.ScfClient(
        credential.Credential(secret_id, secret_key), "ap-hongkong", profile
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    args = parser.parse_args()
    enabled = os.environ.get("SCF_DEPLOY_ENABLED", "false") == "true"
    client = make_client()
    try:
        updated = deploy(client, args.package, enabled=enabled)
    except Exception:
        summary("- deployment: `failed`，请根据安全日志确认失败阶段；未确认成功。")
        raise
    if updated:
        summary(
            "- code update: `succeeded`\n- HTTP health: `passed`\n- 网易云会话有效性需另行验证。"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DeploymentError as error:
        emit("error", {"code": str(error)})
        raise SystemExit(1) from None
    except Exception as error:
        emit("error", {"code": error_code(error)})
        raise SystemExit(1) from None
