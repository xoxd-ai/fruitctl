import Foundation
import XCTest
import CoreMedia
import CoreVideo
import CoreGraphics
import ScreenCaptureKit
import Darwin

final class FruitctlHostTests: XCTestCase {
    private let owner = UUID()
    private let other = UUID()
    private var defaultsSuites: [String] = []

    private func isolatedDefaults() -> UserDefaults {
        let name = "FruitctlHostTests.CaptureOptIn." + UUID().uuidString
        defaultsSuites.append(name)
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    override func tearDown() {
        for name in defaultsSuites { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        defaultsSuites.removeAll()
        super.tearDown()
    }

    func testFreshCapturePreferencesStayDisabledEvenWhenOSPermissionExists() {
        let preferences = HostCapturePreferences(defaults: isolatedDefaults())
        XCTAssertFalse(preferences.isEnabled)
        XCTAssertFalse(preferences.permitsCapture(permissionGranted: true))
        XCTAssertFalse(preferences.permitsCapture(permissionGranted: false))
    }

    func testExplicitCaptureOptInSurvivesConstructorRestartWithoutArguments() {
        let defaults = isolatedDefaults()
        let first = HostCapturePreferences(defaults: defaults, startupChoice: true)
        XCTAssertTrue(first.isEnabled)
        // A distinct defaults reader simulates a new invocation with no args.
        let suite = defaultsSuites.last!
        let reopened = HostCapturePreferences(defaults: UserDefaults(suiteName: suite)!)
        XCTAssertTrue(reopened.isEnabled)
        XCTAssertTrue(reopened.permitsCapture(permissionGranted: true))
    }

    func testHumanDisablePersistsAndNewPermissionCannotUndoIt() {
        let defaults = isolatedDefaults()
        let enabled = HostCapturePreferences(defaults: defaults, startupChoice: true)
        enabled.setEnabled(false)
        XCTAssertFalse(enabled.permitsCapture(permissionGranted: true))
        let reopened = HostCapturePreferences(defaults: UserDefaults(suiteName: defaultsSuites.last!)!)
        XCTAssertFalse(reopened.isEnabled)
        XCTAssertFalse(reopened.permitsCapture(permissionGranted: true))
    }

    func testDeniedPermissionKeepsExplicitIntentButNeverAuthorizesCapture() {
        let defaults = isolatedDefaults()
        let enabled = HostCapturePreferences(defaults: defaults, startupChoice: true)
        XCTAssertFalse(enabled.permitsCapture(permissionGranted: false))
        let reopened = HostCapturePreferences(defaults: UserDefaults(suiteName: defaultsSuites.last!)!)
        XCTAssertTrue(reopened.isEnabled)
        XCTAssertFalse(reopened.permitsCapture(permissionGranted: false))
        XCTAssertTrue(reopened.permitsCapture(permissionGranted: true))
    }

    func testExplicitStartupDisableOverridesPriorOptInAcrossRestart() {
        let defaults = isolatedDefaults()
        _ = HostCapturePreferences(defaults: defaults, startupChoice: true)
        let disabled = HostCapturePreferences(defaults: defaults, startupChoice: false)
        XCTAssertFalse(disabled.isEnabled)
        let reopened = HostCapturePreferences(defaults: UserDefaults(suiteName: defaultsSuites.last!)!)
        XCTAssertFalse(reopened.permitsCapture(permissionGranted: true))
    }

    func testInitialCaptureTimerWaitsWithoutHeartbeatAndCannotExtendLease() throws {
        var state = try started()
        XCTAssertEqual(HostLeaseState.uiHeartbeatDecision(activityEligible: true,
            captureInProgress: true, captureReady: false, overlayReady: false,
            visiblePanels: false), .awaitingInitialCapture)
        XCTAssertFalse(HostLeaseState.isReady(now: 200, uiHeartbeatAt: nil,
                                              captureReady: false, overlayReady: false))
        XCTAssertThrowsError(try renew(&state, at: 200, pulse: nil, capture: false, overlay: false)) {
            XCTAssertEqual($0 as? HostLeaseError, .notReady)
        }
        XCTAssertEqual(state.active?.expiresAtMilliseconds, 3_100)
        XCTAssertTrue(state.expire(at: 3_100))
        XCTAssertThrowsError(try state.requireOwner(sessionID: "session-A", connectionID: owner,
            displayGeneration: 7, now: 3_101)) { XCTAssertEqual($0 as? HostLeaseError, .expired) }
    }

    func testAcquisitionCannotIgnoreEligibilityOrPartialOrUnexpectedVisibleUI() {
        for flags in [(false, true, false, false, false),
                      (true, false, false, false, false),
                      (true, true, true, false, false),
                      (true, true, false, true, false),
                      (true, true, false, false, true),
                      (true, false, true, true, false)] {
            XCTAssertEqual(HostLeaseState.uiHeartbeatDecision(activityEligible: flags.0,
                captureInProgress: flags.1, captureReady: flags.2, overlayReady: flags.3,
                visiblePanels: flags.4), .invalidate)
        }
    }

    func testQualifiedVisibleUIReceivesHeartbeatDuringLaterCapture() {
        for capturing in [false, true] {
            XCTAssertEqual(HostLeaseState.uiHeartbeatDecision(activityEligible: true,
                captureInProgress: capturing, captureReady: true, overlayReady: true,
                visiblePanels: true), .recordVisibleHeartbeat)
        }
        XCTAssertEqual(HostLeaseState.uiHeartbeatDecision(activityEligible: false,
            captureInProgress: true, captureReady: true, overlayReady: true,
            visiblePanels: true), .invalidate)
    }

    private func started(at now: UInt64 = 100) throws -> HostLeaseState {
        var state = HostLeaseState()
        try state.begin(sessionID: "session-A", connectionID: owner, sequence: 1,
                        challenge: "challenge-A", displayGeneration: 7, now: now)
        return state
    }

    private func renew(_ state: inout HostLeaseState, at now: UInt64, pulse: UInt64?,
                       connection: UUID? = nil, sequence: UInt64 = 2,
                       generation: UInt64 = 7, capture: Bool = true, overlay: Bool = true) throws {
        try state.renew(sessionID: "session-A", connectionID: connection ?? owner,
            sequence: sequence, challenge: "challenge-B", displayGeneration: generation,
            now: now, uiHeartbeatAt: pulse, captureReady: capture, overlayReady: overlay)
    }

    func testLeaseExpiresAtDeadlineAndLateRenewalCannotResurrectIt() throws {
        var state = try started()
        XCTAssertNoThrow(try state.requireOwner(sessionID: "session-A", connectionID: owner,
                                               displayGeneration: 7, now: 3_099))
        XCTAssertThrowsError(try renew(&state, at: 3_100, pulse: 3_100)) {
            XCTAssertEqual($0 as? HostLeaseError, .expired)
        }
        XCTAssertTrue(state.expire(at: 3_100))
        XCTAssertNil(state.active)
        XCTAssertFalse(state.expire(at: 3_101))
    }

    func testASecondConnectionCannotAcquireRenewOrReleaseAnotherLease() throws {
        var state = try started()
        XCTAssertThrowsError(try state.begin(sessionID: "session-B", connectionID: other,
            sequence: 1, challenge: "challenge-C", displayGeneration: 7, now: 101)) {
            XCTAssertEqual($0 as? HostLeaseError, .busy)
        }
        XCTAssertThrowsError(try renew(&state, at: 102, pulse: 102, connection: other)) {
            XCTAssertEqual($0 as? HostLeaseError, .wrongOwner)
        }
        XCTAssertFalse(state.release(connectionID: other, sessionID: "session-A"))
        XCTAssertFalse(state.release(connectionID: owner, sessionID: "wrong-session"))
        XCTAssertEqual(state.active?.sessionID, "session-A")
        XCTAssertTrue(state.release(connectionID: owner))
        XCTAssertNil(state.active)
    }

    func testRenewalRequiresIncreasingSequenceAndFreshMainThreadPulse() throws {
        var state = try started()
        let original = state.active
        XCTAssertThrowsError(try renew(&state, at: 350, pulse: 100, sequence: 1)) {
            XCTAssertEqual($0 as? HostLeaseError, .staleSequence)
        }
        XCTAssertEqual(state.active, original)
        XCTAssertThrowsError(try renew(&state, at: 351, pulse: 100)) {
            XCTAssertEqual($0 as? HostLeaseError, .notReady)
        }
        XCTAssertEqual(state.active, original)
        try renew(&state, at: 350, pulse: 100)
        XCTAssertEqual(state.active?.sequence, 2)
        XCTAssertEqual(state.active?.challenge, "challenge-B")
        XCTAssertEqual(state.active?.expiresAtMilliseconds, 3_350)
    }

    func testDisplayChangesAndCaptureOrOverlayFailureFailClosed() throws {
        for values in [(UInt64(8), true, true), (7, false, true), (7, true, false)] {
            var state = try started()
            XCTAssertThrowsError(try renew(&state, at: 101, pulse: 101,
                generation: values.0, capture: values.1, overlay: values.2))
            XCTAssertEqual(state.active?.expiresAtMilliseconds, 3_100)
        }
        var state = try started()
        state.invalidate()
        XCTAssertThrowsError(try renew(&state, at: 101, pulse: 101))
    }

    func testMissingFutureOrStaleHeartbeatsAreNeverReadinessProof() {
        for pulse in [nil, UInt64(301), UInt64(0)] as [UInt64?] {
            XCTAssertFalse(HostLeaseState.isReady(now: 300, uiHeartbeatAt: pulse,
                                                 captureReady: true, overlayReady: true))
        }
        XCTAssertTrue(HostLeaseState.isReady(now: 300, uiHeartbeatAt: 50,
                                            captureReady: true, overlayReady: true))
        XCTAssertFalse(HostLeaseState.isReady(now: 301, uiHeartbeatAt: 50,
                                             captureReady: true, overlayReady: true))
    }

    func testInvalidLeaseTokensAndDeadlineOverflowAreRejected() throws {
        for token in ["", "has space", "has\nnewline", "purple💜", String(repeating: "a", count: 257)] {
            var state = HostLeaseState()
            XCTAssertThrowsError(try state.begin(sessionID: token, connectionID: owner,
                sequence: 1, challenge: "valid", displayGeneration: 1, now: 0))
            XCTAssertNil(state.active)
        }
        var state = HostLeaseState()
        XCTAssertThrowsError(try state.begin(sessionID: "valid", connectionID: owner,
            sequence: 1, challenge: "valid", displayGeneration: 1, now: UInt64.max - 2_999))
        XCTAssertNil(state.active)
    }

    func testInactiveOrNonDrawableLaunchCannotStartActivityWithoutNotifications() {
        let state = HostAvailabilityState()
        XCTAssertFalse(state.allowsActivity(onConsole: false, ownedSession: true, displaysDrawable: true))
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: false, displaysDrawable: true))
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: false))
        XCTAssertTrue(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
    }

    func testWakeCannotClearIndependentSessionAndDisplayHolds() {
        var state = HostAvailabilityState()
        state.apply(.sessionResigned)
        state.apply(.screensSlept)
        state.apply(.systemSlept)
        state.apply(.systemWoke)
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        state.apply(.screensWoke)
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        state.apply(.sessionActivated)
        XCTAssertTrue(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
    }

    func testHumanStopSurvivesAllNonHumanWakeAndActivationEvents() {
        var state = HostAvailabilityState()
        state.apply(.humanStopped)
        for event in [HostAvailabilityState.Event.sessionResigned, .screensSlept, .systemSlept,
                      .systemWoke, .screensWoke, .sessionActivated] {
            state.apply(event)
            XCTAssertFalse(state.humanAllowed)
            XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        }
        state.apply(.humanResumed)
        XCTAssertTrue(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
    }

    func testActiveHumanStopRevokesTheLeaseAndRetainsItsFinalBinding() throws {
        var state = try started()
        try renew(&state, at: 350, pulse: 350)
        state.stopFromHuman(instanceID: "instance-A", processID: 321, displayID: 1,
                            displayGeneration: 7, now: 400)

        XCTAssertNil(state.active)
        XCTAssertThrowsError(try state.requireOwner(sessionID: "session-A", connectionID: owner,
            displayGeneration: 7, now: 400)) { XCTAssertEqual($0 as? HostLeaseError, .expired) }
        XCTAssertThrowsError(try renew(&state, at: 401, pulse: 401)) {
            XCTAssertEqual($0 as? HostLeaseError, .expired)
        }
        let event = try XCTUnwrap(state.lastHumanStopEvent)
        XCTAssertEqual(event.eventNumber, 1)
        XCTAssertEqual(event.instanceID, "instance-A")
        XCTAssertEqual(event.processID, 321)
        XCTAssertEqual(event.displayID, 1)
        XCTAssertEqual(event.displayGeneration, 7)
        XCTAssertEqual(event.invokedAtMilliseconds, 400)
        XCTAssertEqual(event.activity?.sessionID, "session-A")
        XCTAssertEqual(event.activity?.sequence, 2)
        XCTAssertEqual(event.activity?.displayGeneration, 7)
        XCTAssertEqual(event.activity?.remainingMilliseconds, 2_950)
        XCTAssertEqual(event.metadata["active_lease_at_stop"], .boolean(true))
    }

    func testIdleHumanStopIsObservableWithoutInventingAnActiveLease() throws {
        var state = HostLeaseState()
        state.stopFromHuman(instanceID: "instance-A", processID: 321, displayID: 1,
                            displayGeneration: 7, now: 400)
        let event = try XCTUnwrap(state.lastHumanStopEvent)
        XCTAssertNil(state.active)
        XCTAssertNil(event.activity)
        XCTAssertEqual(event.metadata["active_lease_at_stop"], .boolean(false))
        XCTAssertEqual(event.metadata["active_lease"], .null)
        XCTAssertEqual(event.metadata["invoked_monotonic_ms"], .integer(400))
    }

    func testOrdinaryReleaseBeforeHumanStopCannotBecomeActiveStopEvidence() throws {
        var state = try started()
        XCTAssertTrue(state.release(connectionID: owner, sessionID: "session-A"))
        XCTAssertNil(state.lastHumanStopEvent)
        state.stopFromHuman(instanceID: "instance-A", processID: 321, displayID: 1,
                            displayGeneration: 7, now: 200)
        XCTAssertNil(try XCTUnwrap(state.lastHumanStopEvent).activity)
    }

    func testExpiredOrChangedDisplayLeaseIsNotBoundToAnActiveHumanStop() throws {
        for (now, generation) in [(UInt64(3_100), UInt64(7)), (3_101, 7), (200, 8)] {
            var state = try started()
            // Do not tick/expire first: the transition must reject a stale
            // stored lease on its own, including the exact expiry boundary.
            state.stopFromHuman(instanceID: "instance-A", processID: 321, displayID: 1,
                                displayGeneration: generation, now: now)
            XCTAssertNil(state.active)
            XCTAssertNil(try XCTUnwrap(state.lastHumanStopEvent).activity)
            XCTAssertEqual(state.lastHumanStopEvent?.displayGeneration, generation)
        }
    }

    func testStopEventAndHumanLatchSurviveReconnectAndWakeWithoutReactivation() throws {
        var state = try started()
        var availability = HostAvailabilityState()
        availability.apply(.humanStopped)
        state.stopFromHuman(instanceID: "instance-A", processID: 321, displayID: 1,
                            displayGeneration: 7, now: 200)
        let event = try XCTUnwrap(state.lastHumanStopEvent)

        // A disconnected owner and a fresh attachment cannot erase the event.
        XCTAssertFalse(state.release(connectionID: owner))
        XCTAssertFalse(state.release(connectionID: other))
        for transition in [HostAvailabilityState.Event.sessionResigned, .screensSlept,
                           .systemSlept, .systemWoke, .screensWoke, .sessionActivated] {
            availability.apply(transition)
            state.invalidate()
            XCTAssertNil(state.active)
            XCTAssertEqual(state.lastHumanStopEvent, event)
            XCTAssertFalse(availability.allowsActivity(onConsole: true, ownedSession: true,
                                                       displaysDrawable: true))
        }
        availability.apply(.humanResumed)
        state.invalidate()
        XCTAssertEqual(state.lastHumanStopEvent, event)
        XCTAssertNil(state.active)
        XCTAssertTrue(availability.humanAllowed)
    }

    func testOnlyLatestStopEventIsRetainedAndNewProcessStartsWithoutHistory() throws {
        var state = try started()
        state.stopFromHuman(instanceID: "instance-A", processID: 321, displayID: 1,
                            displayGeneration: 7, now: 200)
        let first = try XCTUnwrap(state.lastHumanStopEvent)
        state.stopFromHuman(instanceID: "instance-A", processID: 321, displayID: 1,
                            displayGeneration: 7, now: 300)
        let latest = try XCTUnwrap(state.lastHumanStopEvent)
        XCTAssertEqual(latest.eventNumber, 2)
        XCTAssertNotEqual(latest.eventID, first.eventID)
        XCTAssertEqual(latest.invokedAtMilliseconds, 300)
        XCTAssertNil(latest.activity)

        var restarted = HostLeaseState()
        XCTAssertNil(restarted.lastHumanStopEvent)
        restarted.stopFromHuman(instanceID: "instance-B", processID: 654, displayID: 1,
                                displayGeneration: 1, now: 5)
        let restartedEvent = try XCTUnwrap(restarted.lastHumanStopEvent)
        XCTAssertEqual(restartedEvent.eventNumber, 1)
        XCTAssertEqual(restartedEvent.instanceID, "instance-B")
        XCTAssertNotEqual(restartedEvent.eventID, latest.eventID)
    }

    func testStopMetadataExposesCorrelationWithoutChallengeOrConnectionIdentity() throws {
        var state = try started()
        state.stopFromHuman(instanceID: "instance-A", processID: 321, displayID: 1,
                            displayGeneration: 7, now: 200)
        let event = try XCTUnwrap(state.lastHumanStopEvent)
        let data = try JSONEncoder().encode(HostValue.object(event.metadata))
        let encoded = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertFalse(encoded.contains("challenge-A"))
        XCTAssertFalse(encoded.contains(owner.uuidString))
        XCTAssertEqual(event.metadata["clock_basis"], .string("host_instance_milliseconds"))
        XCTAssertEqual(event.metadata["schema"], .string("fruitctl.human-stop.v1"))
        guard case .object(let activity)? = event.metadata["active_lease"] else {
            return XCTFail("Active Stop must retain the ended lease binding")
        }
        XCTAssertEqual(Set(activity.keys), Set(["session_id", "displayGeneration", "sequence",
                                              "lease_remaining_ms"]))
        XCTAssertNil(event.metadata["physical_cleared"])
    }

    func testHumanAllowDoesNotOverrideAnInactiveSessionOrSleepingDisplay() {
        var state = HostAvailabilityState()
        state.apply(.humanStopped)
        state.apply(.sessionResigned)
        state.apply(.screensSlept)
        state.apply(.humanResumed)
        XCTAssertTrue(state.humanAllowed)
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        state.apply(.sessionActivated)
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        state.apply(.screensWoke)
        XCTAssertTrue(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
    }

    func testProtocolAcceptsActionAndLegacyMethodButPreservesTypedIdentifiers() throws {
        let action = try JSONDecoder().decode(HostRequest.self, from:
            Data(#"{"action":"renew_activity","id":"r-7","params":{"session_id":"s","sequence":2}}"#.utf8))
        XCTAssertEqual(action.action, "renew_activity")
        XCTAssertEqual(action.id, .string("r-7"))
        XCTAssertEqual(try action.requiredSequence(), 2)
        let legacy = try JSONDecoder().decode(HostRequest.self, from:
            Data(#"{"method":"health","id":7}"#.utf8))
        XCTAssertEqual(legacy.action, "health")
        XCTAssertEqual(legacy.id, .integer(7))
        for value in ["true", "1.5", "[]", "{}"] {
            XCTAssertThrowsError(try JSONDecoder().decode(HostRequest.self, from:
                Data("{\"action\":\"health\",\"id\":\(value)}".utf8)))
        }
        let response = try HostResponse.ok(action, ["raw_vnc_exclusion": .boolean(false)]).line()
        XCTAssertEqual(response.last, 10)
        let object = try JSONSerialization.jsonObject(with: response) as? [String: Any]
        XCTAssertEqual(object?["id"] as? String, "r-7")
        XCTAssertEqual(object?["success"] as? Bool, true)
    }

    func testCaptureFailureSerializesOnlyRecognizedAppleValues() throws {
        let screenCaptureDomain = "synthetic.screen-capture-domain"
        let domains: [(String, HostAppleErrorDomain)] = [
            (screenCaptureDomain, .screenCaptureKit), (NSCocoaErrorDomain, .cocoa),
            (NSPOSIXErrorDomain, .posix), (NSOSStatusErrorDomain, .osStatus)
        ]
        let privateMarker = "private-diagnostic-marker"
        for (domain, symbol) in domains {
            for code in [Int(Int32.min), -1, 0, Int(Int32.max)] {
                for phase in [HostCapturePhase.shareableContent, .captureImage] {
                    let original = NSError(domain: domain, code: code, userInfo: [
                        NSLocalizedDescriptionKey: privateMarker,
                        NSLocalizedFailureReasonErrorKey: "/synthetic/private/" + privateMarker,
                        NSURLErrorKey: URL(fileURLWithPath: "/synthetic/private/" + privateMarker),
                        NSUnderlyingErrorKey: NSError(domain: privateMarker, code: 12)
                    ])
                    let failure = try XCTUnwrap(HostCaptureFailure.preserving(original, phase: phase,
                        screenCaptureErrorDomain: screenCaptureDomain) as? HostCaptureFailure)
                    XCTAssertEqual(failure.reason, .captureFailed)
                    XCTAssertEqual(failure.diagnostic.appleDomain, symbol)
                    XCTAssertEqual(failure.diagnostic.appleCode, Int32(exactly: code))
                    let line = try HostResponse.failure(id: .string("request-7"),
                        message: failure.reason.rawValue, data: failure.diagnostic).line()
                    let text = try XCTUnwrap(String(data: line, encoding: .utf8))
                    XCTAssertFalse(text.contains(privateMarker))
                    XCTAssertFalse(text.contains("/synthetic/private/"))
                    let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
                    XCTAssertEqual(reply["id"] as? String, "request-7")
                    XCTAssertEqual(reply["success"] as? Bool, false)
                    let error = try XCTUnwrap(reply["error"] as? [String: Any])
                    XCTAssertEqual(error["code"] as? Int, -32000)
                    XCTAssertEqual(error["message"] as? String, "capture_failed")
                    let diagnostic = try XCTUnwrap(error["data"] as? [String: Any])
                    XCTAssertEqual(Set(diagnostic.keys), Set(["schema", "phase", "apple_domain", "apple_code"]))
                    XCTAssertEqual(diagnostic["schema"] as? String, "fruitctl.host-capture-error.v1")
                    XCTAssertEqual(diagnostic["phase"] as? String, phase.rawValue)
                    XCTAssertEqual(diagnostic["apple_domain"] as? String, symbol.rawValue)
                    XCTAssertEqual(diagnostic["apple_code"] as? Int, code)
                }
            }
        }
    }

    func testUnknownAppleDomainsAndUnrepresentableCodesAreNotReflected() throws {
        let marker = "/synthetic/private/untrusted-domain"
        let diagnostic = HostCaptureDiagnostic(error: NSError(domain: marker, code: 17,
            userInfo: [NSLocalizedDescriptionKey: marker]), phase: .captureImage,
            screenCaptureErrorDomain: "synthetic.screen-capture-domain")
        XCTAssertNil(diagnostic.appleDomain)
        XCTAssertNil(diagnostic.appleCode)
        let unknownLine = try HostResponse.failure(id: .integer(7), message: "capture_failed",
                                                   data: diagnostic).line()
        XCTAssertFalse(String(decoding: unknownLine, as: UTF8.self).contains(marker))
        let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: unknownLine) as? [String: Any])
        XCTAssertEqual(reply["id"] as? Int, 7)
        let error = try XCTUnwrap(reply["error"] as? [String: Any])
        let data = try XCTUnwrap(error["data"] as? [String: Any])
        XCTAssertEqual(Set(data.keys), Set(["schema", "phase"]))
        for code in [Int(Int32.min) - 1, Int(Int32.max) + 1, Int.min, Int.max] {
            let bounded = HostCaptureDiagnostic(error: NSError(domain: NSPOSIXErrorDomain, code: code),
                phase: .shareableContent, screenCaptureErrorDomain: "synthetic.screen-capture-domain")
            XCTAssertEqual(bounded.appleDomain, .posix)
            XCTAssertNil(bounded.appleCode)
        }
    }

    func testCaptureNormalizationPreservesExistingErrorsAndLegacyWireResponse() throws {
        for original in [HostCaptureError.notEnabled, .permissionRequired, .displayUnavailable,
                         .selfApplicationUnavailable, .incompleteImage, .captureFailed, .imageEncodingFailed] {
            XCTAssertEqual(HostCaptureFailure.preserving(original, phase: .captureImage,
                screenCaptureErrorDomain: "synthetic.screen-capture-domain") as? HostCaptureError, original)
        }
        let line = try HostResponse.failure(id: .string("request-7"), message: "capture_failed").line()
        XCTAssertEqual(String(decoding: line, as: UTF8.self),
            "{\"error\":{\"code\":-32000,\"message\":\"capture_failed\"},\"id\":\"request-7\",\"success\":false}\n")
        let original = HostCaptureFailure(diagnostic: HostCaptureDiagnostic(
            error: NSError(domain: NSPOSIXErrorDomain, code: 0), phase: .shareableContent,
            screenCaptureErrorDomain: "synthetic.screen-capture-domain"))
        let preserved = try XCTUnwrap(HostCaptureFailure.preserving(original, phase: .captureImage,
            screenCaptureErrorDomain: "synthetic.screen-capture-domain") as? HostCaptureFailure)
        XCTAssertEqual(preserved.diagnostic, original.diagnostic)
    }

    func testFramingHandlesFragmentationAndRejectsOversizedOrUnterminatedInput() throws {
        var framer = HostLineFramer()
        XCTAssertEqual(try framer.append(Data("{\"action\":\"he".utf8)), [])
        XCTAssertTrue(framer.hasIncompleteLine)
        let lines = try framer.append(Data("alth\"}\n\n{\"action\":\"capture\"}\n".utf8))
        XCTAssertEqual(lines.count, 2)
        XCTAssertFalse(framer.hasIncompleteLine)
        XCTAssertEqual(try JSONDecoder().decode(HostRequest.self, from: lines[0]).action, "health")
        var oversized = HostLineFramer()
        XCTAssertThrowsError(try oversized.append(Data(repeating: 65,
                                               count: HostLineFramer.maximumRequestBytes + 1)))
        var unterminated = HostLineFramer()
        _ = try unterminated.append(Data(#"{"action":"health"}"#.utf8))
        XCTAssertTrue(unterminated.hasIncompleteLine)
    }
}

/// These tests create tiny in-memory samples. They do not call the screenshot
/// API, open a desktop or establish the clock mapping of a real SCK sample.
final class HostNativeCaptureTimingTests: XCTestCase {
    private func time(_ value: Int64, scale: Int32 = 1_000, epoch: Int64 = 0) -> CMTime {
        CMTime(value: value, timescale: scale, flags: .valid, epoch: epoch)
    }

    private func makeSample(presentation: CMTime? = nil, blue: UInt8 = 0, red: UInt8 = 255,
                            format: OSType = kCVPixelFormatType_32BGRA, ready: Bool = true,
                            status: Any? = SCFrameStatus.complete.rawValue,
                            displayTime: Any? = UInt64(9_007_199_254_740_993)) throws -> CMSampleBuffer {
        var pixelBuffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 2, 1, format, nil, &pixelBuffer), kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixelBuffer)
        XCTAssertEqual(CVPixelBufferLockBaseAddress(buffer, []), kCVReturnSuccess)
        if let bytes = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) {
            for pixel in 0..<2 {
                bytes[pixel * 4] = blue; bytes[pixel * 4 + 1] = 0
                bytes[pixel * 4 + 2] = red; bytes[pixel * 4 + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        var description: CMVideoFormatDescription?
        XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
            imageBuffer: buffer, formatDescriptionOut: &description), noErr)
        var timing = CMSampleTimingInfo(duration: .invalid,
            presentationTimeStamp: presentation ?? time(105), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateForImageBuffer(allocator: kCFAllocatorDefault,
            imageBuffer: buffer, dataReady: ready, makeDataReadyCallback: nil, refcon: nil,
            formatDescription: try XCTUnwrap(description), sampleTiming: &timing,
            sampleBufferOut: &sample), noErr)
        let result = try XCTUnwrap(sample)
        if status != nil || displayTime != nil {
            let array = try XCTUnwrap(CMSampleBufferGetSampleAttachmentsArray(result,
                createIfNecessary: true) as? [NSMutableDictionary])
            let attachments = try XCTUnwrap(array.first)
            if let status { attachments[SCStreamFrameInfo.status.rawValue] = status }
            if let displayTime { attachments[SCStreamFrameInfo.displayTime.rawValue] = displayTime }
        }
        return result
    }

    private func read(_ sample: CMSampleBuffer, width: Int = 2, height: Int = 1) throws -> HostCapturedSample {
        try HostCapturedSample.read(sample, width: width, height: height,
                                    requestHostTime: time(100), completionHostTime: time(110))
    }

    private func rgba(_ image: CGImage) throws -> [UInt8] {
        let context = try XCTUnwrap(CGContext(data: nil, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let bytes = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
        return Array(UnsafeBufferPointer(start: bytes, count: image.width * image.height * 4))
    }

    private func timing(presentation: CMTime? = nil, request: CMTime? = nil,
                        completion: CMTime? = nil, complete: Bool? = true) -> HostNativeFrameTiming {
        HostNativeFrameTiming(presentationTime: presentation ?? time(105),
            requestHostTime: request ?? time(100), completionHostTime: completion ?? time(110),
            frameComplete: complete, windowServerDisplayTime: nil)
    }

    func testPixelsAndPresentationTimeComeFromTheSameReturnedSample() throws {
        let red = try read(makeSample(presentation: time(103)))
        let blue = try read(makeSample(presentation: time(107), blue: 255, red: 0))
        XCTAssertEqual(try rgba(red.image), [255, 0, 0, 255, 255, 0, 0, 255])
        XCTAssertEqual(try rgba(blue.image), [0, 0, 255, 255, 0, 0, 255, 255])
        XCTAssertEqual(CMTimeCompare(red.timing.presentationTime, time(103)), 0)
        XCTAssertEqual(CMTimeCompare(blue.timing.presentationTime, time(107)), 0)
        XCTAssertNotEqual(CMTimeCompare(red.timing.presentationTime, blue.timing.presentationTime), 0)
        XCTAssertEqual(red.timing.windowServerDisplayTime, 9_007_199_254_740_993)
    }

    func testReusedSourceSurfaceCannotChangeTheReturnedImage() throws {
        let sample = try makeSample()
        let captured = try read(sample)
        let before = try rgba(captured.image)
        let source = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
        XCTAssertEqual(CVPixelBufferLockBaseAddress(source, []), kCVReturnSuccess)
        if let bytes = CVPixelBufferGetBaseAddress(source) {
            memset(bytes, 0, CVPixelBufferGetBytesPerRow(source))
        }
        CVPixelBufferUnlockBaseAddress(source, [])
        XCTAssertEqual(try rgba(captured.image), before)
        XCTAssertEqual(before, [255, 0, 0, 255, 255, 0, 0, 255])
    }

    func testInvalidOrNotReadySampleCannotProduceAnImage() throws {
        let invalid = try makeSample()
        XCTAssertEqual(CMSampleBufferInvalidate(invalid), noErr)
        for sample in [invalid, try makeSample(ready: false)] {
            XCTAssertThrowsError(try read(sample)) {
                XCTAssertEqual($0 as? HostCaptureError, .incompleteImage)
            }
        }
    }

    func testPartialGeometryWrongPixelFormatAndAllocationBoundsAreRejected() throws {
        let sample = try makeSample()
        for size in [(1, 1), (2, 2), (0, 1), (16_385, 1), (16_384, 16_384), (Int.max, Int.max)] {
            XCTAssertThrowsError(try read(sample, width: size.0, height: size.1)) {
                XCTAssertEqual($0 as? HostCaptureError, .incompleteImage)
            }
        }
        XCTAssertThrowsError(try read(makeSample(format: kCVPixelFormatType_32ARGB))) {
            XCTAssertEqual($0 as? HostCaptureError, .incompleteImage)
        }
    }

    func testExplicitIncompleteAndMalformedFrameStatusAreRejected() throws {
        let statuses: [Any] = [SCFrameStatus.idle.rawValue, SCFrameStatus.blank.rawValue,
                               999, NSNumber(value: false), "0"]
        for status in statuses {
            XCTAssertThrowsError(try read(makeSample(status: status))) {
                XCTAssertEqual($0 as? HostCaptureError, .incompleteImage)
            }
        }
    }

    func testMissingTimingAttachmentsDoNotBreakStaticCaptureOrInventFreshness() throws {
        let captured = try read(makeSample(status: nil, displayTime: nil))
        XCTAssertEqual(try rgba(captured.image), [255, 0, 0, 255, 255, 0, 0, 255])
        XCTAssertNil(captured.timing.frameComplete)
        XCTAssertNil(captured.timing.windowServerDisplayTime)
        XCTAssertEqual(captured.timing.qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime),
                       .frameStatusUnavailable)
    }

    func testMalformedDisplayTimeRemainsUnknownInsteadOfBecomingZeroOrNow() throws {
        let values: [Any] = [NSNumber(value: true), NSNumber(value: -1), NSNumber(value: 1.5), "123"]
        for raw in values {
            let captured = try read(makeSample(displayTime: raw))
            XCTAssertNil(captured.timing.windowServerDisplayTime)
            XCTAssertEqual(captured.timing.frameComplete, true)
        }
    }

    func testTimestampMetadataPreservesIntegersAboveJavaScriptPrecision() throws {
        let native = HostNativeFrameTiming(presentationTime: time(Int64.max, scale: 1, epoch: Int64.max),
            requestHostTime: time(100), completionHostTime: time(110), frameComplete: true,
            windowServerDisplayTime: UInt64.max)
        let request = try JSONDecoder().decode(HostRequest.self, from: Data(#"{"action":"capture","id":"timing-1"}"#.utf8))
        let line = try HostResponse.ok(request, ["native_frame_timing": native.metadata]).line()
        let response = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        let metadata = try XCTUnwrap(result["native_frame_timing"] as? [String: Any])
        let pts = try XCTUnwrap(metadata["presentation_time"] as? [String: Any])
        XCTAssertEqual(pts["value"] as? String, String(Int64.max))
        XCTAssertEqual(pts["epoch"] as? String, String(Int64.max))
        XCTAssertEqual(metadata["window_server_display_time"] as? String, String(UInt64.max))
        XCTAssertEqual(metadata["native_time_semantics"] as? String, "sample_presentation_time")
        XCTAssertEqual(metadata["native_to_host_clock_relation"] as? String, "unverified")
        XCTAssertEqual(metadata["window_server_display_time_units"] as? String, "unverified")
        XCTAssertEqual(metadata["freshness"] as? String, "unknown")
    }

    func testInvalidNativeTimeCannotBeRepairedByValidRequestBrackets() {
        for value in [CMTime.invalid, .indefinite, .positiveInfinity, .negativeInfinity,
                      time(-1), CMTime(value: 1, timescale: 0, flags: .valid, epoch: 0)] {
            let native = timing(presentation: value)
            XCTAssertFalse(HostNativeFrameTiming.usable(native.presentationTime))
            XCTAssertEqual(native.qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime),
                           .presentationTimeUnavailable)
        }
    }

    func testNumericTimestampProximityDoesNotEstablishClockMapping() {
        let native = timing()
        XCTAssertTrue(native.hasValidHostBracket)
        XCTAssertEqual(native.qualificationRefusal(), .clockRelationUnverified)
        XCTAssertEqual(native.qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime), nil)
    }

    func testStaleNativeTimeCannotBeRepairedByDelayedCompletion() {
        for completion in [time(110), time(10_000)] {
            XCTAssertEqual(timing(presentation: time(99), completion: completion)
                .qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime), .stalePresentationTime)
        }
        XCTAssertEqual(timing(presentation: time(111))
            .qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime), .futurePresentationTime)
    }

    func testStaticSampleRemainsUsableButNonadvancingTimingFailsStrictQualification() throws {
        let captured = try read(makeSample())
        XCTAssertEqual(captured.image.width, 2)
        XCTAssertEqual(captured.timing.qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime,
            previousPresentationTime: time(105)), .nonadvancingPresentationTime)
        XCTAssertEqual(captured.timing.qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime,
            previousPresentationTime: time(106)), .nonadvancingPresentationTime)
    }

    func testRationalComparisonDoesNotRoundDistinctNativeTimesToMilliseconds() {
        let native = timing(presentation: time(105_001, scale: 1_000_000))
        XCTAssertEqual(native.qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime,
            previousPresentationTime: time(105, scale: 1_000)), nil)
        XCTAssertEqual(native.qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime,
            previousPresentationTime: time(105_001, scale: 1_000_000)), .nonadvancingPresentationTime)
    }

    func testDifferentEpochsAndInvalidHostBracketsCannotQualify() {
        for native in [timing(request: .invalid), timing(completion: time(99)),
                       timing(completion: time(110, epoch: 1))] {
            XCTAssertEqual(native.qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime),
                           .invalidHostBracket)
        }
        XCTAssertEqual(timing(presentation: time(105, epoch: 1))
            .qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime), .clockEpochMismatch)
        XCTAssertEqual(timing().qualificationRefusal(clockRelation: .verifiedCoreMediaHostTime,
            previousPresentationTime: time(100, epoch: 1)), .clockEpochMismatch)
    }

    func testCancelledSampleReadDoesNotReturnPixelsOrTiming() async throws {
        let sample = try makeSample()
        let task = Task { () throws -> HostCapturedSample in
            withUnsafeCurrentTask { $0?.cancel() }
            return try self.read(sample)
        }
        do { _ = try await task.value; XCTFail("Cancelled sample accepted") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    @MainActor
    func testPermissionWithdrawalAndOptOutRejectReturnedSample() async throws {
        let sample = try makeSample()
        for withdrawPermission in [true, false] {
            var granted = true, enabled = true
            let permission = HostCapturePermission(preflight: { granted }, request: { false })
            do {
                _ = try await permission.withCaptureAuthorization(enabled: { enabled }) {
                    let captured = try self.read(sample)
                    if withdrawPermission { granted = false } else { enabled = false }
                    return captured
                }
                XCTFail("Withdrawn authorization accepted pixels/timing")
            } catch {
                XCTAssertEqual(error as? HostCaptureError,
                               withdrawPermission ? .permissionRequired : .notEnabled)
            }
        }
    }
}
