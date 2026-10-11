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

## Observation contract

A successful capture contains a complete frame with current dimensions,
coordinate mapping, and a frame identifier. A changing test target is necessary
to qualify action-to-observation behavior. A static screenshot cannot prove a
fresh frame, and a partial update cannot be reported as complete pixels.

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
