# Home Manager consumption

Fruitctl owns the runtime and canonical skill. Your infrastructure repository
owns host profiles, SSH access, credential providers, service enablement and
agent configuration. Pin a full Fruitctl commit in `flake.lock`; a moving
`main` URL is a discovery link, not an installation receipt.

The flake exports `packages.<system>.fruitctl` (`default`, `runtime` and `proxy`
aliases), `homeManagerModules.default`, `overlays.default`, and the canonical skill at
`share/fruitctl/skills/fruitctl`. The Node package is available for ARM and x86
Darwin/Linux evaluation. `packages.aarch64-darwin.native-controller` supplies
the released alpha.11 signed controller; native VNC control is Apple Silicon
Darwin only. Linux uses the SSH bridge. The Host prototype has no public package
export or runtime payload.

```nix
inputs.fruitctl.url = "github:xoxd-ai/fruitctl/1ba90e84d4b6fe464c9146e7c41c4cffc3edf8e3";

# In the Home Manager module list:
imports = [ inputs.fruitctl.homeManagerModules.default ];
```

This tested alpha.9 source pin includes the portable runtime, skill,
qualification helpers, portable Host-installer interface and optional installer
`--timings`. Its Linux leaf package passed 665 of 666 offline checks on October
12, 2026, under Node 24.21.0; one declared real-curl check was skipped because
curl was unavailable. This package result does not qualify installing or
running the native Host.

An October 12 managed delivery passed through the infrastructure's normal
serialized Home Manager canary and follower path. The canary's Fruitctl
consumer stayed disabled; one enabled Linux seat received the alpha.9 package,
three skill roots and four generated MCP fragments. The selected source pin,
installed package metadata and projections matched the accepted alpha.9
package. This is a dated delivery observation, not broader fleet enablement or
a Darwin Home Manager installation.

A separate October 12 canonical component check used the installed Home Manager
package and shipped skill in two fresh Claude Code 2.1.295 CLI sessions using
the existing configured `claude-opus-5-5` model against an owned synthetic
desktop. They observed four complete images, made and reversed
two inputs, awaited two session releases and reconnected to the restored scene.
The run used normal settings without authentication, model or provider
overrides; recorded settings digests and metadata remained intact at the bound
checks. This is installed Home Manager synthetic MCP component evidence,
separate from the [public stock installer/configuration journey](agents.md).
Physical desktop, real SSH, native Host, macOS consent, other frontend
combinations and product SLO qualification remain open; Gateway/Junie remains
deferred.

Repin reviewed code changes after their own package check. Documentation-only
commits may advance `main` without changing the last tested code-source pin.
Every consumer's final pin, package realization and Home Manager activation
need their own recorded checks; changing this example does not upgrade a
published runtime archive.

The public [alpha.11 runtime](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.11)
is produced from `142743262d3242775f210c9d62a6b8e423c3ce5a`. Its Darwin runtime
carries a controller built, tested, signed and notarized from that same
revision, and the explicitly selected `native-controller` package consumes
those immutable bytes on any pin that includes the alpha.11
`nix/native-release.json`. Pins that include the alpha.10 file select the
alpha.10 controller produced from `a80d40a5b27f4917200f8248f813605f5c2c1fea`.
Earlier pins select the alpha.3 controller produced from
`e00fcc86bbac4247d5a0847d7e656369c52cc15f`, which alpha.9 also reused.
Advancing the source pin does not rebuild, patch or re-sign released bytes.
Later native source work on `main` does not supply a new public native artifact
through this pin.

### Historical package and delivery records

The historical alpha.8 source pin includes the portable runtime, skill,
qualification helpers and portable Host-installer interface. Its Linux leaf
package passed 622 of 623 offline checks on October 11, 2026, under Node
24.21.0; one declared real-curl check was skipped because curl was unavailable.
This package result does not qualify installing or running the native Host.

