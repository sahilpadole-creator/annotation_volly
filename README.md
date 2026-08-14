# Volleyball Annotation Review Tool

Browser-based review and correction tool for precomputed volleyball annotations.

Hosted app: https://sahilpadole-creator.github.io/annotation_volly/

## Features

- **Batch Processing**: Load a playlist of videos (e.g., 187 rallies) and annotate sequentially.
- **Batch Export**: Export all annotations to a single zipped file, natively compatible with custom XML pipelines.
- **Hotkeys & Ergonomics**: Keyboard-first design for rapid annotation and exact frame-accurate video navigation.
- **Offline review**: Upload a ZIP containing matching video and XML/JSON prediction files, correct mistakes, and download updated annotations.
- **Private by design**: On GitHub Pages, files stay in the browser and are never uploaded to a server.
- **Local inference only**: Model inference is available only in the owner's local development setup. No weights or inference backend are published here.
- **Tracking JSON Bypass Pipeline**: Bypass heavy SlowFast detection by reusing offline tracks (e.g., BoTSORT), vastly speeding up processing.

## Architecture

The public repository and GitHub Pages deployment contain only the React/Vite review frontend.

### Frontend (Client-side)
Located in the root directory. Built with React 19, TypeScript, and Vite.
- Run `npm install`
- Run `npm run dev` to start the frontend.
- Hotkeys are mapped for standard skills (Toss, Serve, Reception, Set, Dig, Attack, Block).

### Hosted review workflow
1. Run inference on the owner's local tool.
2. Put each video and its matching XML/JSON annotation file in a ZIP.
3. Open the hosted app and select the required annotation mode.
4. Upload the ZIP, review/correct annotations, and download the updated result.

The hosted build never calls a localhost inference API.

## Deployment

Deploy the frontend to GitHub Pages with `npm run deploy`.
