import sys
import time
from AppKit import NSSpeechRecognizer, NSObject, NSSound
from Quartz import CGEventCreateKeyboardEvent, CGEventPost, kCGHIDEventTap, kCGEventFlagMaskAlternate, CGEventSetFlags
from PyObjCTools import AppHelper

class SpeechDelegate(NSObject):
    def speechRecognizer_didRecognizeCommand_(self, recognizer, command):
        print(f"\n[🟢 WakeWord] Detected: '{command}' at {time.strftime('%H:%M:%S')}", flush=True)
        
        # Anti-Premature Stop Guard: Ignore wake word triggers if Voice Bar is already active (listening, sending, thinking)
        try:
            with open("/tmp/ocb_status.txt", "r") as f:
                status = f.read().strip()
                if status != "idle" and status != "offline" and status != "error":
                    print(f"[🟡 WakeWord] Ignored command because Voice Bar is currently busy (state: '{status}')", flush=True)
                    return
        except Exception:
            pass

        # Play a subtle, premium notification sound
        sound = NSSound.alloc().initWithContentsOfFile_byReference_("/System/Library/Sounds/Tink.aiff", True)
        if sound:
            sound.play()
            
        # Post Option-Space (⌥Space) keyboard event
        # 49 is the keycode for Space
        event_down = CGEventCreateKeyboardEvent(None, 49, True)
        CGEventSetFlags(event_down, kCGEventFlagMaskAlternate)
        event_up = CGEventCreateKeyboardEvent(None, 49, False)
        CGEventSetFlags(event_up, kCGEventFlagMaskAlternate)
        
        CGEventPost(kCGHIDEventTap, event_down)
        time.sleep(0.02)
        CGEventPost(kCGHIDEventTap, event_up)
        print("[⚡️ Hotkey] Triggered ⌥Space event programmatically", flush=True)

def main():
    print("=" * 60)
    print("        OpenCodex Native Voice Activation Listener 🎙️")
    print("=" * 60)
    print("Creating speech recognizer...", flush=True)
    
    recognizer = NSSpeechRecognizer.alloc().init()
    if not recognizer:
        print("❌ Error: Failed to initialize NSSpeechRecognizer.")
        sys.exit(1)
        
    # We can define a set of custom commands/keywords to listen to
    commands = [
        "开启助手",
        "你好助手",
        "唤醒助手",
        "open codex",
        "hello codex",
        "wake up"
    ]
    
    recognizer.setCommands_(commands)
    recognizer.setListensInForegroundOnly_(False)
    
    delegate = SpeechDelegate.alloc().init()
    recognizer.setDelegate_(delegate)
    
    print(f"Listening for wake words in the background:")
    for cmd in commands:
        print(f"  • \"{cmd}\"")
        
    print("\nStarting listening session...")
    recognizer.startListening()
    
    print("\n🎉 Wake-word listener is now active!")
    print("💡 Screen numbers are GONE. macOS menu bar numbers are GONE.")
    print("👉 Speak any wake word to trigger your floating visualizer pill.")
    print("Press Ctrl+C to stop.")
    print("=" * 60, flush=True)
    
    try:
        AppHelper.runConsoleEventLoop()
    except KeyboardInterrupt:
        print("\nStopping listening session...", flush=True)
        recognizer.stopListening()
        print("Goodbye!")

if __name__ == "__main__":
    main()
