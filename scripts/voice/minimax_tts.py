import sys
import os
import json
import urllib.request
import binascii

def main():
    if len(sys.argv) < 3:
        print("ERROR: Missing text or output path")
        sys.exit(1)

    text = sys.argv[1]
    output_path = sys.argv[2]
    voice_id = sys.argv[3] if len(sys.argv) > 3 else "presenter_male"
    speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5

    api_key = os.environ.get("MINIMAX_API_KEY")
    api_host = os.environ.get("MINIMAX_API_HOST", "https://api.minimaxi.com")

    if not api_key:
        print("ERROR: Missing MINIMAX_API_KEY environment variable")
        sys.exit(1)

    url = f"{api_host}/v1/t2a_v2"
    payload = {
        "model": "speech-2.8-turbo",
        "text": text,
        "stream": False,
        "voice_setting": {
            "voice_id": voice_id,
            "speed": speed,
            "vol": 1.0,
            "pitch": 2,
            "emotion": "happy",
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
        },
        "output_format": "hex",
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req) as response:
            res_json = json.loads(response.read().decode("utf-8"))
            if res_json.get("base_resp", {}).get("status_code") == 0:
                audio_hex = res_json.get("data", {}).get("audio", "")
                if audio_hex:
                    with open(output_path, "wb") as output:
                        output.write(binascii.unhexlify(audio_hex))
                    print(f"SUCCESS: Audio written to {output_path}")
                else:
                    print("ERROR: No audio data in response")
                    sys.exit(1)
            else:
                msg = res_json.get("base_resp", {}).get("status_msg", "Unknown error")
                print(f"ERROR: MiniMax API failed: {msg}")
                sys.exit(1)
    except Exception as error:
        print(f"ERROR: Exception occurred: {str(error)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
