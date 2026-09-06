#!/usr/bin/env python3
"""Offline faster-whisper runner for saved local media. It never downloads a model."""
import argparse
import json
import os
import sys
from pathlib import Path

def stamp(seconds: float, separator: str = ".") -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, rest = divmod(milliseconds, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}{separator}{millis:03}"

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output-json")
    parser.add_argument("--output-srt")
    parser.add_argument("--output-md")
    parser.add_argument("--model", default=os.environ.get("CONTENT_ASR_MODEL", ""))
    parser.add_argument("--language")
    args = parser.parse_args()
    try:
        from faster_whisper import WhisperModel
        import faster_whisper
    except Exception as error:
        print(f"faster-whisper is unavailable: {error}", file=sys.stderr)
        return 2
    if args.probe:
        print(f"faster-whisper {getattr(faster_whisper, '__version__', 'available')}")
        return 0
    if not args.input or not args.output_json or not args.output_srt or not args.output_md:
        print("input and all output paths are required", file=sys.stderr)
        return 2
    source = Path(args.input)
    model = Path(args.model) if args.model else None
    if not source.is_file():
        print("input media file is missing", file=sys.stderr)
        return 2
    if model is None or not model.exists():
        print("offline ASR model is missing; set CONTENT_ASR_MODEL to an existing local faster-whisper model directory", file=sys.stderr)
        return 3
    try:
        engine = WhisperModel(str(model), local_files_only=True)
        segments, info = engine.transcribe(str(source), language=args.language or None, vad_filter=True, word_timestamps=False)
        items = [{"startMs": round(segment.start * 1000), "endMs": round(segment.end * 1000), "text": segment.text.strip()} for segment in segments if segment.text.strip()]
        language = getattr(info, "language", None)
        payload = {"language": language, "segments": items, "engine": "faster-whisper"}
        for output in [args.output_json, args.output_srt, args.output_md]:
            Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output_json).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        Path(args.output_srt).write_text("\n\n".join(f"{index}\n{stamp(item['startMs'] / 1000, ',')} --> {stamp(item['endMs'] / 1000, ',')}\n{item['text']}" for index, item in enumerate(items, 1)) + ("\n" if items else ""), encoding="utf-8")
        lines = ["# 机器语音转写", "", f"语言：{language or '未识别'}", ""]
        lines.extend(f"- [{stamp(item['startMs'] / 1000)} – {stamp(item['endMs'] / 1000)}] {item['text']}" for item in items)
        Path(args.output_md).write_text("\n".join(lines) + "\n", encoding="utf-8")
        return 0
    except Exception as error:
        print(f"ASR failed: {error}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
