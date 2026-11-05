// Area snip helper for OpenCluely (macOS).
//
// Usage: snip <output.png>
// Freezes the display under the mouse, lets the user drag out an area, and
// writes it to <output.png> at full Retina resolution.
// Exit codes: 0 = saved, 1 = cancelled (Esc or a click without a drag),
//             2 = capture failed (usually Screen Recording permission).
//
// OpenCluely owns the shortcut and launches this per snip. Like the system
// screenshot tool it replaces, it never activates itself, so the app you are
// in keeps focus.

import Cocoa
import ScreenCaptureKit
import Carbon.HIToolbox

// MARK: - Entry

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: snip <output.png>\n".data(using: .utf8)!)
    exit(2)
}
let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)   // background tool, no dock icon
    app.run()
}

// MARK: - App delegate: starts one snip

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let snipper = SnipController()

    func applicationDidFinishLaunching(_ note: Notification) {
        snipper.begin()
    }
}

// MARK: - Carbon global hotkey (no external deps)
// Used for Esc while the overlay is up: the overlay never takes keyboard
// focus, so it can't see key presses any other way.

final class HotKeyCenter {
    private var ref: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var handler: (() -> Void)?

    func register(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) {
        handler = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: OSType(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
            let center = Unmanaged<HotKeyCenter>.fromOpaque(userData!).takeUnretainedValue()
            center.handler?()
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handlerRef)

        let id = EventHotKeyID(signature: OSType(0x534E4950), id: 1) // 'SNIP'
        RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
        ref = nil; handlerRef = nil; handler = nil
    }
}

// MARK: - Controller: capture, present overlay, crop result

@MainActor
final class SnipController {
    private var panel: NSPanel?
    private let escape = HotKeyCenter()

    func begin() {
        // The display under the mouse, not just the first one
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main,
              let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else {
            exit(2)
        }
        Task {
            guard let image = await capture(displayID: displayID, screen: screen) else {
                NSLog("no image — likely Screen Recording permission not granted yet")
                exit(2)
            }
            present(image, on: screen)
        }
    }

    private func capture(displayID: CGDirectDisplayID, screen: NSScreen) async -> CGImage? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else { return nil }
            let scale = screen.backingScaleFactor
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width  = Int(CGFloat(display.width)  * scale)  // pixel dims = full Retina res
            config.height = Int(CGFloat(display.height) * scale)
            config.showsCursor = false                            // don't bake in the cursor
            return try await SCScreenshotManager.captureImage(contentFilter: filter,
                                                              configuration: config)
        } catch {
            NSLog("capture failed: \(error)")
            return nil
        }
    }

    private func present(_ image: CGImage, on screen: NSScreen) {
        // A non-activating panel takes the drag without pulling focus from
        // the app you are in, and joins full-screen Spaces.
        let panel = NSPanel(contentRect: screen.frame,
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.isOpaque = true
        panel.backgroundColor = .black
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.sharingType = .none
        let view = SnipView(frame: NSRect(origin: .zero, size: screen.frame.size),
                            image: image,
                            scale: screen.backingScaleFactor) { [weak self] pxRect in
            self?.finish(pxRect: pxRect, image: image)
        }
        panel.contentView = view
        panel.setFrame(screen.frame, display: true)
        panel.orderFrontRegardless()
        self.panel = panel

        escape.register(keyCode: UInt32(kVK_Escape), modifiers: 0) { [weak self] in
            Task { @MainActor in self?.finish(pxRect: .zero, image: image) }
        }
    }

    private func finish(pxRect: CGRect, image: CGImage) {
        escape.unregister()
        panel?.orderOut(nil)
        panel = nil
        guard pxRect.width >= 1, pxRect.height >= 1,
              let crop = image.cropping(to: pxRect.integral) else { exit(1) }
        let rep = NSBitmapImageRep(cgImage: crop)
        guard let png = rep.representation(using: .png, properties: [:]),
              (try? png.write(to: outputURL)) != nil else { exit(2) }
        exit(0)
    }
}

// MARK: - View: draws frozen image, tracks drag, returns a PIXEL rect

final class SnipView: NSView {
    private let image: CGImage
    private let scale: CGFloat
    private let onComplete: (CGRect) -> Void
    private var start: NSPoint?
    private var sel: NSRect = .zero

    init(frame: NSRect, image: CGImage, scale: CGFloat,
         onComplete: @escaping (CGRect) -> Void) {
        self.image = image; self.scale = scale; self.onComplete = onComplete
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { fatalError() }

    // The panel is never key, so the first click must start the drag
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirty: NSRect) {
        let bg = NSImage(cgImage: image, size: bounds.size)   // NSImage handles orientation
        bg.draw(in: bounds)
        NSColor.black.withAlphaComponent(0.25).setFill()
        bounds.fill()
        guard sel != .zero, let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState(); ctx.clip(to: sel); bg.draw(in: bounds); ctx.restoreGState()
        NSColor.white.setStroke()
        let p = NSBezierPath(rect: sel); p.lineWidth = 1; p.stroke()
    }

    override func mouseDown(with e: NSEvent) {
        start = convert(e.locationInWindow, from: nil); sel = .zero; needsDisplay = true
    }
    override func mouseDragged(with e: NSEvent) {
        guard let s = start else { return }
        let p = convert(e.locationInWindow, from: nil)
        sel = NSRect(x: min(s.x, p.x), y: min(s.y, p.y),
                     width: abs(p.x - s.x), height: abs(p.y - s.y))
        needsDisplay = true
    }
    override func mouseUp(with e: NSEvent) {
        defer { start = nil }
        guard sel.width >= 2, sel.height >= 2 else { onComplete(.zero); return }
        // view points (Y-up, bottom-left)  ->  image pixels (Y-down, top-left)
        let h = bounds.height
        onComplete(CGRect(x: sel.minX * scale,
                          y: (h - sel.maxY) * scale,
                          width: sel.width * scale,
                          height: sel.height * scale))
    }
}
