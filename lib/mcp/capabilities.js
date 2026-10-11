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

export function preAdmissionRefusal(message) {
  const error = new Error(message);
  error.code = 'unsupported_action';
  error.responses = [];
  refusals.add(error);
  return error;
}

// A serialized code/message, mutable Error property or remote response cannot
// bypass cleanup. Only a refusal constructed before admission has this brand.
export function isPreAdmissionRefusal(error) { return refusals.has(error); }

export function requireNativeActions(actions, capabilities) {
  if (capabilities.known && actions.some(action => !capabilities.actions.includes(action.action))) {
    throw preAdmissionRefusal('Action unavailable on native backend');
  }
}
