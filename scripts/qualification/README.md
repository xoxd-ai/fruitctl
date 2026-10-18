# Explicit Host launch developer utility

`launch_host_once.m` is a source developer qualification tool for an already
reviewed Fruitctl Host bundle on macOS 15+ Apple silicon. It is absent from
runtime release bundles and is not called by the installer or broker. The
broker's `--stdio` shim continues to attach to a resident app.

The helper reads a private runtime request, so changing the transaction, app
installation or previously observed PID does not require editing its source.
It never terminates an instance, enables capture, grants permission or supplies
arguments to Host. It refuses a registered running `com.xoxd.fruitctl.host`
instance. The caller owns any preceding attended shutdown and fresh process
checks; a bundle registry census is not a kernel census.

## Build and pure checks

Select installed Apple clang, a canonical installed macOS SDK and an existing
Python 3.9+ interpreter explicitly. Do not use the macOS `/usr/bin/python3`
installer stub. Use an exclusive output directory under an existing owned
canonical parent, and the fleet's existing build placement/custody rules.

```sh
just build-host-launcher \
  /absolute/owned/new-launcher-build \
  /absolute/verified/existing/python3 \
  /absolute/verified/Apple/clang \
  /absolute/canonical/MacOSX.sdk
```

The wrapper runs compiler version metadata, syntax (10 seconds), one link
(20 seconds) and `--offline-self-test` (2 seconds), within a cooperative
37-second productive and 3-second cleanup budget after Python starts. It
records input/output hashes, direct child metadata and dedicated-group closure.
Output limits are checked after capture, not hard memory bounds. If ownership,
reaping or descendant closure cannot be established, it reports failure and
retains the recorded pending scope for its caller; it never signals a foreign
process or assumes a compiler's exit closes its descendants. The caller must
supervise the invocation, including interpreter startup and any pending scope.
Fleet bench custody belongs to the existing operator rail, not this public tool.

The offline branch executes the real request and completion predicates using
value fixtures before any UID, file, process, console, app registry or workspace
access. It covers multiple paths, spaces, runtime previous PIDs, PID reuse,
strict JSON types, bounds, expiry and unexpected fields. Compilation and these
pure checks do not qualify an actual launch, TCC, capture or the purple overlay.

## Runtime request

The caller must construct the request from its **operator-configured target
and verified artifact**, never from an MCP tool's target/path arguments. Before
dispatch, verify the complete payload and expected signing/designated identity
and exclude other writers. `sourceBindingSha256` and `authoritySha256` below
are correlation references to that caller's records; this helper checks their
format and does not authenticate those records or perform signature verification.

Create a fresh canonical directory owned by the current user with mode 0700,
and a regular, single-link mode-0600 `launch-request.json`. Every field below
is required; unknown fields are rejected. This abbreviated example replaces
each placeholder with the actual lowercase 64-digit SHA-256/nonce value and
fresh **target-clock** times before use:

```json
{
  "schema": "fruitctl.launchservices-native-request.v2",
  "appPath": "/Applications/FruitctlHost.app",
  "executablePath": "/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost",
  "bundleIdentifier": "com.xoxd.fruitctl.host",
  "arguments": [],
  "oldPid": null,
  "nonce": "<64 lowercase hex digits>",
  "sourceBindingSha256": "<64 lowercase hex digits>",
  "authoritySha256": "<64 lowercase hex digits>",
  "issuedAtUnix": 100,
  "expiresAtUnix": 108
}
```

`appPath` must be an absolute canonical existing `.app` directory, and
`executablePath` must be its exact `Contents/MacOS/FruitctlHost` executable.
The bundle's identifier and declared executable must match. Spaces and Unicode
names are supported; dot/parent/empty components, control characters and
symlinks are refused. App/executable ownership must be the current user or root,
with no group/other write bit. These metadata checks do not prove signed bytes
or prevent a simultaneous writer; the caller's artifact checks remain required.

`oldPid` is either null (no previously excluded PID) or a positive integral PID
greater than one. It is an exclusion supplied by the caller, not proof of
process ownership or permission to terminate anything. A callback with that
same numeric PID is conservatively unknown even if the number may have been
reused. Post-launch kernel birth/image/user checks still establish real custody.
Booleans and numeric strings are not numbers in this protocol.

Request times must be finite, positive, ordered, already issued and not expired;
their interval is at most 10 seconds. Different machine clocks are not assumed
synchronized. The native callback deadline uses monotonic elapsed time and is
at most 8 seconds, shortened to the request's remaining lifetime.

Only an explicitly authorized attended launch uses:

```sh
/absolute/owned/new-launcher-build/fruitctl-host-launch-once \
  --request /absolute/owned/new-transaction/launch-request.json
```

