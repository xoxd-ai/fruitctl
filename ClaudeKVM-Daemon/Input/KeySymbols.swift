import Foundation

// MARK: - Button Masks (VNC RFB protocol)

enum MouseButton: Int {
    case left   = 1
    case middle = 2
    case right  = 4
    case scrollUp    = 8
    case scrollDown  = 16
    case scrollLeft  = 32
    case scrollRight = 64
}

// MARK: - Timing (deterministic, zero randomness)

struct InputTiming {
    // Mouse
    var clickHoldUs: UInt32     = 50_000   // 50ms
    var doubleClickGapUs: UInt32 = 50_000  // 50ms
    var hoverSettleUs: UInt32   = 400_000  // 400ms

    // Drag
    var dragPositionUs: UInt32  = 30_000   // 30ms
    var dragPressUs: UInt32     = 50_000   // 50ms
    var dragStepUs: UInt32      = 5_000    // 5ms
    var dragSettleUs: UInt32    = 30_000   // 30ms
    var dragPixelsPerStep: Double = 20.0   // 20px
    var dragMinSteps: Int       = 10

    // Scroll
    var scrollPressUs: UInt32   = 10_000   // 10ms
    var scrollTickUs: UInt32    = 20_000   // 20ms

    // Keyboard
    var keyHoldUs: UInt32       = 30_000   // 30ms
    var comboModUs: UInt32      = 10_000   // 10ms

    // Typing
    var typeKeyUs: UInt32       = 20_000   // 20ms
    var typeInterKeyUs: UInt32  = 20_000   // 20ms
    var typeShiftUs: UInt32     = 10_000   // 10ms
    var pasteSettleUs: UInt32   = 30_000   // 30ms
    /// D29: after a routed paste's Cmd+V, before the next clipboard write
    /// (the restore included), so the target app reads the pasted text.
    var pasteRestoreUs: UInt32  = 300_000  // 300ms

    // Display
    var cursorCropRadius: Int   = 150      // px
}

// MARK: - Scroll Direction

enum ScrollDirection: String {
    case up, down, left, right

    var buttonMask: Int {
        switch self {
        case .up:    return MouseButton.scrollUp.rawValue
        case .down:  return MouseButton.scrollDown.rawValue
        case .left:  return MouseButton.scrollLeft.rawValue
        case .right: return MouseButton.scrollRight.rawValue
        }
    }
}

// MARK: - Key Symbol Constants

enum KeySym {
    static let shiftLeft: UInt32 = 0xFFE1
    static let shiftRight: UInt32 = 0xFFE2
    static let ctrlLeft: UInt32 = 0xFFE3
    static let ctrlRight: UInt32 = 0xFFE4
    static let altLeft: UInt32 = 0xFFE9
    static let altRight: UInt32 = 0xFFEA
    static let metaLeft: UInt32 = 0xFFE7
    static let metaRight: UInt32 = 0xFFE8
    static let superLeft: UInt32 = 0xFFEB
    static let superRight: UInt32 = 0xFFEC
    static let tab: UInt32 = 0xFF09
    static let returnKey: UInt32 = 0xFF0D
    static let escape: UInt32 = 0xFF1B
    static let backspace: UInt32 = 0xFF08
    static let delete: UInt32 = 0xFFFF
    static let home: UInt32 = 0xFF50
    static let end: UInt32 = 0xFF57
    static let pageUp: UInt32 = 0xFF55
    static let pageDown: UInt32 = 0xFF56
    static let arrowLeft: UInt32 = 0xFF51
    static let arrowUp: UInt32 = 0xFF52
    static let arrowRight: UInt32 = 0xFF53
    static let arrowDown: UInt32 = 0xFF54
    static let space: UInt32 = 0x0020
    static let insert: UInt32 = 0xFF63
    static let capsLock: UInt32 = 0xFFE5
    static let numLock: UInt32 = 0xFF7F
    static let scrollLock: UInt32 = 0xFF14
    static let printScreen: UInt32 = 0xFF61
    static let pause: UInt32 = 0xFF13
    static let menu: UInt32 = 0xFF67
    static let f1: UInt32 = 0xFFBE
    static let f2: UInt32 = 0xFFBF
    static let f3: UInt32 = 0xFFC0
    static let f4: UInt32 = 0xFFC1
    static let f5: UInt32 = 0xFFC2
    static let f6: UInt32 = 0xFFC3
    static let f7: UInt32 = 0xFFC4
    static let f8: UInt32 = 0xFFC5
    static let f9: UInt32 = 0xFFC6
    static let f10: UInt32 = 0xFFC7
    static let f11: UInt32 = 0xFFC8
    static let f12: UInt32 = 0xFFC9

