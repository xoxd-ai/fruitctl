import AppKit
import ScreenCaptureKit
import CoreGraphics
import CoreVideo
import CoreMedia
import Darwin
import ImageIO
import UniformTypeIdentifiers

struct HostCapturedImage {
    let png: Data
    let nativeWidth: Int
    let nativeHeight: Int
    let scaledWidth: Int
    let scaledHeight: Int
    let displayID: CGDirectDisplayID
    let bounds: CGRect
    let excludedPID: pid_t
    let excludedBundleID: String
    let nativeFrameTiming: HostNativeFrameTiming

    var geometryMetadata: [String: HostValue] {
        ["mimeType": .string("image/png"),
         "nativeWidth": .integer(Int64(nativeWidth)), "nativeHeight": .integer(Int64(nativeHeight)),
         "scaledWidth": .integer(Int64(scaledWidth)), "scaledHeight": .integer(Int64(scaledHeight)),
         "display_id": .integer(Int64(displayID)),
         "display_bounds": .object(["x": .number(Double(bounds.origin.x)), "y": .number(Double(bounds.origin.y)),
                                    "width": .number(Double(bounds.width)), "height": .number(Double(bounds.height))]),
         "pixels_per_point_x": .number(Double(nativeWidth) / Double(bounds.width)),
         "pixels_per_point_y": .number(Double(nativeHeight) / Double(bounds.height)),
         "cursor_included": .boolean(true),
         "capture_filter": .string("excluding_entire_own_application"),
         "native_capture_resolution": .string("best"),
         "native_pixel_format": .string("BGRA32"),
         "excluded_application_pid": .integer(Int64(excludedPID)),
         "excluded_application_bundle_id": .string(excludedBundleID),
         "native_frame_timing": nativeFrameTiming.metadata]
    }

    var metadata: [String: HostValue] {
        geometryMetadata.merging(["image": .string(png.base64EncodedString())]) { _, value in value }
    }
}

/// Captures only the explicitly selected display, excluding this entire app.
/// Each screenshot gets a fresh filter; native VNC capture is a separate path.
@MainActor
final class HostCapture {
    private let preferences: HostCapturePreferences
    private let permission: HostCapturePermission
    var enabled: Bool { preferences.isEnabled }
    let displayID: CGDirectDisplayID

    init(preferences: HostCapturePreferences, permission: HostCapturePermission,
         displayID: CGDirectDisplayID) {
        self.preferences = preferences; self.permission = permission; self.displayID = displayID
    }

    func snapshot(maximumDimension: Int) async throws -> HostCapturedImage {
        guard maximumDimension > 0 else { throw HostCaptureError.incompleteImage }
        try permission.requireCapture(enabled: enabled)
        let content: SCShareableContent
        do {
            content = try await permission.withCaptureAuthorization(enabled: { self.enabled }) {
                try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            }
        } catch let error as HostCaptureError { throw error }
        catch {
            throw HostCaptureFailure.preserving(error, phase: .shareableContent,
                                              screenCaptureErrorDomain: SCStreamErrorDomain)
        }
        guard let display = content.displays.first(where: { $0.displayID == displayID }),
              CGDisplayIsActive(displayID) != 0 else { throw HostCaptureError.displayUnavailable }
        guard let ownApp = content.applications.first(where: {
            $0.processID == getpid() && $0.bundleIdentifier == Bundle.main.bundleIdentifier
        }) else { throw HostCaptureError.selfApplicationUnavailable }
        let width = CGDisplayPixelsWide(displayID), height = CGDisplayPixelsHigh(displayID)
        let bounds = CGDisplayBounds(displayID)
        // Bound the source allocation independently of requested output scaling.
        guard width > 0, height > 0, width <= 16_384, height <= 16_384,
              width <= 33_554_432 / height,
              bounds.width > 0, bounds.height > 0, !bounds.isInfinite, !bounds.isNull else {
            throw HostCaptureError.incompleteImage
        }
        let filter = SCContentFilter(display: display, excludingApplications: [ownApp],
                                     exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = true
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.scalesToFit = false
        configuration.captureResolution = .best
        let sampled: (CMSampleBuffer, CMTime, CMTime)
        do {
            sampled = try await permission.withCaptureAuthorization(enabled: { self.enabled }) {
                try Task.checkCancellation()
                let hostClock = CMClockGetHostTimeClock()
                let requestedAt = CMClockGetTime(hostClock)
                let sample = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter,
                                                                             configuration: configuration)
                let completedAt = CMClockGetTime(hostClock)
                try Task.checkCancellation()
                return (sample, requestedAt, completedAt)
            }
        } catch let error as HostCaptureError { throw error }
        catch {
            throw HostCaptureFailure.preserving(error, phase: .captureImage,
                                              screenCaptureErrorDomain: SCStreamErrorDomain)
        }
        let captured = try HostCapturedSample.read(sampled.0, width: width, height: height,
            requestHostTime: sampled.1, completionHostTime: sampled.2)
        let image = captured.image
        guard image.width == width, image.height == height,
              CGDisplayBounds(displayID) == bounds,
              CGDisplayPixelsWide(displayID) == width, CGDisplayPixelsHigh(displayID) == height else {
            throw HostCaptureError.incompleteImage
        }
        let ratio = min(1, Double(maximumDimension) / Double(max(width, height)))
        let scaledWidth = max(1, Int((Double(width) * ratio).rounded()))
        let scaledHeight = max(1, Int((Double(height) * ratio).rounded()))
        let output: CGImage
        if ratio == 1 { output = image }
        else {
            guard let context = CGContext(data: nil, width: scaledWidth, height: scaledHeight,
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
                throw HostCaptureError.imageEncodingFailed
            }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: scaledWidth, height: scaledHeight))
            guard let resized = context.makeImage() else { throw HostCaptureError.imageEncodingFailed }
            output = resized
        }
        let png = NSMutableData()
        guard let encoder = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil)
        else { throw HostCaptureError.imageEncodingFailed }
        CGImageDestinationAddImage(encoder, output, nil)
        guard CGImageDestinationFinalize(encoder) else { throw HostCaptureError.imageEncodingFailed }
        try Task.checkCancellation()
        return HostCapturedImage(png: png as Data, nativeWidth: width, nativeHeight: height,
            scaledWidth: scaledWidth, scaledHeight: scaledHeight, displayID: displayID, bounds: bounds,
            excludedPID: ownApp.processID, excludedBundleID: ownApp.bundleIdentifier,
            nativeFrameTiming: captured.timing)
    }
}

extension HostCapturePermission {
    static func system() -> HostCapturePermission {
        HostCapturePermission(preflight: { CGPreflightScreenCaptureAccess() },
                              request: { CGRequestScreenCaptureAccess() })
    }
}
