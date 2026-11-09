#!/usr/bin/env python3
"""
analyse.py — measurable audio properties, printed as JSON.

Design notes that matter:

**Numbers, not adjectives.** A caller asking "what does this sound like" can do
something with `centroidHz: 1230`; "bright and lively" cannot be checked or
compared. Every field below is computed, none is inferred from a genre guess.

**The file is decoded by the caller-provided path only.** No network access, no
model downloads; librosa loads the file with soundfile/audioread and nothing
leaves the machine.

**Sections are energy-based, not structural.** Splitting a track into "intro /
verse / chorus" needs a learned model. What this reports is where the loudness
changed, labelled by position and level, so the reader can decide what those
changes mean.
"""

import json
import sys
import warnings

warnings.filterwarnings("ignore")

# numpy/librosa print nothing on success; anything they do print is noise that
# would corrupt the JSON on stdout.
import os
os.environ.setdefault("PYTHONWARNINGS", "ignore")


def fail(message, code="error"):
    print(json.dumps({"ok": False, "error": message, "code": code}, ensure_ascii=False))
    sys.exit(0)


def main():
    if len(sys.argv) < 2:
        fail("用法: analyse.py <音频文件>", "no-input")

    path = sys.argv[1]

    try:
        import numpy as np
        import librosa
    except Exception as error:  # noqa: BLE001 - surfaced to the caller verbatim
        fail(f"缺少依赖: {error}。安装：pip install librosa soundfile", "missing-dependency")

    try:
        # mono + 22050 Hz is enough for every metric below and keeps a long file
        # from consuming seconds of decode time.
        y, sr = librosa.load(path, sr=22050, mono=True)
    except Exception as error:  # noqa: BLE001
        fail(f"无法解码音频: {error}", "decode-failed")

    if y.size == 0:
        fail("音频为空", "empty-audio")

    duration = float(librosa.get_duration(y=y, sr=sr))
    result = {
        "ok": True,
        "file": path,
        "duration": round(duration, 3),
        "sampleRate": int(sr),
        "samples": int(y.size),
    }

    # ---- loudness ---------------------------------------------------------
    # RMS in dBFS is not LUFS; the caller gets both a rough overall level and a
    # peak so it can tell "quiet recording" from "quiet master".
    rms = float(np.sqrt(np.mean(y ** 2)))
    peak = float(np.max(np.abs(y)))
    result["dynamics"] = {
        "rmsDb": round(20 * np.log10(rms) if rms > 0 else -120.0, 2),
        "peakDb": round(20 * np.log10(peak) if peak > 0 else -120.0, 2),
        "crestDb": round(20 * np.log10(peak / rms) if rms > 0 and peak > 0 else 0.0, 2),
    }

    # ---- tempo ------------------------------------------------------------
    try:
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
        beat_times = librosa.frames_to_time(beats, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        # Regularity: how evenly spaced the detected beats are. A human drummer
        # and a click track differ here even at the same BPM.
        intervals = np.diff(beat_times) if beat_times.size > 1 else np.array([])
        regularity = 0.0
        if intervals.size > 1:
            mean_interval = float(np.mean(intervals))
            regularity = round(1.0 - min(1.0, float(np.std(intervals)) / mean_interval), 3) if mean_interval > 0 else 0.0

        # A detected BPM of zero means "no periodic beat found", which is a real
        # answer for ambient beds, field recordings and speech — not a failure.
        # Reporting it as a number would invite the caller to treat 0 BPM as a
        # tempo reading, so the field says what happened instead.
        if bpm <= 0.0 or beat_times.size == 0:
            result["tempo"] = {
                "bpm": None,
                "beats": 0,
                "regularity": None,
                "detected": False,
                "note": "未检测到周期性节拍（可能是环境声、人声或自由节奏）",
            }
        else:
            result["tempo"] = {
                "bpm": round(bpm, 2),
                "beats": int(beat_times.size),
                "regularity": regularity,
                "detected": True,
                "firstBeats": [round(float(t), 3) for t in beat_times[:12]],
            }
    except Exception as error:  # noqa: BLE001
        result["tempo"] = {"error": str(error)}

    # ---- tonality ---------------------------------------------------------
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        profile = chroma.mean(axis=1)
        names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        order = np.argsort(profile)[::-1]
        # Major and minor are told apart by the third: a major third sits four
        # semitones above the root, a minor third three.
        root_index = int(order[0])
        third_major = (root_index + 4) % 12
        third_minor = (root_index + 3) % 12
        mode = "major" if profile[third_major] >= profile[third_minor] else "minor"
        result["tonality"] = {
            "root": names[root_index],
            "mode": mode,
            "estimatedKey": f"{names[root_index]} {mode}",
            "chroma": {names[i]: round(float(profile[i]), 4) for i in range(12)},
            "topPitches": [names[int(i)] for i in order[:5]],
        }
    except Exception as error:  # noqa: BLE001
        result["tonality"] = {"error": str(error)}

    # ---- timbre -----------------------------------------------------------
    try:
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
        rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr, roll_percent=0.85)
        zcr = librosa.feature.zero_crossing_rate(y)
        bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr)
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
        result["timbre"] = {
            # High centroid = bright; low = dark. Comparable across files.
            "centroidHz": round(float(np.mean(centroid)), 1),
            "rolloffHz": round(float(np.mean(rolloff)), 1),
            "bandwidthHz": round(float(np.mean(bandwidth)), 1),
            # High ZCR suggests noise or percussion; low suggests sustained tone.
            "zeroCrossRate": round(float(np.mean(zcr)), 5),
            "mfcc": [round(float(v), 2) for v in mfcc.mean(axis=1)],
        }
    except Exception as error:  # noqa: BLE001
        result["timbre"] = {"error": str(error)}

    # ---- sections ---------------------------------------------------------
    # Energy per second, then report where it changed noticeably. This is a
    # measurement, not a structural analysis: it says "quieter from 24s", not
    # "chorus starts at 24s".
    try:
        hop = 512
        rms_frames = librosa.feature.rms(y=y, hop_length=hop)[0]
        frame_times = librosa.frames_to_time(np.arange(rms_frames.size), sr=sr, hop_length=hop)
        per_second = []
        if duration > 0:
            for second in range(int(np.ceil(duration))):
                mask = (frame_times >= second) & (frame_times < second + 1)
                value = float(np.mean(rms_frames[mask])) if np.any(mask) else 0.0
                per_second.append(value)
        if per_second:
            peak_level = max(per_second) or 1.0
            normalised = [round(v / peak_level, 3) for v in per_second]
            sections = []
            last_level = None
            for second, level in enumerate(normalised):
                bucket = "quiet" if level < 0.25 else "medium" if level < 0.66 else "loud"
                if bucket != last_level:
                    sections.append({"at": second, "level": bucket, "energy": level})
                    last_level = bucket
            result["sections"] = sections
            result["energyPerSecond"] = normalised
    except Exception as error:  # noqa: BLE001
        result["sections"] = {"error": str(error)}

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
