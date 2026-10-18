# Architecture

Fruitctl separates the agent protocol, the shared desktop controller, and the
human indication shown on a target. The public producer owns these interfaces;
fleet configuration and deployment belong to each consumer.

## Components

| Component | Responsibility | Platform |
| --- | --- | --- |
| Agent adapter | Configure MCP and install the shared skill | Harness-dependent |
| Shared relay | Forward agent requests and observations | Node.js 24 |
| Darwin broker | Own target profiles, credentials, control leases, and native transport | macOS |
| Native VNC client | Decode target pixels and send remote input | Apple Silicon macOS 15+ baseline |
| SSH bridge | Attach a Linux seat to the Darwin controller | Linux client to Darwin |
| Target indicator | Show the human an active control session | Optional macOS app |
| Filtered capture | Exclude the indicator from qualified observations | Optional macOS ScreenCaptureKit path |

The control path is `MCP → relay → Darwin broker → native VNC → target`.
The indicator/capture path is separate. Existing `vnc_command`, `action_queue`,
and completion tool names remain compatible while their implementation is
refactored. See the [MCP schemas](../tools/index.js) for actual action names.

The current-source SSH relay stops admitting clients when shutdown begins.
Its directly spawned SSH child and local listener share one monotonic retirement
cutoff, with a two-second default; inherited timeouts, deadlines and cancellation
can only shorten retirement. Success requires both the child's drained `close`
event and the listener's close callback. Abort, deadline expiry or unknown
closure returns sticky `release_unconfirmed`, including during startup cleanup
or bridge loss; late closure cannot revise that result or replay input. This
source repair is newer than immutable alpha.7 and is not installed-runtime or
Home Manager delivery qualification.