An October 11 managed delivery passed through the infrastructure's normal
serialized Home Manager canary and follower path. The canary's Fruitctl
consumer stayed disabled; one enabled Linux seat received the alpha.8 package,
three skill roots and four generated MCP fragments, with its relay service
disabled. The selected executables and installed package metadata matched the
accepted alpha.8 package. This is a dated delivery observation, not broader
fleet enablement or a Darwin Home Manager installation.

A separate October 11 component check used the installed Home Manager package
and shipped skill in two fresh Claude Code CLI sessions against an owned
synthetic desktop. The first session observed three complete images and made
and reversed two inputs; the second reconnected and observed the restored
scene. Both awaited session release. The run used normal settings without
authentication or model overrides; recorded settings digests and metadata
remained intact at the bound checks. This is installed Home Manager synthetic
MCP component evidence, separate from the [public-runtime journey](agents.md).
Physical desktop, real SSH, native Host, macOS consent, complete frontend and
product SLO qualification remain open; Gateway/Junie remains deferred.

These October 11 alpha.8 observations remain historical and do not qualify the
current alpha.9 source pin or its public runtime archive.

The earlier alpha.7 producer `cd34bbcdcc9e70bf25f77cbcfd1f129e1eac30db`
passed 556 of 557 offline package tests on October 10 under Node 24.21.0, with
one declared unavailable-curl skip. An October 10 normal canary/follower
delivery installed its package, three skill roots and four MCP fragments on
one enabled Linux seat; the canary consumer and enabled seat's relay stayed
disabled. A fresh login resolved alpha.7, and an October 11 read-only
follow-up still observed it before the later alpha.8 delivery. These are
historical snapshots; they do not qualify alpha.8 or an agent frontend.

Earlier package evidence for
`e599109df9b75fdec3e483b5e2f1b874db22f37f` and delivery records for
`2bf0e4b545123f700a344aa05c29d43854cb413e` remain historical. The immutable
alpha.6 runtime producer `8653325c6ccc0e058b3e4cf84eb44101cfd270fc` is also a
historical packaging record. None of their acceptance transfers to this pin.

## CLI and skills installation

Install the portable CLI and selected agents' canonical skills before declaring
a desktop connection:

```nix
programs.fruitctl = {
  enable = true;
  installOnly = true;
  agents = [ "claude" "codex" "pi" "junie" ];
};
```

This mode needs no target, credential file or SSH bridge on Darwin or Linux.
It installs the Node package and skill links, with no broker configuration,
MCP fragments, socket directory or service. `enableService` defaults to false
in this mode; explicitly enabling it, declaring targets or setting bridge
options is rejected. `mcpServers` is empty and `configPath` is null.

An explicitly selected `nativePackage` may also be staged on its supported
Darwin architecture. It stays null by default and is rejected on Linux or an
incompatible Darwin architecture; installation starts no native process
and grants no target access or macOS permissions. Selecting the published
controller verifies distribution integrity, without qualifying a desktop
connection or an agent frontend.

To configure a connection, set `installOnly = false` (its default) and declare
the controller prerequisites below. `enableService = false` in controller mode
still writes connection configuration and MCP fragments while withholding the
service. This allows an operator to inspect the complete configuration before
a separate activation.

## Darwin controller

`programs.fruitctl` is the public module namespace. A Darwin controller runs
one shared broker. Credentials remain runtime files on that controller;
neither Nix evaluation nor the Linux relay reads their contents.

```nix
{ config, inputs, ... }: {
  # sops-nix Home Manager secrets, materialized as private files at activation.
  sops.secrets."fruitctl/desktop-vnc" = { };
  sops.secrets."fruitctl/desktop-login" = { };
  programs.fruitctl = {
    enable = true;
    enableService = false; # Install packages/configuration before starting a broker.
    nativePackage = inputs.fruitctl.packages.aarch64-darwin.native-controller;
    agents = [ "claude" "codex" "pi" "junie" ];
    targets.desktop = {
      targetId = "office-desktop";
      vnc = { host = "127.0.0.1"; port = 15900; username = "alex"; };
      # A sops-nix materialized file; see the secret providers page for
      # command (vault, op, bw, sops), keychain and env providers.
      credential = { provider = "file"; path = config.sops.secrets."fruitctl/desktop-vnc".path; };
      # D16 type_secret allowlist: ref name to provider.
      secrets.login-password = { provider = "file"; path = config.sops.secrets."fruitctl/desktop-login".path; };
    };
  };
}
```

