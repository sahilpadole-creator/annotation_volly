# Inference Backend (Touch + 5-class Skill)

This backend enables UI buttons in `volleyball-annotator`:

- `Run Touch Model`
- `Run 5-class Skill`

The React app calls:

- `POST /api/infer/touch`
- `POST /api/infer/skill5`

## 1) Install

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2) Configure environment

Set these env vars before starting:

```bash
export TOUCH_PYTHON="/home/sahil/volleyball-pipeline-2/separated_modules/niraj/updated_vollyball/.venv/bin/python"
export TOUCH_SCRIPT="/home/sahil/volleyball-pipeline-2/separated_modules/niraj/updated_vollyball/evaluate_video.py"
export TOUCH_CHECKPOINT="/home/sahil/volleyball-pipeline-2/separated_modules/niraj/updated_vollyball/outputs/touch_1head_40clips_r80_r20_random4_31nt/checkpoints/best-epoch=09-val_touch_f1=0.827.ckpt"

export SKILL_PYTHON="/home/sahil/slowfast_touch_gpu_package/.venv/bin/python"
export SKILL_SCRIPT="/home/sahil/volleyball-pipeline-2/separated_modules/niraj/skill_sahil/infer_skill_on_peaks.py"
export SKILL_CONFIG="/home/sahil/volleyball-pipeline-2/separated_modules/niraj/skill_sahil/config/slowfast_skill_sahil_5class_16f.py"
export SKILL_CHECKPOINT="/home/sahil/volleyball-pipeline-2/separated_modules/niraj/skill_sahil/work_dirs/slowfast_skill_sahil_5class/best_acc_top1_epoch_28.pth"

# Optional for reception/dig post-rule in 5-class
export SKILL_GT_XML="/home/sahil/slowfast_touch_gpu_package/data/Women/annotations_224002.xml"
```

Set CORS origins (comma-separated) for deployed frontend:

```bash
export CORS_ORIGINS="https://sahilpadole-creator.github.io,http://localhost:5173"
```

## 3) Run API

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## 4) Frontend config

In React app env:

```bash
export VITE_INFERENCE_API_BASE="http://localhost:8000"
```

Then run Vite as usual.

---

## Deploy (same GitHub repo)

### Option A: Render (recommended)

This repo includes `render.yaml` and `backend/Dockerfile`.

1. Push repo changes to GitHub.
2. In Render: New -> Blueprint -> connect this repo.
3. Render will create `volleyball-annotator-inference`.
4. Set env vars from `backend/.env.example`.
5. Deploy and verify:

```bash
curl https://<your-render-service>.onrender.com/api/health
```

6. In frontend deployment env, set:

```bash
VITE_INFERENCE_API_BASE=https://<your-render-service>.onrender.com
```

### Option B: Railway

This repo includes `railway.json` and `backend/Dockerfile`.

1. Create new Railway project from this GitHub repo.
2. Add env vars from `backend/.env.example`.
3. Deploy and verify `/api/health`.
4. Set frontend:

```bash
VITE_INFERENCE_API_BASE=https://<your-railway-domain>
```

---

## Important production note

If you need real-time/fast inference, host on a machine with GPU (e.g., EC2 GPU or your existing inference box).
Render/Railway starter plans are typically CPU-only and may be too slow for full videos.
