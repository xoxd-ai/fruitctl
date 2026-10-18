// SPDX-License-Identifier: MIT
const unknown = Object.freeze({ known: false, actions: Object.freeze([]) });
const refusals = new WeakSet();

// Missing metadata belongs to older native releases. It is unknown, never an
// empty supported-action set or permission to claim a newer backend feature.
export function nativeCapabilities(actions) {
  if (actions === undefined) return unknown;
  if (!Array.isArray(actions) || actions.length > 64 ||
      actions.some(action => typeof action !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(action)) ||
      new Set(actions).size !== actions.length) {
    throw new Error('Invalid native capability metadata');
  }
  return Object.freeze({ known: true, actions: Object.freeze([...actions]) });
}

// Capability metadata as a result or executor reports it ({known, actions},
// optionally with backend detail). Malformed metadata is not evidence of
// support: it yields undefined so callers keep treating support as unobserved.
export function advertisedCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.known === false) return unknown;
  if (value.known !== true) return undefined;
  try { return nativeCapabilities(value.actions); }
  catch { return undefined; }
}

// `unsupported_on_route` names an action this route deliberately does not
// serve; `unsupported_action` names one the backend does not offer at all.
export function preAdmissionRefusal(message, code = 'unsupported_action') {
  const error = new Error(message);
  error.code = code;
  error.responses = [];
  refusals.add(error);
  return error;
}

// A serialized code/message, mutable Error property or remote response cannot
// bypass cleanup. Only a refusal constructed before admission has this brand.
export function isPreAdmissionRefusal(error) { return refusals.has(error); }

// Actions that exist only on the Host route. The raw VNC route refuses them
// before admission with a typed code; they are never forwarded to the daemon.
export const HOST_ROUTE_ACTIONS = Object.freeze(['ax_snapshot', 'click_element', 'focus_element']);

// Refusal codes an MCP result may carry from a thrown error. Every other
// thrown failure keeps the message-only shape.
export const TYPED_REFUSAL_CODES = Object.freeze(['unsupported_on_route', 'accessibility_permission_required',
  // D16 type_secret refusals, all before any input.
  'invalid_secret_request', 'secret_ref_not_allowed', 'secret_unavailable', 'human_stop_latched',
  'clipboard_read_disabled',
  // Lane admission: a malformed deadline, or the owner's idle close in progress.
  'invalid_deadline', 'target_idle_retiring',
  // Host element actions (click_element / focus_element).
  'stale_ref', 'ax_unreachable', 'ax_action_unsupported']);

// Linux relay (D20) and broker-socket failures. bridge_lost, bridge_protocol
// and bridge_unconfirmed leave in-flight work uncertain; the others mean the
// request was not delivered.
export const BRIDGE_ERROR_CODES = Object.freeze(['bridge_unreachable', 'bridge_auth_refused', 'bridge_host_key',
  'bridge_command_missing', 'bridge_attach_failed', 'bridge_protocol', 'bridge_lost', 'bridge_broker_unavailable',
  'bridge_unconfirmed', 'broker_unavailable']);

// D8: clipboard_read is off unless the target profile enables it. Refused
// before admission; the daemon's own -32014 refusal is the second guard.
export const CLIPBOARD_UNAVAILABLE_CODE = -32014;
export function clipboardReadRefusal() {
  const error = preAdmissionRefusal('clipboard_read is not enabled for this target (clipboard.read)');
  error.code = 'clipboard_read_disabled';
  return error;
}

// Pointer and keyboard events sent to the target over VNC.
export const VNC_INPUT_ACTIONS = Object.freeze(new Set(['mouse_click', 'mouse_double_click', 'mouse_move', 'hover',
  'nudge', 'mouse_drag', 'scroll', 'key_tap', 'key_combo', 'key_type', 'paste',
  'triple_click', 'hold_key', 'mouse_down', 'mouse_up', 'type_secret']));
// Every action that changes the target through input, including the Host's
// element actions, which press or focus an element and never answer consent.
export const INPUT_ACTIONS = Object.freeze(new Set([...VNC_INPUT_ACTIONS, 'click_element', 'focus_element']));

// Desktop-state refusals (TIN-5509), raised by the broker's sentinel before a
// batch with input reaches the target. Each carries `data.reason`; consent
// also names the dialog's `owner` and `kind`. Like D28's display_asleep they
// are broker string codes: numeric JSON-RPC codes belong to the native
// controller. docs/architecture.md#error-codes registers every code.
export const HUMAN_CONSENT_REQUIRED_CODE = 'human_consent_required';
export const TARGET_LOCKED_CODE = 'target_locked';
export const DESKTOP_REFUSAL_CODES = Object.freeze([HUMAN_CONSENT_REQUIRED_CODE, TARGET_LOCKED_CODE, 'display_asleep']);
const DESKTOP_DATA_KEYS = ['reason', 'owner', 'kind', 'console'];

/** A desktop-state refusal's `data`, keeping only its own bounded string
 * fields, or undefined for any other error. */
export function desktopRefusalData(error) {
  if (!DESKTOP_REFUSAL_CODES.includes(error?.code)) return undefined;
  const data = error.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const kept = Object.fromEntries(DESKTOP_DATA_KEYS
    .filter(key => typeof data[key] === 'string').map(key => [key, data[key].slice(0, 64)]));
  return typeof kept.reason === 'string' ? kept : undefined;
}

export function routeRefusal(action) {
  const error = preAdmissionRefusal(`${action} is unsupported on the raw VNC route; configure hostHelper`);
  error.code = 'unsupported_on_route';
  return error;
}

export function requireNativeActions(actions, capabilities) {
  const hostOnly = actions.find(action => HOST_ROUTE_ACTIONS.includes(action.action));
  if (hostOnly) throw routeRefusal(hostOnly.action);
  if (capabilities.known && actions.some(action => !capabilities.actions.includes(action.action))) {
    throw preAdmissionRefusal('Action unavailable on native backend');
  }
}

// D7 route labels. The raw VNC route never carries the target-side indicator.
// The Host route reports `present` only while its validated activity receipt
// confirms the overlay; otherwise `unknown`. An executor that declares no
// route (an older broker) is labelled unknown rather than guessed.
const ROUTES = new Set(['host', 'raw']);
const INDICATORS = new Set(['present', 'absent', 'unknown']);
export const RAW_PRESENTATION = Object.freeze({ route: 'raw', indicator: 'absent' });

export function presentationLabels(value) {
  const route = ROUTES.has(value?.route) ? value.route : 'unknown';
  if (route === 'raw') return RAW_PRESENTATION;
  const indicator = INDICATORS.has(value?.indicator) && (route === 'host' || value.indicator !== 'present')
    ? value.indicator : 'unknown';
  return Object.freeze({ route, indicator });
}

// A failed, cancelled or timed-out call cannot attest a live overlay. Keep the
// route (raw stays absent) but never carry `present` across a failure.
export function unattestedLabels(value) {
  const labels = presentationLabels(value);
  return labels.indicator === 'present' ? Object.freeze({ route: labels.route, indicator: 'unknown' }) : labels;
}
