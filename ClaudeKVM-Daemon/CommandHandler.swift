import Foundation

extension ClaudeKVMDaemon {

    // MARK: - Command Loop

    func runCommandLoop(vnc: VNCBridge, input: InputController, scaling: DisplayScaling) async {
        let stdin = FileHandle.standardInput
        let lifetime = NativeCommandLifetime()
        input.inputPermit.setFailureHandler { lifetime.cancelCurrent() }

        // Parse on the reader rather than after an action completes. Only the
        // two private permit controls bypass the ordinary serial command lane.
        let requests = AsyncStream<PCRequest> { continuation in
            DispatchQueue.global(qos: .userInteractive).async {
                var buffer = Data()
                var discardOversizedLine = false
                let maximumRequestBytes = 8 * 1024 * 1024
                while true {
                    let data = stdin.availableData
                    if data.isEmpty {
                        input.inputPermit.invalidate()
                        lifetime.close()
                        continuation.finish()
                        return
                    }
                    if discardOversizedLine {
                        guard let newline = data.firstIndex(of: UInt8(ascii: "\n")) else { continue }
                        buffer.append(data[data.index(after: newline)...])
                        discardOversizedLine = false
                    } else { buffer.append(data) }
                    while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                        let line = buffer[buffer.startIndex..<newline]
                        buffer = Data(buffer[buffer.index(after: newline)...])
                        guard !line.isEmpty else { continue }
                        guard line.count <= maximumRequestBytes else {
                            input.inputPermit.invalidateIfRequired()
                            respond(.error(id: nil, code: -32600, message: "Native request exceeds 8 MiB"))
                            continue
                        }
                        do {
                            let request = try JSONDecoder().decode(PCRequest.self, from: line)
                            if PCRequest.inputPermitMethods.contains(request.method) {
                                Task { await handleInputPermit(request, vnc: vnc, permit: input.inputPermit) }
                            } else { continuation.yield(request) }
                        } catch {
                            input.inputPermit.invalidateIfRequired()
                            respond(.error(id: nil, code: -32700, message: "Parse error: \(error.localizedDescription)"))
                        }
                    }
                    if buffer.count > maximumRequestBytes {
                        input.inputPermit.invalidateIfRequired()
                        buffer.removeAll(keepingCapacity: false)
                        discardOversizedLine = true
                        respond(.error(id: nil, code: -32600, message: "Native request exceeds 8 MiB"))
                    }
                }
            }
        }

        for await request in requests {
            let task = Task { await handleRequest(request, vnc: vnc, input: input, scaling: scaling) }
            lifetime.register(task)
            await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
            lifetime.finished()
        }

