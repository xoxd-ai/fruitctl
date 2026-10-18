set shell := ["bash", "-eu", "-c"]

default:
    @just --list

deps:
    npm ci --ignore-scripts

test:
    npm run test:offline

# Offline portable installer integrity, restoration and optional timing checks.
test-installer node="node":
    {{quote(node)}} --test --test-concurrency=1 test/fruitctl-install.test.js test/fruitctl-install-roots.test.js test/fruitctl-install-integrity.test.js test/fruitctl-install-timings.test.js test/fruitctl-install-timings-cli.test.js

# File-only Host installer fixtures; no app launch, Apple trust or desktop.
test-host-installer node="node":
    {{quote(node)}} --test --test-concurrency=1 test/fruitctl-host-install.test.js

# Owned broker/relay retirement, journal/wake/telemetry and inherited-deadline behavior; no desktop.
test-broker node="node":
    {{quote(node)}} --test --test-concurrency=1 test/fruitctl-broker.test.js test/fruitctl-broker-review.test.js test/fruitctl-broker-observability.test.js test/fruitctl-deadline-budget.test.js test/fruitctl-relay.test.js

# Offline full-raster fixture and streaming-oracle checks; contacts no desktop.
test-qualification node="node":
    {{quote(node)}} --test --test-concurrency=1 test/qualification.test.js test/qualification-stream.test.js test/qualification-overlay-gate.test.js test/qualification-live-kit.test.js

# Attended Host-route overlay exclusion gate (observation only; see scripts/qualification/README.md).
# Extra gate flags follow the three paths; there is no optional positional before them.
qualification-overlay-gate target control output_dir *args:
    node scripts/qualification/overlay_exclusion_gate.mjs --attended --target {{quote(target)}} --control {{quote(control)}} --output-dir {{quote(output_dir)}} {{args}}

# Attended PZM live qualification kit, one gate per call (see scripts/qualification/README.md).
# gate: desktop_state, ax, clipboard, type_secret or overlay_600. Extra gate flags follow.
qualification-live gate target socket output_dir *args:
    node scripts/qualification/live_{{gate}}.mjs --attended --target {{quote(target)}} --socket {{quote(socket)}} --output-dir {{quote(output_dir)}} {{args}}

# Developer file-only NDJSON oracle; its private prepared series arrives on stdin.
qualification-scene-stream node="node":
    {{quote(node)}} scripts/qualification/scene_stream.mjs

docs-build:
    npm run docs:build

docs-check:
    npm run docs:check

check:
    npm run check

build-native *args:
    ./scripts/build-native.sh {{args}}

build-host *args:
    ./scripts/build-host.sh {{args}}

# Compile and pure-test the explicit Darwin developer launcher; starts no Host.
build-host-launcher output_dir python clang sdk:
    /bin/bash scripts/qualification/build_host_launcher.sh --output-dir {{quote(output_dir)}} --python {{quote(python)}} --clang {{quote(clang)}} --sdk {{quote(sdk)}}

verify-native-inputs:
    python3 scripts/release/test_native_input.py

test-release:
    python3 scripts/release/test_native_input.py
    python3 scripts/release/test_release.py
    python3 -I -B scripts/release/test_native_release.py

# Explicit Darwin-only synthetic input-admission proof; never a real desktop.
test-observation-gate daemon output_dir:
    FRUITCTL_RUN_NATIVE_SYNTHETIC=1 python3 -I test/fruitctl-observation-gate.py --daemon {{quote(daemon)}} --output-dir {{quote(output_dir)}}

# Explicit Darwin-only autonomous permit proof against an owned synthetic producer.
test-native-permit daemon node output_dir:
    FRUITCTL_RUN_NATIVE_SYNTHETIC=1 python3 -I test/fruitctl-native-permit.py --daemon {{quote(daemon)}} --node {{quote(node)}} --output-dir {{quote(output_dir)}}

verify-release manifest assets_dir:
    python3 scripts/verify-release.py {{quote(manifest)}} --assets-dir {{quote(assets_dir)}}

# Explicit file-only native bundle review; does not qualify install or Apple trust.
verify-native-release manifest assets_dir:
    python3 scripts/verify-release.py {{quote(manifest)}} --assets-dir {{quote(assets_dir)}} --native-only
