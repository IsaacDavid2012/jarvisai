const { execFile, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { MessageMedia } = require("whatsapp-web.js");

const PIPER_BIN = path.join(__dirname, "voice", "bin", "piper", "piper");
const PIPER_MODEL = path.join(__dirname, "voice", "models", "en_GB-alan-medium.onnx");
const TRANSCRIBE_SCRIPT = path.join(__dirname, "voice", "transcribe.py");
const TMP_DIR = path.join(__dirname, "voice", "tmp");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * Transcribe an audio file using faster-whisper on CPU
 * @param {string} audioPath - Path to audio file (.ogg, .opus, .wav, etc.)
 * @returns {Promise<string>} - Transcribed text
 */
function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    execFile("python3", [TRANSCRIBE_SCRIPT, audioPath], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("Transcription error:", err.message, stderr);
        return reject(err);
      }
      try {
        const res = JSON.parse(stdout.trim());
        if (res.error) {
          return reject(new Error(res.error));
        }
        resolve(res.text || "");
      } catch (parseErr) {
        reject(new Error(`Failed to parse transcription output: ${stdout}`));
      }
    });
  });
}

/**
 * Synthesize text to speech using local Piper TTS, convert to WhatsApp-compatible Opus
 * @param {string} text - Text to speak
 * @returns {Promise<MessageMedia>} - MessageMedia ready to send with sendAudioAsVoice: true
 */
function synthesizeSpeechToMedia(text) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const cleanText = text
      .replace(/[*_~`#]/g, "") // strip markdown
      .replace(/https?:\/\/\S+/g, "link")
      .replace(/[\n\r]+/g, " ")
      .trim();

    if (!cleanText) {
      return reject(new Error("Cannot synthesize empty text"));
    }

    const mp3Path = path.join(TMP_DIR, `speech_${timestamp}.mp3`);
    const opusPath = path.join(TMP_DIR, `speech_${timestamp}.opus`);

    // Primary: Edge-TTS British neural voice (en-GB-RyanNeural)
    const escaped = cleanText.replace(/"/g, '\\"');
    exec(`edge-tts --voice en-GB-RyanNeural --text "${escaped}" --write-media "${mp3Path}"`, { timeout: 15000 }, (edgeErr) => {
      if (!edgeErr && fs.existsSync(mp3Path)) {
        exec(`ffmpeg -y -i "${mp3Path}" -c:a libopus -b:a 32k -vbr on "${opusPath}"`, (ffmpegErr) => {
          fs.unlink(mp3Path, () => {});
          if (!ffmpegErr && fs.existsSync(opusPath)) {
            try {
              const media = MessageMedia.fromFilePath(opusPath);
              media.filesize = fs.statSync(opusPath).size;
              fs.unlink(opusPath, () => {});
              return resolve(media);
            } catch (rErr) {
              fs.unlink(opusPath, () => {});
            }
          }
          // Fallback to piper if ffmpeg on mp3 failed
          fallbackPiper();
        });
      } else {
        // Fallback to Piper if edge-tts failed
        fallbackPiper();
      }
    });

    function fallbackPiper() {
      const wavPath = path.join(TMP_DIR, `speech_fb_${timestamp}.wav`);
      const piperProcess = execFile(
        PIPER_BIN,
        ["--model", PIPER_MODEL, "--output_file", wavPath],
        { timeout: 20000 },
        (piperErr) => {
          if (piperErr) {
            console.error("Piper TTS fallback error:", piperErr.message);
            return reject(piperErr);
          }
          exec(`ffmpeg -y -i "${wavPath}" -c:a libopus -b:a 32k -vbr on "${opusPath}"`, (ffmpegErr) => {
            fs.unlink(wavPath, () => {});
            if (ffmpegErr) return reject(ffmpegErr);
            try {
              const media = MessageMedia.fromFilePath(opusPath);
              media.filesize = fs.statSync(opusPath).size;
              fs.unlink(opusPath, () => {});
              resolve(media);
            } catch (readErr) {
              fs.unlink(opusPath, () => {});
              reject(readErr);
            }
          });
        }
      );
      piperProcess.stdin.write(cleanText);
      piperProcess.stdin.end();
    }
  });
}

module.exports = {
  transcribeAudio,
  synthesizeSpeechToMedia
};
