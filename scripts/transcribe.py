#!/usr/bin/env python3
"""
transcribe.py — local speech recognition through faster-whisper.

Why the audio arrives as a decoded array rather than a path:

faster-whisper 1.2.1 opens files through PyAV with
`av.open(path, metadata_errors="ignore")`. The PyAV build installable alongside
it here does not accept that keyword, so passing a path raises
`TypeError: open() got an unexpected keyword argument 'metadata_errors'`.
Handing it a float32 numpy array skips PyAV and the decode path entirely.

Output is one JSON object on stdout. Progress and model-download chatter go to
stderr so they cannot corrupt it.
"""

import json
import os
import sys
import wave

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


def fail(message, code="error"):
    print(json.dumps({"ok": False, "error": message, "code": code}, ensure_ascii=False))
    sys.exit(0)


def main():
    if len(sys.argv) < 4:
        fail("用法: transcribe.py <wav文件> <模型> <语种>", "no-input")

    path, model_name, language = sys.argv[1], sys.argv[2], sys.argv[3]

    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except Exception as error:  # noqa: BLE001
        fail(f"缺少依赖: {error}。安装：pip install faster-whisper", "missing-dependency")

    try:
        with wave.open(path, "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            raw = handle.readframes(frames)
    except Exception as error:  # noqa: BLE001
        fail(f"无法读取 wav: {error}", "decode-failed")

    if width != 2:
        fail(f"只支持 16-bit PCM，实际 {width * 8}-bit", "unsupported-format")

    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    try:
        # int8 keeps a CPU-only run practical; the accuracy difference for
        # transcription is small and this is the default people can afford.
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
    except Exception as error:  # noqa: BLE001
        fail(
            f"加载模型 {model_name} 失败: {error}。若为网络问题，设置 HF_ENDPOINT=https://hf-mirror.com",
            "model-load-failed",
        )

    try:
        segments, info = model.transcribe(
            audio,
            language=None if language in ("", "auto") else language,
            vad_filter=True,
            beam_size=5,
        )
        collected = []
        for segment in segments:
            collected.append({
                "start": round(float(segment.start), 2),
                "end": round(float(segment.end), 2),
                "text": (segment.text or "").strip(),
            })
    except Exception as error:  # noqa: BLE001
        fail(f"识别失败: {error}", "transcribe-failed")

    text = "".join(item["text"] for item in collected).strip()
    print(json.dumps({
        "ok": True,
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 3),
        "audioSeconds": round(len(audio) / rate, 2),
        "segments": collected,
        "text": text,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
