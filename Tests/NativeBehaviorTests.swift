import XCTest
import Foundation
import AppKit

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
}
