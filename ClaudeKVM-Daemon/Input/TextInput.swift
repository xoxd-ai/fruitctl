import Foundation

extension InputController {

    /// Validate and plan the whole text before input or failure cleanup can
    /// mutate held state. Execution keeps cancellation/observation checks on
    /// every key and pause, and never substitutes a clipboard operation.
    func typeText(_ text: String) async throws {
        try await typePlanned(try TextInputPlan(text, timing: timing))
    }

    /// D16: a broker-resolved secret. The whole value is planned before any
    /// event, so an untypable secret sends no click and no key. An optional
    /// left click focuses the field, then the ordinary stroke path types it.
    /// There is no clipboard path (D29), and a failure never names a
    /// character of the secret.
    func typeSecret(_ secret: String, focusAt point: (x: Int, y: Int)?) async throws {
        guard !secret.isEmpty, secret.utf8.count <= SecretTypingError.maximumUTF8Bytes else {
            throw SecretTypingError.invalidLength
        }
        let plan: TextInputPlan
        do { plan = try TextInputPlan(secret, timing: timing) } catch is TextInputPlanError {
            throw SecretTypingError.untypable
        }
        // The settle gate is waited out once, before the first event, so a
        // typed input_not_ready (-32013) still means nothing was sent.
        try await awaitInputReady()
        do {
            if let point { try await mouseClick(x: point.x, y: point.y) }
            try await typePlanned(plan)
        } catch let error as VNCError {
            // A later not-ready (a reconnect mid-secret) may follow written
            // keys; it must not read as a refusal before any key.
            if case .inputNotReady = error { throw SecretTypingError.interrupted }
            throw error
        }
    }

    private func typePlanned(_ plan: TextInputPlan) async throws {
        try await releasingOnFailure {
            try checkInputAdmission()
            for stroke in plan.strokes {
                if stroke.shift {
                    try await emitKey(key: KeySym.shiftLeft, down: true)
                    try await pause(plan.timing.typeShiftUs)
                }

                try await emitKey(key: stroke.keysym, down: true)
                try await pause(plan.timing.typeKeyUs)
                try await emitKey(key: stroke.keysym, down: false)

                if stroke.shift {
                    try await pause(plan.timing.typeShiftUs)
                    try await emitKey(key: KeySym.shiftLeft, down: false)
                }

                try await pause(plan.timing.typeInterKeyUs)
            }
        }
    }

    /// Explicit VNC clipboard + combo operation; typing never selects it automatically.
    /// clientCutText → 30ms → cmd+v (macOS) or ctrl+v (other).
    func pasteText(_ text: String) async throws {
        try checkInputAdmission()
        try await awaitInputReady()
        try await vnc.sendClipboardText(text, context: context, inputPermit: inputPermit)
        try await pause(timing.pasteSettleUs)
        if vnc.isMacOS {
            try await keyCombo("cmd+v")
        } else {
            try await keyCombo("ctrl+v")
        }
    }
}

/// Fixed type_secret failures. Neither names a character or the length.
enum SecretTypingError: LocalizedError {
    static let maximumUTF8Bytes = 4096
    case invalidLength
    case untypable
    case interrupted

    var errorDescription: String? {
        switch self {
        case .invalidLength: return "Secret is empty or exceeds the 4096-byte limit"
        case .untypable: return "Secret contains a character that cannot be typed"
        case .interrupted: return "Input stopped being ready after the secret's first event"
        }
    }
}