The credential provider must already resolve on the controller; check it with
`fruitctl doctor --secrets`. `credentialFile = "/absolute/path"` remains a
backward-compatible alias for a file provider. See
[secret providers](secrets.md) for the provider fields and checks.
The selected `nativePackage` supplies `bin/claude-kvm-daemon`; alternatively, an
absolute `targets.<profile>.daemonPath` selects an independently provisioned
client. The module defaults off and `nativePackage` defaults to null, so no
native release or service is selected implicitly. The existing target Screen
Sharing service and controller-side SSH tunnel must be established separately.
Keep credential
paths as strings: a Nix path literal or `builtins.readFile` would copy secret
material into the store. Do not put a password in a target profile, agent
configuration, activation command or environment definition.

The module writes the `fruitctl.config.v1` target document under
`~/Library/Application Support/fruitctl/config.json` and supplies an Aqua-user launch agent,
`ai.xoxd.fruitctl.broker`. `enableService = false` installs the configuration
without starting a service. The broker uses a private Unix socket below the
user's state directory. It does not enable
Screen Sharing, grant TCC, install the host indicator, or create an SSH tunnel.
Those prerequisites retain their existing owners.

An optional `targets.<profile>.targetId` records a stable physical-desktop
identity. Use one profile per desktop. The broker rejects duplicate explicit
identities, duplicate configured VNC endpoints (including known loopback
aliases), and reused helper SSH hosts. Different tunnel ports or SSH aliases
can still reach the same machine, so assign its physical identity explicitly;
the broker does not infer arbitrary network aliases.

