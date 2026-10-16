import base64
import hashlib
import io
import json
import os
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch

import scripts.deploy_scf as deploy
import scripts.package_scf as package_scf
import scripts.smoke_scf as smoke_scf


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def call(self, _client, action, payload):
        self.calls.append((action, payload))
        response = self.responses[action]
        return response() if callable(response) else response


def valid_responses(hash_value="0" * 64):
    return {
        "GetFunction": {
            "FunctionName": "MusicAPI",
            "Namespace": "default",
            "Type": "HTTP",
            "Runtime": "Nodejs24.11",
            "Status": "Active",
            "Environment": {"Variables": [{"Key": "MUSIC_U", "Value": "present"}]},
            "CfsConfig": {"CfsInsList": [{"LocalMountDir": "/mnt/"}]},
        },
        "GetAlias": {
            "Name": "$DEFAULT",
            "FunctionVersion": "$LATEST",
            "RoutingConfig": {
                "AdditionalVersionWeights": [],
                "AddtionVersionMatchs": [],
            },
        },
        "GetFunctionAddress": {
            "CodeSha256": hash_value,
            "Url": "https://signed.example/?secret=DO-NOT-LOG",
        },
        "ListTriggers": {
            "Triggers": [
                {
                    "Type": "http",
                    "Qualifier": "$DEFAULT",
                    "Enable": 1,
                    "TriggerDesc": json.dumps(
                        {
                            "nested": [
                                {"url": "https://abc.tencentscf.com/?secret=DO-NOT-LOG"}
                            ]
                        }
                    ),
                }
            ]
        },
    }


