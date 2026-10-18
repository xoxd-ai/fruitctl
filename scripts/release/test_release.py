#!/usr/bin/env python3
"""Exercise actual archive validation against safe and malicious release structures."""
import argparse
import hashlib
import copy
import json
import subprocess
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import shutil
import shlex
import stat
import sys
import zipfile
import unittest
import warnings
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_verifier", ROOT / "scripts/verify-release.py")
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)
apple_spec = importlib.util.spec_from_file_location("apple_distribution", ROOT / "scripts/release/apple_distribution.py")
apple = importlib.util.module_from_spec(apple_spec); apple_spec.loader.exec_module(apple)
native_spec = importlib.util.spec_from_file_location("native_release", ROOT / "scripts/release/native_release.py")
native = importlib.util.module_from_spec(native_spec); native_spec.loader.exec_module(native)
source_spec = importlib.util.spec_from_file_location("source_packager", ROOT / "scripts/release/package_source.py")
source = importlib.util.module_from_spec(source_spec); source_spec.loader.exec_module(source)
runtime_spec = importlib.util.spec_from_file_location("runtime_inputs", ROOT / "scripts/release/runtime_inputs.py")
runtime = importlib.util.module_from_spec(runtime_spec); runtime_spec.loader.exec_module(runtime)
notice_spec = importlib.util.spec_from_file_location("notice_producer", ROOT / "LICENSES/refresh-npm-notices.py")
notice_producer = importlib.util.module_from_spec(notice_spec); notice_spec.loader.exec_module(notice_producer)
stage_spec = importlib.util.spec_from_file_location("runtime_stage", ROOT / "scripts/release/prepare_runtime.py")
runtime_stage = importlib.util.module_from_spec(stage_spec); stage_spec.loader.exec_module(runtime_stage)


class RuntimeSourceSelectionTests(unittest.TestCase):
    def setUp(self):
        self.maxDiff = None
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name).resolve()
        self.root = self.base / "checkout"; self.root.mkdir()
        self.stage = self.base / "stage"; self.stage.mkdir()
        self.files = {
            "package.json": b'{"name":"fixture"}\n', "package-lock.json": b'{"packages":{}}\n',
            "index.js": b"// entry fixture\n", "LICENSE": b"MIT license fixture\n",
            "THIRD_PARTY_NOTICES.md": b"tracked notice fixture\n",
            "bin/fruitctl.mjs": b"#!/usr/bin/env node\n// executable fixture\n",
            "lib/nested/module.py": b"# tracked authored fixture\n",
            "tools/helper.mjs": b"// helper fixture\n",
            "integrations/fixture/settings.json": b"{}\n",
            "skills/fixture/SKILL.md": b"skill fixture\n",
            "LICENSES/npm/fixture@1.0.0/LICENSE": b"retained dependency license\n",
            "LICENSES/ordinary.data": b"\x00ordinary tracked bytes\xff",
        }
        for name, data in self.files.items():
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        (self.root / "bin/fruitctl.mjs").chmod(0o755)
        (self.root / ".gitignore").write_text("__pycache__/\n*.pyc\n*.ignored\n")
        (self.root / "README.md").write_text("tracked outside curated runtime roots\n")
        self.git("init", "--quiet")
        self.git("add", "--all")
        self.git("commit", "--quiet", "--message", "Committed public source fixtures")

    def git(self, *args):
        # These settings affect only this owned temporary fixture command;
        # no production Git hooks, signing config or repository are changed.
        # A commit otherwise spawns a detached `git maintenance run --auto`
        # that can still be writing .git/objects when the temporary
        # directory is removed (ENOTEMPTY in cleanup).
        return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                                        "-c", "maintenance.auto=false", "-c", "gc.auto=0",
                                        "-c", "user.name=Runtime Source Fixture", "-c", "user.email=fixture@example.invalid",
                                        *args], cwd=self.root, stderr=subprocess.STDOUT)

    def test_stage_contains_only_committed_curated_files_with_hashes_and_modes(self):
        extras = {"LICENSES/__pycache__/refresh-npm-notices.cpython-313.pyc": b"ignored bytecode fixture",
                  "LICENSES/local.ignored": b"ignored ordinary artifact",
                  "lib/untracked.pyc": b"untracked bytecode", "tools/local-junk.mjs": b"untracked code"}
        for name, data in extras.items():
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        result = runtime_stage.stage_authored_source(self.root, self.stage)
        self.assertEqual(result, {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()})
        self.assertEqual({path.relative_to(self.stage).as_posix() for path in self.stage.rglob("*") if path.is_file()},
                         set(self.files))
        for name, data in self.files.items():
            self.assertEqual((self.stage / name).read_bytes(), data)
            self.assertEqual((self.stage / name).stat().st_mode & 0o777, 0o755 if name.startswith("bin/") else 0o644)

    def test_tracked_file_symlink_is_refused_before_copy(self):
        source = self.root / "LICENSE"; source.unlink(); source.symlink_to(self.root / "THIRD_PARTY_NOTICES.md")
        with self.assertRaisesRegex(ValueError, "source symlinks are refused"):
            runtime_stage.stage_authored_source(self.root, self.stage)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_tracked_parent_symlink_is_refused_before_copy(self):
        parent = self.root / "lib/nested"; shutil.rmtree(parent)
        external = self.base / "outside"; external.mkdir(); (external / "module.py").write_text("outside fixture\n")
        parent.symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "source symlinks are refused"):
            runtime_stage.stage_authored_source(self.root, self.stage)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_modified_tracked_source_is_not_attributed_to_head(self):
        (self.root / "lib/nested/module.py").write_text("changed after source commit\n")
        with self.assertRaisesRegex(ValueError, "authored source must match Git HEAD"):
            runtime_stage.stage_authored_source(self.root, self.stage)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_index_only_curated_addition_is_not_attributed_to_head(self):
        (self.root / "lib/index-only.mjs").write_text("// staged after source commit\n")
        self.git("add", "--", "lib/index-only.mjs")
        with self.assertRaisesRegex(ValueError, "authored source must match Git HEAD"):
            runtime_stage.stage_authored_source(self.root, self.stage)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_noncurated_worktree_edits_do_not_change_authored_source(self):
        (self.root / "README.md").write_text("not a runtime authored input\n")
        result = runtime_stage.stage_authored_source(self.root, self.stage)
        self.assertEqual(result, {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()})

    def test_head_change_during_copy_is_refused(self):
        copyfile = runtime_stage.shutil.copyfile
        changed = False
        def advance_head(source_path, target_path):
            nonlocal changed
            result = copyfile(source_path, target_path)
            if not changed:
                changed = True
                (self.root / "README.md").write_text("new source revision during stage\n")
                self.git("add", "--", "README.md")
                self.git("commit", "--quiet", "--message", "Advance owned source fixture during copying")
            return result
        with patch.object(runtime_stage.shutil, "copyfile", advance_head):
            with self.assertRaisesRegex(ValueError, "source revision changed during staging"):
                runtime_stage.stage_authored_source(self.root, self.stage)

    def test_worktree_mutation_during_hash_is_not_attributed_to_head(self):
        file_sha = runtime_stage.inputs.file_sha
        changed = False
        def mutate_before_hash(path):
            nonlocal changed
            if path == self.root / "LICENSE" and not changed:
                changed = True
                path.write_text("changed after cleanliness check without a new commit\n")
            return file_sha(path)
        with patch.object(runtime_stage.inputs, "file_sha", mutate_before_hash):
            with self.assertRaisesRegex(ValueError, "authored source must match Git HEAD"):
                runtime_stage.stage_authored_source(self.root, self.stage)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_source_mutation_during_copy_is_refused_by_committed_hash(self):
        copyfile = runtime_stage.shutil.copyfile
        changed = False
        def mutate_before_copy(source_path, target_path):
            nonlocal changed
            if source_path == self.root / "LICENSE" and not changed:
                changed = True
                source_path.write_text("changed after source hash before copy\n")
            return copyfile(source_path, target_path)
        with patch.object(runtime_stage.shutil, "copyfile", mutate_before_copy):
            with self.assertRaisesRegex(ValueError, "authored source changed during copying"):
                runtime_stage.stage_authored_source(self.root, self.stage)


class NpmInventoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "LICENSES").mkdir()
        self.entries = {
            "node_modules/runtime-fixture": {"version": "1.0.0", "resolved": "https://example.invalid/runtime.tgz",
                                             "integrity": "sha512-runtime-fixture", "license": "MIT"},
            "node_modules/dev-fixture": {"version": "2.0.0", "resolved": "https://example.invalid/dev.tgz",
                                         "integrity": "sha512-dev-fixture", "license": "MIT", "dev": True},
        }
        self.digest = runtime.sha(json.dumps(self.entries, sort_keys=True, separators=(",", ":")).encode())
        self.packages = [self.notice((name, value)) for name, value in self.entries.items()]
        self.inventory = {"dependency_entries_sha256": self.digest, "package_count": len(self.entries),
                          "packages": self.packages}
        self.provenance = {
            "components": [{"name": "preserved-native-fixture", "revision": "unchanged"}],
            "legacy_prebuilt_libvncclient": {"source_correspondence": "unestablished"},
            "npm_inventory": {"path": "LICENSES/npm-dependencies.json", "source": "package-lock.json",
                              "dependency_entries_sha256": self.digest, "package_count": 2,
                              "runtime_package_count": 1, "development_package_count": 1},
        }
        self.write("package-lock.json", {"packages": {"": {"name": "fixture"}, **self.entries}})
        self.write("LICENSES/npm-dependencies.json", self.inventory)
        self.write("LICENSES/dependency-provenance.json", self.provenance)

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    @staticmethod
    def notice(entry):
        name, package = entry
        return {"lock_path": name, "name": name.removeprefix("node_modules/"), "version": package["version"],
                "scope": "development" if package.get("dev", False) else "runtime",
                "license_expression": package["license"], "source_archive_url": package["resolved"],
                "source_archive_integrity": package["integrity"], "notices": []}

    def test_matching_inventory_returns_only_production_inputs(self):
        packages, digest = runtime.locked_dependencies(self.root)
        self.assertEqual(set(packages), {"node_modules/runtime-fixture"})
        self.assertEqual(digest, self.digest)

    def test_repository_inventory_matches_actual_lock_and_exact_sdk_dependency(self):
        lock = json.loads((ROOT / "package-lock.json").read_text())
        entries = {name: value for name, value in lock["packages"].items() if name}
        packages, digest = runtime.locked_dependencies(ROOT)
        self.assertEqual(set(packages), {name for name, value in entries.items() if not value.get("dev", False)})
        self.assertEqual(digest, runtime.sha(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()))
        manifest = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(packages["node_modules/@modelcontextprotocol/sdk"]["version"],
                         manifest["dependencies"]["@modelcontextprotocol/sdk"])

    def test_stale_provenance_digest_counts_and_identity_are_refused(self):
        mutations = {"dependency_entries_sha256": "0" * 64, "package_count": 3,
                     "runtime_package_count": 2, "development_package_count": 0,
                     "path": "LICENSES/other.json", "source": "other-lock.json"}
        for key, value in mutations.items():
            with self.subTest(key=key):
                changed = copy.deepcopy(self.provenance)
                changed["npm_inventory"][key] = value
                self.write("LICENSES/dependency-provenance.json", changed)
                with self.assertRaisesRegex(ValueError, "npm provenance inventory differs"):
                    runtime.locked_dependencies(self.root)

    def test_wrong_declared_inventory_count_is_refused(self):
        changed = copy.deepcopy(self.inventory); changed["package_count"] = 3
        self.write("LICENSES/npm-dependencies.json", changed)
        with self.assertRaisesRegex(ValueError, "npm notice inventory package count differs"):
            runtime.locked_dependencies(self.root)

    def test_duplicate_inventory_record_is_refused_without_losing_coverage(self):
        changed = copy.deepcopy(self.inventory); changed["packages"].append(copy.deepcopy(self.packages[0]))
        self.write("LICENSES/npm-dependencies.json", changed)
        with self.assertRaisesRegex(ValueError, "duplicate npm notice inventory lock paths"):
            runtime.locked_dependencies(self.root)

    def test_producer_refreshes_provenance_and_preserves_other_components(self):
        # Change a runtime input while both old receipts are still consistent
        # with each other. The producer must refresh both for the new lock.
        changed = copy.deepcopy(self.entries)
        changed["node_modules/runtime-fixture"]["version"] = "1.1.0"
        changed["node_modules/second-runtime-fixture"] = {
            "version": "3.0.0", "resolved": "https://example.invalid/second-runtime.tgz",
            "integrity": "sha512-second-runtime-fixture", "license": "MIT",
        }
        self.write("package-lock.json", {"packages": {"": {"name": "fixture"}, **changed}})
        with self.assertRaisesRegex(ValueError, "npm notice inventory differs"):
            runtime.locked_dependencies(self.root)
        with patch.object(notice_producer, "ROOT", self.root), patch.object(notice_producer, "fetch_notices", self.notice):
            notice_producer.main()
        packages, digest = runtime.locked_dependencies(self.root)
        self.assertEqual(packages["node_modules/runtime-fixture"]["version"], "1.1.0")
        self.assertEqual(set(packages), {"node_modules/runtime-fixture", "node_modules/second-runtime-fixture"})
        self.assertNotEqual(digest, self.digest)
        refreshed = json.loads((self.root / "LICENSES/dependency-provenance.json").read_text())
        self.assertEqual({key: value for key, value in refreshed.items() if key != "npm_inventory"},
                         {key: value for key, value in self.provenance.items() if key != "npm_inventory"})
        self.assertEqual((refreshed["npm_inventory"]["package_count"],
                          refreshed["npm_inventory"]["runtime_package_count"],
                          refreshed["npm_inventory"]["development_package_count"]), (3, 2, 1))


