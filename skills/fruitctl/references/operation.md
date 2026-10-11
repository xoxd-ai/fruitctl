# Observe, act, verify

Use the discovered `vnc_command` schema. Its coordinates are in the displayed
**scaled image space**, not native monitor pixels. Start with:

```json
{"action":"health"}
```

When health includes `capabilities` with `known: true`, use its `actions` list
to avoid unavailable routes. `known: false` or missing metadata means support is
unknown on an older backend; use its compatible existing actions without assuming
new features. An empty list with `known: true` advertises no supported actions.
An advertisement does not qualify permissions, capture or input mapping.

```json
{"action":"screenshot"}
```

Confirm the configured target and inspect the returned pixels before input.
An example click, once its location has been observed, is:

```json
{"action":"mouse_click","x":640,"y":400,"button":"left"}
```

Other input actions include `mouse_double_click`, `mouse_move`, `hover`,
`nudge`, `mouse_drag`, `scroll`, `key_tap`, `key_combo`, `key_type`, and `paste`.
Use the schema's actual fields and bounds. `paste` uses clipboard behavior;
choose `key_type` when modifying the clipboard is inappropriate. Do not send
secrets through either action.

After input, request a fresh screenshot and verify the intended visible state.
`cursor_crop` can inspect detail; `detect_elements` supplies OCR;
`set_baseline`/`diff_check` can detect changes. These are aids, not substitutes
for full-frame identity, completeness, freshness, and mapping checks.

With the optional host helper configured, screenshots use its owned
ScreenCaptureKit image. OCR, crop, baseline, and diff actions are currently
unavailable in that mode; they must not fall back to raw VNC pixels. Input
requires an operator-qualified mapping receipt and the native observation
handshake. If either is unavailable or geometry changes, stop input and report
the qualification gap.

If a capture fails or pixels/geometry are uncertain, stop input. After a
resize/display change, re-establish the session's scaled mapping before acting;
do not reuse the prior image coordinates. If the frontend cannot render the
returned image, report that adapter as unverified rather than claiming a
successful desktop workflow.

`action_queue` accepts up to 20 ordered actions and returns text, not images.
Use it only for a short confident sequence on an observed stable state. It
must fit within the 30-second operation budget, including waits and typing;
use individual actions when the whole sequence cannot be bounded. It
stops on the first error; earlier actions may already have executed. Inspect
the outcome and do not automatically replay a failed or timed-out sequence.
Take a new screenshot after a batch. Do not construct a blind sequence through
unobserved dialogs or permission prompts.

The `shutdown` action is a native lifecycle operation. Use it only when the
session/daemon is confirmed to belong to this task; a shared broker may have
other clients. Do not send `shutdown` through a shared broker without an
explicitly scoped ownership guarantee; an MCP session alone is insufficient.
Prefer the frontend's normal session disconnect when ownership is unclear.
`task_complete` and `task_failed` end this client's owned broker session before
reporting task status. Use them when the task is finished or cannot continue;
an unconfirmed release remains a failure. They do not independently prove a UI
outcome or release another client's ownership.

In qualified indicator mode, the purple indication stays visible throughout
the owned session, including time spent thinking between commands. A healthy
command return does not release ownership. Explicit release, task completion or
failure, disconnect, or the broker's 60-second idle ownership expiry ends it.
If the human uses Stop, readiness is revoked and input must remain stopped;
only the human can allow activity again. Never reacquire or reconnect to bypass
that decision.

Describe what was observed, what was changed, and what remains uncertain.
Never claim input delivery, lease ownership, cancellation, indicator visibility,
or capture exclusion solely because a tool returned an acknowledgement.
