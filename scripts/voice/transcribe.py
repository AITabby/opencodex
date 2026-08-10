import sys
import os
import warnings

warnings.filterwarnings("ignore")

try:
    import whisper

    if len(sys.argv) < 2:
        print("ERROR: Missing audio file path")
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"ERROR: File not found: {audio_path}")
        sys.exit(1)

    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].strip() else "base"
    model = whisper.load_model(model_name)
    result = model.transcribe(audio_path, fp16=False)
    print(result.get("text", "").strip())
except Exception as error:
    print(f"ERROR: {str(error)}")
    sys.exit(1)
