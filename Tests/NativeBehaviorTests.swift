import XCTest
import Foundation
import AppKit
import CLibVNCClient

/// Ordered wire/pause trace shared by the owned fake client and sleeper.
private final class WireTrace {
    private let lock = NSLock()
    private var events: [String] = []
    func append(_ event: String) { lock.lock(); events.append(event); lock.unlock() }
    var values: [String] { lock.lock(); defer { lock.unlock() }; return events }
}

/// Fake monotonic clock for the input settle gate. Each settle sleep is
/// recorded and advances the clock by exactly the requested time.
private final class SettleClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64 = 1_000_000_000
    private var slept: [UInt64] = []
    func now() -> UInt64 { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ nanoseconds: UInt64) { lock.lock(); value += nanoseconds; lock.unlock() }
    func sleep(_ nanoseconds: UInt64) async throws {
        try Task.checkCancellation()
        lock.lock(); slept.append(nanoseconds); value += nanoseconds; lock.unlock()
    }
    var sleeps: [UInt64] { lock.lock(); defer { lock.unlock() }; return slept }
}

final class NativeBehaviorTests: XCTestCase {
    private func request(_ method: String, _ params: String = "{}") throws -> PCRequest {
        try JSONDecoder().decode(PCRequest.self,
            from: Data("{\"method\":\"\(method)\",\"params\":\(params),\"id\":1}".utf8))
    }