    /// Every Shift/Control/Alt/Meta/Super keysym. The set is closed under the
    /// Apple wire mapping (Meta→Super, Alt→Meta), so writing each raw member
    /// releases every modifier either server kind can hold.
    static let modifiers: [UInt32] = [
        shiftLeft, shiftRight, ctrlLeft, ctrlRight, altLeft, altRight,
        metaLeft, metaRight, superLeft, superRight,
    ]
}

/// A click modifier name ("shift", "cmd", ...) resolved to its keysym, or nil
/// for any name that is not a modifier.
func modifierNameToKeysym(_ name: String) -> UInt32? {
    guard let keysym = namedKeyToKeysym(name), KeySym.modifiers.contains(keysym) else { return nil }
    return keysym
}

// MARK: - Named Key → KeySym Resolution

func namedKeyToKeysym(_ name: String) -> UInt32? {
    switch name.lowercased() {
    case "shift", "lshift":      return KeySym.shiftLeft
    case "rshift":               return KeySym.shiftRight
    case "ctrl", "control":      return KeySym.ctrlLeft
    case "rctrl":                return KeySym.ctrlRight
    case "alt", "option", "opt": return KeySym.altLeft
    case "ralt":                 return KeySym.altRight
    case "cmd", "command", "meta", "super": return KeySym.metaLeft
    case "rcmd":                 return KeySym.metaRight
    case "tab":                  return KeySym.tab
    case "return", "enter", "ret": return KeySym.returnKey
    case "escape", "esc":        return KeySym.escape
    case "backspace":            return KeySym.backspace
    case "delete", "del":        return KeySym.delete
    case "home":                 return KeySym.home
    case "end":                  return KeySym.end
    case "pageup", "pgup":       return KeySym.pageUp
    case "pagedown", "pgdn", "pgdown": return KeySym.pageDown
    case "up", "arrowup":        return KeySym.arrowUp
    case "down", "arrowdown":    return KeySym.arrowDown
    case "left", "arrowleft":    return KeySym.arrowLeft
    case "right", "arrowright":  return KeySym.arrowRight
    case "space", "spc":         return KeySym.space
    case "ins", "insert":        return KeySym.insert
    case "capslock", "caps":     return KeySym.capsLock
    case "numlock":              return KeySym.numLock
    case "scrolllock":           return KeySym.scrollLock
    case "printscreen", "print", "prtsc": return KeySym.printScreen
    case "pause", "break":       return KeySym.pause
    case "menu", "contextmenu":  return KeySym.menu
    case "f1":  return KeySym.f1
    case "f2":  return KeySym.f2
    case "f3":  return KeySym.f3
    case "f4":  return KeySym.f4
    case "f5":  return KeySym.f5
    case "f6":  return KeySym.f6
    case "f7":  return KeySym.f7
    case "f8":  return KeySym.f8
    case "f9":  return KeySym.f9
    case "f10": return KeySym.f10
    case "f11": return KeySym.f11
    case "f12": return KeySym.f12
    // xdotool punctuation names resolve as their characters. "plus" is
    // absent: "+" separates the parts of a combo string.
    case "minus":        return charToKeysym("-").keysym
    case "equal":        return charToKeysym("=").keysym
    case "comma":        return charToKeysym(",").keysym
    case "period":       return charToKeysym(".").keysym
    case "slash":        return charToKeysym("/").keysym
    case "backslash":    return charToKeysym("\\").keysym
    case "semicolon":    return charToKeysym(";").keysym
    case "apostrophe", "quote": return charToKeysym("'").keysym
    case "grave":        return charToKeysym("`").keysym
    case "bracketleft":  return charToKeysym("[").keysym
    case "bracketright": return charToKeysym("]").keysym
    default:
        if name.count == 1, let ch = name.first {
            let keysym = charToKeysym(ch).keysym
            return keysym == 0 ? nil : keysym
        }
        return nil
    }
}

