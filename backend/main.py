from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Volleyball Annotator Inference API")


def _cors_origins_from_env() -> list[str]:
    """
    CORS_ORIGINS can be:
      - "*" (allow all)
      - comma-separated list of origins
    """
    raw = os.getenv("CORS_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [x.strip() for x in raw.split(",") if x.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins_from_env(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise HTTPException(
            status_code=500,
            detail=f"Missing required env var: {name}. See backend/README.md for setup.",
        )
    return value


def _run(cmd: list[str], cwd: str | None = None) -> None:
    try:
        subprocess.run(cmd, cwd=cwd, check=True)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Command failed: {' '.join(cmd)}") from e


def _read_touch_peaks(pred_csv: Path) -> list[int]:
    peaks: list[int] = []
    with pred_csv.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if str(row.get("is_peak", "")).strip().lower() in {"1", "true"}:
                frame = row.get("frame_idx")
                if frame is None:
                    continue
                try:
                    peaks.append(int(float(frame)))
                except ValueError:
                    continue
    return sorted(set(peaks))


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "touch_configured": str(
            bool(os.getenv("TOUCH_PYTHON") and os.getenv("TOUCH_SCRIPT") and os.getenv("TOUCH_CHECKPOINT"))
        ).lower(),
        "skill5_configured": str(
            bool(
                os.getenv("SKILL_PYTHON")
                and os.getenv("SKILL_SCRIPT")
                and os.getenv("SKILL_CONFIG")
                and os.getenv("SKILL_CHECKPOINT")
            )
        ).lower(),
    }


@app.post("/api/infer/touch")
async def infer_touch(video: UploadFile = File(...)) -> dict[str, Any]:
    """
    Runs touch model and returns detected peak frames.
    Required env vars:
      TOUCH_PYTHON
      TOUCH_SCRIPT
      TOUCH_CHECKPOINT
    """
    touch_python = _require_env("TOUCH_PYTHON")
    touch_script = _require_env("TOUCH_SCRIPT")
    touch_checkpoint = _require_env("TOUCH_CHECKPOINT")
    device = os.getenv("TOUCH_DEVICE", "cuda")
    stride = os.getenv("TOUCH_STRIDE", "8")
    batch_size = os.getenv("TOUCH_BATCH_SIZE", "8")

    with tempfile.TemporaryDirectory(prefix="annotator_touch_") as td:
        tmp = Path(td)
        video_path = tmp / (video.filename or "input.mp4")
        pred_csv = tmp / "touch_pred.csv"
        with video_path.open("wb") as f:
            shutil.copyfileobj(video.file, f)

        cmd = [
            touch_python,
            touch_script,
            touch_checkpoint,
            str(video_path),
            "--output-csv",
            str(pred_csv),
            "--device",
            device,
            "--stride",
            stride,
            "--batch-size",
            batch_size,
        ]
        _run(cmd)
        if not pred_csv.is_file():
            raise HTTPException(status_code=500, detail="Touch inference completed but no CSV output was found.")
        peaks = _read_touch_peaks(pred_csv)
        return {
            "video_name": video.filename or "input.mp4",
            "touch_peaks": peaks,
            "pred_csv_rows": sum(1 for _ in pred_csv.open(encoding="utf-8")) - 1,
        }


@app.post("/api/infer/skill5")
async def infer_skill5(video: UploadFile = File(...)) -> dict[str, Any]:
    """
    Runs touch + 5-class skill and returns predictions compatible with App import.
    Required env vars:
      TOUCH_PYTHON, TOUCH_SCRIPT, TOUCH_CHECKPOINT
      SKILL_PYTHON, SKILL_SCRIPT, SKILL_CONFIG, SKILL_CHECKPOINT
    Optional:
      SKILL_GT_XML (for reception/dig post-rule)
    """
    touch_python = _require_env("TOUCH_PYTHON")
    touch_script = _require_env("TOUCH_SCRIPT")
    touch_checkpoint = _require_env("TOUCH_CHECKPOINT")

    skill_python = _require_env("SKILL_PYTHON")
    skill_script = _require_env("SKILL_SCRIPT")
    skill_config = _require_env("SKILL_CONFIG")
    skill_checkpoint = _require_env("SKILL_CHECKPOINT")
    skill_gt_xml = os.getenv("SKILL_GT_XML", "").strip()

    touch_device = os.getenv("TOUCH_DEVICE", "cuda")
    touch_stride = os.getenv("TOUCH_STRIDE", "8")
    touch_batch_size = os.getenv("TOUCH_BATCH_SIZE", "8")

    with tempfile.TemporaryDirectory(prefix="annotator_skill5_") as td:
        tmp = Path(td)
        video_path = tmp / (video.filename or "input.mp4")
        pred_csv = tmp / "touch_pred.csv"
        skill_json = tmp / "skill5_preds.json"
        with video_path.open("wb") as f:
            shutil.copyfileobj(video.file, f)

        touch_cmd = [
            touch_python,
            touch_script,
            touch_checkpoint,
            str(video_path),
            "--output-csv",
            str(pred_csv),
            "--device",
            touch_device,
            "--stride",
            touch_stride,
            "--batch-size",
            touch_batch_size,
        ]
        _run(touch_cmd)

        skill_cmd = [
            skill_python,
            skill_script,
            "--video",
            str(video_path),
            "--pred-csv",
            str(pred_csv),
            "--config",
            skill_config,
            "--checkpoint",
            skill_checkpoint,
            "--output-json",
            str(skill_json),
            "--five-class",
        ]
        if skill_gt_xml:
            skill_cmd.extend(["--gt-xml", skill_gt_xml])
        _run(skill_cmd)

        if not skill_json.is_file():
            raise HTTPException(status_code=500, detail="Skill inference completed but no JSON output was found.")
        raw = json.loads(skill_json.read_text(encoding="utf-8"))
        predictions = [{"frame": int(x["frame"]), "label": str(x["skill"])} for x in raw]
        return {
            "video_name": video.filename or "input.mp4",
            "predictions": predictions,
        }
