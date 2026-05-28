# Volleyball Batch Annotator

A client-side web application for annotating volleyball match videos. Allows annotators to mark skill events (toss, serve, reception, set, dig, attack/block) and rally boundaries, then export the annotations to XML format.

### Features
- **Batch Processing**: Load a playlist of videos (e.g. 187 rallies) and annotate sequentially.
- **Google Drive Integration**: Authenticate with Google and load video datasets directly from a shared Drive folder.
- **Batch Export**: Export all annotations to a single zipped file.
- **Hotkeys**: Keyboard-first design for rapid annotation.
- **Model-assisted annotation**: Import predictions JSON or run Touch / 5-class Skill via backend API.

## Backend deployment (same repo)

Backend files are under `backend/` with:

- `backend/main.py` (FastAPI)
- `backend/Dockerfile`
- `backend/.env.example`
- `render.yaml` (Render blueprint)
- `railway.json` (Railway config)

See full setup and env variables in `backend/README.md`.