An optional `targets.<profile>.inputSource` declares the target's expected
input source, such as `com.apple.keylayout.US`. `fruitctl doctor --macos`
warns `input_source_mismatch` when the target selects another one
([target profile](target-profile.md#input-source)).

`targets.<profile>.input.pasteUnmappable` and `targets.<profile>.clipboard`
(`read`, `maxBytes`, `ttlMs`, `extended`) set the target's paste routing and
clipboard policy ([clipboard](target-profile.md#clipboard-and-paste-routing)).
Both default off, apart from `clipboard.extended`. Linux declares none of them.

The optional Host/indicator remains a private prototype until its exact
capture mode passes background and indicator-exclusion qualification. Alpha.8
ships no Host app, ZIP, package export, service or helper mapping. The existing
`targets.<profile>.hostHelper` option remains available for independently
qualified private work and defaults to null; configuring it does not install or
start an app. Home Manager never creates a qualification receipt or infers
display geometry.

`hostHelper` names its display by `displayId`, `displayUuid`, or both. The
CoreGraphics display UUID survives display-ID changes across reconnects; run
the Host with the same `--display-uuid` (`FruitctlHost --doctor` lists online
UUIDs). A UUID-only profile learns the current ID from validated Host health, and
every request carries the UUID for the Host to recheck. A qualified `mapping`
repeats the same identity and may set `scale` (pixels per point, 1-8): a capture
at another scale then refuses input even when its pixel sizes match. On a HiDPI
display the Host now captures the mode's pixel framebuffer, not its point size,
so a mapping qualified against point-sized captures refuses input until it is
requalified with the new `nativeWidth`/`nativeHeight`. Unset
fields are omitted from the generated configuration, never written as null.

The `native-controller` package extracts only the unchanged signed controller
from the [alpha.11 Darwin runtime](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.11).
Its output contains `bin/claude-kvm-daemon`, the native notices and curated
release metadata; the separate Node package owns `bin/fruitctl`. Archive,
executable and notice hashes, archive file modes, ARM64 linkage and the strict
Developer ID signature are checked. Nix makes store files read-only, so the
archive executable mode `0755` need not remain unchanged in the store; the
executable bytes and signature remain unchanged. Fixups, stripping and
re-signing are disabled.
The exact artifact and corresponding-source bindings live in
[`nix/native-release.json`](../nix/native-release.json), the alpha.11
controller input. Apple returned `Accepted` for its controller-ZIP submission
`ed81cbd8-3a8c-4113-a1c3-455a4781c5c5`; that does not notarize the complete
runtime archive. The command-line tool is not stapled. These checks do not
qualify real VNC authentication, target pixels/input mapping, an agent frontend,
the Linux bridge journey or product SLOs.

`packages.aarch64-darwin.legacy-native` consumes the existing
`daemon-v1.0.2-tinyland.4` asset as immutable bytes. It checks the archive,
binary and receipt hashes, expected signing identifier and Developer ID team,
and disables binary fixups/stripping. It is a historical diagnostic baseline;
it **does not include the current fresh-frame repair**. Selecting it explicitly
does not qualify a new Fruitctl release. It remains separate from the explicitly
selected alpha.11 `native-controller` package.

## Linux SSH controller

Linux runs the portable Node relay and attaches to the existing Darwin broker
over SSH. Declare profile names only. The Darwin broker resolves those names
to its own VNC connection and credential files.

```nix
{
  programs.fruitctl = {
    enable = true;
    bridgeHost = "desktop-controller"; # Existing SSH config alias.
    # Prefer the immutable executable selected by the bridge's HM generation:
    bridgeCommand = "/nix/store/<qualified-runtime>/bin/fruitctl";
    targets.desktop = { };
  };
}
```

`bridgeCommand` defaults to `fruitctl` when the remote non-interactive PATH is
already correct. `bridgeSocketPath = null` uses the remote user's default
socket (`~/Library/Application Support/fruitctl/run/broker.sock` on Darwin);
set an absolute remote path only when the bridge uses a custom socket.
The local `socketPath` is separate, so Linux `/home/...` and Darwin `/Users/...`
paths never need to match. The systemd user service stays foreground, owns one
persistent SSH attachment and stops within five seconds. SSH host keys and
authentication remain owned by your SSH
configuration. Linux gets no broker credential document and no native package.

The Linux relay keeps its local socket when the bridge drops and reconnects
on its own. Backoff starts at about one second and doubles to a 30-second cap,
with ±20% jitter. It resets only after a link has stayed up for 30 s, so a
bridge that greets and then drops keeps backing off instead of retrying every
second. SSH keepalives retire a dead network within about 15 s. The relay also
probes the remote `attach --mux` every 15 s and retires a link that sent
nothing for 45 s, which covers a live SSH session whose remote end stopped
answering. A successor SSH child starts only after the previous one has exited.
Each retry is logged with its cause, attempt number and how long the lost link
was up. Nothing a client sent over a lost link is replayed:

| Client state when the link fails | Typed error |
| --- | --- |
| Nothing answered yet (no `opened`, so no input was possible) | the classified cause, for example `bridge_auth_refused` |
| Answered, with work possibly in flight | `bridge_lost` (execution is uncertain) |
| Connects while the bridge is down | the last classified cause, answered at once, or `bridge_unreachable` with reason `reconnecting` when the last loss was `bridge_lost` or `bridge_protocol` |

The classified causes are `bridge_unreachable`, with reason `dns`, `refused`,
`network`, `ssh`, `ssh_unavailable`, `unresponsive` or `reconnecting`, and `bridge_auth_refused`,
`bridge_host_key`, `bridge_command_missing`, `bridge_attach_failed`,
`bridge_protocol` and `bridge_broker_unavailable`. They come from SSH's exit
status and stderr, which is read only on the seat: its text never reaches a
client, the journal or a log line. The agent's MCP result carries the same
code in `error.code`, both for a call in flight and for every later call on
that MCP session; the session does not reopen itself, so reconnect it (in
Claude Code, `/mcp`) once the relay reports `up`.

Two exit statuses tell systemd not to restart the relay. Status 3 means the
relay could not confirm that a lost SSH child exited; reconcile the target
first. Status 78 means the command line is wrong, so a restart cannot help.
Any other failure restarts the relay after 5 s, up to five starts in five
minutes. `KillMode = control-group` stops any child of a former relay from
outliving it.

`fruitctl relay --health` asks the running relay for its state without
touching the bridge. It prints a `fruitctl.relay-health.v1` document with
`state` (`connecting`, `up`, `down` or `closing`), `attempts`, `retryInMs` and
`lastError`, and it exits 0 only while the bridge is up. `attempts` stays
non-zero until the current link has been up for 30 s. An older Darwin
`attach` sends no hello, so with one the relay reports `connecting` until it
answers the first probe or session.

On Linux, the module exports `FRUITCTL_SOCKET_PATH` and `FRUITCTL_BRIDGE_HOST`,
plus `FRUITCTL_BRIDGE_COMMAND` when `bridgeCommand` is not the default. Health
and doctor then find the managed relay and bridge without extra flags.
`fruitctl doctor --macos --target <profile>` runs the target preflight on the
Darwin bridge, through this seat's SSH configuration for that alias, because
the bridge owns the profile. `--target-ssh` is forwarded to the bridge when
`--bridge` is explicit; without `--bridge`, `--target-ssh` stays a direct probe
from this seat.

A `type_secret` action crosses the bridge as a reference only (D16). The relay
applies the broker's own shape check, `{ref, x?, y?}`. Any other shape is
refused with `invalid_secret_request` before it leaves the seat, so a value
never reaches the bridge.

The Darwin broker keeps `KeepAlive = false`, and its recovery is an
operator-owned action. If owned input cleanup is unconfirmed, reconcile the
target and verify held input is cleared before restarting the broker. The
broker's quarantine is process-local; restarting it does not prove cleanup
succeeded.

This is the initial Rocky/Linux architecture. A passing Nix evaluation proves
configuration shape; an initialize, changing-frame capture and control journey
over the selected bridge is required for runtime qualification.

## Agent configuration and skills

The module reads the same `integrations/agents.json` manifest as the public
installer. It links the canonical skill to each selected agent's current
user skill root, de-duplicating shared `.agents/skills/fruitctl` destinations.
Claude uses `.claude/skills/fruitctl`; Junie uses `.junie/skills/fruitctl`.

MCP fragments are written under
`~/.config/fruitctl/agents/<agent>/<profile>.json` (Codex uses `.toml`). Each
starts `fruitctl mcp --target <profile> --socket <local-socket>`; the command
cannot select arbitrary hosts or read target credentials. Its server name is
`fruitctl-<profile>`, so fragments for multiple profiles can be merged without
replacing one another. Merge a fragment
through the module that already owns that agent's configuration, or use the
read-only `config.programs.fruitctl.mcpServers` attribute set. Home Manager
does not silently overwrite existing Claude, Codex, Junie or Pi configuration.

Junie's `~/.junie/mcp/mcp.json` is mutable because Junie writes enabled state.
Preserve unknown servers and operator toggles when merging. IntelliJ's
integrated AI Assistant configuration uses its documented settings interface;
a Junie CLI entry is not evidence that the integrated IDE client is enabled.
Pi native MCP requires the version recorded in the agent manifest. A rendered
fragment or skill link is configuration evidence, not a successful agent
desktop journey.

For fleet adoption, preserve existing server/tool names and policies in the
owning infrastructure module while replacing its runtime/skill source with
this pinned package. Validate package evaluation, target selection, secret
absence from generated agent files, and service argv before an attended switch.
No public configuration imports a fleet host inventory or private transcript.
