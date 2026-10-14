#!/usr/bin/env python3
"""Offline faster-whisper runner for saved local media. It never downloads a model."""
import argparse
import json
import math
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
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--compute-type", choices=["default", "auto", "int8", "int8_float16", "int8_float32", "float16", "float32"])
    parser.add_argument("--hotwords")
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
        engine_options = {"local_files_only": True, "device": args.device}
        if args.compute_type:
            engine_options["compute_type"] = args.compute_type
        engine = WhisperModel(str(model), **engine_options)
        segments, info = engine.transcribe(str(source), language=args.language or None, vad_filter=True, word_timestamps=True, hotwords=args.hotwords or None)
        duration = float(info.duration)
        duration_source = "decoded_audio"
        # Decoder padding can exceed the container's final timestamp. Bound cues to
        # the real local media duration instead of publishing padded model times.
        try:
            import av
            with av.open(str(source)) as container:
                if container.duration is not None and container.duration > 0:
                    duration = min(duration, container.duration / av.time_base)
                    duration_source = "container_and_decoded_audio"
        except Exception:
            pass
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("media duration must be positive and finite")
        duration_ms = math.floor(duration * 1000)
        items = []
        adjustments = []
        previous_end = 0
        for index, segment in enumerate(segments, 1):
            text = segment.text.strip()
            if not text:
                continue
            if not math.isfinite(segment.start) or not math.isfinite(segment.end):
                raise ValueError("speech timestamps must be finite")
            original_start = round(segment.start * 1000)
            original_end = round(segment.end * 1000)
            start_ms = max(0, min(duration_ms, original_start))
            end_ms = max(0, min(duration_ms, original_end))
            if start_ms < previous_end or end_ms <= start_ms:
                raise ValueError("speech timestamps must be ordered with positive ranges")
            if (start_ms, end_ms) != (original_start, original_end):
                adjustments.append({"segment": index, "originalStartMs": original_start, "originalEndMs": original_end, "startMs": start_ms, "endMs": end_ms})
            item = {"startMs": start_ms, "endMs": end_ms, "text": text}
            for source_name, output_name in [("avg_logprob", "avgLogProbability"), ("no_speech_prob", "noSpeechProbability")]:
                value = getattr(segment, source_name, None)
                if value is not None and math.isfinite(value):
                    item[output_name] = value
            words = []
            for word in getattr(segment, "words", None) or []:
                word_start = max(start_ms, min(end_ms, round(word.start * 1000)))
                word_end = max(start_ms, min(end_ms, round(word.end * 1000)))
                if word_end <= word_start:
                    continue
                words.append({"startMs": word_start, "endMs": word_end, "text": word.word, "probability": word.probability})
            item["words"] = words
            items.append(item)
            previous_end = end_ms
        if not items:
            raise ValueError("no non-empty speech segments were recognized")
        language = getattr(info, "language", None)
        runtime = getattr(engine, "model", None)
        payload = {"language": language, "requestedLanguage": args.language, "segments": items, "engine": "faster-whisper", "engineVersion": getattr(faster_whisper, "__version__", None), "model": model.name, "device": getattr(runtime, "device", args.device), "computeType": getattr(runtime, "compute_type", args.compute_type or "default"), "requestedComputeType": args.compute_type, "hotwords": args.hotwords, "provenance": "machine_asr", "durationMs": duration_ms, "durationSource": duration_source, "timestampAdjustments": adjustments}
        for output in [args.output_json, args.output_srt, args.output_md]:
            Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output_json).write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        Path(args.output_srt).write_text("\n\n".join(f"{index}\n{stamp(item['startMs'] / 1000, ',')} --> {stamp(item['endMs'] / 1000, ',')}\n{item['text']}" for index, item in enumerate(items, 1)) + ("\n" if items else ""), encoding="utf-8")
        lines = ["# 机器语音转写", "", f"语言：{language or '未识别'}", "来源：machine_asr（本地机器语音识别，未经人工校对）", f"工具：faster-whisper；模型：{model.name}", ""]
        if args.hotwords:
            lines.extend([f"识别提示：{args.hotwords}", "（本次词汇提示仅辅助本地识别，输出原句未作人工替换。）", ""])
        lines.extend(f"- [{stamp(item['startMs'] / 1000)} – {stamp(item['endMs'] / 1000)}] {item['text']}" for item in items)
        Path(args.output_md).write_text("\n".join(lines) + "\n", encoding="utf-8")
        return 0
    except Exception as error:
        print(f"ASR failed: {error}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
