import sys
import os
import json
import base64
import warnings

# Suppress PyTorch warnings
warnings.filterwarnings("ignore")

import torch
import numpy as np

SAMPLE_RATE = 16000
MAX_WINDOW_SAMPLES = SAMPLE_RATE * 12

def main():
    try:
        from silero_vad import load_silero_vad, get_speech_timestamps
        model = load_silero_vad()
    except Exception as e:
        print(json.dumps({"error": f"Failed to load VAD model: {str(e)}"}))
        sys.exit(1)

    print(json.dumps({"status": "ready"}), flush=True)

    # Keep a rolling window. Re-running Silero over an unbounded recording makes
    # endpoint checks progressively slower during long dictation.
    accumulated_samples = np.empty(0, dtype=np.float32)

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        
        line = line.strip()
        if not line:
            continue
            
        try:
            req = json.loads(line)
            action = req.get("action")
            
            if action == "reset":
                accumulated_samples = np.empty(0, dtype=np.float32)
                print(json.dumps({"status": "reset"}), flush=True)
                continue
                
            elif action == "chunk":
                b64_data = req.get("data", "")
                pcm_bytes = base64.b64decode(b64_data)
                
                # Convert PCM bytes (16-bit signed int) to float32 normalized to [-1.0, 1.0]
                chunk_samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                accumulated_samples = np.concatenate((accumulated_samples, chunk_samples))
                if len(accumulated_samples) > MAX_WINDOW_SAMPLES:
                    accumulated_samples = accumulated_samples[-MAX_WINDOW_SAMPLES:]
                
                # Run VAD on the accumulated buffer
                audio_tensor = torch.from_numpy(accumulated_samples)
                
                speech_timestamps = get_speech_timestamps(
                    audio_tensor,
                    model,
                    sampling_rate=SAMPLE_RATE,
                    threshold=0.60,
                    min_speech_duration_ms=250,
                    min_silence_duration_ms=180,
                    speech_pad_ms=80,
                )
                has_speech = len(speech_timestamps) > 0
                
                total_duration_sec = len(audio_tensor) / SAMPLE_RATE
                last_speech_end_sec = 0.0
                speech_duration_sec = 0.0
                if has_speech:
                    last_speech_end_sec = speech_timestamps[-1]['end'] / SAMPLE_RATE
                    speech_duration_sec = sum(
                        timestamp["end"] - timestamp["start"]
                        for timestamp in speech_timestamps
                    ) / SAMPLE_RATE
                    
                silence_at_end_sec = total_duration_sec - last_speech_end_sec
                rms = float(np.sqrt(np.mean(np.square(accumulated_samples)))) if len(accumulated_samples) else 0.0
                rms_db = 20.0 * np.log10(max(rms, 0.0001))
                
                result = {
                    "has_speech": has_speech,
                    "total_duration": total_duration_sec,
                    "last_speech_end": last_speech_end_sec,
                    "silence_at_end": silence_at_end_sec,
                    "speech_duration": speech_duration_sec,
                    "speech_segments": len(speech_timestamps),
                    "rms_db": float(rms_db),
                }
                print(json.dumps(result), flush=True)
                
            elif action == "exit":
                break
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)

if __name__ == "__main__":
    main()
