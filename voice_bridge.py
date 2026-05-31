#!/usr/bin/env python3
"""
OpenCodex Voice Bridge
语音 → codex exec（完整 Codex + Computer Use）→ 语音
"""

import subprocess, sys, os, tempfile, json, time

CODEX = "/Applications/Codex.app/Contents/Resources/codex"
REPLY_FILE = "/tmp/voice_reply.txt"

def record_audio(output_path, duration=7):
    """Record from MacBook Pro microphone"""
    cmd = [
        "ffmpeg", "-y",
        "-f", "avfoundation",
        "-i", ":1",  # MacBook Pro mic
        "-t", str(duration),
        "-ac", "1", "-ar", "16000",
        output_path
    ]
    subprocess.run(cmd, capture_output=True, timeout=duration + 3)

def transcribe(audio_path):
    """STT - using macOS accessibility speech recognition via script"""
    # For now, return empty - will implement after testing recording
    return ""

def tts(text):
    """Text to speech using edge-tts"""
    cmd = ["edge-tts", "--voice", "zh-CN-XiaoxiaoNeural", "--text", text, "--write-media", "/tmp/voice_output.mp3"]
    subprocess.run(cmd, capture_output=True, timeout=30)
    subprocess.run(["afplay", "/tmp/voice_output.mp3"], capture_output=True, timeout=60)

def process_voice(text):
    """Main: transcribe → codex exec → TTS"""
    print(f"[Bridge] Processing: {text}")
    
    # Write to cmd file for reference
    with open("/tmp/voice_cmd.txt", "w") as f:
        f.write(text)
    
    # Run codex exec
    result = subprocess.run(
        [CODEX, "exec", "-o", REPLY_FILE, text],
        capture_output=True, timeout=120
    )
    
    # Read reply and speak
    if os.path.exists(REPLY_FILE):
        with open(REPLY_FILE) as f:
            reply = f.read().strip()
        if reply:
            print(f"[Bridge] Reply: {reply[:50]}...")
            tts(reply)
            return reply
    return None

if __name__ == "__main__":
    if len(sys.argv) > 1:
        process_voice(" ".join(sys.argv[1:]))
    else:
        print("Usage: voice_bridge.py <text>")
        print("Example: voice_bridge.py 打开浏览器")