class NativeBuildPrivacyTests(unittest.TestCase):
    def configured(self):
        return {"dependencyBuildConfiguration": source.builder.dependency_build_configuration(),
                "dependencyBuildConfigurationSha256": source.builder.dependency_configuration_sha256()}

    def test_compiled_configuration_literals_are_rejected_without_debug_symbols(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "controller"
            # Ten ordinary runtime string constants, rather than DWARF data.
            path.write_bytes(b"\xcf\xfa\xed\xfe" + b"\x00".join(
                b"/Users/build-user/private-stage/ssl/default" + str(index).encode() for index in range(10)))
            with self.assertRaisesRegex(ValueError, "private workspace paths"):
                source.builder.verify_public_native_binary(path)

    def test_private_debug_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "host"
            for value in (b"/Users/build-user/source.swift", b"/home/build-user/source.swift", b"fruitctl-builds/source.swift"):
                with self.subTest(value=value):
                    path.write_bytes(b"fixture debug symbols\x00" + value)
                    with self.assertRaisesRegex(ValueError, "private workspace paths"):
                        source.builder.verify_public_native_binary(path)

    def test_public_config_defaults_are_admitted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "controller"
            path.write_bytes(b"/opt/fruitctl/ssl\x00/opt/fruitctl/lib/ossl-modules\x00/fruitctl/source/Input.swift")
            value = source.builder.verify_public_native_binary(path)
            self.assertTrue(value["privateWorkspacePathsAbsent"])
            self.assertEqual(value["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_empty_native_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "controller"; path.write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "empty"):
                source.builder.verify_public_native_binary(path)

    def test_symlink_native_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "controller"; path.write_bytes(b"public bytes")
            alias = Path(directory).resolve() / "alias"; alias.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "canonical regular"):
                source.builder.verify_public_native_binary(alias)

    def test_old_source_only_cache_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "public dependency build configuration"):
            source.builder.verify_reusable_dependency_configuration({"sourceLockSha256": "a" * 64}, {})

    def test_changed_manifest_configuration_is_rejected(self):
        built, manifest = self.configured(), self.configured()
        manifest["dependencyBuildConfiguration"]["openssl"]["prefix"] = "/private/staging"
        with self.assertRaisesRegex(ValueError, "public dependency build configuration"):
            source.builder.verify_reusable_dependency_configuration(built, manifest)

    def test_changed_build_receipt_configuration_hash_is_rejected(self):
        built = self.configured(); built["dependencyBuildConfigurationSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "public dependency build configuration"):
            source.builder.verify_reusable_dependency_configuration(built, self.configured())

    def test_matching_public_cache_ignores_executable_strip_policy(self):
        built = self.configured(); built["nativeArtifactPolicy"] = {"stripDebugArguments": ["-S", "-x"]}
        source.builder.verify_reusable_dependency_configuration(built, self.configured())

    def test_reused_inputs_from_another_source_lock_are_rejected(self):
        current = {"sourceLockSha256": source.builder.digest(source.builder.LOCK)}
        source.builder.verify_reusable_source_lock(current, dict(current))
        for receipt, manifest in ((current, {"sourceLockSha256": "a" * 64}), ({"sourceLockSha256": "a" * 64}, current), ({}, current)):
            with self.subTest(receipt=receipt, manifest=manifest):
                with self.assertRaisesRegex(ValueError, "different source lock"):
                    source.builder.verify_reusable_source_lock(receipt, manifest)

    def test_jobs_scale_to_host_cores_but_stay_bounded(self):
        limit = max(2, os.cpu_count() or 1)
        for value in ("1", "2", str(limit)):
            self.assertEqual(source.builder.job_count(value), int(value))
        for value in ("0", "-1", str(limit + 1), "two"):
            with self.subTest(value=value):
                with self.assertRaises(argparse.ArgumentTypeError):
                    source.builder.job_count(value)

    def test_generated_and_historical_native_manifest_use_actual_json_schema(self):
        schema = json.loads((ROOT / "release/native-input-manifest.schema.json").read_text())
        historical = {"schemaVersion": 1, "kind": "fruitctl-native-inputs", "platform": "darwin",
                      "architecture": "arm64", "minimumMacOS": "15.0", "sourceLockSha256": "a" * 64,
                      "files": {"include/file" + str(index): {"sha256": "b" * 64, "bytes": 1} for index in range(7)}}
        generated = {**historical, **self.configured()}
        fixtures = [{"name": "historical-v1", "value": historical, "expected": True},
                    {"name": "generated-public-configuration", "value": generated, "expected": True}]
        mutations = [("lone-config", {**historical, "dependencyBuildConfiguration": self.configured()["dependencyBuildConfiguration"]}),
                     ("lone-hash", {**historical, "dependencyBuildConfigurationSha256": "a" * 64}),
                     ("malformed-hash", {**generated, "dependencyBuildConfigurationSha256": "not-a-sha256"}),
                     ("extra-top-field", {**generated, "unsupported": True})]
        changed = copy.deepcopy(generated); changed["dependencyBuildConfiguration"]["openssl"]["openssldir"] = "/private/config"
        mutations.append(("changed-config-default", changed))
        changed = copy.deepcopy(generated); changed["dependencyBuildConfiguration"]["version"] = "1"
        mutations.append(("wrong-config-type", changed))
        changed = copy.deepcopy(generated); changed["dependencyBuildConfiguration"]["unsupported"] = True
        mutations.append(("extra-config-field", changed))
        fixtures.extend({"name": name, "value": value, "expected": False} for name, value in mutations)
        # AJV is an existing pinned SDK dependency, not a new host package.
        script = """const fs = require('node:fs');
const Ajv = require('ajv/dist/2020.js').default;
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const validate = new Ajv({strict:true,allErrors:true}).compile(input.schema);
for (const fixture of input.fixtures) {
  if (validate(fixture.value) !== fixture.expected) {
    console.error(JSON.stringify({name:fixture.name,errors:validate.errors})); process.exit(1);
  }
}
process.stdout.write(JSON.stringify({fixtures:input.fixtures.length,status:'passed'}));"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT,
                                input=json.dumps({"schema": schema, "fixtures": fixtures}),
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"fixtures": len(fixtures), "status": "passed"})

    def test_openssl_installs_only_inside_destdir_with_path_free_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory).resolve(); calls = []
            def capture(command, cwd, label):
                calls.append((command, cwd, label))
            prefix = source.builder.build_openssl(output / "source", output, capture, 2)
            self.assertEqual(prefix, output / "openssl-stage/opt/fruitctl")
            self.assertTrue(prefix.is_relative_to(output))
            self.assertEqual(len(calls), 3)
            configure = calls[0][0]
            self.assertIn("--prefix=/opt/fruitctl", configure)
            self.assertIn("--openssldir=/opt/fruitctl/ssl", configure)
            self.assertIn("--libdir=lib", configure)
            self.assertFalse(any("prefix-map" in str(value) for value in configure))
            self.assertEqual(calls[1][0], ["make", "-j2", "build_sw"])
            self.assertEqual(calls[2][0], ["make", "DESTDIR=" + str(output / "openssl-stage"), "install_sw"])
            self.assertFalse(prefix.exists())  # capture never wrote the public or staged prefix


class AppleCertificateTests(unittest.TestCase):
    description = "\n".join(("Identifier=com.xoxd.fruitctl.host", "TeamIdentifier=QP994XQKNH",
        "CodeDirectory v=20500 flags=0x10000(runtime)", "Timestamp=Oct 5, 2026",
        "Authority=Developer ID Application: Test (QP994XQKNH)"))
    certificate = b"public leaf certificate fixture"

    def fake_codesign(self, command):
        if any(str(value).startswith("--extract-certificates") for value in command):
            # Model codesign's optional argument parsing: the separate-prefix
            # form selects a nonexistent signed-code path instead of a prefix.
            self.assertEqual(len(command), 4)
            self.assertTrue(str(command[2]).startswith("--extract-certificates="))
            Path(str(command[2]).split("=", 1)[1] + "0").write_bytes(self.certificate)
            return ""
        return self.description if "--display" in command else ""

    def test_signature_leaf_is_extracted_with_explicit_option_value(self):
        expected = hashlib.sha1(self.certificate).hexdigest().upper()
        with patch.object(apple, "run", self.fake_codesign):
            result = apple.metadata(Path("/reviewed/FruitctlHost.app"), "QP994XQKNH", expected)
        self.assertEqual(result["certificateSha1"], expected)

    def test_other_leaf_certificate_is_refused(self):
        with patch.object(apple, "run", self.fake_codesign), self.assertRaisesRegex(ValueError, "leaf certificate"):
            apple.metadata(Path("/reviewed/FruitctlHost.app"), "QP994XQKNH", "0" * 40)


class AppleToolArchiveTests(unittest.TestCase):
    payload = b"signed native executable fixture\x00\xff\n"

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name).resolve()
        signed_dir = self.base / "signed"; signed_dir.mkdir()
        self.binary = signed_dir / "claude-kvm-daemon"
        self.binary.write_bytes(self.payload); self.binary.chmod(0o755)
        self.signed = {"schemaVersion": 1, "status": "passed", "kind": "fruitctl-apple-tool-sign",
                       "appName": self.binary.name, "artifactSha256": hashlib.sha256(self.payload).hexdigest(),
                       "artifactBytes": len(self.payload), "signature": {"teamIdentifier": "FIXTURE"}}
        self.sign_receipt = self.base / "sign.json"
        self.sign_receipt.write_text(json.dumps(self.signed))

    def zip(self, target, entries):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)  # Deliberate duplicate-member fixture.
            with zipfile.ZipFile(target, "w") as archive:
                for name, payload, mode, system in entries:
                    entry = zipfile.ZipInfo(name); entry.create_system = system; entry.external_attr = mode << 16
                    archive.writestr(entry, payload)

    def member(self, name=None, payload=None, mode=stat.S_IFREG | 0o755, system=3):
        return (name or self.binary.name, self.payload if payload is None else payload, mode, system)

    def invoke(self, producer, suffix="fixture", app=None):
        target = self.base / (suffix + ".zip"); receipt = self.base / (suffix + ".json")
        calls = []
        def fake_ditto(command):
            calls.append(command)
            self.assertEqual(command[:3], ["ditto", "-c", "-k"])
            producer(command, Path(command[-1]))
            return ""
        argv = ["apple_distribution.py", "archive", "--app", str(app or self.binary),
                "--sign-receipt", str(self.sign_receipt), "--zip", str(target), "--receipt", str(receipt)]
        with patch.object(sys, "argv", argv), patch.object(apple.platform, "system", return_value="Darwin"), \
                patch.object(apple, "metadata", return_value=self.signed["signature"]) as metadata, \
                patch.object(apple, "run", fake_ditto), patch("builtins.print"):
            apple.main()
        metadata.assert_called_once_with(app or self.binary, "FIXTURE", None)
        return target, receipt, calls

    def modeled_ditto(self, command, target):
        # Model the two independent observed defaults: --keepParent nests a
        # bare file, while omitting --norsrc allows an AppleDouble member.
        name = "signed/" + self.binary.name if "--keepParent" in command else self.binary.name
        entries = [self.member(name)]
        if "--norsrc" not in command:
            entries.append(self.member("__MACOSX/._" + self.binary.name, b"AppleDouble metadata"))
        self.zip(target, entries)

    def test_tool_archive_uses_bare_file_without_resource_metadata_and_binds_real_zip(self):
        original = self.binary.read_bytes()
        target, receipt, calls = self.invoke(self.modeled_ditto)
        self.assertEqual(calls, [["ditto", "-c", "-k", "--norsrc", self.binary, target]])
        with zipfile.ZipFile(target) as archive:
            self.assertEqual(archive.namelist(), [self.binary.name])
            self.assertEqual(archive.read(self.binary.name), original)
        result = json.loads(receipt.read_text())
        self.assertEqual(result["archiveSha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(result["archiveBytes"], target.stat().st_size)
        self.assertEqual(result["signReceiptSha256"], hashlib.sha256(self.sign_receipt.read_bytes()).hexdigest())
        self.assertEqual(self.binary.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(self.binary.stat().st_mode), 0o755)

    def test_app_bundle_sequesters_resource_metadata_and_preserves_signed_payload(self):
        app = self.base / "FruitctlHost.app"
        (app / "Contents").mkdir(parents=True); (app / "Contents/Info.plist").write_bytes(b"app fixture")
        self.signed.update(kind="fruitctl-apple-sign", appName=app.name, files=apple.inventory(app))
        self.sign_receipt.write_text(json.dumps(self.signed))
        # Model the observed macOS ditto default: inline AppleDouble members
        # would become extra signed payload paths; --sequesterRsrc moves them
        # into the ZIP metadata namespace without discarding metadata.
        metadata = b"AppleDouble resource metadata fixture"
        def produce(command, target):
            sidecar = ("__MACOSX/" + app.name + "/Contents/._Info.plist"
                       if "--sequesterRsrc" in command else app.name + "/Contents/._Info.plist")
            self.zip(target, [self.member(app.name + "/Contents/Info.plist", b"app fixture", stat.S_IFREG | 0o644),
                              self.member(sidecar, metadata, stat.S_IFREG | 0o644)])
        original = apple.inventory(app)
        target, receipt, calls = self.invoke(produce, app=app)
        with zipfile.ZipFile(target) as archive:
            signed_payload = {name[len(app.name) + 1:]: {"bytes": len(archive.read(name)),
                               "sha256": hashlib.sha256(archive.read(name)).hexdigest()}
                              for name in archive.namelist() if name.startswith(app.name + "/")}
            self.assertEqual(signed_payload, self.signed["files"])
            self.assertEqual(archive.read("__MACOSX/" + app.name + "/Contents/._Info.plist"), metadata)
        self.assertEqual(apple.inventory(app), original)
        self.assertEqual(calls, [["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, target]])
        result = json.loads(receipt.read_text())
        self.assertEqual(result["archiveSha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(result["signReceiptSha256"], hashlib.sha256(self.sign_receipt.read_bytes()).hexdigest())

    def test_archive_receipt_binds_validated_sign_receipt_despite_producer_replacement(self):
        original = self.sign_receipt.read_bytes()
        replacement = dict(self.signed, artifactSha256=hashlib.sha256(b"different signed executable").hexdigest())
        replacement_data = json.dumps(replacement).encode()
        def replace_during_ditto(command, target):
            self.modeled_ditto(command, target)
            self.sign_receipt.write_bytes(replacement_data)
        target, receipt, calls = self.invoke(replace_during_ditto)
        result = json.loads(receipt.read_text())
        self.assertEqual(self.sign_receipt.read_bytes(), replacement_data)
        self.assertNotEqual(hashlib.sha256(original).hexdigest(), hashlib.sha256(replacement_data).hexdigest())
        self.assertEqual(result["signReceiptSha256"], hashlib.sha256(original).hexdigest())
        self.assertNotEqual(result["signReceiptSha256"], hashlib.sha256(replacement_data).hexdigest())
        with zipfile.ZipFile(target) as archive:
            self.assertEqual(hashlib.sha256(archive.read(self.binary.name)).hexdigest(), json.loads(original)["artifactSha256"])

    def test_tool_archive_refuses_parent_appledouble_duplicate_and_extra_members(self):
        cases = [[self.member("signed/" + self.binary.name)],
                 [self.member(), self.member("__MACOSX/._" + self.binary.name, b"resource")],
                 [self.member(), self.member()], [self.member(), self.member("unexpected", b"extra")],
                 [self.member(), self.member("signed/", b"", stat.S_IFDIR | 0o755)],
                 [self.member("../" + self.binary.name)], [self.member("/" + self.binary.name)]]
        for index, entries in enumerate(cases):
            with self.subTest(entries=[entry[0] for entry in entries]):
                with self.assertRaisesRegex(ValueError, "only the bare signed filename"):
                    self.invoke(lambda command, target: self.zip(target, entries), suffix="members" + str(index))
                self.assertFalse((self.base / ("members" + str(index) + ".json")).exists())

    def test_tool_archive_refuses_same_length_payload_substitution(self):
        replacement = b"x" * len(self.payload)
        with self.assertRaisesRegex(ValueError, "payload bytes"):
            self.invoke(lambda command, target: self.zip(target, [self.member(payload=replacement)]))
        self.assertFalse((self.base / "fixture.json").exists())

    def test_tool_archive_refuses_payload_length_substitution(self):
        with self.assertRaisesRegex(ValueError, "payload size"):
            self.invoke(lambda command, target: self.zip(target, [self.member(payload=self.payload + b"extra")]))
        self.assertFalse((self.base / "fixture.json").exists())

    def test_tool_archive_refuses_nonregular_or_changed_executable_modes(self):
        for index, (mode, system) in enumerate([(stat.S_IFLNK | 0o755, 3), (stat.S_IFDIR | 0o755, 3), (0o755, 3),
                (stat.S_IFREG | 0o644, 3), (stat.S_IFREG | 0o775, 3), (stat.S_IFREG | 0o4755, 3), (stat.S_IFREG | 0o755, 0)]):
            with self.subTest(mode=oct(mode), system=system):
                with self.assertRaisesRegex(ValueError, "regular executable mode0755"):
                    self.invoke(lambda command, target: self.zip(target, [self.member(mode=mode, system=system)]), suffix="mode" + str(index))
                self.assertFalse((self.base / ("mode" + str(index) + ".json")).exists())

    def test_tool_archive_refuses_unreadable_zip_or_corrupt_payload(self):
        def corrupt(command, target):
            self.zip(target, [self.member()])
            data = bytearray(target.read_bytes())
            data[30 + len(self.binary.name.encode())] ^= 1  # Stored payload now fails its ZIP CRC.
            target.write_bytes(data)
        for name, producer in [("notzip", lambda command, target: target.write_bytes(b"not a ZIP")), ("badcrc", corrupt)]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "not a readable ZIP"):
                self.invoke(producer, suffix=name)
            self.assertFalse((self.base / (name + ".json")).exists())


class AppleHostDistributionTests(unittest.TestCase):
    """The distribute phase produces exactly what the native release writer consumes."""
    requirement = 'identifier "com.xoxd.fruitctl.host" and anchor apple generic and certificate leaf[subject.OU] = QP994XQKNH'
    certificate = b"public leaf certificate fixture"
    description = "\n".join(("Identifier=com.xoxd.fruitctl.host", "TeamIdentifier=QP994XQKNH",
        "CodeDirectory v=20500 flags=0x10000(runtime)", "Timestamp=Oct 17, 2026",
        "Authority=Developer ID Application: Test (QP994XQKNH)"))
    # Minimal valid AppleDouble header with zero entries.
    sidecar = bytes.fromhex("00051607") + bytes.fromhex("00020000") + bytes(16) + bytes(2)

    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.base = Path(directory.name).resolve()
        self.app = self.base / "host" / "FruitctlHost.app"
        files = {"Contents/Info.plist": (b"plist fixture", 0o644), "Contents/MacOS/FruitctlHost": (b"signed host", 0o755),
                 "Contents/_CodeSignature/CodeResources": (b"seal", 0o644), "Contents/CodeResources": (b"ticket", 0o644)}
        for name, (data, mode) in files.items():
            path = self.app / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data); path.chmod(mode)
        self.final = apple.inventory(self.app)
        signature = {"identifier": "com.xoxd.fruitctl.host", "teamIdentifier": "QP994XQKNH",
                     "certificateSha1": hashlib.sha1(self.certificate).hexdigest().upper(), "description": self.description}
        self.receipts = {}
        self.save("sign", {"kind": "fruitctl-apple-sign", "appName": self.app.name, "signature": signature,
                           "files": {k: v for k, v in self.final.items() if k != "Contents/CodeResources"}})
        self.save("archive", {"kind": "fruitctl-apple-submission-archive", "appName": self.app.name,
                              "signReceiptSha256": self.sha("sign"), "archiveSha256": "a" * 64, "archiveBytes": 1})
        self.save("notary", {"kind": "fruitctl-apple-notarization", "appName": self.app.name, "archiveReceiptSha256": self.sha("archive"),
                             "submittedArchiveSha256": "a" * 64, "apple": {"id": "11111111-1111-4111-8111-111111111111", "status": "Accepted"}})
        self.save("staple", {"kind": "fruitctl-apple-staple", "appName": self.app.name, "signReceiptSha256": self.sha("sign"),
                             "notarizationReceiptSha256": self.sha("notary"), "submissionId": "11111111-1111-4111-8111-111111111111",
                             "files": self.final, "signature": signature})
        self.zip, self.extract, self.receipt = self.base / "FruitctlHost-stapled-distribution.zip", self.base / "extract", self.base / "dist.json"
        self.calls, self.extract_mutation, self.failing = [], None, set()

    def save(self, key, value):
        value.update(schemaVersion=1, status="passed")
        path = self.base / (key + ".json"); path.write_text(json.dumps(value)); self.receipts[key] = path

    def sha(self, key):
        return hashlib.sha256(self.receipts[key].read_bytes()).hexdigest()

    def fake_run(self, command):
        command = [str(value) for value in command]; self.calls.append(command)
        tool = command[0] if command[0] != "xcrun" else command[1]
        if tool in self.failing:
            raise subprocess.CalledProcessError(3, command)
        if tool == "codesign" and any(value.startswith("--extract-certificates=") for value in command):
            Path(command[2].split("=", 1)[1] + "0").write_bytes(self.certificate); return ""
        if tool == "codesign" and "--requirements" in command:
            return "Executable=" + command[-1] + "\ndesignated => " + self.requirement + "\n"
        if tool == "codesign":
            return self.description if "--display" in command else ""
        if command[:3] == ["ditto", "-c", "-k"]:
            source = Path(command[-2]); entries = [(source.name + "/", None, stat.S_IFDIR | 0o755)]
            for path in sorted(source.rglob("*")):
                name = source.name + "/" + path.relative_to(source).as_posix()
                entries.append((name + "/", None, stat.S_IFDIR | 0o755) if path.is_dir()
                               else (name, path.read_bytes(), stat.S_IFREG | stat.S_IMODE(path.stat().st_mode)))
            entries.append(("__MACOSX/" + source.name + "/Contents/._Info.plist", self.sidecar, stat.S_IFREG | 0o644))
            with zipfile.ZipFile(command[-1], "w") as archive:
                for name, data, mode in entries:
                    info = zipfile.ZipInfo(name); info.create_system = 3; info.external_attr = mode << 16
                    archive.writestr(info, data or b"")
            return ""
        if command[:3] == ["ditto", "-x", "-k"]:
            with zipfile.ZipFile(command[-2]) as archive:
                for info in archive.infolist():
                    if info.filename.startswith("__MACOSX/") or info.is_dir():
                        continue
                    path = Path(command[-1]) / info.filename; path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(archive.read(info)); path.chmod(stat.S_IMODE(info.external_attr >> 16))
            if self.extract_mutation:
                self.extract_mutation(Path(command[-1]) / "FruitctlHost.app")
            return ""
        return "accepted\nsource=Notarized Developer ID" if tool == "spctl" else ""

    def distribute(self):
        argv = ["apple_distribution.py", "distribute", "--app", str(self.app), "--zip", str(self.zip),
                "--extract-dir", str(self.extract), "--receipt", str(self.receipt)]
        for key, flag in (("sign", "--sign-receipt"), ("archive", "--archive-receipt"),
                          ("notary", "--notarization-receipt"), ("staple", "--staple-receipt")):
            argv += [flag, str(self.receipts[key])]
        with patch.object(sys, "argv", argv), patch.object(apple.platform, "system", return_value="Darwin"), \
                patch.object(apple, "run", self.fake_run), patch("builtins.print"):
            apple.main()
        return json.loads(self.receipt.read_text())

    def test_receipt_is_accepted_by_the_native_release_consumer(self):
        result = self.distribute()
        self.assertEqual(result["kind"], "fruitctl-private-stapled-host-distribution")
        self.assertEqual((result["signReceiptSha256"], result["submissionArchiveReceiptSha256"],
                          result["acceptedNotarizationReceiptSha256"], result["stapleReceiptSha256"]),
                         (self.sha("sign"), self.sha("archive"), self.sha("notary"), self.sha("staple")))
        self.assertEqual(result["archiveSha256"], hashlib.sha256(self.zip.read_bytes()).hexdigest())
        self.assertEqual(result["actualPostStapleFiles"], self.final)
        # The writer's own checks: requirement roundtrip and complete ZIP map.
        signature = native.signature_projection(json.loads(self.receipts["sign"].read_text())["signature"], "FruitctlHost.app")
        self.assertEqual(native.host_requirement(result, signature)["expression"], self.requirement)
        recorded, actual = result["archivePayloadAndMetadataValidation"], native.zip_map(self.zip, "FruitctlHost.app", self.final)
        self.assertEqual(actual["payloads"], recorded["payloads"])
        self.assertEqual(actual["AppleDoubleSidecars"], recorded["AppleDoubleSidecars"])
        self.assertEqual(actual["directories"], native.recorded_directories(recorded["directories"]))
        # The ticket and Gatekeeper checks run on the re-extracted copy, not the source app.
        restored = str(self.extract / "FruitctlHost.app")
        self.assertIn(["xcrun", "stapler", "validate", restored], self.calls)
        self.assertIn(["spctl", "--assess", "--type", "execute", "--verbose=4", restored], self.calls)

    def assert_refused(self, error=ValueError, phrase=None):
        with self.assertRaises(error) as raised:
            self.distribute()
        if phrase:
            self.assertIn(phrase, str(raised.exception))
        self.assertFalse(self.receipt.exists())

    def test_reextracted_payload_drift_is_refused(self):
        self.extract_mutation = lambda app: (app / "Contents/Info.plist").write_bytes(b"other plist")
        self.assert_refused(phrase="re-extracted Host payload differs")

    def test_ticket_or_gatekeeper_failure_on_the_restored_copy_is_refused(self):
        for tool in ("stapler", "spctl"):
            with self.subTest(tool=tool):
                self.failing = {tool}; self.calls = []
                for path in (self.zip, self.extract):
                    shutil.rmtree(path) if path.is_dir() else path.unlink(missing_ok=True)
                self.assert_refused(subprocess.CalledProcessError)

    def test_broken_receipt_chain_is_refused_before_any_command(self):
        staple = json.loads(self.receipts["staple"].read_text()); staple["notarizationReceiptSha256"] = "0" * 64
        self.receipts["staple"].write_text(json.dumps(staple))
        self.assert_refused(phrase="receipt chain")
        self.assertEqual(self.calls, [])

    def test_app_changed_after_staple_is_refused_before_archiving(self):
        (self.app / "Contents/Info.plist").write_bytes(b"tampered")
        self.assert_refused(phrase="differs from its staple receipt")
        self.assertFalse(self.zip.exists())


class PortableHostLauncherTests(unittest.TestCase):
    def test_bundled_node_precedes_ambient_and_resolves_links_without_changing_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            bundle = root / "runtime space 'quote" / "bin"; bundle.mkdir(parents=True)
            launcher = bundle / "fruitctl-host-install"
            shutil.copyfile(ROOT / "bin/fruitctl-host-install", launcher); launcher.chmod(0o755)
            entry = bundle / "fruitctl-host-install.mjs"; entry.write_text("// inert entrypoint fixture\n")
            probe = root / "node-probe.py"
            probe.write_text("import json,sys\nprint(json.dumps({'source':sys.argv[1],'args':sys.argv[2:]}))\n")
            ambient = root / "ambient"; ambient.mkdir()
            for executable, label in ((bundle / "node", "bundled"), (ambient / "node", "ambient")):
                executable.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(probe)) + " " + label + ' "$@"\n')
                executable.chmod(0o755)
            links = root / "links space"; links.mkdir()
            (links / "intermediate").symlink_to(os.path.relpath(launcher, links))
            relative = links / "relative"; relative.symlink_to("intermediate")
            absolute = links / "absolute"; absolute.symlink_to(launcher)
            env = {**os.environ, "PATH": str(ambient) + os.pathsep + os.environ.get("PATH", "")}
            args = ["doctor", "--app-path", "/a space/FruitctlHost.app", "single' double\"", "$literal;no-eval", ""]
            for selected in (launcher, relative, absolute):
                with self.subTest(launcher=selected.name):
                    completed = subprocess.run([str(selected), *args], env=env, check=True, capture_output=True, text=True, timeout=10)
                    self.assertEqual(json.loads(completed.stdout), {"source": "bundled", "args": [str(entry), *args]})
            (bundle / "node").unlink()
            completed = subprocess.run([str(relative), *args], env=env, check=True, capture_output=True, text=True, timeout=10)
            self.assertEqual(json.loads(completed.stdout), {"source": "ambient", "args": [str(entry), *args]})


class RuntimeArchiveTests(unittest.TestCase):
    files = {name: name.encode() for name in ("bin/node", "bin/fruitctl", "bin/fruitctl.mjs", "package.json",
             "lib/install/index.mjs", "integrations/agents.json", "skills/fruitctl/SKILL.md", "LICENSES/Node-24.21.0-LICENSE.txt")}

    def bundle(self, directory, extra=None, omit=None):
        path = Path(directory) / "runtime.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, data in self.files.items():
                if name == omit:
                    continue
                info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o755 if name.startswith("bin/") else 0o644
                archive.addfile(info, io.BytesIO(data))
            if extra:
                archive.addfile(extra, io.BytesIO(b"x" * extra.size) if extra.isfile() else None)
        return path

    def validate(self, path, node_hash=None):
        return release.runtime_archive(path, node_hash or hashlib.sha256(self.files["bin/node"]).hexdigest(),
                                       hashlib.sha256(self.files["LICENSES/Node-24.21.0-LICENSE.txt"]).hexdigest())

    def test_safe_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.validate(self.bundle(directory)), 8)

    def test_node_substitution(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "Node executable"):
            self.validate(self.bundle(directory), "0" * 64)

    def test_missing_package_metadata(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "omits"):
            self.validate(self.bundle(directory, omit="package.json"))

    def test_parent_traversal(self):
        entry = tarfile.TarInfo("../escaped"); entry.size = 1
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "normalized"):
            self.validate(self.bundle(directory, entry))

    def test_symlink_refused(self):
        entry = tarfile.TarInfo("bin/alias"); entry.type = tarfile.SYMTYPE; entry.linkname = "node"
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "symlinks"):
            self.validate(self.bundle(directory, entry))

    def test_hardlink_refused(self):
        entry = tarfile.TarInfo("bin/alias"); entry.type = tarfile.LNKTYPE; entry.linkname = "bin/node"
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "hardlinks"):
            self.validate(self.bundle(directory, entry))

    def test_duplicate_file_refused(self):
        entry = tarfile.TarInfo("bin/node"); entry.size = 1
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "duplicate"):
            self.validate(self.bundle(directory, entry))


class PrivateHostSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.products = self.root / "build/derived/Build/Products/Release"
        self.original = self.products / "FruitctlHost.app"
        (self.original / "Contents/MacOS").mkdir(parents=True)
        (self.original / "Contents/Info.plist").write_bytes(b"fixture original plist")
        (self.original / "Contents/MacOS/FruitctlHost").write_bytes(b"fixture original executable")
        self.built = {"artifacts": {"FruitctlHost.app": {"files": source.app_inventory(self.original)}}}
        self.build_receipt = self.write("build-receipt.json", self.built)
        self.app = self.root / "private/FruitctlHost.app"
        shutil.copytree(self.original, self.app)
        self.binary = self.app / "Contents/MacOS/FruitctlHost"
        self.binary.write_bytes(b"fixture signature changes executable bytes")
        (self.app / "Contents/_CodeSignature").mkdir()
        (self.app / "Contents/_CodeSignature/CodeResources").write_bytes(b"fixture sealed resources")
        signature = {"teamIdentifier": "QP994XQKNH", "certificateSha1": "6" * 40,
            "identifier": "com.xoxd.fruitctl.host", "description": "\n".join((
                "CodeDirectory v=20500 flags=0x10000(runtime)", "Timestamp=Oct 5, 2026",
                "Authority=Developer ID Application: Fixture (QP994XQKNH)"))}
        self.sign_value = self.receipt("fruitctl-apple-sign", buildReceiptSha256=self.sha(self.build_receipt),
            unsignedFiles=source.app_inventory(self.original), files=source.app_inventory(self.app), signature=signature)
        self.sign = self.write("sign.json", self.sign_value)
        self.zip = self.root / "submission.zip"
        with zipfile.ZipFile(self.zip, "w") as archive:
            for path in self.app.rglob("*"):
                if path.is_file():
                    archive.write(path, "FruitctlHost.app/" + path.relative_to(self.app).as_posix())
        self.archive_value = self.receipt("fruitctl-apple-submission-archive", signReceiptSha256=self.sha(self.sign),
            archiveSha256=self.sha(self.zip), archiveBytes=self.zip.stat().st_size)
        self.archive = self.write("archive.json", self.archive_value)
        self.notary_value = self.receipt("fruitctl-apple-notarization", archiveReceiptSha256=self.sha(self.archive),
            submittedArchiveSha256=self.sha(self.zip), apple={"status": "Accepted", "id": "00000000-0000-0000-0000-000000000000"})
        self.notary = self.write("notary.json", self.notary_value)
        self.staple_value = self.receipt("fruitctl-apple-staple", buildReceiptSha256=self.sha(self.build_receipt),
            signReceiptSha256=self.sha(self.sign), notarizationReceiptSha256=self.sha(self.notary),
            submissionId=self.notary_value["apple"]["id"], signature=copy.deepcopy(signature), files=source.app_inventory(self.app))
        self.staple = self.write("staple.json", self.staple_value)

    def tearDown(self):
        self.temporary.cleanup()

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def receipt(self, kind, **fields):
        return {"kind": kind, "schemaVersion": 1, "status": "passed", "appName": "FruitctlHost.app", **fields}

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value, sort_keys=True))
        return path

    def approved(self, sign=None, archive=None, notary=None, staple=None, submissions=None):
        return source.private_app_receipts([sign or self.sign], [archive or self.archive], [notary or self.notary],
            [staple or self.staple], submissions or [self.zip], self.built, self.build_receipt)

    def descriptor(self, approved):
        return source.binary_descriptor(self.binary, self.products, self.built, {}, approved)

    def test_exact_private_bundle_with_complete_chain(self):
        self.assertEqual(self.descriptor(self.approved()), {"sha256": self.sha(self.binary), "bytes": self.binary.stat().st_size})

    def test_original_build_output_needs_no_distribution_chain(self):
        approved = source.private_app_receipts([], [], [], [], [], self.built, self.build_receipt)
        original = self.original / "Contents/MacOS/FruitctlHost"
        self.assertEqual(source.binary_descriptor(original, self.products, self.built, {}, approved),
            self.built["artifacts"]["FruitctlHost.app"]["files"]["Contents/MacOS/FruitctlHost"])

    def test_separate_publication_copy_keeps_identity_despite_path_metadata(self):
        self.sign_value["signature"]["description"] += "\nExecutable=/private/signed/FruitctlHost.app/Contents/MacOS/FruitctlHost"
        self.write("sign.json", self.sign_value)
        self.archive_value["signReceiptSha256"] = self.sha(self.sign)
        self.write("archive.json", self.archive_value)
        self.notary_value["archiveReceiptSha256"] = self.sha(self.archive)
        self.write("notary.json", self.notary_value)
        self.staple_value["signReceiptSha256"] = self.sha(self.sign)
        self.staple_value["notarizationReceiptSha256"] = self.sha(self.notary)
        self.staple_value["signature"]["description"] += "\nExecutable=/private/publication/FruitctlHost.app/Contents/MacOS/FruitctlHost"
        self.write("staple.json", self.staple_value)
        self.assertEqual(self.descriptor(self.approved())["sha256"], self.sha(self.binary))

    def test_staple_cannot_replace_signed_executable(self):
        self.staple_value["files"]["Contents/MacOS/FruitctlHost"]["sha256"] = "0" * 64
        self.write("staple.json", self.staple_value)
        with self.assertRaisesRegex(ValueError, "original signed bundle bytes"):
            self.approved()

    def test_empty_signed_inventory_is_refused(self):
        self.sign_value["files"] = {}
        self.write("sign.json", self.sign_value)
        with self.assertRaisesRegex(ValueError, "inventory is malformed"):
            self.approved()

    def test_signed_inventory_cannot_omit_an_original_resource(self):
        del self.sign_value["files"]["Contents/Info.plist"]
        self.write("sign.json", self.sign_value)
        with self.assertRaisesRegex(ValueError, "omits original bundle files"):
            self.approved()

    def test_private_path_alone_is_refused(self):
        with self.assertRaisesRegex(ValueError, "actual build output"):
            self.descriptor({})

    def test_partial_receipt_chain_is_refused(self):
        with self.assertRaisesRegex(ValueError, "sign, archive, Accepted"):
            source.private_app_receipts([self.sign], [], [], [self.staple], [self.zip], self.built, self.build_receipt)

    def test_changed_unselected_resource_is_refused(self):
        approved = self.approved()
        (self.app / "Contents/Info.plist").write_bytes(b"substituted plist despite unchanged executable")
        with self.assertRaisesRegex(ValueError, "bundle differs"):
            self.descriptor(approved)

    def test_extra_file_is_refused(self):
        approved = self.approved()
        (self.app / "Contents/unreviewed-helper").write_bytes(b"extra executable")
        with self.assertRaisesRegex(ValueError, "bundle differs"):
            self.descriptor(approved)

    def test_escaping_resource_symlink_is_refused(self):
        approved = self.approved()
        target = self.app / "Contents/Info.plist"
        target.unlink(); target.symlink_to(self.original / "Contents/Info.plist")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.descriptor(approved)

    def test_wrong_unsigned_bundle_is_refused(self):
        self.sign_value["unsignedFiles"]["Contents/Info.plist"]["sha256"] = "0" * 64
        self.write("sign.json", self.sign_value)
        with self.assertRaisesRegex(ValueError, "exact unsigned"):
            self.approved()

    def test_wrong_build_receipt_is_refused(self):
        self.sign_value["buildReceiptSha256"] = "0" * 64
        self.write("sign.json", self.sign_value)
        with self.assertRaisesRegex(ValueError, "tested build"):
            self.approved()

    def test_duplicate_receipt_is_refused(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            source.private_app_receipts([self.sign, self.sign], [self.archive], [self.notary], [self.staple],
                [self.zip], self.built, self.build_receipt)

    def test_malformed_receipt_is_refused(self):
        malformed = self.write("malformed.json", [])
        with self.assertRaisesRegex(ValueError, "passing distribution"):
            self.approved(sign=malformed)

    def test_changed_archive_receipt_is_refused(self):
        self.archive_value["signReceiptSha256"] = "0" * 64
        self.write("archive.json", self.archive_value)
        with self.assertRaisesRegex(ValueError, "signing receipt chain"):
            self.approved()

    def test_changed_submission_zip_is_refused(self):
        self.zip.write_bytes(b"substituted submission archive")
        with self.assertRaisesRegex(ValueError, "submission archive chain"):
            self.approved()

    def test_not_accepted_submission_is_refused(self):
        self.notary_value["apple"]["status"] = "Invalid"
        self.write("notary.json", self.notary_value)
        with self.assertRaisesRegex(ValueError, "actual Accepted"):
            self.approved()

    def test_wrong_stapled_submission_is_refused(self):
        self.staple_value["submissionId"] = "11111111-1111-1111-1111-111111111111"
        self.write("staple.json", self.staple_value)
        with self.assertRaisesRegex(ValueError, "Accepted/staple"):
            self.approved()

    def test_absent_developer_id_metadata_is_refused(self):
        self.sign_value["signature"]["certificateSha1"] = ""
        self.staple_value["signature"] = copy.deepcopy(self.sign_value["signature"])
        self.write("sign.json", self.sign_value); self.write("staple.json", self.staple_value)
        with self.assertRaisesRegex(ValueError, "lacks verified Developer ID"):
            self.approved()


class NativeSourceProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name).resolve()
        self.public = self.base / "public"; self.public.mkdir()
        self.tested = self.base / "tested"; self.tested.mkdir()
        self.native_files = {
            "ClaudeKVM-Daemon/main.swift": b"// tested daemon fixture\n",
            "FruitctlHost/HostLease.swift": b"// tested Host code fixture\n",
            "FruitctlHost/README.md": b"tested Host resource documentation\n",
            "FruitctlHost/ATTENDED-QUALIFICATION.md": b"unchanged qualification resource\n",
            "FruitctlHost/Info.plist": b"unchanged Host plist fixture\n",
            "Tests/NativeBehaviorTests.swift": b"// tested native test fixture\n",
            "test/CredentialInputHarness.swift": b"// tested input harness fixture\n",
            "project.yml": b"targets: fixture\n",
        }
        for root in (self.public, self.tested):
            for name, data in self.native_files.items():
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        self.current_readme = b"corrected public Host resource documentation\n"
        (self.public / "FruitctlHost/README.md").write_bytes(self.current_readme)
        files = {name: self.sha(data) for name, data in self.native_files.items()}
        self.built = {"sourceFiles": files, "sourceTreeSha256": self.tree_sha(files),
                      "artifacts": {"FruitctlHost.app": {"files": {
                          "Contents/Resources/README.md": self.descriptor(self.native_files["FruitctlHost/README.md"])}}}}

    @staticmethod
    def sha(data):
        return hashlib.sha256(data).hexdigest()

    @classmethod
    def descriptor(cls, data):
        return {"sha256": cls.sha(data), "bytes": len(data)}

    @classmethod
    def tree_sha(cls, files):
        return cls.sha(json.dumps(files, sort_keys=True).encode())

    def provenance(self, names=("claude-kvm-daemon",), tested=True):
        return source.native_source_provenance(self.public, self.built, names, self.tested if tested else None)

    def test_default_strict_matching_inputs_preserve_the_tested_map(self):
        (self.public / "FruitctlHost/README.md").write_bytes(self.native_files["FruitctlHost/README.md"])
        value, docs = self.provenance(tested=False)
        self.assertEqual(value["mode"], "strict")
        self.assertEqual(value["testedSourceFiles"], value["publicNativeSourceFiles"])
        self.assertEqual(value["testedSourceTreeSha256"], value["publicNativeSourceTreeSha256"])
        self.assertEqual(docs, {})
        self.assertEqual(value["resourceDocs"], [])

    def test_default_strict_refuses_the_corrected_readme(self):
        with self.assertRaisesRegex(ValueError, "source changed after build: FruitctlHost/README.md"):
            self.provenance(tested=False)

    def test_explicit_controller_records_both_complete_maps_and_exact_tested_docs(self):
        original = copy.deepcopy(self.built)
        value, docs = self.provenance()
        public_files = dict(self.built["sourceFiles"])
        public_files["FruitctlHost/README.md"] = self.sha(self.current_readme)
        self.assertEqual(value["testedSourceFiles"], self.built["sourceFiles"])
        self.assertEqual(value["publicNativeSourceFiles"], public_files)
        self.assertEqual(value["testedSourceTreeSha256"], self.built["sourceTreeSha256"])
        self.assertEqual(value["publicNativeSourceTreeSha256"], self.tree_sha(public_files))
        self.assertEqual(value["selectedBinaries"], ["claude-kvm-daemon"])
        entry, = value["resourceDocs"]
        self.assertEqual(entry, {
            "publicSourcePath": "fruitctl/FruitctlHost/README.md", "testedSourcePath": "FruitctlHost/README.md",
            "testedEvidencePath": "build-evidence/tested-native-resource-docs/FruitctlHost/README.md",
            "testedSha256": self.sha(self.native_files["FruitctlHost/README.md"]),
            "testedBytes": len(self.native_files["FruitctlHost/README.md"]),
            "publicSha256": self.sha(self.current_readme), "publicBytes": len(self.current_readme),
            "ownerArtifact": "FruitctlHost.app", "ownerResourcePath": "Contents/Resources/README.md",
            "ownerArtifactIncluded": False, "publicDocumentationChanged": True})
        self.assertEqual(docs, {entry["testedEvidencePath"]: self.native_files["FruitctlHost/README.md"]})
        self.assertNotIn(str(self.base), json.dumps(value))
        self.assertEqual(self.built, original)

    def test_host_mixed_unknown_and_empty_selections_are_always_refused(self):
        for names in (("FruitctlHost",), ("claude-kvm-daemon", "FruitctlHost"), ("unknown-tool",), ()):
            with self.subTest(names=names), self.assertRaisesRegex(ValueError, "only for the selected controller; Host is refused"):
                self.provenance(names=names)

    def test_code_project_tests_and_every_other_resource_change_are_refused(self):
        for name, data in self.native_files.items():
            if name == "FruitctlHost/README.md":
                continue
            with self.subTest(name=name):
                path = self.public / name
                path.write_bytes(data + b"unreviewed change\n")
                try:
                    with self.assertRaisesRegex(ValueError, "source changed after build"):
                        self.provenance()
                finally:
                    path.write_bytes(data)

    def test_tested_readme_and_code_substitution_are_refused(self):
        for name in ("FruitctlHost/README.md", "ClaudeKVM-Daemon/main.swift"):
            with self.subTest(name=name):
                path = self.tested / name; path.write_bytes(b"substituted tested source\n")
                try:
                    with self.assertRaisesRegex(ValueError, "tested native source root differs"):
                        self.provenance()
                finally:
                    path.write_bytes(self.native_files[name])

    def test_missing_and_extra_inputs_in_either_complete_map_are_refused(self):
        for root in (self.public, self.tested):
            for extra in (False, True):
                with self.subTest(root=root.name, extra=extra):
                    name = "ClaudeKVM-Daemon/extra.swift" if extra else "Tests/NativeBehaviorTests.swift"
                    path = root / name
                    if extra:
                        path.write_bytes(b"extra untested native source\n")
                    else:
                        path.unlink()
                    try:
                        with self.assertRaisesRegex(ValueError, "inventory"):
                            self.provenance()
                    finally:
                        if extra:
                            path.unlink()
                        else:
                            path.write_bytes(self.native_files[name])

    def test_original_host_resource_descriptor_must_match_tested_readme_hash_and_length(self):
        descriptor = self.built["artifacts"]["FruitctlHost.app"]["files"]["Contents/Resources/README.md"]
        for key, value in (("sha256", "0" * 64), ("bytes", descriptor["bytes"] + 1)):
            with self.subTest(key=key):
                original = descriptor[key]; descriptor[key] = value
                try:
                    with self.assertRaisesRegex(ValueError, "original build bundle resource"):
                        self.provenance()
                finally:
                    descriptor[key] = original

    def test_missing_original_host_resource_descriptor_is_refused(self):
        del self.built["artifacts"]["FruitctlHost.app"]["files"]["Contents/Resources/README.md"]
        with self.assertRaisesRegex(ValueError, "original build bundle resource"):
            self.provenance()

    def test_tree_hash_and_receipt_map_tampering_are_refused(self):
        original = copy.deepcopy(self.built)
        self.built["sourceTreeSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "source tree hash differs"):
            self.provenance()
        self.built = copy.deepcopy(original)
        self.built["sourceFiles"]["project.yml"] = "0" * 64
        self.built["sourceTreeSha256"] = self.tree_sha(self.built["sourceFiles"])
        with self.assertRaisesRegex(ValueError, "tested native source root differs"):
            self.provenance()
        self.built = copy.deepcopy(original)
        self.built["sourceFiles"]["project.yml"] = "invalid-hash"
        with self.assertRaisesRegex(ValueError, "source inventory required"):
            self.provenance()

    def test_symlink_root_parent_native_directory_and_file_are_refused(self):
        alias = self.base / "tested-alias"; alias.symlink_to(self.tested, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "canonical native source root"):
            source.native_source_provenance(self.public, self.built, ["claude-kvm-daemon"], alias)
        parent_alias = self.base / "parent-alias"; parent_alias.symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "canonical native source root"):
            source.native_source_provenance(self.public, self.built, ["claude-kvm-daemon"], parent_alias / "tested")
        for root in (self.public, self.tested):
            directory = root / "ClaudeKVM-Daemon"; backup = root / "saved-daemon"
            directory.rename(backup); directory.symlink_to(backup, target_is_directory=True)
            try:
                with self.subTest(root=root.name), self.assertRaisesRegex(ValueError, "symlinks are refused"):
                    self.provenance()
            finally:
                directory.unlink(); backup.rename(directory)
            path = root / "project.yml"; path.unlink(); path.symlink_to((self.tested if root == self.public else self.public) / "project.yml")
            try:
                with self.subTest(root=root.name), self.assertRaisesRegex(ValueError, "regular native project"):
                    self.provenance()
            finally:
                path.unlink(); path.write_bytes(self.native_files["project.yml"])

    def test_tested_readme_mutation_after_inventory_is_refused(self):
        inventory = source.native_source_inventory
        def mutate_after_inventory(root):
            files = inventory(root)
            if root == self.tested:
                (root / "FruitctlHost/README.md").write_bytes(b"changed between inventory and evidence read\n")
            return files
        with patch.object(source, "native_source_inventory", mutate_after_inventory):
            with self.assertRaisesRegex(ValueError, "tested Host README changed after inventory"):
                self.provenance()

    def package_fixture(self):
        build = self.base / "build"; build.mkdir()
        products = build / "derived/Build/Products/Release"; products.mkdir(parents=True)
        daemon = products / "claude-kvm-daemon"; daemon.write_bytes(b"unsigned tested daemon fixture\n")
        self.built["artifacts"][daemon.name] = self.descriptor(daemon.read_bytes())
        dependency_files = {}
        for name in ("openssl-source", "libvnc-source"):
            directory = build / name; directory.mkdir(); (directory / "LICENSE").write_bytes((name + " fixture license\n").encode())
            dependency_files[name] = source.tree_hashes(directory)
        downloads = build / "downloads"; downloads.mkdir()
        for name in ("openssl.tar.gz", "libvnc.tar.gz", "fixture-commit.patch"):
            (downloads / name).write_bytes(("fixture upstream input " + name).encode())
        lock = {"openssl": {"sha256": source.builder.digest(downloads / "openssl.tar.gz")},
                "libvncclient": {"sha256": source.builder.digest(downloads / "libvnc.tar.gz"),
                                 "patches": [{"commit": "fixture-commit", "sha256": source.builder.digest(downloads / "fixture-commit.patch")}]}}
        swift = self.base / "swift-tree"; swift.mkdir(); (swift / "Package.swift").write_bytes(b"// pinned Swift source fixture\n")
        swift_archive = self.base / "swift.tar.gz"; swift_archive.write_bytes(b"verified Swift archive fixture\n")
        node_archive = self.base / "node.tar.xz"; node_archive.write_bytes(b"verified Node source archive fixture\n")
        public_files = {"LICENSE": b"MIT fixture license\n", "THIRD_PARTY_NOTICES.md": b"fixture notices\n",
                        "package.json": b'{"name":"fixture"}\n', "package-lock.json": b'{"packages":{}}\n',
                        "scripts/build-native.sh": b"# fixture builder\n", "scripts/build-host.sh": b"# fixture Host builder\n",
                        "scripts/install.sh": b"# fixture installer\n", "scripts/uninstall.sh": b"# fixture uninstaller\n",
                        "scripts/verify-native-input.py": b"# fixture input verifier\n", "scripts/release/fixture.py": b"# fixture release script\n",
                        "release/native-dependencies.lock.json": json.dumps(lock).encode(),
                        "LICENSES/dependency-provenance.json": json.dumps({"components": [{"id": "swift-argument-parser",
                            "upstream_revision": "fixture-swift-revision", "source_archive": {"source_url": "https://example.invalid/swift",
                            "sha256": source.builder.digest(swift_archive)}}]}).encode(),
                        "LICENSES/node-runtime-provenance.json": json.dumps({"source_archive": {
                            "source_url": "https://example.invalid/node", "sha256": source.builder.digest(node_archive)}}).encode()}
        for name, data in public_files.items():
            path = self.public / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        native_manifest = build / "native-input-manifest.json"; native_manifest.write_text('{"fixture":"native inputs"}\n')
        self.built.update({"schemaVersion": 1, "kind": "fruitctl-native-build", "status": "passed",
                          "sourceRevision": "a" * 40, "sourceLockSha256": source.builder.digest(self.public / "release/native-dependencies.lock.json"),
                          "dependencyBuildDir": str(build), "dependencySourceFiles": dependency_files,
                          "swiftPackageRevision": "fixture-swift-revision", "swiftPackageSourceFiles": source.tree_hashes(swift),
                          "nativeInputManifest": str(native_manifest), "inputManifestSha256": source.builder.digest(native_manifest),
                          "tools": {"fixture": "source-only"}, "commands": []})
        built_path = build / "build-receipt.json"; built_path.write_text(json.dumps(self.built, sort_keys=True))
        inventory = self.base / "public-source.json"
        inventory.write_text(json.dumps({"schemaVersion": 1, "kind": "fruitctl-public-source-inventory", "sourceRevision": "b" * 40,
                                         "workingTreeClean": True, "files": source.tree_hashes(self.public)}))
        output, receipt = self.base / "source.tar.gz", self.base / "source-receipt.json"
        args = ["package_source.py", "--build-dir", str(build), "--output", str(output), "--receipt", str(receipt),
                "--source-inventory", str(inventory), "--binary", str(daemon), "--tested-native-source-root", str(self.tested)]
        def download(entry, target):
            selected = swift_archive if entry["url"].endswith("/swift") else node_archive
            self.assertEqual(source.builder.digest(selected), entry["sha256"])
            shutil.copyfile(selected, target)
        return build, built_path, inventory, output, receipt, args, swift, download

    def run_package(self, fixture):
        build, built_path, inventory, output, receipt, args, swift, download = fixture
        with patch.object(source, "ROOT", self.public), patch.object(source.builder, "LOCK", self.public / "release/native-dependencies.lock.json"), \
             patch.object(source.builder, "download", download), patch.object(source.builder, "extract", return_value=swift), \
             patch.object(sys, "argv", args), patch.object(sys, "stdout", io.StringIO()):
            source.main()

    def test_actual_archive_contains_both_docs_and_dual_provenance_without_rewriting_build(self):
        fixture = self.package_fixture()
        build, built_path, inventory, output, receipt, args, swift, download = fixture
        original_build_bytes = built_path.read_bytes()
        self.run_package(fixture)
        with tarfile.open(output, "r:gz") as archive:
            files = {member.name: archive.extractfile(member).read() for member in archive.getmembers()}
        self.assertEqual(files["fruitctl/FruitctlHost/README.md"], self.current_readme)
        evidence_name = "build-evidence/tested-native-resource-docs/FruitctlHost/README.md"
        self.assertEqual(files[evidence_name], self.native_files["FruitctlHost/README.md"])
        manifest = json.loads(files["corresponding-source.json"])
        external = json.loads(receipt.read_text())
        self.assertEqual(manifest["nativeSourceProvenance"], external["nativeSourceProvenance"])
        provenance = external["nativeSourceProvenance"]
        self.assertEqual(provenance["testedSourceFiles"], self.built["sourceFiles"])
        self.assertEqual(provenance["publicNativeSourceFiles"], source.native_source_inventory(self.public))
        self.assertEqual(manifest["files"][evidence_name], self.sha(files[evidence_name]))
        self.assertEqual(manifest["files"]["fruitctl/FruitctlHost/README.md"], self.sha(self.current_readme))
        self.assertEqual(manifest["sourceTreeSha256"], self.built["sourceTreeSha256"])
        self.assertEqual(external["sourceTreeSha256"], self.built["sourceTreeSha256"])
        self.assertEqual(external["buildReceiptSha256"], self.sha(original_build_bytes))
        packaged_build = json.loads(files["build-evidence/build-receipt.json"])
        self.assertEqual(packaged_build["sourceFiles"], self.built["sourceFiles"])
        self.assertEqual(packaged_build["sourceTreeSha256"], self.built["sourceTreeSha256"])
        self.assertEqual(built_path.read_bytes(), original_build_bytes)
        self.assertFalse(any("FruitctlHost.app" in name for name in files))
        self.assertNotIn(str(self.base), json.dumps(manifest))
        self.assertEqual(external["qualification"], "not-publicly-qualified")

    def test_actual_packager_refuses_binary_substitution_before_doc_exception(self):
        fixture = self.package_fixture()
        Path(fixture[5][fixture[5].index("--binary") + 1]).write_bytes(b"substituted daemon\n")
        with self.assertRaisesRegex(ValueError, "binary differs from tested output"):
            self.run_package(fixture)
        self.assertFalse(fixture[3].exists())
        self.assertFalse(fixture[4].exists())

    def test_actual_archive_pins_validated_build_receipt_despite_concurrent_replacement(self):
        fixture = self.package_fixture()
        build, built_path, inventory, output, receipt, args, swift, download = fixture
        original_bytes = built_path.read_bytes()
        replacement = copy.deepcopy(self.built)
        replacement["sourceRevision"] = "c" * 40
        replacement["sourceFiles"]["ClaudeKVM-Daemon/main.swift"] = "0" * 64
        replacement["sourceTreeSha256"] = self.tree_sha(replacement["sourceFiles"])
        replacement["artifacts"]["claude-kvm-daemon"] = self.descriptor(b"unvalidated substitute daemon\n")
        original_private_receipts = source.private_app_receipts
        def replace_before_sign_chain(*values):
            built_path.write_text(json.dumps(replacement, sort_keys=True))
            self.assertEqual(values[-1], self.sha(original_bytes))
            return original_private_receipts(*values)
        with patch.object(source, "private_app_receipts", replace_before_sign_chain):
            self.run_package(fixture)
        with tarfile.open(output, "r:gz") as archive:
            packaged_build = json.load(archive.extractfile("build-evidence/build-receipt.json"))
            manifest = json.load(archive.extractfile("corresponding-source.json"))
        external = json.loads(receipt.read_text())
        self.assertNotEqual(source.builder.digest(built_path), self.sha(original_bytes))
        self.assertEqual(external["buildReceiptSha256"], self.sha(original_bytes))
        self.assertEqual(packaged_build, source.portable_receipt(json.loads(original_bytes),
            {str(self.public): "${SOURCE_ROOT}", str(build): "${DEPENDENCY_BUILD_ROOT}"}))
        self.assertEqual(manifest["build_snapshot_base_revision"], self.built["sourceRevision"])
        self.assertEqual(external["binary_sha256"]["claude-kvm-daemon"], self.built["artifacts"]["claude-kvm-daemon"])
        self.assertEqual(packaged_build["sourceFiles"], external["nativeSourceProvenance"]["testedSourceFiles"])

    def test_actual_packager_refuses_native_snapshot_omission_and_wrong_doc_hash(self):
        fixture = self.package_fixture()
        inventory_path = fixture[2]; original = json.loads(inventory_path.read_text())
        for omit in (False, True):
            with self.subTest(omit=omit):
                value = copy.deepcopy(original)
                if omit:
                    del value["files"]["Tests/NativeBehaviorTests.swift"]
                else:
                    value["files"]["FruitctlHost/README.md"] = self.built["sourceFiles"]["FruitctlHost/README.md"]
                inventory_path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, "reviewed inventory omits or differs from public native"):
                    self.run_package(fixture)
                self.assertFalse(fixture[3].exists())

    def test_actual_packager_refuses_source_mutation_between_hash_and_copy(self):
        fixture = self.package_fixture()
        copyfile = source.shutil.copyfile
        def mutate_before_copy(origin, target):
            if origin == self.public / "FruitctlHost/README.md":
                origin.write_bytes(b"mutated public docs after review\n")
            return copyfile(origin, target)
        with patch.object(source.shutil, "copyfile", mutate_before_copy):
            with self.assertRaisesRegex(ValueError, "public source changed during copying: FruitctlHost/README.md"):
                self.run_package(fixture)
        self.assertFalse(fixture[3].exists())
        self.assertFalse(fixture[4].exists())

    def test_actual_archive_ignores_ambient_generated_caches(self):
        fixture = self.package_fixture()
        caches = ("scripts/release/__pycache__/build_native.cpython-313.pyc",
                  "LICENSES/__pycache__/refresh-npm-notices.cpython-313.pyc")
        for name in caches:
            path = self.public / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"ambient generated bytecode\n")
        approved = json.loads(fixture[2].read_text())["files"]
        self.assertTrue(all(name not in approved for name in caches))
        self.run_package(fixture)
        with tarfile.open(fixture[3], "r:gz") as archive:
            names = archive.getnames()
        self.assertFalse(any("__pycache__" in Path(name).parts for name in names))
        self.assertTrue(all((self.public / name).is_file() for name in caches))

    def test_actual_packager_refuses_dependency_mutation_during_copy(self):
        fixture = self.package_fixture()
        copyfile = source.shutil.copyfile
        target_source = fixture[0] / "openssl-source/LICENSE"
        def mutate_before_copy(origin, target):
            if origin == target_source:
                origin.write_bytes(b"untested dependency source bytes\n")
            return copyfile(origin, target)
        with patch.object(source.shutil, "copyfile", mutate_before_copy):
            with self.assertRaisesRegex(ValueError, "copied dependency source differs from the tested build inventory"):
                self.run_package(fixture)
        self.assertFalse(fixture[3].exists())
        self.assertFalse(fixture[4].exists())

    def test_actual_packager_refuses_dependency_removal_after_initial_inventory(self):
        fixture = self.package_fixture()
        hashes = source.tree_hashes
        target_source = fixture[0] / "openssl-source"
        def remove_after_inventory(root):
            files = hashes(root)
            if root == target_source:
                (root / "LICENSE").unlink()
            return files
        with patch.object(source, "tree_hashes", remove_after_inventory):
            with self.assertRaisesRegex(ValueError, "copied dependency source differs from the tested build inventory"):
                self.run_package(fixture)
        self.assertFalse(fixture[3].exists())
        self.assertFalse(fixture[4].exists())

    def test_actual_packager_refuses_swift_source_mutation_during_copy(self):
        fixture = self.package_fixture()
        copyfile = source.shutil.copyfile
        def mutate_before_copy(origin, target):
            if origin == fixture[6] / "Package.swift":
                origin.write_bytes(b"// untested Swift source bytes\n")
            return copyfile(origin, target)
        with patch.object(source.shutil, "copyfile", mutate_before_copy):
            with self.assertRaisesRegex(ValueError, "copied dependency source differs from the tested build inventory"):
                self.run_package(fixture)
        self.assertFalse(fixture[3].exists())
        self.assertFalse(fixture[4].exists())

    def test_actual_archive_records_only_the_validated_binary_descriptor(self):
        fixture = self.package_fixture()
        daemon = Path(fixture[5][fixture[5].index("--binary") + 1])
        original = self.descriptor(daemon.read_bytes())
        digest = source.builder.digest
        reads = []
        def replace_after_validated_hash(path):
            result = digest(path)
            if path == daemon:
                reads.append(result)
                path.write_bytes(b"X" * original["bytes"])
            return result
        with patch.object(source.builder, "digest", replace_after_validated_hash):
            self.run_package(fixture)
        external = json.loads(fixture[4].read_text())
        with tarfile.open(fixture[3], "r:gz") as archive:
            manifest = json.load(archive.extractfile("corresponding-source.json"))
        self.assertEqual(reads, [original["sha256"]])
        self.assertNotEqual(digest(daemon), original["sha256"])
        self.assertEqual(external["binary_sha256"], {"claude-kvm-daemon": original})
        self.assertEqual(manifest["binary_sha256"], external["binary_sha256"])

    def test_actual_packager_still_requires_authored_release_scripts_and_licenses(self):
        fixture = self.package_fixture()
        inventory_path = fixture[2]; original = json.loads(inventory_path.read_text())
        for name in ("scripts/release/fixture.py", "LICENSES/node-runtime-provenance.json"):
            with self.subTest(name=name):
                value = copy.deepcopy(original); del value["files"][name]
                inventory_path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, "reviewed source inventory omits licenses, native/install scripts or locks"):
                    self.run_package(fixture)
                self.assertFalse(fixture[3].exists())
                self.assertFalse(fixture[4].exists())

    def test_actual_packager_refuses_explicit_generated_cache_inventory_entry(self):
        fixture = self.package_fixture()
        name = "scripts/release/__pycache__/build_native.cpython-313.pyc"
        path = self.public / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"generated bytecode\n")
        value = json.loads(fixture[2].read_text()); value["files"][name] = source.builder.digest(path)
        fixture[2].write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "exclude generated caches"):
            self.run_package(fixture)
        self.assertFalse(fixture[3].exists())
        self.assertFalse(fixture[4].exists())

    def test_actual_packager_refuses_changed_native_input_manifest(self):
        fixture = self.package_fixture()
        Path(self.built["nativeInputManifest"]).write_bytes(b'{"fixture":"unvalidated inputs"}\n')
        with self.assertRaisesRegex(ValueError, "native input manifest differs from the tested build"):
            self.run_package(fixture)
        self.assertFalse(fixture[3].exists())
        self.assertFalse(fixture[4].exists())

    def test_actual_archive_pins_native_manifest_despite_source_replacement(self):
        fixture = self.package_fixture()
        path = Path(self.built["nativeInputManifest"])
        original = path.read_bytes()
        private_receipts = source.private_app_receipts
        def replace_after_validation(*values):
            path.write_bytes(b'{"fixture":"unvalidated replacement"}\n')
            return private_receipts(*values)
        with patch.object(source, "private_app_receipts", replace_after_validation):
            self.run_package(fixture)
        with tarfile.open(fixture[3], "r:gz") as archive:
            packaged = json.load(archive.extractfile("build-evidence/native-input-manifest.json"))
            manifest = json.load(archive.extractfile("corresponding-source.json"))
        external = json.loads(fixture[4].read_text())
        self.assertEqual(packaged, json.loads(original))
        self.assertEqual(manifest["nativeInputManifestSha256"], self.sha(original))
        self.assertEqual(external["nativeInputManifestSha256"], self.sha(original))
        self.assertNotEqual(source.builder.digest(path), self.sha(original))

    def test_actual_archive_pins_root_metadata_despite_post_copy_replacement(self):
        fixture = self.package_fixture()
        names = ("release/native-dependencies.lock.json", "LICENSES/dependency-provenance.json", "LICENSES/node-runtime-provenance.json")
        original = {name: (self.public / name).read_bytes() for name in names}
        copyfile = source.shutil.copyfile
        def replace_after_copy(origin, target):
            result = copyfile(origin, target)
            if origin.is_relative_to(self.public) and origin.relative_to(self.public).as_posix() in names:
                origin.write_bytes(b'{"unvalidated":"replacement metadata"}\n')
            return result
        with patch.object(source.shutil, "copyfile", replace_after_copy):
            self.run_package(fixture)
        with tarfile.open(fixture[3], "r:gz") as archive:
            manifest = json.load(archive.extractfile("corresponding-source.json"))
            for name in names:
                self.assertEqual(archive.extractfile("fruitctl/" + name).read(), original[name])
        self.assertEqual(manifest["patches"], json.loads(original[names[0]])["libvncclient"]["patches"])
        self.assertEqual(manifest["components"], [*json.loads(original[names[1]])["components"], json.loads(original[names[2]])])
        external = json.loads(fixture[4].read_text())
        self.assertEqual(manifest["publicSourceInventorySha256"], source.builder.digest(fixture[2]))
        self.assertEqual(external["publicSourceInventorySha256"], manifest["publicSourceInventorySha256"])

    def test_actual_packager_refuses_all_validated_archive_and_patch_copy_substitutions(self):
        for name in ("openssl.tar.gz", "libvnc.tar.gz", "fixture-commit.patch", "swift-argument-parser.tar.gz", "node-source.tar.xz"):
            with self.subTest(name=name):
                self.setUp()
                fixture = self.package_fixture()
                copyfile = source.shutil.copyfile
                def replace_before_copy(origin, target):
                    if target.parent.name == "upstream-inputs" and target.name == name:
                        origin.write_bytes(b"unvalidated source archive or patch replacement\n")
                    return copyfile(origin, target)
                with patch.object(source.shutil, "copyfile", replace_before_copy):
                    with self.assertRaisesRegex(ValueError, "copied source input differs from its validated hash"):
                        self.run_package(fixture)
                self.assertFalse(fixture[3].exists())
                self.assertFalse(fixture[4].exists())


if __name__ == "__main__":
    unittest.main()
