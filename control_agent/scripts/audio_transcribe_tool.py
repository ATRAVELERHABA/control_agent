from __future__ import annotations

import argparse
import json
import sys


def load_whisper_model():
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Missing dependency. Install `faster-whisper` in control_agent/.venv first."
        ) from exc

    return WhisperModel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language")
    parser.add_argument("--prompt")
    args = parser.parse_args()

    WhisperModel = load_whisper_model()
    model = WhisperModel(args.model, device="auto", compute_type="auto")
    segments, info = model.transcribe(
        args.path,
        language=args.language or None,
        initial_prompt=args.prompt or None,
    )

    text = "".join(segment.text for segment in segments).strip()
    json.dump(
        {
            "text": text,
            "language": getattr(info, "language", None),
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
