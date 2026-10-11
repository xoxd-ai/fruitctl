import Foundation
import CoreMedia
import CoreFoundation
import CoreVideo
import CoreGraphics
import ScreenCaptureKit
import VideoToolbox
import Darwin

/// Owns the pixels and native timing from one returned screenshot sample.
/// Copy before conversion: the CGImage must never depend on a reused surface.
struct HostCapturedSample {
    let image: CGImage
    let timing: HostNativeFrameTiming

    static func read(_ sample: CMSampleBuffer, width: Int, height: Int,
                     requestHostTime: CMTime, completionHostTime: CMTime) throws -> HostCapturedSample {
        try Task.checkCancellation()
        guard width > 0, height > 0, width <= 16_384, height <= 16_384,
              width <= 33_554_432 / height,
              CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
              CMSampleBufferGetNumSamples(sample) == 1,
              let source = CMSampleBufferGetImageBuffer(sample),
              CVPixelBufferGetWidth(source) == width, CVPixelBufferGetHeight(source) == height,
              CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA,
              !CVPixelBufferIsPlanar(source) else { throw HostCaptureError.incompleteImage }

        let attachments = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                           as? [[SCStreamFrameInfo: Any]])?.first
        let status = unsignedAttachment(attachments?[.status]).flatMap { Int(exactly: $0) }
            .flatMap { SCFrameStatus(rawValue: $0) }
        if attachments?[.status] != nil && status != .complete {
            throw HostCaptureError.incompleteImage
        }
        let timing = HostNativeFrameTiming(presentationTime: CMSampleBufferGetPresentationTimeStamp(sample),
            requestHostTime: requestHostTime, completionHostTime: completionHostTime,
            frameComplete: status.map { $0 == .complete },
            windowServerDisplayTime: unsignedAttachment(attachments?[.displayTime]))

        let copied = try copyBGRA(source, width: width, height: height)
        var image: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(copied, options: nil, imageOut: &image) == noErr,
              let image, image.width == width, image.height == height else {
            throw HostCaptureError.imageEncodingFailed
        }
        try Task.checkCancellation()
        return HostCapturedSample(image: image, timing: timing)
    }

    private static func unsignedAttachment(_ value: Any?) -> UInt64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              ["c", "C", "s", "S", "i", "I", "l", "L", "q", "Q"].contains(String(cString: number.objCType))
        else { return nil }
        return UInt64(number.stringValue)
    }

    private static func copyBGRA(_ source: CVPixelBuffer, width: Int, height: Int) throws -> CVPixelBuffer {
        let rowBytes = width * 4
        let sourceStride = CVPixelBufferGetBytesPerRow(source)
        guard sourceStride >= rowBytes, sourceStride <= 134_217_728 / height else {
            throw HostCaptureError.incompleteImage
        }
        var destination: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                                  nil, &destination) == kCVReturnSuccess,
              let destination else { throw HostCaptureError.imageEncodingFailed }
        let destinationStride = CVPixelBufferGetBytesPerRow(destination)
        guard destinationStride >= rowBytes, destinationStride <= 134_217_728 / height else {
            throw HostCaptureError.incompleteImage
        }
        CVBufferPropagateAttachments(source, destination)
        guard CVPixelBufferLockBaseAddress(source, .readOnly) == kCVReturnSuccess else {
            throw HostCaptureError.incompleteImage
        }
        defer { CVPixelBufferUnlockBaseAddress(source, .readOnly) }
        guard CVPixelBufferLockBaseAddress(destination, []) == kCVReturnSuccess else {
            throw HostCaptureError.imageEncodingFailed
        }
        defer { CVPixelBufferUnlockBaseAddress(destination, []) }
        guard let sourceBytes = CVPixelBufferGetBaseAddress(source),
              let destinationBytes = CVPixelBufferGetBaseAddress(destination) else {
            throw HostCaptureError.incompleteImage
        }
        for row in 0..<height {
            if row % 32 == 0 { try Task.checkCancellation() }
            memcpy(destinationBytes.advanced(by: row * destinationStride),
                   sourceBytes.advanced(by: row * sourceStride), rowBytes)
        }
        return destination
    }
}