        log("stdin closed — shutting down")
        await input.releaseHeldInput()
        input.inputPermit.stopWatchdog()
    }

    /// Controls only change the locked permit, never concurrent cursor/held
    /// state or display scaling. Ordinary input remains strictly serialized.
    private func handleInputPermit(_ req: PCRequest, vnc: VNCBridge, permit: NativeInputPermit) async {
        do {
            let p = req.params
            // Bound integers before DisplayScaling converts them through Double.
            guard let width = p?.nativeWidth, let height = p?.nativeHeight,
                  let scaledWidth = p?.scaledWidth, let scaledHeight = p?.scaledHeight,
                  [width, height, scaledWidth, scaledHeight].allSatisfy({ (1...65535).contains($0) }) else {
                throw CommandValidationError.invalid("native input permit geometry")
            }
            let maximum = max(scaledWidth, scaledHeight)
            let binding = try req.inputPermitBinding(scaling: DisplayScaling(
                nativeWidth: width, nativeHeight: height, maxDimension: maximum))
            guard let sequence = p?.sequence else {
                throw CommandValidationError.invalid("native input permit sequence")
            }
            _ = try await vnc.validateExternalObservation(binding.context)
            let receipt: NativeInputPermit.Receipt
            if req.method == "begin_input_permit" {
                receipt = try permit.begin(binding: binding, sequence: sequence)
            } else {
                guard let challenge = p?.challenge, let remaining = p?.leaseRemainingMilliseconds else {
                    throw CommandValidationError.invalid("native input permit grant")
                }
                receipt = try permit.grant(binding: binding, sequence: sequence,
                    challenge: challenge, leaseRemainingMilliseconds: remaining)
            }
            respond(.inputPermit(id: req.id, receipt: receipt))
        } catch {
            permit.invalidate()
            respond(.error(id: req.id, message: error.localizedDescription))
        }
    }

    // MARK: - Request Handler

    func handleRequest(
        _ req: PCRequest,
        vnc: VNCBridge,
        input: InputController,
        scaling: DisplayScaling
    ) async {
        let id = req.id
        let p = req.params

        do {
            try Task.checkCancellation()
            if req.method == "adopt_observation" { input.context = nil }
            try req.validate(scaling: scaling)
            if PCRequest.inputMethods.contains(req.method) {
                try input.checkInputAdmission()
                guard input.heldKeys.isEmpty, !input.heldButtons else {
                    throw VNCError.sendFailed("Previous input release is unconfirmed; reconcile the target before continuing")
                }
                guard let context = input.context,
                      context == VNCInputContext(vnc.framebufferDiagnostics) else {
                    throw VNCError.sendFailed("Observed display changed; take a new screenshot before input")
                }
            }
            // Screen observations require newly received full pixel coverage,
            // then encode an owned copy bound to the admitted generation.
            let capturedFrame: VNCBridge.FrameCapture?
            switch req.method {
            case "screenshot", "cursor_crop", "diff_check", "set_baseline", "detect_elements":
                // Revoke the prior observation before a refresh can fail.
                input.context = nil
                capturedFrame = try await vnc.captureFreshFramebuffer()
            default: capturedFrame = nil
            }
            if let frame = capturedFrame {
                scaling.updateGeometry(width: frame.width, height: frame.height)
                // Do not authorize input from a frame that later fails encoding.
                input.context = nil
                input.cursorX = min(max(0, input.cursorX), frame.width - 1)
                input.cursorY = min(max(0, input.cursorY), frame.height - 1)
            }
            switch req.method {

            // ── Screen ────────────────────────────────────────

            case "screenshot":
                guard let imageData = capturedFrame?.withFramebuffer({ buf, w, h -> Data? in
                    createPNGFromRGBA(buffer: buf, width: w, height: h, scaling: scaling)
                }) ?? nil else {
                    throw VNCError.sendFailed("No framebuffer")
                }
                input.context = capturedFrame?.inputContext
                respond(.success(id: id, image: imageData.base64EncodedString(),
                                  scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                                  frameContext: capturedFrame?.inputContext))

            case "cursor_crop":
                let pos = input.cursorPosition
                let scaledPos = scaling.toScaled(x: pos.x, y: pos.y)
                guard let imageData = capturedFrame?.withFramebuffer({ buf, w, h -> Data? in
                    cropWithCrosshair(buffer: buf, width: w, height: h,
                                      centerX: pos.x, centerY: pos.y, radius: input.timing.cursorCropRadius)
                }) ?? nil else {
                    throw VNCError.sendFailed("No framebuffer")
                }
                input.context = capturedFrame?.inputContext
                respond(.success(id: id, image: imageData.base64EncodedString(),
                                  x: scaledPos.x, y: scaledPos.y,
                                  frameContext: capturedFrame?.inputContext))

            case "diff_check":
                guard let frame = capturedFrame else { throw VNCError.sendFailed("No framebuffer") }
                let changed = frame.withFramebuffer { buf, _, _ -> Bool in
                    diffCheck(buffer: buf, context: frame.inputContext)
                }
                input.context = frame.inputContext
                respond(.success(id: id, detail: "changeDetected: \(changed)", frameContext: frame.inputContext))

            case "set_baseline":
                guard let frame = capturedFrame else { throw VNCError.sendFailed("No framebuffer") }
                Self.framebufferBaseline.set(frame.pixels, context: frame.inputContext)
                input.context = frame.inputContext
                respond(.success(id: id, detail: "OK", frameContext: frame.inputContext))

            // ── Mouse ─────────────────────────────────────────

            case "mouse_move":
                let native = nativeXY(p, scaling: scaling)
                try await input.mouseMove(x: native.x, y: native.y)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "hover":
                let native = nativeXY(p, scaling: scaling)
                try await input.mouseHover(x: native.x, y: native.y)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "nudge":
                guard let dx = p?.dx, let dy = p?.dy else {
                    throw VNCError.sendFailed("Missing dx/dy")
                }
                let nativeDX = Int((Double(dx) * Double(scaling.nativeWidth) / Double(scaling.scaledWidth)).rounded())
                let nativeDY = Int((Double(dy) * Double(scaling.nativeHeight) / Double(scaling.scaledHeight)).rounded())
                try await input.mouseNudge(dx: nativeDX, dy: nativeDY)
                try input.checkInputAdmission()
                let pos = scaling.toScaled(x: input.cursorPosition.x, y: input.cursorPosition.y)
                respond(.success(id: id, detail: "OK", x: pos.x, y: pos.y))

            case "mouse_click":
                let native = nativeXY(p, scaling: scaling)
                let btn = parseButton(p?.button)
                try await input.mouseClick(x: native.x, y: native.y, button: btn)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "mouse_double_click":
                let native = nativeXY(p, scaling: scaling)
                try await input.mouseDoubleClick(x: native.x, y: native.y)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "mouse_drag":
                guard let toX = p?.toX, let toY = p?.toY else {
                    throw VNCError.sendFailed("Missing toX/toY")
                }
                let from = nativeXY(p, scaling: scaling)
                let to = scaling.toNative(x: toX, y: toY)
                try await input.mouseDrag(fromX: from.x, fromY: from.y, toX: to.x, toY: to.y)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "scroll":
                let native = nativeXY(p, scaling: scaling)
                guard let dirStr = p?.direction,
                      let dir = ScrollDirection(rawValue: dirStr) else {
                    throw VNCError.sendFailed("Missing direction")
                }
                try await input.scroll(x: native.x, y: native.y, direction: dir, amount: p?.amount ?? 3)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            // ── Keyboard ──────────────────────────────────────

            case "key_tap":
                guard let keyName = p?.key, let sym = namedKeyToKeysym(keyName) else {
                    throw VNCError.sendFailed("Missing or unknown key")
                }
                try await input.keyTap(sym)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "key_combo":
                if let combo = p?.key {
                    try await input.keyCombo(combo)
                } else if let keys = p?.keys {
                    let syms = keys.compactMap { namedKeyToKeysym($0) }
                    guard syms.count == keys.count else {
                        throw VNCError.sendFailed("Unknown key in combo: \(keys)")
                    }
                    try await input.keyCombo(syms)
                } else {
                    throw VNCError.sendFailed("Missing key or keys")
                }
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "key_type":
                guard let text = p?.text else {
                    throw VNCError.sendFailed("Missing text")
                }
                try await input.typeText(text)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            case "paste":
                guard let text = p?.text else {
                    throw VNCError.sendFailed("Missing text")
                }
                try await input.pasteText(text)
                try input.checkInputAdmission()
                respond(.success(id: id, detail: "OK"))

            // ── Detection ──────────────────────────────────────

            case "detect_elements":
                guard let elements = capturedFrame?.withFramebuffer({ buf, w, h -> [TextElement] in
                    detectTextElements(buffer: buf, width: w, height: h, scaling: scaling)
                }) else { throw VNCError.sendFailed("No framebuffer") }
                input.context = capturedFrame?.inputContext
                respond(.success(id: id, detail: "\(elements.count) elements",
                                  scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                                  elements: elements, frameContext: capturedFrame?.inputContext))

            // ── Configuration ─────────────────────────────────

            case "adopt_observation":
                let expected = try req.externalObservation(scaling: scaling)
                try await input.adoptObservation(expected, scaling: scaling)
                respond(.success(id: id, detail: "OK", scaledWidth: scaling.scaledWidth,
                                  scaledHeight: scaling.scaledHeight, frameContext: expected))

            case "configure":
                input.inputPermit.invalidateIfRequired()
                handleConfigure(id: id, params: p, input: input, scaling: scaling)

            case "get_timing":
                let timing = buildTimingMap(input: input, scaling: scaling)
                respond(.success(id: id,
                                  scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                                  timing: timing))

            // ── Control ───────────────────────────────────────

            case "wait":
                let ms = p?.ms ?? 500
                try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                respond(.success(id: id, detail: "OK"))

            case "health":
                let current = VNCInputContext(vnc.framebufferDiagnostics)
                let liveScaling = DisplayScaling(nativeWidth: current.width, nativeHeight: current.height,
                                                 maxDimension: scaling.maxDimension)
                respond(.success(id: id, detail: "\(vnc.connectionState)",
                                  scaledWidth: liveScaling.scaledWidth, scaledHeight: liveScaling.scaledHeight,
                                  frameContext: current, capabilities: PCRequest.supportedMethods))

            case "shutdown":
                input.inputPermit.stopWatchdog()
                guard await input.releaseHeldInput() else {
                    throw VNCError.sendFailed("Shutdown could not confirm held-state release")
                }
                respond(.success(id: id, detail: "OK"))
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { Foundation.exit(0) }
                return

            default:
                respond(.error(id: id, code: -32601, message: "Method not found: \(req.method)"))
            }
        } catch {
            input.inputPermit.invalidateIfRequired()
            await input.releaseHeldInput()
            respond(.error(id: id, message: error.localizedDescription))
        }
    }

    // MARK: - Configure Handler

    private func handleConfigure(
        id: PCId?,
        params p: PCRequest.Params?,
        input: InputController,
        scaling: DisplayScaling
    ) {
        if p?.reset == true {
            input.timing = InputTiming()
            scaling.reset()
            let timing = buildTimingMap(input: input, scaling: scaling)
            respond(.success(id: id, detail: "OK — reset to defaults",
                              scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight,
                              timing: timing))
            return
        }

        var changed: [String] = []

        // Display
        if let v = p?.maxDimension {
            scaling.reconfigure(maxDimension: v)
            changed.append("max_dimension")
        }

        // Mouse
        if let v = p?.clickHoldMs {
            input.timing.clickHoldUs = UInt32(v) * 1000
            changed.append("click_hold_ms")
        }
        if let v = p?.doubleClickGapMs {
            input.timing.doubleClickGapUs = UInt32(v) * 1000
            changed.append("double_click_gap_ms")
        }
        if let v = p?.hoverSettleMs {
            input.timing.hoverSettleUs = UInt32(v) * 1000
            changed.append("hover_settle_ms")
        }

        // Drag
        if let v = p?.dragPositionMs {
            input.timing.dragPositionUs = UInt32(v) * 1000
            changed.append("drag_position_ms")
        }
        if let v = p?.dragPressMs {
            input.timing.dragPressUs = UInt32(v) * 1000
            changed.append("drag_press_ms")
        }
        if let v = p?.dragStepMs {
            input.timing.dragStepUs = UInt32(v) * 1000
            changed.append("drag_step_ms")
        }
        if let v = p?.dragSettleMs {
            input.timing.dragSettleUs = UInt32(v) * 1000
            changed.append("drag_settle_ms")
        }
        if let v = p?.dragPixelsPerStep {
            input.timing.dragPixelsPerStep = v
            changed.append("drag_pixels_per_step")
        }
        if let v = p?.dragMinSteps {
            input.timing.dragMinSteps = v
            changed.append("drag_min_steps")
        }

        // Scroll
        if let v = p?.scrollPressMs {
            input.timing.scrollPressUs = UInt32(v) * 1000
            changed.append("scroll_press_ms")
        }
        if let v = p?.scrollTickMs {
            input.timing.scrollTickUs = UInt32(v) * 1000
            changed.append("scroll_tick_ms")
        }

        // Keyboard
        if let v = p?.keyHoldMs {
            input.timing.keyHoldUs = UInt32(v) * 1000
            changed.append("key_hold_ms")
        }
        if let v = p?.comboModMs {
            input.timing.comboModUs = UInt32(v) * 1000
            changed.append("combo_mod_ms")
        }

        // Typing
        if let v = p?.typeKeyMs {
            input.timing.typeKeyUs = UInt32(v) * 1000
            changed.append("type_key_ms")
        }
        if let v = p?.typeInterKeyMs {
            input.timing.typeInterKeyUs = UInt32(v) * 1000
            changed.append("type_inter_key_ms")
        }
        if let v = p?.typeShiftMs {
            input.timing.typeShiftUs = UInt32(v) * 1000
            changed.append("type_shift_ms")
        }
        if let v = p?.pasteSettleMs {
            input.timing.pasteSettleUs = UInt32(v) * 1000
            changed.append("paste_settle_ms")
        }

        // Display tuning
        if let v = p?.cursorCropRadius {
            input.timing.cursorCropRadius = v
            changed.append("cursor_crop_radius")
        }

        if changed.isEmpty {
            respond(.error(id: id, message: "No valid parameters provided"))
            return
        }

        log("configure: \(changed.joined(separator: ", "))")

        if changed.contains("max_dimension") {
            log("Display rescaled: \(scaling.scaledWidth)×\(scaling.scaledHeight)")
            respond(.success(id: id, detail: "OK — changed: \(changed.joined(separator: ", "))",
                              scaledWidth: scaling.scaledWidth, scaledHeight: scaling.scaledHeight))
        } else {
            respond(.success(id: id, detail: "OK — changed: \(changed.joined(separator: ", "))"))
        }
    }

    // MARK: - Timing Map Builder

    private func buildTimingMap(input: InputController, scaling: DisplayScaling) -> [String: Double] {
        let t = input.timing
        return [
            "max_dimension": Double(scaling.maxDimension),
            "click_hold_ms": Double(t.clickHoldUs) / 1000,
            "double_click_gap_ms": Double(t.doubleClickGapUs) / 1000,
            "hover_settle_ms": Double(t.hoverSettleUs) / 1000,
            "drag_position_ms": Double(t.dragPositionUs) / 1000,
            "drag_press_ms": Double(t.dragPressUs) / 1000,
            "drag_step_ms": Double(t.dragStepUs) / 1000,
            "drag_settle_ms": Double(t.dragSettleUs) / 1000,
            "drag_pixels_per_step": t.dragPixelsPerStep,
            "drag_min_steps": Double(t.dragMinSteps),
            "scroll_press_ms": Double(t.scrollPressUs) / 1000,
            "scroll_tick_ms": Double(t.scrollTickUs) / 1000,
            "key_hold_ms": Double(t.keyHoldUs) / 1000,
            "combo_mod_ms": Double(t.comboModUs) / 1000,
            "type_key_ms": Double(t.typeKeyUs) / 1000,
            "type_inter_key_ms": Double(t.typeInterKeyUs) / 1000,
            "type_shift_ms": Double(t.typeShiftUs) / 1000,
            "paste_settle_ms": Double(t.pasteSettleUs) / 1000,
            "cursor_crop_radius": Double(t.cursorCropRadius),
        ]
    }

    // MARK: - Helpers

    func nativeXY(_ params: PCRequest.Params?, scaling: DisplayScaling) -> (x: Int, y: Int) {
        let x = params?.x ?? 0
        let y = params?.y ?? 0
        return scaling.toNative(x: x, y: y)
    }

    func parseButton(_ name: String?) -> MouseButton {
        switch name?.lowercased() {
        case "right":  return .right
        case "middle": return .middle
        default:       return .left
        }
    }
}

/// EOF can arrive while the serial loop is inside a long input operation.
/// Cancel that operation immediately rather than waiting for its next request.
private final class NativeCommandLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var closed = false
    private var task: Task<Void, Never>?

    func register(_ task: Task<Void, Never>) {
        lock.lock()
        self.task = task
        let shouldCancel = closed
        lock.unlock()
        if shouldCancel { task.cancel() }
    }

    func finished() {
        lock.lock(); task = nil; lock.unlock()
    }

    func close() {
        lock.lock()
        closed = true
        let current = task
        lock.unlock()
        current?.cancel()
    }

    func cancelCurrent() {
        lock.lock(); let current = task; lock.unlock()
        current?.cancel()
    }
}