As a service, the relay keeps its listener when the bridge drops. It answers
clients with a typed bridge error and reconnects with capped, jittered backoff.
A successor SSH child starts only after its predecessor drained `close`. Lost
work is never replayed. If a lost child cannot be confirmed closed, the relay
exits with status 3 and does not start a successor. `fruitctl relay --once`
keeps the single-link behaviour. See
[Linux SSH controller](home-manager.md#linux-ssh-controller).

## Backend capabilities

Current source advertises a bounded native action list at readiness and includes
`capabilities: { known, actions }` in MCP health results. Missing metadata from an
older controller remains `known: false`; its existing compatible actions still
work. An explicitly empty native list advertises no supported native actions.
Capabilities describe supported routes, not desktop, permission or input-mapping
qualification. The experimental helper reports its wrapper routes separately
from the native list and requires qualified mapping for input.

Known unsupported actions reject the whole batch before action writes or helper
activity acquisition. A healthy owner's lease and queued compatible work remain
available. Discovering capabilities can start the configured backend; this does
not promise zero initial startup. Failures after admission still retire uncertain
execution, and remote or forged refusal codes cannot bypass cleanup. These source
changes are newer than immutable alpha.7.

## Session and credential ownership

One broker owns each target's live control state. The operator selects a named
profile that fixes the target and credential provider. Tool arguments cannot
redirect that profile. A Linux bridge carries requests and observations without
receiving the target secret. Credentials never become command-line arguments,
adoption receipts, or public configuration.

Use one profile per desktop. Before opening its socket, the broker rejects
known overlaps in VNC endpoints, helper SSH hosts, and explicit `targetId`
values. The operator may assign that stable physical identity when different
addresses name the same machine. Fruitctl does not guess DNS or SSH aliases;
the operator must resolve those aliases and keep one controller owner for the
desktop.

The broker binds a target lease to the connected relay client. Each accepted
execute request from that owner renews the default 60-second lease; another
client is rejected while it is owned or releasing. `task_complete` and
`task_failed` release control, as do disconnect and lease expiry. Release cancels
pending input, releases held native input, and closes the executor before a
successor may acquire the target. Unconfirmed cleanup blocks the target until
the operator reconciles it. An unused native executor also has a five-minute
idle cleanup deadline.

Reconnect requires a new observation and cannot replay previous input. The
optional target app has its own short-lived indicator lease and local stop
control. In the experimental helper path, the executor starts target activity
on the task's first admitted non-health request and renews it every 500
milliseconds across requests and agent thinking gaps. It ends activity on explicit task release,
completion, failure, disconnect, or the broker's 60-second ownership expiry.
Input requires a current ready acknowledgement and independently
qualified mapping. The helper-backed source additionally binds each permit to
the native controller's own challenge, monotonic deadline, helper session, and
current display/framebuffer generation. The native writer checks that permit
before admitting each VNC input event, independently of broker scheduling.
Renewal controls bypass the action queue; expired required permits cannot be
revived by a later acknowledgement or image. Controllers without this private
capability refuse helper-backed input. Loss of the helper, acknowledgement, or
permit retires the executor; uncertain input is never replayed.

Owned synthetic tests cover a responsive native writer while its broker
producer is suspended. They do not qualify a real target, input mapping, or
physical indicator. Neutralizing held-key/button releases may follow expiry;
an already blocked native write or a suspended native process remains outside
the responsive-writer timing proof. The broker's 60-second ownership lease
alone does not prove that the human indicator is active.

### Display wake hold

A target profile may opt in to a display wake hold:

```json
"wake": { "ssh": "alex@office-desktop", "enabled": true }
```

While a client owns that target's lease, the broker runs
`ssh -tt -o BatchMode=yes … -- alex@office-desktop caffeinate -d -u` from a
fixed argument vector, with no local shell. The remote terminal makes the
connection's end hang up `caffeinate`, so it does not outlive the hold. Lease
renewal reuses the running hold. Explicit release, task completion or failure,
disconnect, lease expiry and broker shutdown terminate it. A Host Stop ends it
when the broker retires that lease: on the next refused request, or at the
lease's expiry. The destination uses the same character set as the helper and doctor SSH
validators and an invalid `wake` profile stops the broker before it opens its
socket. `enabled: false` turns the hold off without deleting the destination.

The hold is advisory. Spawn or exit failures are logged on the broker's
stderr, backed off for 30 seconds, and reported in each `health` result as
`wake: { configured, state, failures, last_error?, last_stop? }` with state
`holding`, `idle` or `failed`. They never fail the lease or its input. A hold
that is running is not proof the display is awake; capture freshness still
decides.

`display_asleep` is the stable error code for an asleep display. The broker
never infers sleep from pixel colour. It raises the code from two explicit
signals: the desktop-state sentinel below reporting the main display asleep
(before input), and a native error whose `data.reason` is `display_asleep`.
The native daemon does not emit that signal yet, so without a sentinel an
asleep display surfaces as `stale_screen` or another capture failure.

### Desktop-state sentinel

Before a batch that contains input, the broker reads the target's desktop
state with one fixed, read-only script over the profile's SSH destination
(`desktopState.ssh`, else `wake.ssh`, else `hostHelper.sshHost`) and refuses
the batch before it starts or uses the VNC executor when the state is known
to block input: `target_locked` for the lock screen or login window,
`display_asleep` for an asleep main display, and `human_consent_required` for
an on-screen window of a consent or system dialog owner. These are broker
string codes; numeric JSON-RPC codes stay with the native controller. The refusal is pre-admission: nothing is sent, the executor is
not retired and the lease is kept. The journal records it as `refused`. The
script shares doctor's probe fragments and parsers; it reads no window titles
or pixels and never answers a dialog (D16). Results are cached for about 2 s.
Health and screenshot results carry `desktop_state`; a screenshot never waits
for a probe and reports a cached sample only while it is fresh (else `unknown`,
`stale`), and health waits at most 1.5 s, within its deadline, for one already
running. Before input the probe gets at most half of the batch's remaining
budget. An unreachable, slow or unconfigured sentinel is `unknown` and refuses
nothing.
Fields and codes: [target profile](target-profile.md#desktop-state-sentinel).

### Action journal

The broker appends a hash-chained JSONL journal for each client session, one
file per session UUID under its state directory: `journal/<session>.jsonl` in
`~/Library/Application Support/fruitctl/state` on macOS, or
`$XDG_STATE_HOME/fruitctl` (default `~/.local/state/fruitctl`) elsewhere.
`FRUITCTL_STATE_DIR` overrides the state directory. The directory is private
`0700` and each file `0600`. Configure it at the top level of the broker
config:

```json
"journal": { "dir": "/absolute/path", "enabled": true }
```

The journal is on by default; `enabled: false` turns it off.

Each requested action becomes one `fruitctl.journal.v1` record: `seq`, `ts`,
`session`, `target`, `method`, `params`, a bounded `result` summary with its
`outcome` (`ok`, `error`, `failed`, `not_run`, `refused` or `not_admitted`),
`frame_sha256` of the decoded returned image, any executor `provenance`, then
`prev_hash` and `hash`. The hash is SHA-256 of the record's canonical JSON
(sorted keys) without `hash`; the first record's `prev_hash` is 64 zeros.
Images are never stored, only their digests. `type_secret` stores its `ref`,
`x`, `y`, the provider kind and a `length_class`, and replaces every other
parameter with `[redacted]` ([secret providers](secrets.md)). Any parameter whose name
looks like a credential (password, secret, token, credential, API or private
key, OTP, PIN code, auth) is redacted for every action. Text is cut to 256
characters. A `key_type` that paste routing sent through the clipboard records
`kind: "paste"` in its result summary. A `clipboard_read` record holds only
whether the text was withheld, never the text.

Journal writes are queued after the result is known. A write failure is logged
and counted, and never fails or delays a returned action. A broken existing
file is never extended. Verify a file with:

```sh
fruitctl journal verify ~/.local/state/fruitctl/journal/<session>.jsonl
```

It prints JSON and exits 1 at the first record that breaks the chain, naming
the line and reason (`record hash mismatch`, `previous hash mismatch`,
`sequence gap or reorder`, `session mismatch` or `truncated final record`).
The chain detects edits, insertions, deletions and reordering within a file. It
cannot detect deleting the whole file or its newest records together with
their successors; keep copies elsewhere when that matters.

## Observation contract

A successful capture contains a complete frame with current dimensions,
coordinate mapping, and a frame identifier. A changing test target is necessary
to qualify action-to-observation behavior. A static screenshot cannot prove a
fresh frame, and a partial update cannot be reported as complete pixels.

The raw-VNC daemon asks for each observation with a non-incremental
FramebufferUpdateRequest (RFC 6143 section 7.5.3). While that capture is
pending, the daemon's own message loop adds no incremental request. LibVNC
0.9.15 still writes its own incremental request after every
FramebufferUpdate it processes (`rfbclient.c:2564`), before the completion
callback. Any update that arrives during a pending capture therefore leaves
an incremental request outstanding at the server. Every screen observation
still requires new full pixel coverage and a completed update on the same
allocation within that capture's original deadline: 10000 ms on a server
detected as Apple, 5000 ms otherwise, or `--capture-timeout-ms` (1000 to
20000; profile `vnc.captureTimeoutMs`). The request's `deadline_ms` budget,
stamped by the Node executor, caps it, so the capture fails typed before the
30 s tool deadline. A complete cached mirror,
server silence, partial pixels or a metadata-only update cannot establish
current pixels or authorize further input. Static-screen behavior on macOS
Screen Sharing still requires native and attended qualification.

A failed observation returns JSON-RPC code `-32010` (`stale_screen`). Its
message keeps the prefix `No fresh complete framebuffer update within` for
deadline failures, followed by that capture's deadline (`5 seconds` by default
on servers other than Apple, `10 seconds` on Apple), and `data.reason` is one of `server_silent`,
`metadata_only`, `incomplete_coverage`, `late_complete` (every pixel arrived,
but only at or after the deadline), `allocation_changed`, `disconnected`,
`request_failed`, `capture_busy` or `cancelled`. `data.diagnostics` carries
only control-flow counters, including the inferred
`unanswered_full_requests`, `unanswered_incremental_requests`,
`auto_rearm_observed` and `request_gate_leaks`. RFB requests carry no
identifier, so the unanswered counts err high, never low: a full request is
retired one at a time, only by an update whose own rectangles cover the whole
allocation, and an update carrying any rectangle retires every outstanding
incremental request. A server that answers several full requests with one
update leaves the full count high for the rest of the connection. The MCP
server keeps this code and data in the tool result's structured `error` object
(`{code, message, data}`, the shape every failed result uses) beside the
compatible error text and the D7 `route` and `indicator` labels; a failed
`action_queue` reports its first failure in the same object.

Input refusals use code `-32011` with `data.reason` and are returned before
any event of the refused request. Mouse holds (D27) are batch-scoped: the
executor that runs one `action_queue` batch assigns it one private
`hold_scope`, carries it on every native request of that batch and ends the
batch with `release_holds`. `mouse_down`/`mouse_up` without that scope are
refused (`hold_outside_batch`); any native request from outside the batch
force-releases a live hold first; abort or shutdown releases it through the
existing held-input release. The scope is not an MCP field. Before the first
input of each connection generation the native client writes one release-only
key-up per Shift/Control/Alt/Meta/Super keysym. It is deferred from connect so
an observation-only connection still writes no input.

Observation conditions that fresh captures did not meet fail with JSON-RPC
code `-32012`. `data.reason` is `stable_timeout` (`wait_for_stable`, or a queue
step's `expect.stable_ms`) or `change_not_observed` (a queue step's
`expect.change_in`), with `elapsed_ms` and `captures`. Every compared frame
was fresh. A capture failure inside the wait stays `-32010` `stale_screen`.
`wait_for_stable`, `zoom` and region `diff_check` never compare or return a
cached frame. A queue step's `expect` runs in the same executor operation as
the step, as private native methods: `expect_baseline` before the step, then
`expect_change` and `wait_for_stable` after it. An unmet expectation therefore
stops the batch before the next step's input. `wait_for_stable` and the
expectation methods return no image, so they keep the request's prior input
authorization only while the display identity is unchanged and never grant
one; `zoom`, like `screenshot`, adopts its frame.

The Host route answers `screenshot` from its own ScreenCaptureKit image. It
refuses every observation computed from raw VNC pixels before admission:
`cursor_crop`, `diff_check`, `set_baseline`, `detect_elements`, `zoom`,
`wait_for_stable` and the queue expectation methods. The refusal carries the
string code `unsupported_on_route`. Actions a backend does not offer at all
keep `unsupported_action`.

`--rfb-wire-ledger` writes one stderr line per framebuffer request: message
type, incremental flag, length and monotonic milliseconds, never payloads.
The daemon's own requests are listed after LibVNC reports them sent. LibVNC
also reports success without writing when the server's SupportedMessages
bitmap or a pending resize excludes a message; such a request is listed with
origin `suppressed`, and a suppressed observation request fails as
`request_failed` instead of being awaited. LibVNC's initial request and
post-update re-arm are inferred; its SetPixelFormat, SetEncodings and resize
requests are not listed, so a header-only packet capture remains the wire
authority. Input is coalesced: each run of key, pointer and clipboard
messages becomes one `type=input` line, written just before the next request
line or at disconnect, naming only the message types. The ledger never
records how many input messages were sent, when each was sent or how long
clipboard text was.

`--rfb-request-mode on-demand` is opt-in; `stream` stays the default. After
the connection initializes, the daemon clears LibVNC's FramebufferUpdateRequest
bit in the client-to-server capability bitmap (`client2server[0] & 0x08`).
While that bit is clear, LibVNC reports success without writing its own
post-update re-arm or resize request (`rfbclient.c:1497`). The daemon opens
the bit only around its own whole-screen request, for an observation or for
missing pixels after a resize, and never writes an incremental request. Its
first missing-pixel refresh after connecting waits one second behind
`rfbInitConnection`'s own request, so the two are never outstanding together.
A server SupportedMessages rectangle can rewrite the bitmap and leak one
re-arm before any callback runs. The daemon counts that as
`request_gate_leaks` (kept across framebuffer reallocations), closes the bit
again, marks the pending observation `ordered_after_prior_input: false` and
counts the leaked re-arm as outstanding until an update answers it. A target
profile selects the mode with
`"vnc": { "requestMode": "on-demand" }`. Whether Apple's server needs this
mode, or keeps an idle connection without an outstanding request responsive,
remains unqualified until an attended probe records it.

In the default `stream` mode the daemon also holds that bit clear from an
observation's own whole-screen request until the observation resolves, then
restores it and the stream resumes. Without the hold, LibVNC re-arms an
incremental request after every update, including an update already in
flight when the whole-screen request was written. Apple's server answers the
newest request: while the screen animates (on PZM, after typing into the
System Settings search field) that re-arm superseded the whole-screen request
on about one capture in five, and only partial updates arrived until the
capture failed as `stale_screen` `incomplete_coverage` (TIN-5509, 2026-10-16).
The hold changes only what is written. A capture still succeeds only when
rectangles received after its own request, then FinishedUpdate, cover the
whole allocation; it reports `requests.incremental: 0` unless a server
SupportedMessages rectangle leaks a re-arm, which is counted in
`request_gate_leaks` as on demand.

Each successful observation result carries `provenance`: `source`
(`in_session`), `coverage` (`complete_received_after_request`),
`request_mode`, the full and incremental `requests` written while it was
pending, `prior_unanswered_requests` (the full and incremental requests
believed outstanding when its own request was admitted),
`ordered_after_prior_input`, `elapsed_ms` and `elicited_input`, which is
always `null` because no input is written to obtain an observation.
`ordered_after_prior_input` is `true` only when no request was believed
outstanding at admission and no request leaked through the on-demand gate
while the observation was pending. Only then must every update that completed
it answer a request written after any earlier input. Stream mode usually has
LibVNC's re-arm or a poll outstanding, so it usually reports `false`; an
observation admitted right after another, before the stream resumes, can
find nothing outstanding.

On Apple's server the daemon writes Command as `Super_L`/`Super_R` and Option
as `Meta_L`/`Meta_R`; the `cmd` and `alt`/`option` key names are unchanged.
The Option mapping remains pending native and attended verification.

### Input readiness after connect

Apple's `screensharingd` silently drops all RFB input, pointer and key, for
about 2.5 s after the viewer authenticates, and LibVNC still reports each
write as sent (see [Compatibility](compatibility.md#apple-input-settle-time)).
The daemon therefore records a monotonic timestamp when ServerInit completes
on each connection generation and holds input until the settle time has
elapsed. A reconnect is a new generation and restarts it.

- `--input-settle-ms N` sets the time (0 to 10000). The default is 3000 when
  the server is detected as Apple (the same ARD credential request that turns
  on the Option and Command keysym mapping) and 0 otherwise.
- The first input of a generation waits out the remaining time; later input
  is not delayed. Waiting is preferred to refusing, and no event is written
  early. Every write on the native queue rechecks the gate, including
  release-only writes, the per-generation modifier sync, clipboard text for
  `paste` and held-input release after an error or abort.
- The wait ends at once on cancellation or abort. The Node executor passes each
  request a private `deadline_ms` budget, a little shorter than its own
  deadline. If the remaining settle time does not fit in it, or in the native
  input permit's lease on the Host route, the request fails before any event
  with JSON-RPC code `-32013`, `data.reason` `input_not_ready` and
  `data.remaining_ms`. The Host route waits out the settle time itself before
  adopting the observation and requesting the permit, so the lease is never
  spent waiting.
- Observation is never delayed: `screenshot`, `health` and the other screen
  methods run during the settle time. `health` reports `input_ready`,
  `input_settle_remaining_ms` and `input_settle_ms`.

Input and capture failures are distinct. If an input's execution is uncertain,
report that uncertainty and avoid replay. If capture fails after known input,
report both facts and stop until a complete observation is available.

In the experimental Host path, a capture refusal preserves its stable reason
and, when available, the failed capture phase, recognized Apple error domain
symbol and signed 32-bit code. A locally generated request ID correlates the refusal.
Localized descriptions, paths, arbitrary domains and underlying errors are
discarded. If retirement cannot confirm release, the failing request still
reports `release_unconfirmed`, with the sanitized Host cause for diagnosis;
the target stays revoked and requires operator reconciliation. These source
diagnostics do not qualify capture or grant macOS permission.

## Error codes

The native daemon, FruitctlHost, the Darwin broker, the Linux relay and the
MCP server share one error `code` field. Numeric codes are JSON-RPC and belong
to the native processes; the broker only relays them, except that the Host
route raises `-32013` itself with the daemon's meaning. Broker codes are
strings. This table is the register: a new code is added here in the same
change that raises it, and `test/fruitctl-error-codes.test.js` fails on a code
in `lib/`, `ClaudeKVM-Daemon/` or `FruitctlHost/` that is missing. `-32001` to
`-32009` and `-32015` upward are unassigned.

| Code | Raised by | Meaning |
| --- | --- | --- |
| `-32700` | daemon | Request line is not JSON |
| `-32600` | daemon, Host | Invalid request, including one over the line limit |
| `-32601` | daemon, Host | Unknown method (Host: `unsupported_host_action`) |
| `-32000` | daemon, Host | Untyped failure; no `data` |
| `-32010` | daemon | `stale_screen`: no fresh complete frame; `data.reason`, `data.diagnostics` |
| `-32011` | daemon | Input refused before any event; `data.reason` |
| `-32012` | daemon | Observation condition unmet: `stable_timeout`, `change_not_observed` |
| `-32013` | daemon, Host route | `input_not_ready`: settle time does not fit the deadline; no event written |
| `-32014` | daemon | `clipboard_unavailable`: `clipboard_read` failed or is off; `data.reason` |
| `unsupported_action` | broker, MCP | The backend does not offer the action |
| `unsupported_on_route` | broker | The action exists only on the other route |
| `unsupported_expectation` | MCP | The step cannot carry the requested `expect` |
| `invalid_deadline` | broker | `timeoutMs` is not a positive number of milliseconds |
| `target_idle_retiring` | broker | The owner's idle connection is closing; retry |
| `clipboard_read_disabled` | broker | `clipboard.read` is off for this target |
| `invalid_secret_request` | broker, relay | `type_secret` is not `{ref, x?, y?}` |
| `secret_ref_not_allowed` | broker | The ref is not in this target's `secrets` allowlist |
| `secret_unavailable` | broker | A provider failed; `data.reason`, `data.ref`, `data.provider` |
| `human_stop_latched` | broker, Host route | The human Stop is latched |
| `human_consent_required` | sentinel, Host | A consent or system dialog is on screen; `data.owner`, `data.kind` |
| `target_locked` | sentinel | Locked screen or login window; `data.console` |
| `display_asleep` | sentinel, wake | The target display is asleep |
| `accessibility_permission_required` | Host route, Host | FruitctlHost lacks the Accessibility grant |
| `stale_ref` | Host route, Host | The element ref is not in the latest `ax_snapshot` |
| `ax_unreachable` | Host | The element can no longer be reached |
| `ax_action_unsupported` | Host | The element does not offer the action |
| `credential_unavailable` | broker | The VNC credential provider failed at startup |
| `release_unconfirmed` | broker, relay, executors | Release is unconfirmed; the target stays revoked until reconciled |
| `operation_failed` | broker | Any other error crossing the broker socket |
| `broker_unavailable` | client | The broker socket is not reachable |
| `bridge_unreachable`, `bridge_auth_refused`, `bridge_host_key`, `bridge_command_missing`, `bridge_attach_failed`, `bridge_broker_unavailable` | relay | The SSH bridge (D20) did not deliver the request |
| `bridge_protocol`, `bridge_lost`, `bridge_unconfirmed` | relay | The bridge failed with work in flight; nothing is replayed |
| `relay_config`, `relay_listener_failed` | relay | The relay could not start |

"Host route" is the broker's host-helper executor; "Host" is FruitctlHost
itself. A string code raised by the broker before admission (lane, secret,
clipboard, sentinel or a Host route check) means nothing was sent and the
lease is kept. The same code in a FruitctlHost reply, or `display_asleep`
from an executor, follows an admitted request and retires the lane. Secret
providers run only after every pre-admission refusal has passed.

## FuzzyBot spell

Fruitctl Host remains an unqualified source prototype. Public runtime previews
include no Host binary, installer, background service or generated helper
mapping. Its signed development copies remain private until the exact capture
mode passes exclusion, input mapping, lifecycle and permission qualification.
Signing or notarization cannot enable this feature or supply macOS consent.

Future Host rollout requires launching the app bundle through LaunchServices in
the logged-in GUI session, checking the app returned by
[NSWorkspace](https://developer.apple.com/documentation/appkit/nsworkspace/openapplication%28at%3Aconfiguration%3Acompletionhandler%3A%29),
and verifying the privacy-responsible code and capture permission. In an attended
trial, direct `Contents/MacOS` execution over SSH was attributed to the remote
service; the Host's existing grant did not establish that invocation's access.
Apple's [responsibility-tracking guidance](https://developer.apple.com/forums/thread/125438)
explains the attribution boundary. Host capture and privacy qualification remain pending,
and no automatic permission grant is provided.

Permission provisioning is a separate, attended step. Apple's
[PPPC schema](https://raw.githubusercontent.com/apple/device-management/release/mdm/profiles/com.apple.TCC.configuration-profile-policy.yaml)
does not allow a profile to silently grant Screen Capture. A user-approved MDM
policy may let a standard user configure that service with
`AllowStandardUserToSetSystemService`; this authorizes the user's choice rather
than granting recording access. Accessibility and event-posting policies are
separate permissions, not substitutes for Screen Capture approval.

Managed alert suppression is another separate policy. Apple's
[Restrictions schema](https://raw.githubusercontent.com/apple/device-management/release/mdm/profiles/com.apple.applicationaccess.yaml)
defines `forceBypassScreenCaptureAlert` from macOS 15.1; it suppresses presentation
of a capture alert and is unavailable through manual profile installation or
User Enrollment. It does not supply the Screen Capture grant described above.
The ordinary Host capture path still requires the target user's attended
permission choice; managed policy belongs to the device-management owner.

Apple's [Persistent Content Capture entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
is available from macOS 14.4 for VNC applications. It requires Apple permission
and the approved capability in the app's Xcode profile. This is a reviewed
capability route, not an ordinary TCC bypass or a headless grant. Fruitctl's
public preview supplies neither that approval nor Screen Capture provisioning.

The [macOS permissions guide](permissions.md) carries the unmanaged consent
procedure, managed-device prerequisites, signed-identity verification and
Account Holder request checklist. Its
[standard-user policy template](permissions/fruitctl-standard-user.mobileconfig.example)
contains only the Screen Capture policy that lets the user choose; an MDM
administrator must bind it to the exact signed app before deployment.

The target-side indicator draws an edge-feathered deep purple pulse with the
centered message: “Machine under FuzzyBot spell, courtesy xoxd.ai)”. It accepts
no pointer or keyboard input and respects a reduced-motion setting. Human stop
remains available through an accessible local control.
Local Stop revokes agent control for the running FruitctlHost session and stays
in force through controller reconnect or wake. Restarting FruitctlHost allows
control again; Stop is not persisted across app restarts. Capture opt-in,
macOS capture consent and fresh controller lease checks remain separate
requirements.
The intended animation has a 72 BPM pulse cycle. Qualification records physical
pulse rate and timing uncertainty; reduced-motion static indication is a
separate case. A renderer timer or a ready acknowledgement alone cannot prove
what the person sees.

The indicator must remain absent from every frame delivered to the agent while
remaining visible to a person at the machine. Window sharing flags alone are
not proof that VNC excludes it. The qualification lane uses filtered
ScreenCaptureKit observations and records a simultaneous human-display and
agent-frame comparison. Raw VNC mode does not enable the overlay until that
mode passes the same exclusion proof. Hiding the overlay during capture or
masking its pixels is outside the capture contract.

The helper attaches over SSH to an already installed, resident target app
through its `--stdio` interface. That attachment does not launch the app, grant
macOS consent, or install it. Helper screenshots use owned filtered capture;
input remains on the VNC client and requires a measured mapping between those
observations and the VNC desktop. Until the installed path has an exclusion and
mapping receipt, treat it as an unqualified preview.

Current Host source obtains one `CMSampleBuffer` from
`SCScreenshotManager.captureSampleBuffer`, copies its bounded BGRA pixels into
owned storage and encodes the PNG from that copy. The accompanying
`native_frame_timing` metadata retains that sample's presentation time, optional
WindowServer display time, and separate request/completion brackets from the
CoreMedia host clock. Integer timestamp values and epochs are decimal strings
so JSON consumers can preserve their precision.

These fields support capture qualification; they do not establish frame
freshness. Metadata explicitly reports `freshness: unknown`, an unverified
native-to-host clock relation and unverified WindowServer display-time units.
RPC completion time is not the acquisition time, and the CoreMedia host clock
must not be equated with the Host's process-relative `ContinuousClock` Stop
diagnostics. A separate pure
classifier can reject stale, future or nonadvancing samples only after a
qualification establishes the actual clock relation. Ordinary static capture
does not use that classifier. This source change supplies no signed Host
release or physical capture acceptance.

## Compatibility and release boundary

Keep legacy executable aliases and the compatible signed application identity
during the refactor. Publish signed bytes with exact source revision, checksums,
and provenance. Consumers do not modify or re-sign those artifacts. macOS user
consent remains separate from code-signing and notarization.

The shared broker, Linux bridge, and optional target app are preview
implementation lanes. Their source and offline checks do not constitute a
qualified runtime release. This architecture states their contract; the
[compatibility matrix](compatibility.md) limits claims to released and qualified
combinations.
