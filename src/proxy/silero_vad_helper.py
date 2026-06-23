import sys
import os
import json
import warnings

# Suppress PyTorch warnings
warnings.filterwarnings("ignore")

import torch
import torchaudio

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing wav path"}))
        sys.exit(1)
        
    wav_path = sys.argv[1]
    if not os.path.exists(wav_path):
        print(json.dumps({"error": "File not found"}))
        sys.exit(1)
        
    try:
        from silero_vad import load_silero_vad, get_speech_timestamps
        model = load_silero_vad()
        
        # Load audio (Silero VAD expects 16000Hz mono)
        wav, sr = torchaudio.load(wav_path)
        if sr != 16000:
            transform = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)
            wav = transform(wav)
            sr = 16000
            
        if wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
            
        wav = wav.squeeze(0)
        
        # get speech timestamps
        speech_timestamps = get_speech_timestamps(wav, model, sampling_rate=16000, threshold=0.45)
        
        has_speech = len(speech_timestamps) > 0
        
        # Calculate duration of silence at the end
        total_duration_samples = len(wav)
        total_duration_sec = total_duration_samples / 16000.0
        
        last_speech_end_sec = 0.0
        if has_speech:
            # speech_timestamps is list of dicts with 'start' and 'end' in samples
            last_speech_end_sec = speech_timestamps[-1]['end'] / 16000.0
            
        silence_at_end_sec = total_duration_sec - last_speech_end_sec
        
        result = {
            "has_speech": has_speech,
            "total_duration": total_duration_sec,
            "last_speech_end": last_speech_end_sec,
            "silence_at_end": silence_at_end_sec,
            "timestamps": [{"start": t["start"]/16000.0, "end": t["end"]/16000.0} for t in speech_timestamps]
        }
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