class DeploymentTests(unittest.TestCase):
    def test_migration_and_health_are_required_without_mutation(self):
        for values in (
            {"SCF_CONFIG_MIGRATED": "false"},
            {"SCF_HEALTH_URL": ""},
            {
                "SCF_HEALTH_URL": "https://other.tencentscf.com/",
                "SCF_HEALTH_TRUSTED_ORIGIN": "https://other.tencentscf.com",
            },
        ):
            client = FakeClient(valid_responses())
            with patch.dict(os.environ, values):
                with self.assertRaisesRegex(deploy.DeploymentError, "PreflightFailed"):
                    deploy.deploy(client, Path("unused"), client.call, enabled=True)
            self.assertFalse(any(name.startswith("Update") for name, _ in client.calls))

    def test_readonly_summary_lists_failed_conditions(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / "summary"
            with patch.dict(
                os.environ,
                {
                    "SCF_CONFIG_MIGRATED": "false",
                    "SCF_HEALTH_URL": "",
                    "GITHUB_STEP_SUMMARY": str(summary),
                },
            ):
                client = FakeClient(valid_responses())
                self.assertFalse(deploy.deploy(client, Path("unused"), client.call))
            text = summary.read_text()
            self.assertIn("preflight ready: `false`", text)
            self.assertIn("config_migrated", text)
            self.assertIn("health_target", text)
            self.assertIn("skipped", text)

    def test_missing_trigger_url_cannot_be_overridden_by_custom_domain(self):
        responses = valid_responses()
        responses["ListTriggers"]["Triggers"][0]["TriggerDesc"] = '{"unknown": []}'
        client = FakeClient(responses)
        with patch.dict(
            os.environ,
            {
                "SCF_HEALTH_URL": "https://custom.example/",
                "SCF_HEALTH_TRUSTED_ORIGIN": "https://custom.example",
            },
        ):
            result = deploy.preflight(client, client.call)
        self.assertFalse(result["checks"]["trigger_url_discovered"])
        self.assertFalse(result["ready"])

    def test_uppercase_hex_hash_is_normalized(self):
        client = FakeClient(valid_responses("AB" * 32))
        self.assertEqual(deploy.code_hash(client, client.call), "ab" * 32)
        deploy.wait_for_code(client, {"ab" * 32}, client.call)

    def test_health_retries_transient_failures_only_with_deadline(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = deploy.EXPECTED_HEALTH_TEXT.encode()
        opener = MagicMock()
        opener.open.side_effect = [
            deploy.URLError("synthetic"),
            deploy.HTTPError("hidden", 503, "hidden", {}, None),
            response,
        ]
        with (
            patch.object(deploy, "build_opener", return_value=opener),
            patch.object(deploy.time, "sleep"),
        ):
            deploy.health_check(
                "https://abc.tencentscf.com/", origins={"https://abc.tencentscf.com"}
            )
        self.assertEqual(opener.open.call_count, 3)
        opener.open.side_effect = deploy.URLError("synthetic")
        with (
            patch.object(deploy, "build_opener", return_value=opener),
            patch.object(deploy.time, "sleep"),
            patch.object(deploy.time, "monotonic", side_effect=[0, 0, 0, 91, 91]),
        ):
            with self.assertRaisesRegex(deploy.DeploymentError, "HealthCheckTimeout"):
                deploy.health_check(
                    "https://abc.tencentscf.com/",
                    origins={"https://abc.tencentscf.com"},
                )

    def test_smoke_extraction_rejects_traversal_and_symlinks(self):
        for name, mode in (
            ("../outside", 0o100644),
            ("dist/link.js", 0o120777),
            ("/absolute", 0o100644),
        ):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "fixture.zip"
                with zipfile.ZipFile(archive, "w") as bundle:
                    info = zipfile.ZipInfo(name)
                    info.external_attr = mode << 16
                    bundle.writestr(info, "synthetic")
                with self.assertRaisesRegex(ValueError, "UnsafeSmokeArchive"):
                    smoke_scf.extract_package(archive, root / "output")

    def setUp(self):
        env = patch.dict(
            os.environ,
            {
                "SCF_CONFIG_MIGRATED": "true",
                "SCF_HEALTH_URL": "https://abc.tencentscf.com/",
                "SCF_HEALTH_TRUSTED_ORIGIN": "",
                "GITHUB_STEP_SUMMARY": "",
            },
        )
        env.start()
        self.addCleanup(env.stop)

    def test_health_redirect_and_wrong_body_fail(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = b"wrong body"
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(deploy, "build_opener", return_value=opener) as factory:
            with self.assertRaisesRegex(deploy.DeploymentError, "HealthCheckFailed"):
                deploy.health_check(
                    "https://abc.tencentscf.com/",
                    origins={"https://abc.tencentscf.com"},
                )
            handler = factory.call_args.args[0]
            with self.assertRaisesRegex(deploy.DeploymentError, "HealthCheckRedirect"):
                handler.redirect_request(None)

    def test_health_failure_after_update_never_emits_success(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bundle.zip"
            archive.write_bytes(b"zip")
            responses = valid_responses(hashlib.sha256(b"zip").hexdigest())
            responses["UpdateFunctionCode"] = {}
            client = FakeClient(responses)
            output = io.StringIO()
            with (
                patch.dict(
                    os.environ, {"SCF_HEALTH_URL": "https://abc.tencentscf.com/"}
                ),
                patch.object(
                    deploy,
                    "health_check",
                    side_effect=deploy.DeploymentError("HealthCheckFailed"),
                ),
                redirect_stdout(output),
            ):
                with self.assertRaises(deploy.DeploymentError):
                    deploy.deploy(client, archive, client.call, enabled=True)
            self.assertNotIn('"status": "succeeded"', output.getvalue())

    def test_real_api_shapes_and_signed_url_redaction(self):
        client = FakeClient(valid_responses())
        output = io.StringIO()
        with redirect_stdout(output):
            result = deploy.preflight(client, client.call)
        self.assertTrue(result["ready"])
        self.assertEqual(result["old_code_sha256"], "0" * 64)
        self.assertNotIn("DO-NOT-LOG", output.getvalue())
        self.assertNotIn("signed.example", output.getvalue())

    def test_routing_unknown_nonempty_and_trigger_mismatches_rejected(self):
        for routing in (
            {"AdditionalVersionWeights": [{"Version": "1", "Weight": 0.1}]},
            {"AddtionVersionMatchs": [{}]},
            {"Unknown": []},
            {"AdditionalVersionWeights": None},
            [],
        ):
            with self.subTest(routing=routing):
                responses = valid_responses()
                responses["GetAlias"]["RoutingConfig"] = routing
                client = FakeClient(responses)
                self.assertFalse(deploy.preflight(client, client.call)["ready"])
        for changes in (
            {"Type": "HTTP"},
            {"Enable": "TRUE"},
            {"Enable": 0},
            {"Qualifier": "$LATEST"},
        ):
            responses = valid_responses()
            responses["ListTriggers"]["Triggers"][0].update(changes)
            client = FakeClient(responses)
            self.assertFalse(deploy.preflight(client, client.call)["ready"])

    def test_wait_requires_address_hash_and_active_status(self):
        responses = valid_responses()
        configs = iter(
            [{"Status": "Updating"}, {"Status": "Active"}, {"Status": "Active"}]
        )
        hashes = iter(["1" * 64, "0" * 64, "1" * 64])
        responses["GetFunction"] = lambda: next(configs)
        responses["GetFunctionAddress"] = lambda: {
            "CodeSha256": next(hashes),
            "Url": "secret",
        }
        client = FakeClient(responses)
        with patch.object(deploy.time, "sleep"):
            deploy.wait_for_code(client, {"1" * 64}, client.call)
        self.assertEqual(len(client.calls), 6)

    def test_wait_timeout_and_read_retries_are_bounded(self):
        client = FakeClient(valid_responses())
        with (
            patch.object(deploy.time, "monotonic", side_effect=[0, 0, 2, 2]),
            patch.object(deploy.time, "sleep"),
        ):
            with self.assertRaisesRegex(deploy.DeploymentError, "ReadinessTimeout"):
                deploy.wait_for_code(client, {"1" * 64}, client.call, timeout=1)
        with (
            patch.object(deploy.time, "sleep"),
            patch.object(deploy, "api", side_effect=RuntimeError("secret")) as api,
        ):
            with self.assertRaises(RuntimeError):
                deploy.read_api(None, "GetFunction", {}, client.call)
            self.assertEqual(api.call_count, 3)

    def test_wait_tolerates_pending_code_address_after_update(self):
        class PendingAddress(Exception):
            def get_code(self):
                return "FailedOperation.GetFunctionAddress"

        responses = valid_responses()
        attempts = 0

        def address():
            nonlocal attempts
            attempts += 1
            if attempts <= 3:
                raise PendingAddress("must-not-log-signed-url")
            return {"CodeSha256": "1" * 64}

        responses["GetFunctionAddress"] = address
        client = FakeClient(responses)
        output = io.StringIO()
        with patch.object(deploy.time, "sleep"), redirect_stdout(output):
            deploy.wait_for_code(client, {"1" * 64}, client.call)
        self.assertEqual(attempts, 4)
        self.assertNotIn("must-not-log", output.getvalue())
        self.assertNotIn("UpdateFunctionCode", [name for name, _ in client.calls])

    def test_bad_health_and_oversize_prevent_update(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bundle.zip"
            archive.write_bytes(b"x")
            for url in (
                "https://user:password@abc.tencentscf.com/",
                "https://abc.tencentscf.com/music",
                "https://abc.tencentscf.com/?token=x",
            ):
                client = FakeClient(valid_responses())
                with patch.dict(os.environ, {"SCF_HEALTH_URL": url}):
                    with self.assertRaises(deploy.DeploymentError):
                        deploy.deploy(client, archive, client.call, enabled=True)
                self.assertNotIn(
                    "UpdateFunctionCode", [name for name, _ in client.calls]
                )
            archive.write_bytes(b"x" * (deploy.MAX_ARCHIVE_BYTES + 1))
            client = FakeClient(valid_responses())
            with patch.dict(
                os.environ, {"SCF_HEALTH_URL": "https://abc.tencentscf.com/"}
            ):
                with self.assertRaisesRegex(deploy.DeploymentError, "PackageSizeLimit"):
                    deploy.deploy(client, archive, client.call, enabled=True)
            self.assertNotIn("UpdateFunctionCode", [name for name, _ in client.calls])

    def test_update_failure_is_not_retried(self):
        def fail():
            raise RuntimeError("secret response")

        responses = valid_responses()
        responses["UpdateFunctionCode"] = fail
        client = FakeClient(responses)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"SCF_HEALTH_URL": "https://abc.tencentscf.com/"}),
        ):
            archive = Path(directory) / "bundle.zip"
            archive.write_bytes(b"zip")
            with self.assertRaises(RuntimeError):
                deploy.deploy(client, archive, client.call, enabled=True)
        self.assertEqual(
            [name for name, _ in client.calls].count("UpdateFunctionCode"), 1
        )

    def test_dist_secrets_and_symlinks_rejected(self):
        for name in ("nested/.env", "nested/data/token.js", "nested/credential.json"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("synthetic-secret")
                with self.assertRaises(ValueError):
                    package_scf.validate_tree(root, compiled=True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.js").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "PackageSymlinkRejected"):
                package_scf.validate_tree(root, compiled=True)
            with self.assertRaisesRegex(ValueError, "PackageSymlinkRejected"):
                package_scf.validate_tree(root)

    def test_preflight_rejects_missing_cloud_music_u(self):
        responses = valid_responses()
        responses["GetFunction"]["Environment"]["Variables"] = []
        client = FakeClient(responses)
        self.assertFalse(deploy.preflight(client, client.call)["ready"])

    def test_preflight_rejects_alias_routing_and_never_writes_config(self):
        responses = valid_responses()
        responses["GetAlias"]["RoutingConfig"] = {"1": 0.2}
        client = FakeClient(responses)
        self.assertFalse(deploy.preflight(client, client.call)["ready"])
        self.assertFalse(
            any(name == "UpdateFunctionConfiguration" for name, _ in client.calls)
        )

    def test_enabled_gate_rejects_unready_preflight_before_update(self):
        responses = valid_responses()
        responses["GetFunction"]["Environment"]["Variables"] = []
        client = FakeClient(responses)
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bundle.zip"
            archive.write_bytes(b"zip-content")
            with self.assertRaises(deploy.DeploymentError):
                deploy.deploy(client, archive, client.call, enabled=True)
        self.assertFalse(any(name == "UpdateFunctionCode" for name, _ in client.calls))

    def test_disabled_gate_runs_only_readonly_preflight(self):
        client = FakeClient(valid_responses())
        self.assertFalse(
            deploy.deploy(
                client, Path("/tmp/does-not-exist"), client.call, enabled=False
            )
        )
        self.assertEqual(
            [name for name, _ in client.calls],
            ["GetFunction", "GetFunctionAddress", "GetAlias", "ListTriggers"],
        )

    def test_update_is_single_call_and_waits_for_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bundle.zip"
            archive.write_bytes(b"zip-content")
            expected = base64.b64encode(
                hashlib.sha256(archive.read_bytes()).digest()
            ).decode()
            responses = valid_responses(expected)
            responses["UpdateFunctionCode"] = {"FunctionVersion": "$LATEST"}
            client = FakeClient(responses)
            with (
                patch.object(deploy.time, "sleep"),
                patch.object(deploy, "health_check") as health,
            ):
                self.assertTrue(
                    deploy.deploy(client, archive, client.call, enabled=True)
                )
            health.assert_called_once()
            names = [name for name, _ in client.calls]
            self.assertEqual(names.count("UpdateFunctionCode"), 1)
            self.assertNotIn("UpdateFunctionConfiguration", names)
            update_payload = next(
                payload
                for name, payload in client.calls
                if name == "UpdateFunctionCode"
            )
            self.assertEqual(update_payload["InstallDependency"], "FALSE")
            self.assertEqual(update_payload["Publish"], "FALSE")

    def test_error_code_does_not_expose_error_text(self):
        error = RuntimeError("MUSIC_U=secret-value")
        self.assertEqual(deploy.error_code(error), "RuntimeError")
        self.assertNotIn("secret-value", deploy.error_code(error))

    def test_package_staging_excludes_credentials_and_bootstrap_is_executable(self):
        with tempfile.TemporaryDirectory(dir="/tmp/opencode") as directory:
            root = Path(directory)
            (root / "dist").mkdir()
            (root / "dist/index.js").write_text("console.log('ok')", encoding="utf-8")
            (root / "package.json").write_text(
                '{"name":"fixture","dependencies":{}}', encoding="utf-8"
            )
            (root / "package-lock.json").write_text("{}", encoding="utf-8")
            (root / "dist/stale.js").write_text("stale", encoding="utf-8")
            (root / "scf_bootstrap").write_text("#!/bin/bash\n", encoding="utf-8")
            os.chmod(root / "scf_bootstrap", 0o755)
            output = root / "out.zip"

            def fake_run(command, **kwargs):
                if command[0] == "node":
                    fresh = Path(command[-1])
                    fresh.mkdir()
                    (fresh / "index.js").write_text("fresh")
                else:
                    (Path(kwargs["cwd"]) / "node_modules").mkdir()

            with patch.object(
                package_scf.subprocess, "run", side_effect=fake_run
            ) as run:
                package_scf.create_package(root, output)
            self.assertEqual(run.call_count, 2)
            with zipfile.ZipFile(output) as archive:
                names = set(archive.namelist())
                self.assertEqual(
                    names, {"dist/index.js", "package.json", "scf_bootstrap"}
                )
                info = archive.getinfo("scf_bootstrap")
                self.assertTrue((info.external_attr >> 16) & stat.S_IXUSR)
                self.assertEqual(archive.read("dist/index.js"), b"fresh")
                self.assertTrue(
                    archive.read("scf_bootstrap").startswith(b"#!/bin/bash\n")
                )
                self.assertFalse(
                    any(
                        name in names
                        for name in [".env", "data/cache", "package-lock.json"]
                    )
                )
            with (
                patch.object(package_scf.subprocess, "run", side_effect=fake_run),
                patch.object(package_scf, "MAX_ARCHIVE_BYTES", 1),
            ):
                with self.assertRaisesRegex(ValueError, "PackageSizeLimit"):
                    package_scf.create_package(root, root / "too-large.zip")
            self.assertFalse((root / "too-large.zip").exists())

    def test_health_url_rejects_redirectable_or_untrusted_origin(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.validate_health_url("http://example.test/")
        with self.assertRaises(deploy.DeploymentError):
            deploy.validate_health_url("https://example.test/")
        self.assertEqual(
            deploy.validate_health_url(
                "https://internal.example/",
                "https://internal.example",
                {"https://abc.tencentscf.com"},
            ),
            "https://internal.example/",
        )


if __name__ == "__main__":
    unittest.main()