// MARK: - Character → KeySym Resolution

func charToKeysym(_ ch: Character) -> (keysym: UInt32, shift: Bool) {
    // A named single key cannot silently truncate a composed character. Text
    // typing plans every scalar separately, preserving its original ordering.
    guard ch.unicodeScalars.count == 1, let scalar = ch.unicodeScalars.first else {
        return (0, false)
    }
    return scalarToKeysym(scalar)
}

private func scalarToKeysym(_ scalar: Unicode.Scalar) -> (keysym: UInt32, shift: Bool) {
    let code = scalar.value

    if code >= 0x20 && code <= 0x7E {
        if code >= 0x41 && code <= 0x5A {
            return (code, true)
        }
        if "!@#$%^&*()_+{}|:\"<>?~".unicodeScalars.contains(scalar) {
            return (code, true)
        }
        return (code, false)
    }

    // RFB uses the Latin-1 keysyms directly, and Unicode keysyms above Latin-1.
    if code >= 0xA0 && code <= 0xFF { return (code, false) }
    if code >= 0x100 { return (0x01000000 | code, false) }
    return (0, false)
}

struct TextInputStroke: Equatable {
    let keysym: UInt32
    let shift: Bool
}

enum TextInputPlanError: LocalizedError {
    case textTooLarge
    case unsupportedControl(UInt32)

    var errorDescription: String? {
        switch self {
        case .textTooLarge: return "Text exceeds the 1048576-byte typing limit"
        case .unsupportedControl(let code):
            return "Unsupported typing control U+" + String(code, radix: 16).uppercased()
        }
    }
}

/// Compact complete event plan: each validated stroke determines its down/up,
/// optional Shift down/up and pauses using this captured timing. No conversion,
/// omission or fallback is allowed after execution starts. At most one stroke
/// per input byte is retained; do not expand a megabyte into millions of events.
/// LF, CR and CRLF represent one Return each; tab represents Tab. All other
/// C0/C1 controls and DEL are refused before any event. Other Unicode scalars,
/// including combining marks, selectors and joiners, retain their exact order;
/// this plans RFB symbols, not a guarantee about a target's keyboard layout.
struct TextInputPlan {
    static let maximumUTF8Bytes = 1_048_576
    let strokes: [TextInputStroke]
    let timing: InputTiming

    init(_ text: String, timing: InputTiming) throws {
        guard text.utf8.count <= Self.maximumUTF8Bytes else {
            throw TextInputPlanError.textTooLarge
        }
        var planned: [TextInputStroke] = []
        planned.reserveCapacity(text.unicodeScalars.count)
        var afterCR = false
        for scalar in text.unicodeScalars {
            let code = scalar.value
            if code == 0x0A && afterCR {
                afterCR = false
                continue // CRLF is one line-ending, not two Return strokes.
            }
            afterCR = code == 0x0D
            if code == 0x0A || code == 0x0D {
                planned.append(.init(keysym: KeySym.returnKey, shift: false))
            } else if code == 0x09 {
                planned.append(.init(keysym: KeySym.tab, shift: false))
            } else {
                let symbol = scalarToKeysym(scalar)
                guard symbol.keysym != 0 else {
                    throw TextInputPlanError.unsupportedControl(code)
                }
                planned.append(.init(keysym: symbol.keysym, shift: symbol.shift))
            }
        }
        strokes = planned
        self.timing = timing
    }
}
