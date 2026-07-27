import AppKit

class ClickThroughWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

class DropZoneView: NSView {
    var onDragEntered: (() -> Void)?
    var onDragExited: (() -> Void)?
    var onPerformDrop: (([URL]) -> Void)?
    
    override func hitTest(_ point: NSPoint) -> NSView? {
        // Return nil on standard click events so that clicks pass through to underlying elements
        if let event = NSApp.currentEvent {
            if event.type == .leftMouseDown || event.type == .rightMouseDown || event.type == .otherMouseDown {
                return nil
            }
        }
        return self
    }
    
    // NSDraggingDestination protocols
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        onDragEntered?()
        return .copy
    }
    
    override func draggingExited(_ sender: NSDraggingInfo?) {
        onDragExited?()
    }
    
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pasteboard = sender.draggingPasteboard
        
        // 1. Local files
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL], !urls.isEmpty {
            let fileURLs = urls.filter { $0.isFileURL }
            if !fileURLs.isEmpty {
                onPerformDrop?(fileURLs)
                return true
            }
        }
        
        // 2. Dragged image data (TIFF/PNG from screenshots, web, etc.)
        if let imgData = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) {
            let tempURL = URL(fileURLWithPath: "/tmp/dropped_file.png")
            if let image = NSImage(data: imgData) {
                if let tiffData = image.tiffRepresentation,
                   let bitmap = NSBitmapImageRep(data: tiffData),
                   let pngData = bitmap.representation(using: .png, properties: [:]) {
                    do {
                        try pngData.write(to: tempURL)
                        onPerformDrop?([tempURL])
                        return true
                    } catch {
                        // fallback to other checks
                    }
                }
            }
        }
        
        // 3. Plain text / Strings
        if let string = pasteboard.string(forType: .string) {
            let tempURL = URL(fileURLWithPath: "/tmp/dropped_file.txt")
            do {
                try string.write(to: tempURL, atomically: true, encoding: .utf8)
                onPerformDrop?([tempURL])
                return true
            } catch {
                // fallback
            }
        }
        
        return false
    }
}

class NotchDropZoneController: NSObject {
    var window: ClickThroughWindow!
    var dropZoneView: DropZoneView!
    
    init(onDragEntered: @escaping () -> Void, onDragExited: @escaping () -> Void, onPerformDrop: @escaping ([URL]) -> Void) {
        super.init()
        
        let width: CGFloat = 260
        let height: CGFloat = 38 // Standard physical camera notch point depth on MacBook screens
        
        let screen = NSScreen.main ?? NSScreen.screens.first
        let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = screenFrame.origin.x + (screenFrame.width - width) / 2
        let y = screenFrame.origin.y + screenFrame.height - height
        
        let contentRect = NSRect(x: x, y: y, width: width, height: height)
        
        window = ClickThroughWindow(
            contentRect: contentRect,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.level = .statusBar
        window.ignoresMouseEvents = false // False is required so drag events are processed by this window
        window.collectionBehavior = [.canJoinAllSpaces, .ignoresCycle]
        
        dropZoneView = DropZoneView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        dropZoneView.onDragEntered = onDragEntered
        dropZoneView.onDragExited = onDragExited
        dropZoneView.onPerformDrop = onPerformDrop
        dropZoneView.registerForDraggedTypes([
            .fileURL,
            .URL,
            .png,
            .tiff,
            .string
        ])
        
        window.contentView = dropZoneView
        window.orderFrontRegardless()
    }
}

