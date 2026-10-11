import Foundation
import CoreMedia

/// Native presentation/display timing is evidence from the returned sample,
/// not an exact acquisition instant or a promise that it follows submission.
struct HostNativeFrameTiming {
    let presentationTime: CMTime
    let requestHostTime: CMTime
    let completionHostTime: CMTime
    let frameComplete: Bool?
    let windowServerDisplayTime: UInt64?

    enum QualificationRefusal: String, Error, Equatable {
        case presentationTimeUnavailable = "presentation_time_unavailable"
        case frameStatusUnavailable = "frame_status_unavailable"
        case invalidHostBracket = "invalid_host_bracket"
        case clockRelationUnverified = "clock_relation_unverified"
        case clockEpochMismatch = "clock_epoch_mismatch"
        case stalePresentationTime = "stale_presentation_time"
        case futurePresentationTime = "future_presentation_time"
        case nonadvancingPresentationTime = "nonadvancing_presentation_time"
    }

    /// No production capture establishes this mapping. A separately reviewed
    /// qualification must establish it for the actual platform/Host instance.
    enum ClockRelation: Equatable { case unverified, verifiedCoreMediaHostTime }

    static func usable(_ time: CMTime) -> Bool {
        time.isValid && time.isNumeric && time.timescale > 0 && time.value >= 0
    }

    static func timeMetadata(_ time: CMTime) -> HostValue {
        .object(["value": .string(String(time.value)),
                 "timescale": .integer(Int64(time.timescale)),
                 "epoch": .string(String(time.epoch)),
                 "flags": .integer(Int64(time.flags.rawValue)),
                 "numeric_nonnegative": .boolean(usable(time))])
    }

    var hasValidHostBracket: Bool {
        Self.usable(requestHostTime) && Self.usable(completionHostTime)
            && requestHostTime.epoch == completionHostTime.epoch
            && CMTimeCompare(requestHostTime, completionHostTime) <= 0
    }

    var metadata: HostValue {
        .object([
            "schema": .string("fruitctl.native-frame-timing.v1"),
            "source": .string("SCScreenshotManager.captureSampleBuffer"),
            "native_time_semantics": .string("sample_presentation_time"),
            "presentation_time": Self.timeMetadata(presentationTime),
            "presentation_time_available": .boolean(Self.usable(presentationTime)),
            "frame_complete": frameComplete.map { .boolean($0) } ?? .null,
            "window_server_display_time": windowServerDisplayTime.map { .string(String($0)) } ?? .null,
            "window_server_display_time_semantics": .string("window_server_frame_display_time"),
            "window_server_display_time_units": .string("unverified"),
            "host_clock_basis": .string("core_media_host_time_mach_absolute_time"),
            "request_host_time": Self.timeMetadata(requestHostTime),
            "completion_host_time": Self.timeMetadata(completionHostTime),
            "host_bracket_valid": .boolean(hasValidHostBracket),
            "native_to_host_clock_relation": .string("unverified"),
            "freshness": .string("unknown")
        ])
    }

    /// A changing-scene gate may use this after independently establishing
    /// native-to-host clock mapping. Ordinary static capture does not call it.
    /// RPC timestamps and a delayed completion cannot repair a stale sample.
    func qualificationRefusal(clockRelation: ClockRelation = .unverified,
                              previousPresentationTime: CMTime? = nil) -> QualificationRefusal? {
        guard Self.usable(presentationTime) else { return .presentationTimeUnavailable }
        guard frameComplete == true else { return .frameStatusUnavailable }
        guard hasValidHostBracket else { return .invalidHostBracket }
        guard clockRelation == .verifiedCoreMediaHostTime else { return .clockRelationUnverified }
        guard presentationTime.epoch == requestHostTime.epoch else { return .clockEpochMismatch }
        guard CMTimeCompare(presentationTime, requestHostTime) >= 0 else { return .stalePresentationTime }
        guard CMTimeCompare(presentationTime, completionHostTime) <= 0 else { return .futurePresentationTime }
        if let previousPresentationTime {
            guard Self.usable(previousPresentationTime),
                  previousPresentationTime.epoch == presentationTime.epoch else { return .clockEpochMismatch }
            guard CMTimeCompare(presentationTime, previousPresentationTime) > 0 else {
                return .nonadvancingPresentationTime
            }
        }
        return nil
    }
}
