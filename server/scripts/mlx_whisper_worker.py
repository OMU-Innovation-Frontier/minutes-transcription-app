#!/usr/bin/env python3
"""Private JSON-lines bridge between the Node server and MLX Whisper."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import sys
import time
import wave
from pathlib import Path
from typing import Any

# A model identifier must never fall through to a Hub download. The Node side
# also verifies that --model is an existing directory before this process starts.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["PYTHONNOUSERSITE"] = "1"

import mlx.core as mx  # noqa: E402
import mlx_whisper  # noqa: E402
import numpy as np  # noqa: E402
from mlx_whisper.transcribe import ModelHolder  # noqa: E402


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def load_pcm16_wav(audio_path: str) -> np.ndarray[Any, np.dtype[np.float32]]:
    with wave.open(audio_path, "rb") as source:
        if (
            source.getnchannels() != 1
            or source.getsampwidth() != 2
            or source.getframerate() != 16_000
            or source.getcomptype() != "NONE"
        ):
            raise ValueError("unsupported WAV format")
        frames = source.readframes(source.getnframes())
    if not frames or len(frames) % 2 != 0:
        raise ValueError("invalid PCM16 data")
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def normalize_segments(raw_segments: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_segments, list):
        raise ValueError("invalid segments")
    segments: list[dict[str, Any]] = []
    for segment in raw_segments:
        if not isinstance(segment, dict):
            raise ValueError("invalid segment")
        start = float(segment["start"])
        end = float(segment["end"])
        text = str(segment["text"]).strip()
        if start < 0 or end < start:
            raise ValueError("invalid timestamp")
        segments.append({"startMs": round(start * 1000), "endMs": round(end * 1000), "text": text})
    return segments


def transcribe(model_path: str, request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    language = request.get("language")
    audio_path = request.get("audioPath")
    if not isinstance(request_id, str) or language not in {"ja", "en"} or not isinstance(audio_path, str):
        raise ValueError("invalid request")
    audio = load_pcm16_wav(audio_path)
    started_at = time.perf_counter()
    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=model_path,
        language=language,
        task="transcribe",
        fp16=True,
        verbose=False,
        condition_on_previous_text=False,
        word_timestamps=False,
    )
    processing_time_ms = (time.perf_counter() - started_at) * 1000
    return {
        "type": "result",
        "id": request_id,
        "text": str(result.get("text", "")).strip(),
        "segments": normalize_segments(result.get("segments")),
        "processingTimeMs": processing_time_ms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model", required=True)
    parser.add_argument("--package-version", required=True)
    args = parser.parse_args()
    model_path = str(Path(args.model).resolve(strict=True))
    if not Path(model_path).is_dir():
        return 2
    if importlib.metadata.version("mlx-whisper") != args.package_version:
        return 3

    # Populate mlx_whisper.transcribe.ModelHolder before accepting requests so
    # every utterance reuses one in-memory model.
    ModelHolder.get_model(model_path, mx.float16)
    emit({"type": "ready"})

    for line in sys.stdin:
        request: dict[str, Any] | None = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("invalid request")
            if request.get("type") == "close":
                return 0
            if request.get("type") != "transcribe":
                raise ValueError("invalid request")
            emit(transcribe(model_path, request))
        except Exception:
            request_id = request.get("id") if isinstance(request, dict) else None
            emit({"type": "error", "id": request_id, "code": "recognition_failed"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