    func testReadyAndHealthAddTheSameBoundedCapabilitiesWithoutChangingLegacyPayloads() throws {
        let methods = PCRequest.supportedMethods
        XCTAssertLessThanOrEqual(methods.count, 64)
        XCTAssertEqual(Set(methods).count, methods.count)
        XCTAssertTrue(PCRequest.inputMethods.isSubset(of: Set(methods)))
        XCTAssertTrue(PCRequest.inputPermitMethods.isSubset(of: Set(methods)))
        let ready = PCNotification(method: "ready", params: [
            "scaledWidth": .int(1280), "scaledHeight": .int(720), "capabilities": .strings(methods),
        ])
        let readyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(ready)) as? [String: Any])
        let params = try XCTUnwrap(readyJSON["params"] as? [String: Any])
        let health = PCResponse.success(id: .number(1), detail: "connected", scaledWidth: 1280,
                                        scaledHeight: 720, capabilities: methods)
        let healthJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(health)) as? [String: Any])
        let result = try XCTUnwrap(healthJSON["result"] as? [String: Any])
        XCTAssertEqual(params["capabilities"] as? [String], methods)
        XCTAssertEqual(result["capabilities"] as? [String], methods)
        XCTAssertEqual(result["detail"] as? String, "connected")
        let legacy = PCResponse.success(id: .number(2), detail: "OK")
        let legacyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as? [String: Any])
        let legacyResult = try XCTUnwrap(legacyJSON["result"] as? [String: Any])
        XCTAssertNil(legacyResult["capabilities"])
        XCTAssertEqual(legacyResult["detail"] as? String, "OK")
    }

    func testEncodedGeometryMatchesMappingForOddAspectRatio() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1081)
        let pixels = Data(repeating: 127, count: 1920 * 1081 * 4)
        let encoded = try XCTUnwrap(pixels.withUnsafeBytes {
            FrameImageEncoder.encode(buffer: $0, width: 1920, height: 1081, scaling: scaling)
        })
        let image = try XCTUnwrap(NSBitmapImageRep(data: encoded))
        XCTAssertEqual(image.pixelsWide, scaling.scaledWidth)
        XCTAssertEqual(image.pixelsHigh, scaling.scaledHeight)
        XCTAssertEqual(image.pixelsHigh, 721) // old encoder truncated to 720
    }

    func testResizeRefreshesNativeMappingAndResetRestoresStartupMaximum() {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080, maxDimension: 1024)
        scaling.reconfigure(maxDimension: 320)
        scaling.updateGeometry(width: 1080, height: 1920)
        XCTAssertEqual(scaling.nativeWidth, 1080)
        XCTAssertEqual(scaling.scaledHeight, 320)
        scaling.reset()
        XCTAssertEqual(scaling.maxDimension, 1024)
        XCTAssertEqual(scaling.scaledWidth, 576)
        XCTAssertEqual(scaling.scaledHeight, 1024)
        let edge = scaling.toNative(x: scaling.scaledWidth - 1, y: scaling.scaledHeight - 1)
        XCTAssertLessThan(edge.x, 1080)
        XCTAssertLessThan(edge.y, 1920)
    }

    func testTinyAspectRatioNeverCreatesZeroSizedImage() {
        let scaling = DisplayScaling(nativeWidth: 1, nativeHeight: 32_000, maxDimension: 320)
        XCTAssertEqual(scaling.scaledWidth, 1)
        XCTAssertEqual(scaling.scaledHeight, 320)
    }

    func testEncoderRejectsWrongBufferSizeAndStaleGeometry() {
        let scaling = DisplayScaling(nativeWidth: 2, nativeHeight: 2)
        XCTAssertNil(Data(repeating: 0, count: 15).withUnsafeBytes {
            FrameImageEncoder.encode(buffer: $0, width: 2, height: 2, scaling: scaling)
        })
        XCTAssertNil(Data(repeating: 0, count: 16).withUnsafeBytes {
            FrameImageEncoder.encode(buffer: $0, width: 1, height: 4, scaling: scaling)
        })
    }

    func testNativeValidationRejectsMissingNegativeAndExtremeCoordinates() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        for params in ["{}", "{\"x\":-1,\"y\":0}", "{\"x\":9223372036854775807,\"y\":0}", "{\"x\":0,\"y\":720}"] {
            XCTAssertThrowsError(try request("mouse_click", params).validate(scaling: scaling))
        }
        XCTAssertNoThrow(try request("mouse_click", "{\"x\":1279,\"y\":719}").validate(scaling: scaling))
        XCTAssertThrowsError(try request("scroll", "{\"x\":0,\"y\":0,\"direction\":\"up\",\"amount\":-1}").validate(scaling: scaling))
        XCTAssertThrowsError(try request("key_combo", "{\"key\":\"cmd++v\"}").validate(scaling: scaling))
    }

    func testConfigurationValidatedBeforeUnsignedConversion() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        for params in ["{\"key_hold_ms\":-1}", "{\"max_dimension\":0}",
                       "{\"drag_pixels_per_step\":0}", "{\"drag_min_steps\":-1}",
                       "{\"scroll_tick_ms\":9223372036854775807}"] {
            XCTAssertThrowsError(try request("configure", params).validate(scaling: scaling))
        }
        XCTAssertThrowsError(try request("wait", "{\"ms\":-1}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("configure", "{\"key_hold_ms\":500,\"drag_pixels_per_step\":1}").validate(scaling: scaling))
    }

    func testBaselineDetectsGeometryGenerationAndByteCountChanges() {
        var baseline = FramebufferBaseline()
        let pixels = Data(repeating: 0, count: 16)
        let first = VNCInputContext(width: 2, height: 2, connectionGeneration: 1, allocation: 1)
        XCTAssertFalse(baseline.compareAndReplace(pixels, context: first))
        XCTAssertFalse(baseline.compareAndReplace(pixels, context: first))
        let rotated = VNCInputContext(width: 1, height: 4, connectionGeneration: 1, allocation: 2)
        XCTAssertTrue(baseline.compareAndReplace(pixels, context: rotated))
        let reconnected = VNCInputContext(width: 1, height: 4, connectionGeneration: 2, allocation: 2)
        XCTAssertTrue(baseline.compareAndReplace(pixels, context: reconnected))
        XCTAssertTrue(baseline.compareAndReplace(Data(repeating: 0, count: 12), context: reconnected))
    }

    func testKeyFailureReleasesUncertainPressWithoutReplaying() async {
        let vnc = VNCBridge(config: .init()) // never connects to a target
        var events: [String] = []
        let input = InputController(vnc: vnc, keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
            if down { throw VNCError.sendFailed("synthetic uncertain write") }
        }, sleeper: { _ in })
        do { try await input.keyTap(KeySym.shiftLeft); XCTFail("expected failure") } catch {}
        XCTAssertEqual(events, ["65505:true:false", "65505:false:true"])
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testCancelledClickAttemptsButtonRelease() async {
        let vnc = VNCBridge(config: .init())
        var events: [Int] = []
        let input = InputController(vnc: vnc, pointerSender: { _, _, mask, _, _ in
            events.append(mask)
        }, sleeper: { _ in throw CancellationError() })
        do { try await input.mouseClick(x: 1, y: 1); XCTFail("expected cancellation") } catch {}
        XCTAssertEqual(events, [1, 0])
        XCTAssertFalse(input.heldButtons)
    }

    func testPartialComboFailureReleasesKeysInReverseOrder() async {
        let vnc = VNCBridge(config: .init())
        var events: [String] = []
        let input = InputController(vnc: vnc, keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
            if key == 99 && down { throw VNCError.sendFailed("synthetic") }
        }, sleeper: { _ in })
        do { try await input.keyCombo([KeySym.ctrlLeft, KeySym.shiftLeft, 99]); XCTFail("expected failure") } catch {}
        XCTAssertEqual(Array(events.suffix(3)), ["99:false:true", "65505:false:true", "65507:false:true"])
    }

    func testFailedReleaseRetainsUncertainHeldState() async {
        let vnc = VNCBridge(config: .init())
        let input = InputController(vnc: vnc, keySender: { _, _, _, _ in
            throw VNCError.sendFailed("synthetic disconnected channel")
        }, sleeper: { _ in })
        do { try await input.keyTap(KeySym.shiftLeft); XCTFail("expected failure") } catch {}
        XCTAssertEqual(input.heldKeys, [KeySym.shiftLeft])
        let released = await input.releaseHeldInput()
        XCTAssertFalse(released)
    }

    func testTextLineEndingsAndTabEmitCompleteKeyPairs() async throws {
        var events: [String] = []
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
        }, sleeper: { _ in })
        try await input.typeText("a\nb\rc\r\nd\te")
        let expected: [UInt32] = [97, 0xFF0D, 98, 0xFF0D, 99, 0xFF0D, 100, 0xFF09, 101]
        XCTAssertEqual(events, expected.flatMap { ["\($0):true:false", "\($0):false:false"] })
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testTextPreservesDecomposedJoinerSelectorAndSupplementaryScalarOrder() async throws {
        var events: [String] = []
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
        }, sleeper: { _ in })
        // Explicit scalar spelling avoids Swift Character grouping or Unicode
        // canonical equivalence hiding lost combining marks and joiners.
        try await input.typeText("\u{00E9} e\u{0301}\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}\u{2764}\u{FE0F}\u{1F1FA}\u{1F1F3}")
        let expected: [UInt32] = [0xE9, 0x20, 0x65, 0x01000301, 0x0101F469,
            0x0101F3FD, 0x0100200D, 0x0101F4BB, 0x01002764, 0x0100FE0F,
            0x0101F1FA, 0x0101F1F3]
        XCTAssertEqual(events, expected.flatMap { ["\($0):true:false", "\($0):false:false"] })
        XCTAssertTrue(input.heldKeys.isEmpty)
        // These are exact protocol symbols; no target or keyboard layout is connected.
    }

    func testUnsupportedTextControlAfterValidPrefixRejectsBeforeAnyEmitterOrPause() async throws {
        var calls: [String] = []
        let input = InputController(vnc: VNCBridge(config: .init()), pointerSender: { _, _, _, _, _ in
            calls.append("pointer")
        }, keySender: { _, _, _, _ in
            calls.append("key")
        }, sleeper: { _ in calls.append("pause") })
        let unsupported = Array(UInt32(0)...UInt32(0x1F)) + Array(UInt32(0x7F)...UInt32(0x9F))
        for code in unsupported where code != 0x09 && code != 0x0A && code != 0x0D {
            let suffix = String(try XCTUnwrap(Unicode.Scalar(code)))
            do {
                try await input.typeText("A\u{00E9}e\u{0301}\u{1F469}\u{200D}\u{1F4BB}" + suffix)
                XCTFail("unsupported control \(code) succeeded")
            } catch TextInputPlanError.unsupportedControl(let rejected) {
                XCTAssertEqual(rejected, code)
            } catch { XCTFail("wrong rejection for \(code): \(error)") }
            XCTAssertTrue(calls.isEmpty, "control \(code) caused side effects")
            XCTAssertTrue(input.heldKeys.isEmpty)
        }
    }

    // D16: the focus click and every keystroke of a secret use the ordinary
    // input path; nothing else is written (no clipboard, no extra key).
    func testSecretFocusClickThenTypesOnlyItsKeystrokes() async throws {
        let trace = WireTrace()
        let input = tracedInput(trace)
        try await input.typeSecret("s3c", focusAt: (x: 4, y: 5))
        let values = trace.values
        XCTAssertEqual(Array(values.prefix(3)), ["pointer 4,5 mask=1", "pause 50000", "pointer 4,5 mask=0"])
        XCTAssertEqual(values.dropFirst(3).filter { !$0.hasPrefix("pause") },
                       ["down 0x73", "up 0x73", "down 0x33", "up 0x33", "down 0x63", "up 0x63"])
        XCTAssertTrue(input.heldKeys.isEmpty)
        XCTAssertFalse(input.heldButtons)
    }

    // An untypable character is refused before the focus click, and the
    // error names neither the character nor its code point.
    func testUntypableSecretSendsNothingAndNamesNoCharacter() async throws {
        let trace = WireTrace()
        let input = tracedInput(trace)
        do {
            try await input.typeSecret("pw\u{07}", focusAt: (x: 4, y: 5))
            XCTFail("untypable secret succeeded")
        } catch SecretTypingError.untypable {
            let message = SecretTypingError.untypable.localizedDescription
            XCTAssertFalse(message.contains("U+"))
            XCTAssertFalse(message.contains("7"))
        } catch { XCTFail("unexpected error: \(error)") }
        do {
            try await input.typeSecret(String(repeating: "a", count: SecretTypingError.maximumUTF8Bytes + 1), focusAt: nil)
            XCTFail("oversize secret succeeded")
        } catch SecretTypingError.invalidLength {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(trace.values.isEmpty)
    }

    // A not-ready refusal after the secret's first key must not surface as
    // -32013, which promises that no event was written.
    func testSecretNotReadyAfterFirstKeyIsNotReportedAsARefusal() async throws {
        var downs = 0
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { _, down, _, _ in
            if down { downs += 1 }
            if down, downs == 2 { throw VNCError.inputNotReady(remainingMilliseconds: 5) }
        }, sleeper: { _ in })
        do {
            try await input.typeSecret("ab", focusAt: nil)
            XCTFail("interrupted secret succeeded")
        } catch SecretTypingError.interrupted {
            XCTAssertNil(PCResponse.inputNotReady(id: nil, error: SecretTypingError.interrupted))
        } catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testTypeSecretTakesOnlyThePrivateSecretFieldWithPairedCoordinates() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        XCTAssertTrue(PCRequest.inputMethods.contains("type_secret"))
        XCTAssertTrue(PCRequest.supportedMethods.contains("type_secret"))
        XCTAssertNoThrow(try request("type_secret", "{\"secret\":\"s\"}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("type_secret", "{\"secret\":\"s\",\"x\":1,\"y\":2}").validate(scaling: scaling))
        for params in ["{}", "{\"secret\":\"\"}", "{\"secret\":\"s\",\"text\":\"s\"}",
                       "{\"text\":\"s\"}", "{\"secret\":\"s\",\"x\":1}", "{\"secret\":\"s\",\"x\":1,\"y\":720}"] {
            XCTAssertThrowsError(try request("type_secret", params).validate(scaling: scaling), params)
        }
        // No other method accepts the private field.
        XCTAssertThrowsError(try request("key_type", "{\"text\":\"a\",\"secret\":\"s\"}").validate(scaling: scaling))
    }

    func testInvalidPlanDoesNotReleaseOrAlterAlreadyHeldInput() async throws {
        var events: [String] = []
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
        }, sleeper: { _ in })
        try await input.emitKey(key: KeySym.ctrlLeft, down: true)
        events.removeAll()
        do { try await input.typeText("valid prefix\u{0000}"); XCTFail("invalid text succeeded") }
        catch TextInputPlanError.unsupportedControl(0) {}
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(events.isEmpty)
        XCTAssertEqual(input.heldKeys, [KeySym.ctrlLeft])
        // Cleanup remains an explicit caller decision for a refused plan.
        let released = await input.releaseHeldInput()
        XCTAssertTrue(released)
        XCTAssertEqual(events, ["65507:false:true"])
    }

    func testTextByteLimitRejectsDirectCallBeforeAnyEmitter() async throws {
        let maximum = String(repeating: "a", count: TextInputPlan.maximumUTF8Bytes)
        let exactPlan = try TextInputPlan(maximum, timing: .init())
        XCTAssertEqual(exactPlan.strokes.count, TextInputPlan.maximumUTF8Bytes)
        var calls: [String] = []
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { _, _, _, _ in
            calls.append("key")
        }, sleeper: { _ in calls.append("pause") })
        // A multibyte suffix proves the bound measures UTF-8 bytes, not Characters.
        do { try await input.typeText(maximum + "\u{00E9}"); XCTFail("oversize text succeeded") }
        catch TextInputPlanError.textTooLarge {}
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(calls.isEmpty)
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testTextUncertainWriteReleasesHeldScalarAndDoesNotReplayOrReportSuccess() async {
        var events: [String] = []
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
            if key == 0xE9 && down { throw VNCError.sendFailed("synthetic uncertain text write") }
        }, sleeper: { _ in })
        do { try await input.typeText("A\u{00E9}x"); XCTFail("partial text returned success") }
        catch VNCError.sendFailed(let reason) { XCTAssertEqual(reason, "synthetic uncertain text write") }
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(events, ["65505:true:false", "65:true:false", "65:false:false", "65505:false:false",
            "233:true:false", "233:false:true"])
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testTextCancellationDuringShiftReleasesOnlyTheHeldModifier() async {
        var events: [String] = []
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
        }, sleeper: { _ in throw CancellationError() })
        do { try await input.typeText("Ab"); XCTFail("cancelled text succeeded") }
        catch is CancellationError {}
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(events, ["65505:true:false", "65505:false:true"])
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testTextFailedReleaseRetainsHeldStateAndReportsFailure() async {
        var events: [String] = []
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
            throw VNCError.sendFailed("synthetic disconnected text channel")
        }, sleeper: { _ in })
        do { try await input.typeText("ab"); XCTFail("unconfirmed release returned success") }
        catch VNCError.sendFailed(let reason) {
            XCTAssertEqual(reason, "Input failed and held-state release could not be confirmed")
        } catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(events, ["97:true:false", "97:false:true"])
        XCTAssertEqual(input.heldKeys, [97])
    }

    func testTextPlanKeepsItsCapturedTimingForTheWholeSequence() async throws {
        var timing = InputTiming()
        timing.typeKeyUs = 11; timing.typeInterKeyUs = 13; timing.typeShiftUs = 17
        var pauses: [UInt32] = []
        var input: InputController!
        input = InputController(vnc: VNCBridge(config: .init()), timing: timing,
            keySender: { _, _, _, _ in }, sleeper: { duration in
                pauses.append(duration)
                input.timing.typeKeyUs = 101
                input.timing.typeInterKeyUs = 103
                input.timing.typeShiftUs = 107
            })
        try await input.typeText("Ab")
        XCTAssertEqual(pauses, [17, 11, 17, 13, 11, 13])
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testNamedSingleKeyCannotSilentlyTruncateUnicodeOrAdmitAnUnsupportedControl() throws {
        XCTAssertNil(namedKeyToKeysym("e\u{0301}"))
        XCTAssertNil(namedKeyToKeysym("\u{1F469}\u{200D}\u{1F4BB}"))
        XCTAssertNil(namedKeyToKeysym("\u{0085}"))
        XCTAssertNil(namedKeyToKeysym("\u{0000}"))
        XCTAssertEqual(namedKeyToKeysym("\u{00E9}"), 0xE9)
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        for key in ["e\u{0301}", "\u{1F469}\u{200D}\u{1F4BB}", "\u{0085}"] {
            let params = try XCTUnwrap(String(data: JSONEncoder().encode(["key": key]), encoding: .utf8))
            XCTAssertThrowsError(try request("key_tap", params).validate(scaling: scaling))
        }
    }

    func testExternalObservationRequiresCompleteBindingAndExactRoundedScale() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        let valid = "{\"nativeWidth\":1920,\"nativeHeight\":1081,\"scaledWidth\":1280,\"scaledHeight\":721,\"connectionGeneration\":2,\"allocation\":3}"
        let adopted = try request("adopt_observation", valid).externalObservation(scaling: scaling)
        XCTAssertEqual(adopted, VNCInputContext(width: 1920, height: 1081, connectionGeneration: 2, allocation: 3))
        for invalid in ["{}", valid.replacingOccurrences(of: "\"allocation\":3", with: "\"allocation\":0"),
                        valid.replacingOccurrences(of: "\"connectionGeneration\":2", with: "\"connectionGeneration\":0"),
                        valid.replacingOccurrences(of: "\"scaledHeight\":721", with: "\"scaledHeight\":720"),
                        valid.replacingOccurrences(of: "\"nativeWidth\":1920", with: "\"nativeWidth\":9223372036854775807")] {
            XCTAssertThrowsError(try request("adopt_observation", invalid).validate(scaling: scaling))
        }
    }

    func testExternalObservationAcknowledgmentCarriesAllSixExactBindingFields() throws {
        let context = VNCInputContext(width: 1920, height: 1081, connectionGeneration: 2, allocation: 3)
        let response = PCResponse.success(id: .number(1), scaledWidth: 1280, scaledHeight: 721, frameContext: context)
        let encoded = try JSONEncoder().encode(response)
        let payload = try XCTUnwrap((JSONSerialization.jsonObject(with: encoded) as? [String: Any])?["result"] as? [String: Any])
        for (field, expected) in ["nativeWidth":1920, "nativeHeight":1081, "scaledWidth":1280,
                                  "scaledHeight":721, "connectionGeneration":2, "allocation":3] {
            XCTAssertEqual(payload[field] as? Int, expected)
        }
    }

    func testRefusedExternalObservationClearsPreviousInputAuthorization() async {
        let vnc = VNCBridge(config: .init()) // no native connection or target
        let input = InputController(vnc: vnc)
        let context = VNCInputContext(width: 1920, height: 1080, connectionGeneration: 1, allocation: 1)
        input.context = context
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        do { try await input.adoptObservation(context, scaling: scaling); XCTFail("disconnected adoption admitted") }
        catch VNCError.notConnected {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertNil(input.context)
    }

    private func permitBinding() -> NativeInputPermit.Binding {
        .init(instanceID: "owned-helper", sessionID: "owned-session", displayID: 1,
              displayGeneration: 2,
              context: .init(width: 1920, height: 1081, connectionGeneration: 3, allocation: 4),
              scaledWidth: 1280, scaledHeight: 721)
    }

    func testPermitDeadlineStartsAtChallengeRatherThanDelayedGrant() throws {
        var now: UInt64 = 0
        let permit = NativeInputPermit(now: { now }, watchdogEnabled: false)
        let binding = permitBinding()
        try permit.qualifyObservation(context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let challenge = try permit.begin(binding: binding, sequence: 1)
        now = 450_000_000
        let receipt = try permit.grant(binding: binding, sequence: 1, challenge: challenge.challenge,
                                       leaseRemainingMilliseconds: 3_000)
        XCTAssertEqual(receipt.remainingMilliseconds, 550)
        now = 999_999_999
        XCTAssertNoThrow(try permit.check(context: binding.context))
        now = 1_000_000_000
        XCTAssertThrowsError(try permit.check(context: binding.context))
        XCTAssertThrowsError(try permit.begin(binding: binding, sequence: 2))
    }

    func testPermitLateGrantAndReplayCannotReviveTheOwnedChild() throws {
        let binding = permitBinding()
        for delayed in [false, true] {
            var now: UInt64 = 0
            let permit = NativeInputPermit(now: { now }, watchdogEnabled: false)
            try permit.qualifyObservation(context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
            let challenge = try permit.begin(binding: binding, sequence: 1)
            if delayed {
                now = 500_000_001
            } else {
                _ = try permit.grant(binding: binding, sequence: 1, challenge: challenge.challenge,
                                     leaseRemainingMilliseconds: 3_000)
            }
            XCTAssertThrowsError(try permit.grant(binding: binding, sequence: 1,
                challenge: challenge.challenge, leaseRemainingMilliseconds: 3_000))
            XCTAssertThrowsError(try permit.begin(binding: binding, sequence: 2))
        }
    }

    func testFreshChallengeCannotRenewAFormerPermitAfterItsDeadline() throws {
        var now: UInt64 = 0
        let permit = NativeInputPermit(now: { now }, watchdogEnabled: false)
        let binding = permitBinding()
        try permit.qualifyObservation(context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let initial = try permit.begin(binding: binding, sequence: 1)
        _ = try permit.grant(binding: binding, sequence: 1, challenge: initial.challenge,
                             leaseRemainingMilliseconds: 3_000)
        now = 750_000_000
        let renewal = try permit.begin(binding: binding, sequence: 2)
        now = 1_000_000_000 // New challenge is timely, but the former permit expired.
        XCTAssertThrowsError(try permit.grant(binding: binding, sequence: 2,
            challenge: renewal.challenge, leaseRemainingMilliseconds: 3_000))
        XCTAssertThrowsError(try permit.check(context: binding.context))
    }

    func testUngrantAndChangedOwnerCannotAdmitInput() throws {
        let binding = permitBinding()
        let permit = NativeInputPermit(now: { 0 }, watchdogEnabled: false)
        try permit.qualifyObservation(context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        _ = try permit.begin(binding: binding, sequence: 1)
        XCTAssertThrowsError(try permit.check(context: binding.context))
        let second = NativeInputPermit(now: { 0 }, watchdogEnabled: false)
        try second.qualifyObservation(context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let challenge = try second.begin(binding: binding, sequence: 1)
        _ = try second.grant(binding: binding, sequence: 1, challenge: challenge.challenge,
                             leaseRemainingMilliseconds: 500)
        let changed = NativeInputPermit.Binding(instanceID: binding.instanceID,
            sessionID: "successor", displayID: binding.displayID, displayGeneration: binding.displayGeneration,
            context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        XCTAssertThrowsError(try second.begin(binding: changed, sequence: 2))
        XCTAssertThrowsError(try second.check(context: binding.context))
    }

    func testExpiredTextOnlyReleasesHeldKeyAndDoesNotReplayOrAcceptSuccessor() async throws {
        var now: UInt64 = 0
        var events: [String] = []
        let permit = NativeInputPermit(now: { now }, watchdogEnabled: false)
        let binding = permitBinding()
        try permit.qualifyObservation(context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let challenge = try permit.begin(binding: binding, sequence: 1)
        _ = try permit.grant(binding: binding, sequence: 1, challenge: challenge.challenge,
                             leaseRemainingMilliseconds: 3_000)
        let input = InputController(vnc: VNCBridge(config: .init()), keySender: { key, down, context, release in
            XCTAssertEqual(context, binding.context)
            events.append("\(key):\(down):\(release)")
        }, sleeper: { _ in now = 1_000_000_000 }, inputPermit: permit)
        input.context = binding.context
        do { try await input.typeText("ab"); XCTFail("expired action succeeded") } catch {}
        XCTAssertEqual(events, ["97:true:false", "97:false:true"])
        XCTAssertTrue(input.heldKeys.isEmpty)
        input.context = binding.context // Even a fresh observation cannot clear the terminal permit.
        do { try await input.keyTap(98); XCTFail("successor succeeded") } catch {}
        XCTAssertEqual(events, ["97:true:false", "97:false:true"])
    }

    func testChangedTextObservationOnlyReleasesIntoTheOriginalContext() async throws {
        let binding = permitBinding()
        let changed = VNCInputContext(width: 1920, height: 1081, connectionGeneration: 3, allocation: 5)
        let permit = NativeInputPermit(now: { 0 }, watchdogEnabled: false)
        try permit.qualifyObservation(context: binding.context,
            scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let challenge = try permit.begin(binding: binding, sequence: 1)
        _ = try permit.grant(binding: binding, sequence: 1, challenge: challenge.challenge,
                             leaseRemainingMilliseconds: 3_000)
        var events: [String] = []
        var input: InputController!
        input = InputController(vnc: VNCBridge(config: .init()), keySender: { key, down, context, release in
            XCTAssertEqual(context, binding.context)
            events.append("\(key):\(down):\(release)")
        }, sleeper: { _ in input.context = changed }, inputPermit: permit)
        input.context = binding.context
        do { try await input.typeText("ab"); XCTFail("changed observation returned success") }
        catch VNCError.sendFailed(let reason) { XCTAssertTrue(reason.contains("Native input permit"), reason) }
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(events, ["97:true:false", "97:false:true"])
        XCTAssertTrue(input.heldKeys.isEmpty)
        XCTAssertThrowsError(try permit.check(context: binding.context))
    }

    func testActualNativeQueueChecksPointerKeyAndClipboardPermits() async throws {
        var now: UInt64 = 0
        let permit = NativeInputPermit(now: { now }, watchdogEnabled: false)
        let binding = permitBinding()
        try permit.qualifyObservation(context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let challenge = try permit.begin(binding: binding, sequence: 1)
        _ = try permit.grant(binding: binding, sequence: 1, challenge: challenge.challenge,
                             leaseRemainingMilliseconds: 3_000)
        XCTAssertNoThrow(try permit.check(context: binding.context)) // Producer preflight was valid.
        now = 1_000_000_000
        let bridge = VNCBridge(config: .init()) // No C socket or target; permit must precede send.
        for kind in ["pointer", "key", "clipboard"] {
            do {
                switch kind {
                case "pointer": try await bridge.sendMouseEvent(x: 1, y: 1,
                    context: binding.context, inputPermit: permit)
                case "key": try await bridge.sendKeyEvent(key: 97, down: true,
                    context: binding.context, inputPermit: permit)
                default: try await bridge.sendClipboardText("synthetic", context: binding.context, inputPermit: permit)
                }
                XCTFail("expired \(kind) reached the native sender")
            } catch VNCError.sendFailed(let reason) {
                XCTAssertTrue(reason.contains("Native input permit"), reason)
            } catch { XCTFail("permit guard was bypassed: \(error)") }
        }
    }

    func testNativePermitWireReceiptCarriesExactOwnerChallengeAndGeometry() throws {
        let permit = NativeInputPermit(now: { 0 }, watchdogEnabled: false)
        let binding = permitBinding()
        try permit.qualifyObservation(context: binding.context, scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let receipt = try permit.begin(binding: binding, sequence: 7)
        let data = try JSONEncoder().encode(PCResponse.inputPermit(id: .number(1), receipt: receipt))
        let result = try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["result"] as? [String: Any])
        XCTAssertEqual(result["instance_id"] as? String, binding.instanceID)
        XCTAssertEqual(result["session_id"] as? String, binding.sessionID)
        XCTAssertEqual(result["challenge"] as? String, receipt.challenge)
        XCTAssertEqual(result["native_permit_protocol"] as? String, NativeInputPermit.protocolVersion)
        for (field, expected) in ["display_id":1, "displayGeneration":2, "sequence":7,
            "nativeWidth":1920, "nativeHeight":1081, "scaledWidth":1280, "scaledHeight":721,
            "connectionGeneration":3, "allocation":4, "input_permit_ms":1000,
            "maximum_round_trip_ms":500, "native_permit_remaining_ms":1000] {
            XCTAssertEqual(result[field] as? Int, expected, field)
        }
    }

    func testTimelyRenewalAndExactRoundTripBoundaryExtendOnlyFromNewChallenge() throws {
        var now: UInt64 = 0
        let permit = NativeInputPermit(now: { now }, watchdogEnabled: false)
        let binding = permitBinding()
        try permit.qualifyObservation(context: binding.context,
            scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let initial = try permit.begin(binding: binding, sequence: 1)
        now = 500_000_000
        _ = try permit.grant(binding: binding, sequence: 1, challenge: initial.challenge,
                             leaseRemainingMilliseconds: 3_000)
        let renewal = try permit.begin(binding: binding, sequence: 2)
        now = 900_000_000
        let granted = try permit.grant(binding: binding, sequence: 2, challenge: renewal.challenge,
                                       leaseRemainingMilliseconds: 3_000)
        XCTAssertEqual(granted.remainingMilliseconds, 600)
        now = 1_499_999_999
        XCTAssertNoThrow(try permit.check(context: binding.context))
        now = 1_500_000_000
        XCTAssertThrowsError(try permit.check(context: binding.context))
    }

    func testIndependentWatchdogExpiresWithoutAnyInputOrBrokerPoll() async throws {
        let permit = NativeInputPermit()
        let binding = permitBinding()
        try permit.qualifyObservation(context: binding.context,
            scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let failed = expectation(description: "native watchdog independently invalidated owner")
        failed.assertForOverFulfill = true
        permit.setFailureHandler { failed.fulfill() }
        let challenge = try permit.begin(binding: binding, sequence: 1)
        _ = try permit.grant(binding: binding, sequence: 1, challenge: challenge.challenge,
                             leaseRemainingMilliseconds: 100)
        await fulfillment(of: [failed], timeout: 2)
        XCTAssertThrowsError(try permit.check(context: binding.context))
        XCTAssertThrowsError(try permit.qualifyObservation(context: binding.context,
            scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight))
    }

    func testPermitRequiresPriorAdoptionAndItsExactScaledMapping() throws {
        let binding = permitBinding()
        let absent = NativeInputPermit(now: { 0 }, watchdogEnabled: false)
        XCTAssertThrowsError(try absent.begin(binding: binding, sequence: 1))
        let wrongScale = NativeInputPermit(now: { 0 }, watchdogEnabled: false)
        try wrongScale.qualifyObservation(context: binding.context,
            scaledWidth: binding.scaledWidth, scaledHeight: binding.scaledHeight)
        let changed = NativeInputPermit.Binding(instanceID: binding.instanceID, sessionID: binding.sessionID,
            displayID: binding.displayID, displayGeneration: binding.displayGeneration,
            context: binding.context, scaledWidth: 1920, scaledHeight: 1081)
        XCTAssertThrowsError(try wrongScale.begin(binding: changed, sequence: 1))
        XCTAssertThrowsError(try wrongScale.begin(binding: binding, sequence: 2))
    }

    // MARK: - Typed stale_screen (TIN-5509)

    func testStaleScreenTaxonomyEncoding() throws {
        XCTAssertEqual(VNCStaleScreenReason.allCases.map(\.rawValue), [
            "server_silent", "metadata_only", "incomplete_coverage", "late_complete",
            "allocation_changed", "disconnected", "request_failed", "capture_busy", "cancelled",
        ])
        var diagnostics = VNCFramebufferDiagnostics()
        diagnostics.unansweredFullRequests = 2
        diagnostics.unansweredIncrementalRequests = 4
        diagnostics.autoRearmObserved = 3
        diagnostics.lastCallbackAgeMilliseconds = 7
        let embedded = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(diagnostics.encoded.utf8)) as? [String: Any])
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        for reason in VNCStaleScreenReason.allCases {
            let message = "\(VNCError.staleScreenDeadlineMessage(milliseconds: 5_000)); diagnostics=\(diagnostics.encoded)"
            XCTAssertTrue(message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
            let error = VNCError.staleScreen(reason: reason,
                                             data: VNCStaleScreenData(message: message, diagnostics: diagnostics))
            XCTAssertEqual(error.localizedDescription, message)
            let response = try XCTUnwrap(PCResponse.staleScreen(id: .number(7), error: error))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(response)) as? [String: Any])
            XCTAssertEqual(Set(json.keys), ["error", "id"])
            XCTAssertEqual(json["id"] as? Int, 7)
            let payload = try XCTUnwrap(json["error"] as? [String: Any])
            XCTAssertEqual(payload["code"] as? Int, -32010)
            XCTAssertEqual(payload["code"] as? Int, VNCError.staleScreenCode)
            XCTAssertEqual(payload["message"] as? String, message)
            let data = try XCTUnwrap(payload["data"] as? [String: Any])
            XCTAssertEqual(Set(data.keys), ["reason", "diagnostics"])
            XCTAssertEqual(data["reason"] as? String, reason.rawValue)
            // Typed data and the compatible message carry identical snake_case keys.
            let wire = try XCTUnwrap(data["diagnostics"] as? [String: Any])
            XCTAssertEqual(Set(wire.keys), Set(embedded.keys))
            XCTAssertEqual(wire["unanswered_full_requests"] as? Int, 2)
            XCTAssertEqual(wire["unanswered_incremental_requests"] as? Int, 4)
            XCTAssertEqual(wire["auto_rearm_observed"] as? Int, 3)
            XCTAssertEqual(wire["last_callback_age_milliseconds"] as? Int, 7)
        }
        // Disconnection and cancellation keep their Swift types inside the
        // bridge and classify only at the wire boundary.
        let snapshot = VNCFramebufferDiagnostics()
        func classified(_ error: Error) -> VNCStaleScreenReason? {
            guard let typed = VNCError.classifyStaleScreen(error, diagnostics: snapshot),
                  case let .staleScreen(reason, _) = typed else { return nil }
            return reason
        }
        XCTAssertEqual(classified(VNCError.notConnected), .disconnected)
        XCTAssertEqual(classified(CancellationError()), .cancelled)
        XCTAssertNil(classified(VNCError.sendFailed("No framebuffer")))
        XCTAssertNil(PCResponse.staleScreen(id: .number(8), error: VNCError.sendFailed("No framebuffer")))
        // Every other failure keeps the legacy -32000 shape without data.
        let legacy = try XCTUnwrap(JSONSerialization.jsonObject(
            with: encoder.encode(PCResponse.error(id: .number(9), message: "x"))) as? [String: Any])
        let legacyError = try XCTUnwrap(legacy["error"] as? [String: Any])
        XCTAssertEqual(Set(legacyError.keys), ["code", "message"])
        XCTAssertEqual(legacyError["code"] as? Int, -32000)
    }

    // MARK: - Observation regions (TIN-6598)

    /// An RGBX frame of one color with optional rectangles of another.
    private func frame(_ width: Int, _ height: Int, fill: UInt8 = 0,
                       paint: [(FrameRect, UInt8)] = []) -> Data {
        var bytes = [UInt8](repeating: fill, count: width * height * 4)
        for (rect, value) in paint {
            for y in rect.y..<rect.maxY {
                for x in rect.x..<rect.maxX { bytes[(y * width + x) * 4] = value }
            }
        }
        return Data(bytes)
    }

    func testRegionMappingCoversTouchedNativePixelsAndRoundsBoxesOutward() throws {
        let rect = FrameRect(x: 10, y: 20, width: 30, height: 40)
        let native = try XCTUnwrap(FrameRegion.toNative(rect, nativeWidth: 2560, nativeHeight: 1440,
                                                        scaledWidth: 1280, scaledHeight: 720))
        XCTAssertEqual(native, FrameRect(x: 20, y: 40, width: 60, height: 80))
        XCTAssertEqual(FrameRegion.toScaled(native, nativeWidth: 2560, nativeHeight: 1440,
                                            scaledWidth: 1280, scaledHeight: 720), rect)
        // A one-pixel scaled region on an odd ratio covers every native pixel it touches.
        XCTAssertEqual(FrameRegion.toNative(FrameRect(x: 0, y: 0, width: 1, height: 1), nativeWidth: 1920,
                                            nativeHeight: 1081, scaledWidth: 1280, scaledHeight: 721),
                       FrameRect(x: 0, y: 0, width: 2, height: 2))
        // A one-pixel native change never vanishes when reported in scaled space.
        XCTAssertEqual(FrameRegion.toScaled(FrameRect(x: 1919, y: 1080, width: 1, height: 1), nativeWidth: 1920,
                                            nativeHeight: 1081, scaledWidth: 1280, scaledHeight: 721),
                       FrameRect(x: 1279, y: 720, width: 1, height: 1))
        // Regions clamp to the frame; nothing outside it maps to anything.
        XCTAssertEqual(FrameRegion.toNative(FrameRect(x: 1270, y: 710, width: 50, height: 50), nativeWidth: 1280,
                                            nativeHeight: 720, scaledWidth: 1280, scaledHeight: 720),
                       FrameRect(x: 1270, y: 710, width: 10, height: 10))
        XCTAssertNil(FrameRegion.toNative(FrameRect(x: 1280, y: 0, width: 5, height: 5), nativeWidth: 1280,
                                          nativeHeight: 720, scaledWidth: 1280, scaledHeight: 720))
        XCTAssertTrue(FrameRect(x: 1279, y: 719, width: 1, height: 1).isInside(width: 1280, height: 720))
        for invalid in [FrameRect(x: -1, y: 0, width: 1, height: 1), FrameRect(x: 0, y: 0, width: 0, height: 1),
                        FrameRect(x: 1279, y: 0, width: 2, height: 1),
                        FrameRect(x: Int.max, y: 0, width: Int.max, height: 1)] {
            XCTAssertFalse(invalid.isInside(width: 1280, height: 720))
        }
    }

    func testMaskSubtractsIgnoredRectanglesFromRegions() {
        let mask = FrameMask(width: 10, height: 3, include: [FrameRect(x: 0, y: 0, width: 6, height: 2),
                                                             FrameRect(x: 4, y: 0, width: 4, height: 1)],
                             exclude: [FrameRect(x: 2, y: 1, width: 2, height: 5)])
        XCTAssertEqual(mask.spans(row: 0), [0..<8])
        XCTAssertEqual(mask.spans(row: 1), [0..<2, 4..<6])
        XCTAssertEqual(mask.spans(row: 2), [])
        XCTAssertEqual(mask.includedPixels, 12)
        XCTAssertEqual(mask.bounds, FrameRect(x: 0, y: 0, width: 8, height: 2))
        let whole = FrameMask(width: 4, height: 2, include: nil, exclude: [])
        XCTAssertEqual(whole.includedPixels, 8)
        // Regions that map to nothing admit nothing; they never widen to the frame.
        XCTAssertEqual(FrameMask(width: 4, height: 2, include: [], exclude: []).includedPixels, 0)
        let ignored = FrameMask(width: 4, height: 2, include: nil, exclude: [FrameRect(x: 0, y: 0, width: 4, height: 2)])
        XCTAssertNil(ignored.bounds)
    }

    func testCompareCountsColorChangesOnlyAndGroupsSeparateBoxes() throws {
        let width = 64, height = 32
        let baseline = frame(width, height)
        // Padding is not a visible change.
        var padding = [UInt8](baseline)
        padding[3] = 255
        let whole = FrameMask(width: width, height: height, include: nil, exclude: [])
        let none = try XCTUnwrap(baseline.withUnsafeBytes { old in
            Data(padding).withUnsafeBytes { FrameRegion.compare(old, $0, width: width, height: height, mask: whole) }
        })
        XCTAssertEqual(none, FrameDiff(changedPixels: 0, comparedPixels: width * height))
        let small = FrameRect(x: 2, y: 2, width: 3, height: 3)
        let large = FrameRect(x: 40, y: 20, width: 5, height: 6)
        let current = frame(width, height, paint: [(small, 9), (large, 9)])
        func diff(_ mask: FrameMask) throws -> FrameDiff {
            try XCTUnwrap(baseline.withUnsafeBytes { old in
                current.withUnsafeBytes { FrameRegion.compare(old, $0, width: width, height: height, mask: mask) }
            })
        }
        let both = try diff(whole)
        XCTAssertEqual(both.changedPixels, 9 + 30)
        XCTAssertEqual(both.boxes, [large, small]) // largest change first
        XCTAssertFalse(both.boxesTruncated)
        XCTAssertEqual(both.ratio, 39.0 / Double(width * height), accuracy: 1e-12)
        let masked = try diff(FrameMask(width: width, height: height, include: nil, exclude: [large]))
        XCTAssertEqual(masked.boxes, [small])
        XCTAssertEqual(masked.comparedPixels, width * height - 30)
        // Mismatched geometry is not comparable.
        XCTAssertNil(baseline.withUnsafeBytes { old in
            Data(count: 8).withUnsafeBytes { FrameRegion.compare(old, $0, width: width, height: height, mask: whole) }
        })
        // Many separate changes report the largest boxes and say so.
        let scattered = (0..<20).map { (FrameRect(x: ($0 % 10) * 40, y: ($0 / 10) * 40, width: 1, height: 1), UInt8(1)) }
        let wide = frame(400, 80, paint: scattered)
        let many = try XCTUnwrap(frame(400, 80).withUnsafeBytes { old in
            wide.withUnsafeBytes { FrameRegion.compare(old, $0, width: 400, height: 80,
                                                       mask: FrameMask(width: 400, height: 80, include: nil, exclude: [])) }
        })
        XCTAssertEqual(many.boxes.count, FrameRegion.maximumBoxes)
        XCTAssertTrue(many.boxesTruncated)
    }

    func testEvaluateReportsAbsentMatchedAndGeometryChangedBaselinesInScaledSpace() {
        let context = VNCInputContext(width: 64, height: 32, connectionGeneration: 1, allocation: 1)
        let baseline = frame(64, 32)
        let current = frame(64, 32, paint: [(FrameRect(x: 10, y: 4, width: 4, height: 2), 7)])
        func evaluate(_ prior: (pixels: Data, context: VNCInputContext)?, _ context: VNCInputContext,
                      include: [FrameRect]? = nil) -> FrameDiffSummary {
            FrameRegion.evaluate(baseline: prior, current: current, context: context, include: include,
                                 exclude: [], scaledWidth: 32, scaledHeight: 16)
        }
        XCTAssertEqual(evaluate(nil, context), FrameDiffSummary(changed: false, changedRatio: 0, changedPixels: 0,
            comparedPixels: 0, boxes: [], boxesTruncated: false, baseline: .absent))
        let matched = evaluate((pixels: baseline, context: context), context)
        XCTAssertTrue(matched.changed)
        XCTAssertEqual(matched.baseline, .matched)
        XCTAssertEqual(matched.boxes, [FrameRect(x: 5, y: 2, width: 2, height: 1)])
        XCTAssertEqual(matched.changedRatio, 0.003906)
        // A region elsewhere sees no change.
        let elsewhere = evaluate((pixels: baseline, context: context), context,
                                 include: [FrameRect(x: 20, y: 8, width: 4, height: 4)])
        XCTAssertFalse(elsewhere.changed)
        XCTAssertEqual(elsewhere.comparedPixels, 64)
        // A reallocation cannot be compared pixel by pixel.
        let reallocated = VNCInputContext(width: 64, height: 32, connectionGeneration: 1, allocation: 2)
        let moved = evaluate((pixels: baseline, context: reallocated), context,
                             include: [FrameRect(x: 2, y: 2, width: 3, height: 3)])
        XCTAssertEqual(moved, FrameDiffSummary(changed: true, changedRatio: 1, changedPixels: 36, comparedPixels: 36,
            boxes: [FrameRect(x: 2, y: 2, width: 3, height: 3)], boxesTruncated: false, baseline: .geometryChanged))
    }

    func testStabilityNeedsAnUnchangedRunAndAStableVerdictOutranksTimeout() {
        var stability = FrameStability(stableMilliseconds: 300, timeoutMilliseconds: 1000,
                                       startedMilliseconds: 1000, firstCaptureMilliseconds: 1050)
        XCTAssertFalse(stability.isStable)
        stability.observe(changed: false, atMilliseconds: 1200)
        XCTAssertFalse(stability.isStable)
        stability.observe(changed: true, atMilliseconds: 1300) // the run restarts here
        stability.observe(changed: false, atMilliseconds: 1500)
        XCTAssertFalse(stability.isStable)
        XCTAssertFalse(stability.isExpired(atMilliseconds: 1999))
        XCTAssertTrue(stability.isExpired(atMilliseconds: 2000))
        stability.observe(changed: false, atMilliseconds: 2100)
        XCTAssertTrue(stability.isStable)
        XCTAssertEqual(stability.stableForMilliseconds, 800)
        XCTAssertEqual(stability.captures, 5)
        XCTAssertEqual(stability.elapsed(atMilliseconds: 900), 0)
        XCTAssertEqual(FrameStability.pollMilliseconds(stableMilliseconds: 50), 50)
        XCTAssertEqual(FrameStability.pollMilliseconds(stableMilliseconds: 400), 100)
        XCTAssertEqual(FrameStability.pollMilliseconds(stableMilliseconds: 10_000), 250)
    }

    func testObservationRequestsValidateRegionsAndBoundsBeforeCapture() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        let methods = Set(PCRequest.supportedMethods)
        XCTAssertTrue(["zoom", "wait_for_stable", "expect_baseline", "expect_change"].allSatisfy(methods.contains))
        XCTAssertNoThrow(try request("diff_check").validate(scaling: scaling))
        XCTAssertNoThrow(try request("zoom", "{\"x\":1270,\"y\":710,\"width\":10,\"height\":10}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("zoom", "{\"x\":0,\"y\":0,\"width\":1280,\"height\":720,\"max_dimension\":320}")
            .validate(scaling: scaling))
        XCTAssertNoThrow(try request("wait_for_stable", "{\"stable_ms\":300,\"timeout_ms\":3000,"
            + "\"regions\":[{\"x\":0,\"y\":0,\"width\":10,\"height\":10}],\"ignore\":[]}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("expect_change", "{\"x\":0,\"y\":0,\"width\":1,\"height\":1}").validate(scaling: scaling))
        let seventeen = Array(repeating: "{\"x\":0,\"y\":0,\"width\":1,\"height\":1}", count: 17).joined(separator: ",")
        for (method, params) in [
            ("zoom", "{\"x\":0,\"y\":0,\"width\":1281,\"height\":1}"),
            ("zoom", "{\"x\":0,\"y\":0,\"width\":0,\"height\":1}"),
            ("zoom", "{\"x\":0,\"y\":0}"),
            ("zoom", "{\"x\":0,\"y\":0,\"width\":1,\"height\":1,\"max_dimension\":100}"),
            ("expect_change", "{\"x\":0,\"y\":0,\"width\":1,\"height\":1,\"timeout_ms\":20000}"),
            ("diff_check", "{\"regions\":[]}"),
            ("diff_check", "{\"regions\":[\(seventeen)]}"),
            ("diff_check", "{\"ignore\":[{\"x\":0,\"y\":700,\"width\":1,\"height\":21}]}"),
            ("wait_for_stable", "{\"stable_ms\":300}"),
            ("wait_for_stable", "{\"stable_ms\":3000,\"timeout_ms\":300}"),
            ("wait_for_stable", "{\"stable_ms\":10,\"timeout_ms\":300}"),
            ("wait_for_stable", "{\"stable_ms\":300,\"timeout_ms\":20001}"),
        ] {
            XCTAssertThrowsError(try request(method, params).validate(scaling: scaling), "\(method) \(params)")
        }
    }

    func testObservationResultsAndUnmetConditionEncodeStableWireShapes() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let unmet = ObservationUnmetError(reason: .stableTimeout, message: "Screen did not stay unchanged",
                                          elapsedMilliseconds: 3004, captures: 12)
        XCTAssertEqual(ObservationUnmetError.Reason.allCases.map(\.rawValue), ["stable_timeout", "change_not_observed"])
        let response = try XCTUnwrap(PCResponse.observationUnmet(id: .number(3), error: unmet))
        XCTAssertNil(PCResponse.observationUnmet(id: .number(3), error: VNCError.sendFailed("x")))
        XCTAssertNil(PCResponse.staleScreen(id: .number(3), error: unmet))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(response)) as? [String: Any])
        let payload = try XCTUnwrap(json["error"] as? [String: Any])
        XCTAssertEqual(payload["code"] as? Int, -32012)
        XCTAssertEqual(payload["message"] as? String, "Screen did not stay unchanged")
        let data = try XCTUnwrap(payload["data"] as? [String: Any])
        XCTAssertEqual(Set(data.keys), ["reason", "elapsed_ms", "captures"])
        XCTAssertEqual(data["reason"] as? String, "stable_timeout")
        let diff = FrameDiffSummary(changed: true, changedRatio: 0.5, changedPixels: 2, comparedPixels: 4,
                                    boxes: [FrameRect(x: 1, y: 2, width: 3, height: 4)], boxesTruncated: false,
                                    baseline: .matched)
        let zoom = ZoomSummary(region: FrameRect(x: 1, y: 2, width: 3, height: 4),
                               native: FrameRect(x: 2, y: 4, width: 6, height: 8), imageWidth: 6, imageHeight: 8)
        let success = PCResponse.success(id: .number(4), detail: "changeDetected: true", diff: diff, zoom: zoom,
            stable: StableSummary(stableMilliseconds: 300, stableForMilliseconds: 320, elapsedMilliseconds: 900,
                                  captures: 5))
        let result = try XCTUnwrap((JSONSerialization.jsonObject(with: encoder.encode(success)) as? [String: Any])?["result"]
            as? [String: Any])
        XCTAssertEqual(result["detail"] as? String, "changeDetected: true")
        XCTAssertEqual(Set(try XCTUnwrap(result["diff"] as? [String: Any]).keys),
                       ["changed", "changed_ratio", "changed_pixels", "compared_pixels", "boxes", "boxes_truncated",
                        "baseline"])
        XCTAssertEqual(Set(try XCTUnwrap(result["zoom"] as? [String: Any]).keys),
                       ["region", "native", "image_width", "image_height"])
        XCTAssertEqual(Set(try XCTUnwrap(result["stable"] as? [String: Any]).keys),
                       ["stable_ms", "stable_for_ms", "elapsed_ms", "captures"])
    }

    // MARK: - Apple modifier wire trace (TIN-5008)

    /// A real VNCBridge over an owned in-memory client: real LibVNCClient
    /// allocation, no socket, server or desktop. Polls are never scheduled.
    private func ownedBridge(_ trace: WireTrace) async throws -> VNCBridge {
        let operations = VNCClientOperations(make: { config in
            rfbGetClient(config.bitsPerSample, config.samplesPerPixel, config.bytesPerPixel)
        }, initialize: { client in
            client.pointee.width = 2; client.pointee.height = 2
            client.pointee.format.bitsPerPixel = 32
            guard vncMallocFrameBuffer(client) != 0 else { VNCClientOperations.release(client); return false }
            vncGotFrameBufferUpdate(client, 0, 0, 2, 2)
            vncFinishedFrameBufferUpdate(client)
            return true
        }, cleanup: VNCClientOperations.release,
        poll: { _, _, _ in true }, incrementalUpdate: { _ in true }, fullUpdate: { _ in true },
        sendKey: { _, key, down in
            trace.append((down ? "down 0x" : "up 0x") + String(key, radix: 16, uppercase: true))
            return true
        })
        let bridge = VNCBridge(operations: operations, schedule: { _, _, _ in })
        try await bridge.connect()
        try await bridge.waitForFramebuffer()
        return bridge
    }

    func testOptionAndCommandNamesResolveToPortableKeysyms() {
        XCTAssertEqual(namedKeyToKeysym("alt"), KeySym.altLeft)
        XCTAssertEqual(namedKeyToKeysym("option"), KeySym.altLeft)
        XCTAssertEqual(namedKeyToKeysym("opt"), KeySym.altLeft)
        XCTAssertEqual(namedKeyToKeysym("cmd"), KeySym.metaLeft)
        XCTAssertEqual(namedKeyToKeysym("command"), KeySym.metaLeft)
        XCTAssertEqual(namedKeyToKeysym("n"), 0x6E)
    }

    /// alt+cmd+n through the real InputController and VNCBridge. On Apple's
    /// server Option is written as Meta_L and Command as Super_L; Option goes
    /// down first and comes up last, each step waits its configured settle,
    /// and the string and keys-array forms write identical RFB events.
    func testOptionCommandComboWireTraceOnAppleAndOtherServers() async throws {
        for appleServer in [true, false] {
            let trace = WireTrace()
            let bridge = try await ownedBridge(trace)
            bridge.isMacOS = appleServer
            let input = InputController(vnc: bridge, sleeper: { trace.append("pause \($0)") })
            input.context = VNCInputContext(bridge.framebufferDiagnostics)
            let option = appleServer ? "0xFFE7" : "0xFFE9"
            let command = appleServer ? "0xFFEB" : "0xFFE7"
            let combo = ["down " + option, "pause 10000", "down " + command, "pause 10000",
                         "down 0x6E", "pause 30000", "up 0x6E", "pause 10000",
                         "up " + command, "pause 10000", "up " + option, "pause 10000"]
            try await input.keyCombo("alt+cmd+n")
            let keys = ["alt", "cmd", "n"].compactMap(namedKeyToKeysym)
            XCTAssertEqual(keys.count, 3)
            try await input.keyCombo(keys)
            // The connection's first input follows the release-only modifier sync.
            let sync = VNCBridge.modifierKeysyms.map { "up 0x" + String($0, radix: 16, uppercase: true) }
            XCTAssertEqual(trace.values, sync + combo + combo)
            XCTAssertTrue(input.heldKeys.isEmpty)
            // A configured settle applies to every modifier step.
            input.timing.comboModUs = 50_000
            let before = trace.values.count
            try await input.keyCombo("alt+cmd+n")
            XCTAssertEqual(Array(trace.values[before...]).filter { $0.hasPrefix("pause") },
                           ["pause 50000", "pause 50000", "pause 30000", "pause 50000", "pause 50000", "pause 50000"])
            bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        }
    }

    // MARK: - Input settle (TIN-5509)

    /// InputController over fake senders: each write is stamped with the
    /// milliseconds since ServerInit on the fake clock.
    private func settleHarness(appleServer: Bool = true, configured: Int? = nil)
        -> (InputController, VNCInputSettle, SettleClock, WireTrace, UInt64) {
        let clock = SettleClock(), trace = WireTrace()
        let settle = VNCInputSettle(configuredMilliseconds: configured, now: clock.now, sleep: clock.sleep)
        settle.serverInitCompleted(generation: 1, appleServer: appleServer)
        let origin = clock.now()
        let stamp = { (clock.now() - origin) / 1_000_000 }
        let input = InputController(vnc: VNCBridge(),
            pointerSender: { x, y, mask, _, _ in trace.append("pointer \(x),\(y),\(mask) @\(stamp())") },
            keySender: { key, down, _, _ in trace.append("\(down ? "down" : "up") \(key) @\(stamp())") },
            sleeper: { _ in }, inputSettle: settle)
        input.context = VNCInputContext(width: 4, height: 4, connectionGeneration: 1, allocation: 1)
        return (input, settle, clock, trace, origin)
    }

    func testInputSettleDefaultsAppleOnlyAndClampsTheFlag() {
        XCTAssertEqual(VNCInputSettle.effectiveMilliseconds(configured: nil, appleServer: true), 3_000)
        XCTAssertEqual(VNCInputSettle.effectiveMilliseconds(configured: nil, appleServer: false), 0)
        XCTAssertEqual(VNCInputSettle.effectiveMilliseconds(configured: 0, appleServer: true), 0)
        XCTAssertEqual(VNCInputSettle.effectiveMilliseconds(configured: 1_500, appleServer: false), 1_500)
        XCTAssertEqual(VNCInputSettle.effectiveMilliseconds(configured: 20_000, appleServer: true), 10_000)
        let idle = VNCInputSettle()
        XCTAssertFalse(idle.status().connected)
        XCTAssertFalse(idle.status().ready)
        XCTAssertFalse(idle.admits(generation: 0))
    }

    /// Measured on Apple: screensharingd paused ~4.7 s mid-update after
    /// UI-heavy input, so Apple gets 10 s and every other server keeps 5 s.
    func testCaptureDeadlineDefaultsAppleOnlyAndClampsTheFlag() {
        XCTAssertEqual(VNCCaptureDeadline.effectiveMilliseconds(configured: nil, appleServer: true), 10_000)
        XCTAssertEqual(VNCCaptureDeadline.effectiveMilliseconds(configured: nil, appleServer: false), 5_000)
        XCTAssertEqual(VNCCaptureDeadline.effectiveMilliseconds(configured: 7_500, appleServer: false), 7_500)
        XCTAssertEqual(VNCCaptureDeadline.effectiveMilliseconds(configured: 5_000, appleServer: true), 5_000)
        XCTAssertEqual(VNCCaptureDeadline.effectiveMilliseconds(configured: 10, appleServer: true), 1_000)
        XCTAssertEqual(VNCCaptureDeadline.effectiveMilliseconds(configured: 60_000, appleServer: false), 20_000)
        XCTAssertLessThan(VNCCaptureDeadline.maximumMilliseconds, 30_000, "must fit inside the MCP tool deadline")
        // The bridge reads Apple detection at capture time, after the ARD credential request.
        var config = VNCConfiguration()
        let bridge = VNCBridge(config: config)
        XCTAssertEqual(bridge.captureDeadlineMilliseconds, 5_000)
        bridge.isMacOS = true
        XCTAssertEqual(bridge.captureDeadlineMilliseconds, 10_000)
        config.captureTimeoutMilliseconds = 8_000
        XCTAssertEqual(VNCBridge(config: config).captureDeadlineMilliseconds, 8_000)
        // The compatible prefix survives; the rest names the actual deadline.
        XCTAssertEqual(VNCError.staleScreenDeadlineMessage(milliseconds: 5_000),
                       "No fresh complete framebuffer update within 5 seconds")
        XCTAssertEqual(VNCError.staleScreenDeadlineMessage(milliseconds: 10_000),
                       "No fresh complete framebuffer update within 10 seconds")
        XCTAssertEqual(VNCError.staleScreenDeadlineMessage(milliseconds: 2_345),
                       "No fresh complete framebuffer update within 2345 ms")
        XCTAssertTrue(VNCError.staleScreenDeadlineMessage(milliseconds: 0)
            .hasPrefix(VNCError.staleScreenDeadlinePrefix))
    }

    /// Measured on Apple: keys at +1.3 s were ignored. The first input now
    /// waits to +3.0 s; input after the settle time is immediate.
    func testFirstInputWaitsOutSettleThenLaterInputIsImmediate() async throws {
        let (input, settle, clock, trace, _) = settleHarness()
        clock.advance(1_300_000_000)
        XCTAssertEqual(settle.status().remainingMilliseconds, 1_700)
        XCTAssertFalse(settle.status().ready)
        try await input.keyTap(0x61)
        XCTAssertEqual(clock.sleeps, [1_700_000_000])
        XCTAssertEqual(trace.values, ["down 97 @3000", "up 97 @3000"])
        XCTAssertTrue(settle.status().ready)
        XCTAssertEqual(settle.status().remainingMilliseconds, 0)
        try await input.mouseClick(x: 1, y: 2, button: .left)
        try await input.keyTap(0x62)
        XCTAssertEqual(clock.sleeps, [1_700_000_000], "settled input never waits again")
        XCTAssertTrue(trace.values.dropFirst(2).allSatisfy { $0.hasSuffix("@3000") })
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testReconnectRestartsTheSettleTime() async throws {
        let (input, settle, clock, trace, origin) = settleHarness()
        clock.advance(5_000_000_000)
        try await input.keyTap(0x61)
        XCTAssertEqual(clock.sleeps, [])
        settle.disconnected()
        XCTAssertFalse(settle.status().ready)
        XCTAssertFalse(settle.admits(generation: 1))
        clock.advance(10_000_000)
        settle.serverInitCompleted(generation: 2, appleServer: true)
        let reconnectedAt = (clock.now() - origin) / 1_000_000
        XCTAssertFalse(settle.admits(generation: 2))
        XCTAssertEqual(settle.status().connectionGeneration, 2)
        XCTAssertEqual(settle.status().remainingMilliseconds, 3_000)
        input.context = VNCInputContext(width: 4, height: 4, connectionGeneration: 2, allocation: 1)
        try await input.keyTap(0x62)
        XCTAssertEqual(clock.sleeps, [3_000_000_000])
        XCTAssertEqual(Array(trace.values.suffix(2)),
                       ["down 98 @\(reconnectedAt + 3_000)", "up 98 @\(reconnectedAt + 3_000)"])
        XCTAssertTrue(settle.admits(generation: 2))
        XCTAssertFalse(settle.admits(generation: 1))
    }

    func testDeadlineShorterThanSettleFailsTypedWithoutAnyEvent() async throws {
        let (input, _, clock, trace, _) = settleHarness()
        clock.advance(500_000_000)
        input.requestDeadlineNs = clock.now() + 1_000_000_000
        do {
            try await input.keyTap(0x61)
            XCTFail("input inside the settle time must not outrun its deadline")
        } catch VNCError.inputNotReady(let remaining) {
            XCTAssertEqual(remaining, 2_500)
        }
        do {
            try await input.pasteText("x")
            XCTFail("paste must wait for the settle time too")
        } catch VNCError.inputNotReady(let remaining) {
            XCTAssertEqual(remaining, 2_500)
        }
        XCTAssertEqual(trace.values, [])
        XCTAssertEqual(clock.sleeps, [])
        XCTAssertTrue(input.heldKeys.isEmpty)
        // A deadline that covers the remaining time waits instead of failing.
        input.requestDeadlineNs = clock.now() + 2_600_000_000
        try await input.keyTap(0x61)
        XCTAssertEqual(trace.values, ["down 97 @3000", "up 97 @3000"])

        let response = try XCTUnwrap(PCResponse.inputNotReady(id: .number(7),
            error: VNCError.inputNotReady(remainingMilliseconds: 2_500)))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? [String: Any])
        let payload = try XCTUnwrap(json["error"] as? [String: Any])
        XCTAssertEqual(payload["code"] as? Int, -32013)
        XCTAssertEqual(payload["code"] as? Int, VNCError.inputNotReadyCode)
        XCTAssertNotEqual(VNCError.inputNotReadyCode, VNCError.staleScreenCode)
        XCTAssertTrue((payload["message"] as? String)?.hasPrefix("Input not ready") == true)
        let data = try XCTUnwrap(payload["data"] as? [String: Any])
        XCTAssertEqual(data["reason"] as? String, "input_not_ready")
        XCTAssertEqual(data["remaining_ms"] as? Int, 2_500)
        XCTAssertNil(PCResponse.inputNotReady(id: nil, error: VNCError.notConnected))
        XCTAssertNil(PCResponse.staleScreen(id: nil, error: VNCError.inputNotReady(remainingMilliseconds: 1)))
    }

    func testNonAppleServerDefaultsToNoSettle() async throws {
        let (input, settle, clock, trace, _) = settleHarness(appleServer: false)
        XCTAssertTrue(settle.status().ready)
        XCTAssertEqual(settle.status().settleMilliseconds, 0)
        try await input.keyTap(0x61)
        XCTAssertEqual(clock.sleeps, [])
        XCTAssertEqual(trace.values, ["down 97 @0", "up 97 @0"])
        // An explicit flag value applies to any server.
        let (configured, _, configuredClock, _, _) = settleHarness(appleServer: false, configured: 1_200)
        try await configured.keyTap(0x61)
        XCTAssertEqual(configuredClock.sleeps, [1_200_000_000])
    }

    func testCancelledSettleWaitWritesNothing() async throws {
        let clock = SettleClock(), trace = WireTrace()
        let settle = VNCInputSettle(now: clock.now, sleep: { try await Task.sleep(nanoseconds: $0 * 20) })
        settle.serverInitCompleted(generation: 1, appleServer: true)
        let input = InputController(vnc: VNCBridge(),
            keySender: { key, down, _, _ in trace.append("\(down ? "down" : "up") \(key)") },
            sleeper: { _ in }, inputSettle: settle)
        input.context = VNCInputContext(width: 4, height: 4, connectionGeneration: 1, allocation: 1)
        let task = Task { try await input.keyTap(0x61) }
        task.cancel()
        do { try await task.value; XCTFail("cancelled input must not complete") }
        catch { XCTAssertTrue(error is CancellationError, "\(error)") }
        XCTAssertEqual(trace.values, [])
    }

    func testPermitLeaseBoundsTheSettleWait() async throws {
        let clock = SettleClock()
        let settle = VNCInputSettle(now: clock.now, sleep: clock.sleep)
        settle.serverInitCompleted(generation: 1, appleServer: true)
        do {
            try await settle.waitUntilReady(budgetNs: { 1_000_000_000 })
            XCTFail("a wait longer than the permit lease must not start")
        } catch VNCError.inputNotReady(let remaining) {
            XCTAssertEqual(remaining, 3_000)
        }
        XCTAssertEqual(clock.sleeps, [])
        try await settle.waitUntilReady(budgetNs: { nil })
        XCTAssertEqual(clock.sleeps, [3_000_000_000])
        // Ordinary raw-VNC mode has no lease bound.
        XCTAssertNil(NativeInputPermit(watchdogEnabled: false).remainingNanoseconds())
    }

    /// Through the real VNCBridge: the ARD credential callback marks the
    /// server as Apple during the handshake, so the 3000 ms default applies.
    /// The native queue refuses every write before the settle time, release
    /// and clipboard included, while observation stays available.
    func testBridgeRefusesEveryWriteBeforeSettleAndResetsOnReconnect() async throws {
        let clock = SettleClock(), trace = WireTrace()
        let operations = VNCClientOperations(make: { config in
            rfbGetClient(config.bitsPerSample, config.samplesPerPixel, config.bytesPerPixel)
        }, initialize: { client in
            if let credential = vncGetCredential(client, rfbCredentialTypeUser) {
                free(credential.pointee.userCredential.username)
                free(credential.pointee.userCredential.password)
                credential.deallocate()
            }
            client.pointee.width = 2; client.pointee.height = 2
            client.pointee.format.bitsPerPixel = 32
            guard vncMallocFrameBuffer(client) != 0 else { VNCClientOperations.release(client); return false }
            vncGotFrameBufferUpdate(client, 0, 0, 2, 2)
            vncFinishedFrameBufferUpdate(client)
            return true
        }, cleanup: VNCClientOperations.release,
        poll: { _, _, _ in true }, incrementalUpdate: { _ in true }, fullUpdate: { _ in true },
        sendKey: { _, key, down in
            trace.append((down ? "down 0x" : "up 0x") + String(key, radix: 16, uppercase: true))
            return true
        }, sendPointer: { _, _, _, _ in trace.append("pointer"); return true },
        sendClientCutText: { _, _ in trace.append("cut"); return true })
        let bridge = VNCBridge(operations: operations, schedule: { _, _, _ in },
                               monotonicNanoseconds: clock.now)
        try await bridge.connect()
        try await bridge.waitForFramebuffer()
        XCTAssertTrue(bridge.isMacOS)
        let context = VNCInputContext(bridge.framebufferDiagnostics)
        XCTAssertEqual(bridge.inputSettle.status(), VNCInputSettle.Status(
            connectionGeneration: context.connectionGeneration, connected: true,
            settleMilliseconds: 3_000, remainingNanoseconds: 3_000_000_000))
        func refused(_ write: () async throws -> Void) async {
            do { try await write(); XCTFail("write before the settle time") }
            catch VNCError.inputNotReady(let remaining) { XCTAssertGreaterThan(remaining, 0) }
            catch { XCTFail("unexpected \(error)") }
        }
        await refused { try await bridge.sendKeyEvent(key: 0x61, down: true, context: context) }
        await refused { try await bridge.sendKeyEvent(key: 0x61, down: false, context: context, releaseOnly: true) }
        await refused { try await bridge.sendMouseEvent(x: 1, y: 1, context: context) }
        await refused { try await bridge.sendClipboardText("x", context: context) }
        // Observation is never gated.
        try await bridge.waitForFramebuffer()
        let health = PCResponse.success(id: .number(1), detail: "connected").withInputSettle(bridge.inputSettle.status())
        let healthJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(health)) as? [String: Any])
        let result = try XCTUnwrap(healthJSON["result"] as? [String: Any])
        XCTAssertEqual(result["input_ready"] as? Bool, false)
        XCTAssertEqual(result["input_settle_remaining_ms"] as? Int, 3_000)
        XCTAssertEqual(result["input_settle_ms"] as? Int, 3_000)
        XCTAssertEqual(trace.values, [])

        clock.advance(3_000_000_000)
        try await bridge.sendKeyEvent(key: 0x61, down: true, context: context)
        try await bridge.sendKeyEvent(key: 0x61, down: false, context: context, releaseOnly: true)
        // The first settled input also writes the modifier release sync (TIN-6597).
        let firstInput = VNCBridge.modifierKeysyms.map { "up 0x" + String($0, radix: 16, uppercase: true) }
            + ["down 0x61", "up 0x61"]
        XCTAssertEqual(trace.values, firstInput)

        bridge.disconnect()
        XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertFalse(bridge.inputSettle.status().connected)
        try await bridge.connect()
        try await bridge.waitForFramebuffer()
        let reconnected = VNCInputContext(bridge.framebufferDiagnostics)
        XCTAssertGreaterThan(reconnected.connectionGeneration, context.connectionGeneration)
        XCTAssertEqual(bridge.inputSettle.status().remainingMilliseconds, 3_000)
        await refused { try await bridge.sendKeyEvent(key: 0x62, down: true, context: reconnected) }
        XCTAssertEqual(trace.values, firstInput)
        bridge.disconnect()
    }

    // MARK: - Native input parity (TIN-6597)

    /// Pointer, key and pause trace through fake senders; no bridge connection.
    private func tracedInput(_ trace: WireTrace, failKey: UInt32? = nil,
                             sleeper: ((UInt32) async throws -> Void)? = nil) -> InputController {
        let pauses: (UInt32) async throws -> Void = sleeper ?? { duration in trace.append("pause \(duration)") }
        return InputController(vnc: VNCBridge(config: .init()), pointerSender: { x, y, mask, _, release in
            trace.append("pointer \(x),\(y) mask=\(mask)" + (release ? " release" : ""))
        }, keySender: { key, down, _, release in
            trace.append((down ? "down 0x" : "up 0x") + String(key, radix: 16, uppercase: true)
                         + (release ? " release" : ""))
            if down, key == failKey { throw VNCError.sendFailed("synthetic uncertain key") }
        }, sleeper: pauses)
    }

    func testModifierKeysymsAreOneSetAcrossInputAndBridge() {
        XCTAssertEqual(KeySym.modifiers, VNCBridge.modifierKeysyms)
        XCTAssertEqual(Set(KeySym.modifiers).count, KeySym.modifiers.count)
        for name in ["shift", "rshift", "ctrl", "control", "rctrl", "alt", "option", "opt", "ralt",
                     "cmd", "command", "meta", "super", "rcmd"] {
            XCTAssertNotNil(modifierNameToKeysym(name), name)
        }
        for name in ["a", "tab", "capslock", "f1", "space"] { XCTAssertNil(modifierNameToKeysym(name), name) }
    }

    func testTripleClickWritesThreeLeftClicksSeparatedByTheDoubleClickGap() async throws {
        let trace = WireTrace()
        let input = tracedInput(trace)
        try await input.mouseTripleClick(x: 4, y: 5)
        let click = ["pointer 4,5 mask=1", "pause 50000", "pointer 4,5 mask=0"]
        XCTAssertEqual(trace.values, click + ["pause 50000"] + click + ["pause 50000"] + click)
        XCTAssertFalse(input.heldButtons)
        XCTAssertEqual(input.cursorPosition.x, 4)
        XCTAssertEqual(input.cursorPosition.y, 5)
    }

    func testModifierClickPressesAroundTheClickAndReleasesInReverse() async throws {
        let trace = WireTrace()
        let input = tracedInput(trace)
        try await input.mouseClick(x: 7, y: 8, button: .right, modifiers: [KeySym.shiftLeft, KeySym.metaLeft])
        XCTAssertEqual(trace.values, ["down 0xFFE1", "pause 10000", "down 0xFFE7", "pause 10000",
            "pointer 7,8 mask=4", "pause 50000", "pointer 7,8 mask=0",
            "pause 10000", "up 0xFFE7", "pause 10000", "up 0xFFE1"])
        XCTAssertTrue(input.heldKeys.isEmpty)
        XCTAssertFalse(input.heldButtons)
        // Without modifiers the click keeps its historical wire trace.
        let plain = WireTrace()
        try await tracedInput(plain).mouseClick(x: 1, y: 1)
        XCTAssertEqual(plain.values, ["pointer 1,1 mask=1", "pause 50000", "pointer 1,1 mask=0"])
    }

    func testModifierClickFailureReleasesHeldModifiersWithoutReplayingTheClick() async {
        let trace = WireTrace()
        let input = tracedInput(trace, failKey: KeySym.metaLeft)
        do {
            try await input.mouseClick(x: 2, y: 3, modifiers: [KeySym.shiftLeft, KeySym.metaLeft])
            XCTFail("uncertain modifier write returned success")
        } catch {}
        XCTAssertEqual(trace.values, ["down 0xFFE1", "pause 10000", "down 0xFFE7",
                                      "up 0xFFE7 release", "up 0xFFE1 release"])
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testRightAndMiddleDragsHoldTheirOwnButtonForTheWholePath() async throws {
        for button in [MouseButton.right, .middle] {
            let trace = WireTrace()
            let input = tracedInput(trace)
            input.timing.dragMinSteps = 2
            try await input.mouseDrag(fromX: 0, fromY: 0, toX: 10, toY: 0, button: button)
            let pointers = trace.values.filter { $0.hasPrefix("pointer") }
            XCTAssertEqual(pointers.first, "pointer 0,0 mask=0")
            XCTAssertEqual(pointers.last, "pointer 10,0 mask=0")
            let pressed = pointers.dropFirst().dropLast()
            XCTAssertFalse(pressed.isEmpty)
            XCTAssertTrue(pressed.allSatisfy { $0.hasSuffix("mask=\(button.rawValue)") }, "\(pressed)")
            XCTAssertFalse(input.heldButtons)
        }
    }

    func testHoldKeyKeepsTheKeyDownForItsDurationThenReleases() async throws {
        let trace = WireTrace()
        try await tracedInput(trace).holdKey(KeySym.shiftLeft, durationUs: 750_000)
        XCTAssertEqual(trace.values, ["down 0xFFE1", "pause 750000", "up 0xFFE1"])
    }

    func testHoldKeyCancellationReleasesWithinTheSameCall() async {
        let trace = WireTrace()
        let input = tracedInput(trace, sleeper: { _ in throw CancellationError() })
        do { try await input.holdKey(0x61, durationUs: 2_000_000); XCTFail("cancelled hold succeeded") }
        catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(trace.values, ["down 0x61", "up 0x61 release"])
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    /// D27: a batch-scoped hold keeps its button pressed across moves (a
    /// drag), ends at mouse_up, and otherwise is force-released release-only.
    func testBatchScopedHoldDragsUntilUpAndForceReleaseEndsIt() async throws {
        let trace = WireTrace()
        let input = tracedInput(trace)
        try await input.mouseDown(x: 2, y: 3, button: .left, scope: "batch-a")
        XCTAssertEqual(input.holdScope, "batch-a")
        XCTAssertTrue(input.heldButtons)
        try await input.mouseMove(x: 9, y: 9)
        try await input.mouseUp(x: nil, y: nil, button: .left)
        XCTAssertNil(input.holdScope)
        XCTAssertFalse(input.heldButtons)
        XCTAssertEqual(trace.values, ["pointer 2,3 mask=1", "pointer 9,9 mask=1", "pointer 9,9 mask=0"])
        // Two buttons may be held together; releasing one keeps the other.
        try await input.mouseDown(x: 1, y: 1, button: .left, scope: "batch-b")
        try await input.mouseDown(x: 1, y: 1, button: .right, scope: "batch-b")
        try await input.mouseUp(x: 4, y: 4, button: .left)
        XCTAssertEqual(input.holdScope, "batch-b")
        XCTAssertTrue(input.heldButtons)
        // Batch end or abort: one release-only pointer write clears the hold.
        let released = await input.releaseHeldInput()
        XCTAssertTrue(released)
        XCTAssertNil(input.holdScope)
        XCTAssertEqual(input.holdMask, 0)
        XCTAssertFalse(input.heldButtons)
        XCTAssertEqual(Array(trace.values.suffix(4)), ["pointer 1,1 mask=1", "pointer 1,1 mask=5",
                                                       "pointer 4,4 mask=4", "pointer 4,4 mask=0 release"])
    }

    func testHoldRefusalsAreTypedAndWriteNothing() async throws {
        let trace = WireTrace()
        let input = tracedInput(trace)
        do { try await input.mouseUp(x: nil, y: nil, button: .left); XCTFail("unheld release accepted") }
        catch NativeInputRefusal.buttonNotHeld {} catch { XCTFail("unexpected error: \(error)") }
        try await input.mouseDown(x: 1, y: 1, button: .left, scope: "batch")
        do { try await input.mouseDown(x: 1, y: 1, button: .left, scope: "batch"); XCTFail("double press accepted") }
        catch NativeInputRefusal.buttonAlreadyHeld {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(trace.values, ["pointer 1,1 mask=1"])
        let encoded = try JSONEncoder().encode(XCTUnwrap(PCResponse.inputRefusal(id: .number(3),
            error: NativeInputRefusal.holdOutsideBatch)))
        let payload = try XCTUnwrap((JSONSerialization.jsonObject(with: encoded) as? [String: Any])?["error"] as? [String: Any])
        XCTAssertEqual(payload["code"] as? Int, -32011)
        XCTAssertEqual((payload["data"] as? [String: Any])?["reason"] as? String, "hold_outside_batch")
        XCTAssertNil(PCResponse.inputRefusal(id: .number(4), error: VNCError.sendFailed("other")))
        _ = await input.releaseHeldInput()
    }

    func testNativeValidationOfParityMethods() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        func refusal(_ method: String, _ params: String) -> NativeInputRefusal? {
            do { try request(method, params).validate(scaling: scaling); return nil }
            catch let refused as NativeInputRefusal { return refused }
            catch { return nil }
        }
        // mouse_down/mouse_up without the executor's batch scope are typed refusals.
        XCTAssertEqual(refusal("mouse_down", "{\"x\":1,\"y\":1}"), .holdOutsideBatch)
        XCTAssertEqual(refusal("mouse_up", "{}"), .holdOutsideBatch)
        XCTAssertNoThrow(try request("mouse_down", "{\"x\":1,\"y\":1,\"button\":\"right\",\"hold_scope\":\"b-1\"}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("mouse_up", "{\"hold_scope\":\"b-1\"}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("mouse_up", "{\"x\":2,\"y\":2,\"hold_scope\":\"b-1\"}").validate(scaling: scaling))
        for (method, params) in [("mouse_up", "{\"x\":2,\"hold_scope\":\"b-1\"}"),
                                 ("mouse_down", "{\"hold_scope\":\"b-1\"}"),
                                 ("mouse_down", "{\"x\":1,\"y\":1,\"hold_scope\":\"bad scope\"}"),
                                 ("release_holds", "{}"),
                                 ("triple_click", "{\"x\":1}"),
                                 ("mouse_drag", "{\"x\":1,\"y\":1,\"toX\":2,\"toY\":2,\"button\":\"back\"}"),
                                 ("mouse_click", "{\"x\":1,\"y\":1,\"modifiers\":[\"a\"]}"),
                                 ("mouse_click", "{\"x\":1,\"y\":1,\"modifiers\":[\"cmd\",\"command\"]}"),
                                 ("mouse_double_click", "{\"x\":1,\"y\":1,\"modifiers\":[\"cmd\"]}"),
                                 ("hold_key", "{\"key\":\"a\"}"),
                                 ("hold_key", "{\"key\":\"a\",\"duration_ms\":0}"),
                                 ("hold_key", "{\"key\":\"a\",\"duration_ms\":10001}"),
                                 ("hold_key", "{\"key\":\"nope\",\"duration_ms\":10}")] {
            XCTAssertThrowsError(try request(method, params).validate(scaling: scaling), "\(method) \(params)")
        }
        XCTAssertNoThrow(try request("triple_click", "{\"x\":1279,\"y\":719}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("mouse_click", "{\"x\":1,\"y\":1,\"modifiers\":[\"shift\",\"cmd\"]}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("hold_key", "{\"key\":\"shift\",\"duration_ms\":10000}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("release_holds", "{\"hold_scope\":\"b-1\"}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("cursor_position").validate(scaling: scaling))
        for method in ["triple_click", "cursor_position", "hold_key", "mouse_down", "mouse_up", "release_holds"] {
            XCTAssertTrue(PCRequest.supportedMethods.contains(method), method)
        }
        XCTAssertFalse(PCRequest.inputMethods.contains("cursor_position"))
        XCTAssertFalse(PCRequest.inputMethods.contains("release_holds"))
    }
}
