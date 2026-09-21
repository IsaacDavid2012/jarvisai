import sys
import os
import json
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing input audio file"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"Audio file not found: {audio_path}"}))
        sys.exit(1)

    try:
        # Load local lightweight Whisper model on CPU (int8 quant)
        model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_path, beam_size=1)
        text = " ".join([s.text.strip() for s in segments]).strip()
        print(json.dumps({"text": text, "language": info.language, "duration": info.duration}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