The current user must also own the console session. The request directory is
held by an open descriptor; the request is opened without following symlinks,
and descriptor/named identity is renewed. The helper consumes the request once
into exclusive `native-launch-consumed.json` before its single NSWorkspace
call. Host always receives an empty argument array and fixed minimal launch
environment. Existing consumption is refused, including after an earlier error.

The helper sets new-instance=true, substitution=false, prompts=false and
activation=false explicitly. Apple's API delivers its callback on a concurrent
queue; the helper serializes it and its timer on the main queue. Exact callback
bundle/executable paths, bundle identifier, integral PID, non-terminated state
and launch date are required. `native-launch-result.json` is exclusive and
records a nonce, status, callback metadata and `retryAllowed:false`. Errors and
timeouts remain unknown: the app may exist even if completion was rejected.
Never automatically replay the request or switch to an opener. No callback
metadata alone proves payload signature, process custody, health, permission or
capture readiness. Renew kernel identity and app health independently before
any later activity. `promptsUserIfNeeded=false` controls this API's UI; it does
not disable prompts that the launched app or macOS may independently present.

Apple's primary API contracts: [openApplication](https://developer.apple.com/documentation/appkit/nsworkspace/openapplication(at:configuration:completionhandler:)),
[new instance](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/createsnewapplicationinstance),
[substitution](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/allowsrunningapplicationsubstitution),
[prompts](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/promptsuserifneeded),
[running app metadata](https://developer.apple.com/documentation/appkit/nsrunningapplication),
and [launch date](https://developer.apple.com/documentation/appkit/nsrunningapplication/launchdate).

## Streaming scene file oracle

`scene_stream.mjs` checks a prepared series of complete PNG files using the
tracked fixture generator and unchanged full-raster oracle. It reads files and
NDJSON only; it does not launch, connect to, capture from or send input to a
desktop. It is a source developer command, absent from runtime release bundles.

Generate a fixture with `node test/qualification/generate.mjs OUTPUT.html RUN_ID`.
Use its 32-character lowercase hexadecimal run ID and the SHA256 of those exact
HTML bytes in the first input line. The series directory must be an existing
canonical directory owned by the current POSIX user with mode `0700`.

```json
{"directory":"/absolute/owned/frames","runId":"0123456789abcdef0123456789abcdef","width":1920,"height":1080,"maximumFrames":30,"fixtureSha256":"REPLACE_WITH_EXACT_64_CHARACTER_SHA256"}
{"file":"/absolute/owned/frames/frame-01.png","number":1}
```

Supply one numbered line for every requested frame, through 30 or 600, followed
by EOF. `maximumFrames` selects the complete requested series, not an allowance
for a shorter successful series. Names are `frame-01.png` through `frame-30.png`
or `frame-600.png`, with at least two decimal digits. Each file must be owned by
the same user, mode `0600`, regular, singly linked and at most 12 MiB. Finish
writing each file before submitting its line; do not replace or edit submitted
files. Strict UTF8 input is limited to 8192 bytes per line and 4 MiB in total.

```sh
just qualification-scene-stream /absolute/existing/node24 < series.ndjson > scene-results.ndjson
just test-qualification /absolute/existing/node24
```

Output is one prepared record followed by serial per-frame records, including
the PNG hash, all seven marker checks, advancing sequence and full-raster
diagnostics. The command waits for each output write before processing the next
record; input streams can buffer ahead. Its caller must drain output and
supervise any interactive wait.
Exit `0` means the complete requested series passed. Exit `1` follows the first
emitted `failed-scene` record and stops further processing. Exit `2` means
malformed, oversized, inaccessible, changed or incomplete input, including an
early interactive EOF or malformed PNG. Existing private workers can have
different exit semantics; this command does not replace them automatically.

The directory stays open and its named/descriptor identity, ownership and mode
are renewed around each frame. Frame descriptor/named metadata and complete
reads are bracketed; final symlinks are refused. Directory timestamps and link
counts may change as the caller supplies new files (APFS counts every entry in
a directory's link count). These checks are not an atomic
filesystem snapshot: the caller must control concurrent writers and directory
ancestry. Neither simulated fixture timing nor a passing file series proves
600 actual captures in 60 seconds, Host identity, permission, physical Stop,
input revocation, cursor attribution or capture-indicator exclusion. The oracle
keeps complete pixels and the existing narrow pointer diagnostic; it applies
no masking, cropping or color repair.

## Overlay exclusion gate (attended, Host route)

`overlay_exclusion_gate.mjs` checks that agent frames from the Host route do not
contain the Host's own activity overlay. It is an MCP client of the operator's
configured target profile (`fruitctl mcp --target PROFILE`), so it sees exactly
the frames an agent sees. It sends only `health` and `screenshot`; any other
action is refused before it is sent. It never launches the Host, grants a
permission, sends input or masks pixels. Closing the client releases the lease.

Prerequisites are attended: the Host installed and running with Screen
Recording granted and capture enabled, a profile with `hostHelper` for that
Mac, and the scene fixture (`test/qualification/generate.mjs`) shown full screen
so the background is a known neutral.

```sh
just qualification-overlay-gate PROFILE /absolute/control.png /absolute/new-output-dir [--save-frames ...]
```

Defaults are 600 captures at a 100 ms cadence (the 600-frame/60-second gate).
Each capture is a fresh `screenshot`, so the Host's activity lease and its
overlay stay up for the whole series. A frame passes when:

- its labels say `route: host`, `indicator: present`,
  `capture_backend: owned_sck`, `raw_vnc_exclusion: false`,
  `overlay_ready: true` and `capture_enabled: true`, so the overlay was attested
  on screen and the pixels came from the Host's filtered capture, not raw VNC;
- no pixel has the overlay's purple signature (`min(R, B) - G >= 12`; the
  overlay is sRGB 75/0/130 from `FruitctlHost/HostRenderer.swift`). Neutral and
  cyan fixture pixels, and any scaling of them, score 0 or less.

The series stops at the first failing frame, which is always saved. Add
`--save-frames` to keep every frame (private evidence). Latency is the MCP
round trip per capture; the receipt reports p50/p95/max, and fewer than 95% of
captures within `--latency-limit-ms` (default 5000, the warm-capture SLO) fails.

**Positive control.** An absent signature only means something if the overlay
was really visible and the detector would have seen it through the same colour
pipeline. During the run, capture the same display through a path that does not
exclude the overlay (for example a Chrome Remote Desktop screenshot) and save
it at the `--control` path. The image must be the remote display alone, edge to
edge (Chrome Remote Desktop full screen, or cropped to the remote display): the
gate checks the outer ring, so local window chrome around it cannot anchor. The
gate reads it after the last frame and requires the signature on at least half
of the outer ring on every side, and a file modification time no earlier than
the start of the series, so a control left from an earlier run cannot anchor a
new one. Without such a control the result is `unanchored` (exit 1), never
`passed`. An unreadable agent frame fails as `undecodable_frame` and is saved.

`overlay-exclusion-receipt.json` in the new output directory records each
frame's hash, latency, overlay pixel count and label failures. Exit 0 is
`passed`, 1 is `failed` or `unanchored`, 2 is a usage or transport error. The
gate does not qualify scene validity (use `scene_stream.mjs`), consent, Stop,
input mapping or the human-visible heartbeat.


## Attended live qualification kit (PZM)

Five drivers and one checklist for the next attended window, run in this
order. Each driver is an MCP client of the operator's configured profile,
started exactly as a frontend starts it (`fruitctl mcp --target PROFILE
--socket /abs/broker.sock`), and refuses to run without `--attended`, an
interactive terminal and a new absolute `--output-dir` (created mode 0700).
It prints each operator step and waits for Enter (`s` skips, `a` aborts),
saves every returned frame with its SHA-256, and writes
`<gate>-result.json` (`fruitctl.live-qualification.v1`): every check with its
expected and observed value, operator steps, and each call's code and
latency. A gate is `passed` only when every check ran and passed; a skipped
step makes it `incomplete`, and the gate sends no input that depended on it
(skipping the TextEdit step ends gates (c) and (d) before any paste or typing). Exit 0 is `passed`, 1 is `failed` or
`incomplete`, 2 is a usage or transport error. Drivers never launch an app,
change a setting, answer a dialog or run anything on the target; the
operator does that when a step asks. Output is private evidence.

```sh
just qualification-live GATE PROFILE /abs/broker.sock /abs/new-output-dir [gate flags]
# GATE: desktop_state | ax | clipboard | type_secret | overlay_600
# --fruitctl /abs/installed/fruitctl selects the installed launcher under test.
```

**Prerequisites.** Node 24 with `npm ci`; the release under test installed on
the Darwin controller and its broker running; the Host installed, capture
enabled, Screen Recording and Accessibility granted (expect one Screen
Recording re-confirmation on the first capture after an install, per D38).
Profiles on the broker: `pzm` on the Host route (`hostHelper` with the
qualified mapping, `desktopState` reaching the console user,
`clipboard.read: true`, `input.pasteUnmappable: true`, and a `secrets` entry
`qual-canary` with the `file` provider); `pzm-raw`, the same Mac without
`hostHelper`; `pzm-noclip`, the same Mac with `clipboard.read: false`. On the
broker host, write a throwaway canary of 16+ characters to the canary file,
mode 0600. Never allowlist a real credential for this kit.

| Order | Gate | Flags | Operator steps | Passes when |
| --- | --- | --- | --- | --- |
| 1 | `desktop_state` (a) | — | Lock the screen, then unlock; run `pmset displaysleepnow` in your own Terminal on the target, then wake it; raise a real system dialog (an administrator prompt or a TCC consent prompt), then answer it | `health` reports each state; a `mouse_move` probe is refused `target_locked`, `display_asleep`, `human_consent_required` (with `owner` and `kind`); after each clear, `health` is clear and the probe is admitted |
| 2 | `ax` (b) | — | Open a popover with a button (Notes **Aa**), a sheet (TextEdit save sheet), keep the menu bar visible; pick the element when several match; confirm the effect | `ax_snapshot` succeeds; `click_element` returns `verified: true` and the Host names the surface (`popover`, `sheet`, `menu_extra` or `control_center`); the frame changes; a fresh snapshot succeeds; operator confirms |
| 3 | `clipboard` (c) | `--read-disabled-target pzm-noclip` | Focus an empty plain-text TextEdit document | `paste` of emoji/CJK text round-trips through `clipboard_read` exactly, `utf8`, `fresh: true`; a routed `key_type` reports `kind: "paste"` and the clipboard reads back the saved value; `pzm-noclip` refuses `clipboard_read_disabled` with no text |
| 4 | `type_secret` (d) | `--ref qual-canary` | Focus an empty plain-text TextEdit document | An unlisted ref is refused `secret_ref_not_allowed`; `type_secret` succeeds with no value in its result; copying the typed text makes `clipboard_read` return `redacted: true`, which the broker does only for a declared secret; the field and clipboard are cleared |
| 4b | journal check | on the broker host: `node scripts/qualification/live_type_secret.mjs --check-journal FILE --secret-file PATH` | Choose the newest `journal/<session>.jsonl` (`ls -t`) | The chain verifies, the canary appears nowhere, and every `type_secret` record keeps only `ref`, `x`, `y`, `provider`, `length_class` |
| 5 | `overlay_600` (e) | `--control-target pzm-raw [--control-at 300] [--save-frames]` | Show the scene fixture full screen, or a desktop with neutral edges | 600 Host frames at 100 ms, all attested Host labels, none with the overlay in any 4 px edge band, and 95% within 5 s; the raw VNC control taken mid-series, while the Host lease is up, shows the overlay on at least half of every band. This is the D41/D42 gate receipt (`overlay-exclusion-receipt.json`) |
| 6 | relay journey (f) | checklist below | | |

Gate (e) uses the edge-band detector of the attended 2026-10-17 run
(`--detector edge-band` on `overlay_exclusion_gate.mjs`): a pixel is tinted
when R − G ≥ 25 and B − G ≥ 45, read in 4 px bands at each edge; a Host frame
fails when any band is at least 1% tinted. The tint is visible over neutral,
light, dark and purple backgrounds but not over saturated blue, green or red
(an edge with R < G − 10 or B < G − 14). Such an edge cannot anchor the
control, so the result is `unanchored`, never a false `passed`. Gate (e)
requests `format: "png"` for every frame (D38), as the standalone gate does.

**Relay journey checklist (f), Rocky Linux seat to the Darwin broker.** Run on
the Linux seat with its relay attached to the Darwin bridge:

1. `fruitctl relay --health` reports `up` (an older Darwin attach without a
   hello reports `connecting` until the first session is answered).
2. From the Darwin host, `fruitctl doctor --macos --target pzm` passes; from
   the seat, the same command runs through the bridge.
3. Run gates (a), (c) and (d) on the seat with `--socket` set to the relay
   socket (`$XDG_RUNTIME_DIR/fruitctl/relay.sock`). The same checks must pass;
   the seat never holds the canary or the VNC credential.
4. Run the journal check (4b) on the Darwin host against the seat's
   `type_secret` session: the seat sent the ref only.
5. During one idle session, the operator interrupts the bridge (for example
   stops the seat's SSH connection). The next call fails with a typed
   `bridge_*` code (`bridge_lost` only when the link was confirmed and work
   may be in flight), nothing is replayed, and `relay --health` returns to
   `up` once the bridge is back. The interrupted MCP session does not reopen;
   a new session must work.
6. On the Darwin host, each seat session left its own journal file and
   `fruitctl journal verify` returns `"ok": true` for each.

The kit qualifies these behaviours on one Mac and one release. It does not
qualify a frontend (see the frontend acceptance journey in `docs/agents.md`),
Stop, the human-visible heartbeat or the product SLO.
