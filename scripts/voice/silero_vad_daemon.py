import sys
import json
import base64
import warnings

warnings.filterwarnings("ignore")

import torch
import numpy as np

def main():
    try:
        from silero_vad import load_silero_vad, get_speech_timestamps
        model = load_silero_vad()
    except Exception as error:
        print(json.dumps({"error": f"Failed to load VAD model: {str(error)}"}))
        sys.exit(1)

    print(json.dumps({"status": "ready"}), flush=True)
    accumulated_samples = []

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
                accumulated_samples = []
                print(json.dumps({"status": "reset"}), flush=True)
                continue
            if action == "chunk":
                pcm_bytes = base64.b64decode(req.get("data", ""))
                chunk_samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                accumulated_samples.extend(chunk_samples)
                audio_tensor = torch.from_numpy(np.array(accumulated_samples, dtype=np.float32))
                speech_timestamps = get_speech_timestamps(audio_tensor, model, sampling_rate=16000, threshold=0.45)
                has_speech = len(speech_timestamps) > 0
                total_duration_sec = len(audio_tensor) / 16000.0
                last_speech_end_sec = speech_timestamps[-1]["end"] / 16000.0 if has_speech else 0.0
                print(json.dumps({
                    "has_speech": has_speech,
                    "total_duration": total_duration_sec,
                    "last_speech_end": last_speech_end_sec,
                    "silence_at_end": total_duration_sec - last_speech_end_sec,
                }), flush=True)
            elif action == "exit":
                break
        except Exception as error:
            print(json.dumps({"error": str(error)}), flush=True)

if __name__ == "__main__":
    main()
