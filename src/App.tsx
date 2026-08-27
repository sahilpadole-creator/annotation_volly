import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Upload, Download, Settings, Trash2, AlertTriangle, AlertCircle, FileVideo, ArrowRight, ArrowLeft, CheckCircle, Eye, EyeOff, Maximize, Minimize, MousePointer2, Search, Pencil, Zap } from 'lucide-react';
import type { AppState, SkillLabel, PlaylistItem, SkillEvent, PlayerBox, InferenceVideoMeta, Rally, VideoMetadata } from './types';
import { exportAllToZip, generateXMLString, getXmlExportFilename, getBatchZipFilename, normalizeAnnotationStem, annotationKeysMatch } from './utils/exportUtils';
import { detectVideoFps } from './utils/fpsUtils';
import { applyBallPostprocess } from './utils/ballPostprocess';
import { parseZIPAnnotations, parseXMLAnnotations, parseJSONAnnotations, extendPlayerBoxesToFrameCount } from './utils/importUtils';
import {
  APP_MODE_STORAGE_KEY,
  EMPTY_APP_STATE,
  isItemAlgorithmApplied,
  isTouchFamilyMode,
  loadWorkflowState,
  persistWorkflowState,
  withAlgorithmApplied,
  workflowFromAppMode,
  type WorkflowMode,
} from './utils/workflowMode';
import { VNL_LABEL_DEFS } from './utils/vnlAnnotation';
import {
  computeVnlFolderKey,
  findStoredVnlItem,
  getVnlFolderLabelFromFiles,
  loadActiveVnlFolder,
  loadVnlFolder,
  persistVnlFolder,
  storedFolderToAppState,
} from './utils/vnlBrowserStorage';
import {
  buildAttackBlockProgress,
  computeTouchBlockFolderKey,
  findNextPendingAttackFrame,
  findStoredTouchBlockItem,
  getTouchBlockFolderLabelFromFiles,
  loadActiveTouchBlockFolder,
  loadTouchBlockFolder,
  mergeTouchBlockEvents,
  persistTouchBlockFolder,
  storedTouchBlockFolderToAppState,
} from './utils/touchBlockBrowserStorage';
import { applySixSkillPostprocess, SKILL_CLASS_IDS } from './utils/skillPostprocess';
import { ensureGpuH264File, ensureBrowserPlayableViaWasm, looksLikeH264Filename } from './utils/videoPreview';
import { getCachedH264 } from './utils/h264BrowserCache';
import VolleyballParticles from './components/VolleyballParticles';
import BlockClipAnnotator from './components/BlockClipAnnotator';
import './index.css';

const SKILL_MAP: Record<string, { label: SkillLabel; classId: number }> = {
  '1': { label: 'toss', classId: SKILL_CLASS_IDS.toss },
  '2': { label: 'serve', classId: SKILL_CLASS_IDS.serve },
  '3': { label: 'reception', classId: SKILL_CLASS_IDS.reception },
  '4': { label: 'set', classId: SKILL_CLASS_IDS.set },
  '5': { label: 'dig', classId: SKILL_CLASS_IDS.dig },
  '6': { label: 'attack', classId: SKILL_CLASS_IDS.attack },
  '7': { label: 'block', classId: SKILL_CLASS_IDS.block },
};

const LABEL_TO_SKILL: Record<string, { label: SkillLabel; classId: number }> = {
  toss: { label: 'toss', classId: SKILL_CLASS_IDS.toss },
  serve: { label: 'serve', classId: SKILL_CLASS_IDS.serve },
  reception: { label: 'reception', classId: SKILL_CLASS_IDS.reception },
  receive: { label: 'reception', classId: SKILL_CLASS_IDS.reception },
  'reception/dig': { label: 'reception', classId: SKILL_CLASS_IDS.reception },
  set: { label: 'set', classId: SKILL_CLASS_IDS.set },
  dig: { label: 'dig', classId: SKILL_CLASS_IDS.dig },
  attack: { label: 'attack', classId: SKILL_CLASS_IDS.attack },
  block: { label: 'block', classId: SKILL_CLASS_IDS.block },
  'attack/block': { label: 'attack', classId: SKILL_CLASS_IDS.attack },
  score: { label: 'score', classId: 7 },
  spike: { label: 'attack', classId: SKILL_CLASS_IDS.attack },
  touch: { label: 'touch', classId: SKILL_CLASS_IDS.touch },
};

type PredictionLike = { frame?: number | string; label?: string; skill?: string; class_id?: number; confidence?: number };
type PredictionImportPayload = {
  video_name?: string;
  predictions?: PredictionLike[];
  events?: PredictionLike[];
  rally?: { start_frame?: number | null; end_frame?: number | null };
  start_frame?: number;
  end_frame?: number;
  video_fps?: number;
};

const INFERENCE_API_BASE = import.meta.env.VITE_INFERENCE_API_BASE || 'http://localhost:8000';
const OFFLINE_REVIEW_ONLY =
  import.meta.env.VITE_OFFLINE_REVIEW_ONLY === 'true' ||
  window.location.hostname.endsWith('.github.io');

type AssignPlayerResult = {
  frame?: number | string;
  track_ids?: (number | string)[];
  touch_player?: string;
  pred_box_xyxy?: number[] | null;
  candidates?: { tid?: number | string; box?: number[]; [key: string]: unknown }[];
};

const parseTouchPlayerId = (touchPlayer: unknown): number | undefined => {
  if (typeof touchPlayer !== 'string' || !touchPlayer.trim()) return undefined;
  const match = touchPlayer.match(/t?(\d+)/i);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isNaN(id) ? undefined : id;
};

const extractAssignedTrackId = (assignment: AssignPlayerResult | undefined): number | undefined => {
  if (!assignment) return undefined;
  if (assignment.track_ids && assignment.track_ids.length > 0) {
    const id = Number(assignment.track_ids[0]);
    if (!Number.isNaN(id)) return id;
  }
  return parseTouchPlayerId(assignment.touch_player);
};

const findAssignmentForFrame = (assignEvents: AssignPlayerResult[], frame: number) =>
  assignEvents.find((e) => Number(e.frame) === Number(frame));

/** Match OpenCV frame indexing: frame N starts at time N/fps. */
const timeToFrame = (timeSec: number, fps: number, maxFrame?: number): number => {
  const frame = Math.floor(timeSec * fps + 1e-4);
  if (maxFrame !== undefined) return Math.max(0, Math.min(frame, maxFrame));
  return Math.max(0, frame);
};

const frameToTime = (frame: number, fps: number, seekToFrameCenter: boolean = false): number =>
  seekToFrameCenter ? (frame + 0.5) / fps : frame / fps;

/**
 * Duration-based frame mapping is more robust than fps-based mapping across
 * rallies with slightly different encoded timing characteristics.
 */
const timeToFrameByDuration = (timeSec: number, durationSec: number, frameCount: number): number => {
  if (!(durationSec > 0) || !(frameCount > 0)) return 0;
  const ratio = Math.max(0, Math.min(1, timeSec / durationSec));
  return Math.max(0, Math.min(frameCount - 1, Math.floor(ratio * frameCount)));
};

const frameToTimeByDuration = (frame: number, durationSec: number, frameCount: number): number => {
  if (!(durationSec > 0) || !(frameCount > 0)) return 0;
  const safeFrame = Math.max(0, Math.min(frameCount - 1, frame));
  return ((safeFrame + 0.5) / frameCount) * durationSec;
};

/** VNL: map inference frame index → browser media time (preview may differ in duration from original). */
const vnlMapFrameToTime = (
  frame: number,
  inferenceFrameCount: number,
  videoDurationSec: number,
  fps: number,
): number => {
  if (videoDurationSec > 0 && inferenceFrameCount > 0) {
    return frameToTimeByDuration(frame, videoDurationSec, inferenceFrameCount);
  }
  return frameToTime(frame, fps, false);
};

/** VNL: map browser media time → inference frame index. */
const vnlMapTimeToFrame = (
  timeSec: number,
  inferenceFrameCount: number,
  videoDurationSec: number,
  fps: number,
): number => {
  if (videoDurationSec > 0 && inferenceFrameCount > 0) {
    return timeToFrameByDuration(timeSec, videoDurationSec, inferenceFrameCount);
  }
  return timeToFrame(timeSec, fps, inferenceFrameCount > 0 ? inferenceFrameCount - 1 : undefined);
};

const estimateBrowserFrameCount = (durationSec: number, fps: number): number => {
  if (!(durationSec > 0) || !(fps > 0)) return 0;
  return Math.max(1, Math.ceil(durationSec * fps));
};

/**
 * Frame<->time mapping anchored to the video's real first-frame PTS (`baseTime`).
 *
 * OpenCV/the preview pipeline index frames by DECODE ORDER (frame 0,1,2,...),
 * but an MP4 can carry a container start-time offset (e.g. 0.033s ≈ 1 frame).
 * The browser keeps that offset in the media timeline, so `frame/fps` seeks land
 * ~1 frame away from the box's frame — invisible for a slow ball, obvious for a
 * fast one. Anchoring every conversion to `baseTime` (the PTS of decode-frame 0,
 * measured at runtime via requestVideoFrameCallback) makes the annotator's frame
 * index identical to the inference's decode index for every rally.
 */
const frameToMediaTime = (frame: number, fps: number, baseTime: number): number =>
  baseTime + (Math.max(0, frame) + 0.5) / fps;

const mediaTimeToFrame = (
  timeSec: number,
  fps: number,
  baseTime: number,
  maxFrame: number,
): number => {
  // floor pairs with frame-center seeks: seek lands at (N+0.5)/fps → frame N.
  const frame = Math.floor((timeSec - baseTime) * fps + 1e-4);
  return Math.max(0, Math.min(maxFrame, frame));
};

/** Map a screen click to normalized [x,y] on the video picture (letterbox-aware). */
const getNormalizedVideoClick = (
  video: HTMLVideoElement,
  clientX: number,
  clientY: number,
): [number, number] | null => {
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;
  if (!videoW || !videoH) return null;

  const rect = video.getBoundingClientRect();
  const elementW = rect.width;
  const elementH = rect.height;
  if (elementW <= 0 || elementH <= 0) return null;

  const videoAspect = videoW / videoH;
  const elementAspect = elementW / elementH;
  let displayW: number;
  let displayH: number;
  let offsetX: number;
  let offsetY: number;

  if (elementAspect > videoAspect) {
    displayH = elementH;
    displayW = elementH * videoAspect;
    offsetX = (elementW - displayW) / 2;
    offsetY = 0;
  } else {
    displayW = elementW;
    displayH = elementW / videoAspect;
    offsetX = 0;
    offsetY = (elementH - displayH) / 2;
  }

  const x = (clientX - rect.left - offsetX) / displayW;
  const y = (clientY - rect.top - offsetY) / displayH;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
};

const getVideoLetterboxLayout = (
  video: HTMLVideoElement,
): { displayW: number; displayH: number; offsetX: number; offsetY: number } | null => {
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;
  if (!videoW || !videoH) return null;

  const rect = video.getBoundingClientRect();
  const elementW = rect.width;
  const elementH = rect.height;
  if (elementW <= 0 || elementH <= 0) return null;

  const videoAspect = videoW / videoH;
  const elementAspect = elementW / elementH;
  if (elementAspect > videoAspect) {
    const displayH = elementH;
    const displayW = elementH * videoAspect;
    return { displayW, displayH, offsetX: (elementW - displayW) / 2, offsetY: 0 };
  }
  const displayW = elementW;
  const displayH = elementW / videoAspect;
  return { displayW, displayH, offsetX: 0, offsetY: (elementH - displayH) / 2 };
};

const normalizedVideoPointToContainerPercent = (
  xy: [number, number],
  video: HTMLVideoElement,
  container: HTMLElement,
): { left: number; top: number } | null => {
  const layout = getVideoLetterboxLayout(video);
  if (!layout) return null;
  const videoRect = video.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (containerRect.width <= 0 || containerRect.height <= 0) return null;

  const px = videoRect.left + layout.offsetX + xy[0] * layout.displayW;
  const py = videoRect.top + layout.offsetY + xy[1] * layout.displayH;
  return {
    left: ((px - containerRect.left) / containerRect.width) * 100,
    top: ((py - containerRect.top) / containerRect.height) * 100,
  };
};

const cloneBallBoxes = (boxes: Record<number, PlayerBox[]>): Record<number, PlayerBox[]> => {
  const out: Record<number, PlayerBox[]> = {};
  for (const [frameStr, frameBoxes] of Object.entries(boxes)) {
    out[Number(frameStr)] = frameBoxes.map((b) => ({ ...b }));
  }
  return out;
};

const buildInferenceVideoMeta = (payload: {
  video_fps?: number;
  frame_count?: number;
  width?: number;
  height?: number;
}): InferenceVideoMeta | undefined => {
  const fps = Number(payload.video_fps);
  const frame_count = Number(payload.frame_count);
  const width = Number(payload.width);
  const height = Number(payload.height);
  if (!fps || !frame_count) return undefined;
  return {
    fps,
    frame_count,
    width: width || 1280,
    height: height || 720,
  };
};

const buildVideoMetadataFromInference = (
  filename: string,
  payload: { video_fps?: number; frame_count?: number; width?: number; height?: number } | null | undefined,
  fallback?: VideoMetadata | null,
): VideoMetadata | null => {
  const inferenceMeta = buildInferenceVideoMeta(payload ?? {});
  if (inferenceMeta) {
    return {
      filename,
      fps: inferenceMeta.fps,
      frame_count: inferenceMeta.frame_count,
      width: inferenceMeta.width,
      height: inferenceMeta.height,
      duration: inferenceMeta.frame_count / inferenceMeta.fps,
    };
  }
  if (fallback) {
    const fps = Number(payload?.video_fps) || fallback.fps;
    return { ...fallback, fps };
  }
  return fallback ?? null;
};

const getPlaybackTiming = (
  meta: { fps: number; frame_count: number; width: number; height: number } | null | undefined,
  inferenceMeta?: InferenceVideoMeta,
) => {
  if (inferenceMeta) return inferenceMeta;
  return {
    fps: meta?.fps ?? 30,
    frame_count: meta?.frame_count ?? 0,
    width: meta?.width ?? 1280,
    height: meta?.height ?? 720,
  };
};

/** Ball mode: inference frame_count (OpenCV) is often short — allow stepping through full browser video. */
const getBallPlaybackTiming = (
  meta: { fps: number; frame_count: number; width: number; height: number; duration?: number } | null | undefined,
  inferenceMeta?: InferenceVideoMeta,
) => {
  const base = inferenceMeta ?? {
    fps: meta?.fps ?? 30,
    frame_count: meta?.frame_count ?? 0,
    width: meta?.width ?? 1280,
    height: meta?.height ?? 720,
  };
  const browserFrames = meta?.duration && base.fps > 0
    ? Math.ceil(meta.duration * base.fps)
    : 0;
  return {
    ...base,
    width: meta?.width || base.width,
    height: meta?.height || base.height,
    frame_count: Math.max(base.frame_count, browserFrames, meta?.frame_count ?? 0),
  };
};

const getTimingForMode = (
  appMode: 'home' | 'touch' | 'touch_block' | 'ball' | 'block_clip' | 'vnl',
  meta: { fps: number; frame_count: number; width: number; height: number; duration?: number } | null | undefined,
  inferenceMeta?: InferenceVideoMeta,
) => {
  if (appMode === 'vnl' && inferenceMeta) {
    return {
      fps: inferenceMeta.fps,
      frame_count: inferenceMeta.frame_count,
      width: inferenceMeta.width,
      height: inferenceMeta.height,
    };
  }
  if (appMode === 'ball') {
    return getBallPlaybackTiming(meta, inferenceMeta);
  }
  return getPlaybackTiming(meta, inferenceMeta);
};

const parseBallBox = (
  raw: any,
  videoWidth?: number,
  videoHeight?: number,
): [number, number, number, number] | null => {
  // Support multiple backend shapes: box[x1,y1,x2,y2], xyxy, or x/y/w/h.
  let x1: number | undefined;
  let y1: number | undefined;
  let x2: number | undefined;
  let y2: number | undefined;

  if (Array.isArray(raw?.box) && raw.box.length >= 4) {
    [x1, y1, x2, y2] = raw.box.map((v: unknown) => Number(v));
  } else if (Array.isArray(raw?.xyxy) && raw.xyxy.length >= 4) {
    [x1, y1, x2, y2] = raw.xyxy.map((v: unknown) => Number(v));
  } else if (
    raw?.x_min !== undefined &&
    raw?.y_min !== undefined &&
    raw?.x_max !== undefined &&
    raw?.y_max !== undefined
  ) {
    x1 = Number(raw.x_min);
    y1 = Number(raw.y_min);
    x2 = Number(raw.x_max);
    y2 = Number(raw.y_max);
  } else if (
    raw?.x !== undefined &&
    raw?.y !== undefined &&
    raw?.w !== undefined &&
    raw?.h !== undefined
  ) {
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w);
    const h = Number(raw.h);
    x1 = x;
    y1 = y;
    x2 = x + w;
    y2 = y + h;
  }

  if ([x1, y1, x2, y2].some((v) => v === undefined || Number.isNaN(v as number))) return null;

  let out: [number, number, number, number] = [x1 as number, y1 as number, x2 as number, y2 as number];

  // Normalize support: if all coordinates are [0..1], scale to pixels.
  const isNormalized = out.every((v) => v >= 0 && v <= 1);
  if (isNormalized && videoWidth && videoHeight) {
    out = [out[0] * videoWidth, out[1] * videoHeight, out[2] * videoWidth, out[3] * videoHeight];
  }

  if (out[2] <= out[0] || out[3] <= out[1]) return null;
  return out;
};

const ballPredictionToPlayerBox = (
  b: { frame?: number; box?: unknown; conf?: number; rejectReason?: string },
  videoWidth?: number,
  videoHeight?: number,
  rejected = false,
): { frame: number; box: PlayerBox } | null => {
  const frame = Number(b.frame);
  if (Number.isNaN(frame)) return null;
  const parsedBox = parseBallBox(b, videoWidth, videoHeight);
  if (!parsedBox) return null;
  return {
    frame,
    box: {
      x_min: parsedBox[0],
      y_min: parsedBox[1],
      x_max: parsedBox[2],
      y_max: parsedBox[3],
      track_id: rejected ? 0 : 1,
      is_active: !rejected,
      conf: Number(b.conf) || 0,
      source: 'inference',
      postprocess_rejected: rejected || undefined,
      reject_reason: rejected ? (b.rejectReason || 'removed') : undefined,
    },
  };
};

const predictionsToBallBoxMap = (
  predictions: Array<{ frame?: number; box?: unknown; conf?: number; rejectReason?: string }>,
  videoWidth?: number,
  videoHeight?: number,
  rejected = false,
): Record<number, PlayerBox[]> => {
  const out: Record<number, PlayerBox[]> = {};
  for (const pred of predictions) {
    const parsed = ballPredictionToPlayerBox(pred, videoWidth, videoHeight, rejected);
    if (!parsed) continue;
    out[parsed.frame] = [parsed.box];
  }
  return out;
};

const mergeBallBoxes = (
  inference: Record<number, PlayerBox[]> | undefined,
  edits: Record<number, PlayerBox[]> | undefined,
): Record<number, PlayerBox[]> => {
  const merged = cloneBallBoxes(inference ?? {});
  if (!edits) return merged;
  for (const [frameStr, boxes] of Object.entries(edits)) {
    const frame = Number(frameStr);
    if (Number.isNaN(frame)) continue;
    if (boxes.length === 0) {
      delete merged[frame];
      continue;
    }
    // Any saved edit for this frame replaces inference (draw, move, resize).
    merged[frame] = boxes.map((b) => ({ ...b }));
  }
  return merged;
};

const getTrackingCoverage = (playerBoxes?: Record<number, PlayerBox[]>) => {
  if (!playerBoxes) return { frameCount: 0, maxFrame: -1 };
  const frameKeys = Object.keys(playerBoxes)
    .map((f) => parseInt(f, 10))
    .filter((f) => !Number.isNaN(f));
  return {
    frameCount: frameKeys.length,
    maxFrame: frameKeys.length > 0 ? Math.max(...frameKeys) : -1,
  };
};

const hasTouchTrackingData = (item: Pick<PlaylistItem, 'rawJsonString' | 'playerBoxes'>) =>
  Boolean(item.rawJsonString?.trim()) ||
  Boolean(item.playerBoxes && Object.keys(item.playerBoxes).length > 0);

const markActivePlayerOnFrames = (
  playerBoxes: Record<number, PlayerBox[]>,
  frame: number,
  trackId: number,
  predBox?: number[] | null
) => {
  for (let f = frame - 2; f <= frame + 2; f++) {
    if (!playerBoxes[f]) playerBoxes[f] = [];
    const existingBox = playerBoxes[f].find((b) => Number(b.track_id) === trackId);
    if (existingBox) {
      existingBox.is_active = true;
    } else if (predBox && predBox.length === 4) {
      playerBoxes[f].push({
        x_min: predBox[0],
        y_min: predBox[1],
        x_max: predBox[2],
        y_max: predBox[3],
        track_id: trackId,
        is_active: true,
      });
    }
  }
};

function App() {
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [batchProgress, setBatchProgress] = useState({ isRunning: false, completed: 0, total: 0, lastFps: 0, avgTimeSec: 0 });
  const [includeMp4InZip, setIncludeMp4InZip] = useState(false);
  const [inferenceEngine, setInferenceEngine] = useState<"slowfast" | "yolo">("slowfast");
  const [appMode, setAppMode] = useState<'home' | 'touch' | 'touch_block' | 'ball' | 'block_clip' | 'vnl'>('home');
  const googleTokenRef = useRef<string | null>(null);
  
  const [state, setState] = useState<AppState>({
    playlist: [],
    currentPlaylistIndex: 0,
    videoMetadata: null,
    rally: { start_frame: null, end_frame: null },
    events: [],
    currentFrame: 0,
    playerBoxes: {},
    manualActions: [],
  });

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginUsername === 'admin' && loginPassword === 'password123') {
      setIsAuthenticated(true);
      setLoginError('');
    } else {
      setLoginError('Invalid username or password');
    }
  };

  const historyRef = useRef<{
    events: SkillEvent[];
    manualActions: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: PlayerBox }[];
    playerBoxes: Record<number, any[]>;
  }[]>([]);

  const saveToHistory = (currentState: AppState) => {
    historyRef.current.push({
      events: JSON.parse(JSON.stringify(currentState.events)),
      manualActions: JSON.parse(JSON.stringify(currentState.manualActions)),
      playerBoxes: JSON.parse(JSON.stringify(currentState.playerBoxes))
    });
    // Keep history bounded to last 50 states
    if (historyRef.current.length > 50) {
      historyRef.current.shift();
    }
  };

  const handleUndo = () => {
    if (historyRef.current.length === 0) {
      window.alert("No more actions to undo.");
      return;
    }
    const previousState = historyRef.current.pop()!;
    setState(prev => ({
      ...prev,
      events: previousState.events,
      manualActions: previousState.manualActions,
      playerBoxes: previousState.playerBoxes
    }));
  };

  const handleResetRally = () => {
    if (window.confirm("Are you sure you want to completely reset all manual annotations for this video? This cannot be undone.")) {
      saveToHistory(state); // Save the current state before wiping it, just in case they want to undo the reset!
      setState(prev => {
        // Strip out manually drawn boxes (track_id >= 999000) and deactivate others
        const resetBoxes: Record<number, any[]> = {};
        Object.keys(prev.playerBoxes).forEach(fStr => {
          const f = parseInt(fStr, 10);
          resetBoxes[f] = prev.playerBoxes[f]
            .filter(b => b.track_id < 999000)
            .map(b => ({ ...b, is_active: false }));
        });

        // Strip player assignments from events and remove any manually created events
        const resetEvents = prev.events
          .filter(ev => ev.source !== 'manual')
          .map(ev => ({ ...ev, player_id: undefined }));

        return {
          ...prev,
          manualActions: [],
          playerBoxes: resetBoxes,
          events: resetEvents
        };
      });
    }
  };

  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [ballEditMode, setBallEditMode] = useState(false);
  const [showOnlyActiveBoxes, setShowOnlyActiveBoxes] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [ballFrameStepFps, setBallFrameStepFps] = useState(5);
  const [isAutoStepping, setIsAutoStepping] = useState(false);
  const [drawingBox, setDrawingBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const [draggingBox, setDraggingBox] = useState<{ trackId: number; startX: number; startY: number; initialBox: PlayerBox } | null>(null);
  const [resizingBox, setResizingBox] = useState<{ trackId: number; startX: number; startY: number; initialBox: PlayerBox; corner: 'tl' | 'tr' | 'bl' | 'br' } | null>(null);
  const [ballEngine, setBallEngine] = useState<'yolo26' | 'side_view' | 'triplet'>('yolo26');
  const [touchDetector, setTouchDetector] = useState<'default' | 'side_view'>('default');
  const touchDetectorRef = useRef<'default' | 'side_view'>('default');
  const [backendHealth, setBackendHealth] = useState<Record<string, string> | null>(null);
  const [ballPostprocessEnabled, setBallPostprocessEnabled] = useState(true);
  const [showRejectedBallBoxes, setShowRejectedBallBoxes] = useState(true);
  
  // Fullscreen & Zoom Features
  const [interactionMode, setInteractionMode] = useState<'draw' | 'zoom'>('draw');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewTransform, setViewTransform] = useState({ zoom: 1, tx: 0, ty: 0 });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const [assigningEventFrame, setAssigningEventFrame] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const isSeekingRef = useRef(false);
  const pendingSeekFrameRef = useRef<number | null>(null);
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoUrlRef = useRef<string>('');
  const videoFileKeyRef = useRef<string>('');
  const gpuFileReadyRef = useRef<Map<string, File>>(new Map());
  const vnlFolderKeyRef = useRef<string | null>(null);
  const vnlFolderLabelRef = useRef<string>('VNL folder');
  const [vnlAwaitingFolder, setVnlAwaitingFolder] = useState(false);
  const touchBlockFolderKeyRef = useRef<string | null>(null);
  const touchBlockFolderLabelRef = useRef<string>('Touch Block folder');
  const [touchBlockAwaitingFolder, setTouchBlockAwaitingFolder] = useState(false);
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null);
  const [videoTranscoding, setVideoTranscoding] = useState(false);
  const videoTranscodingRef = useRef(false);
  const convertFailedRef = useRef<Set<string>>(new Set());
  const [videoPlaybackKind, setVideoPlaybackKind] = useState<'direct' | 'h264' | null>(null);

  const clearVideoUrl = useCallback(() => {
    const prev = videoUrlRef.current;
    if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    videoUrlRef.current = '';
    videoFileKeyRef.current = '';
    setVideoUrl('');
    setVideoPlaybackError(null);
    setVideoPlaybackKind(null);
  }, []);

  const assignVideoUrlFromFile = useCallback((file: File) => {
    const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
    if (videoFileKeyRef.current === fileKey && videoUrlRef.current.startsWith('blob:')) {
      return;
    }
    const prev = videoUrlRef.current;
    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    videoFileKeyRef.current = fileKey;
    setVideoUrl(url);
    setVideoPlaybackError(null);
    setVideoPlaybackKind('direct');
    if (prev.startsWith('blob:') && prev !== url) {
      window.setTimeout(() => URL.revokeObjectURL(prev), 10_000);
    }
  }, []);

  const assignVideoUrlFromRemote = useCallback((url: string) => {
    const prev = videoUrlRef.current;
    if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    videoUrlRef.current = url;
    videoFileKeyRef.current = url;
    setVideoUrl(url);
    setVideoPlaybackError(null);
    setVideoPlaybackKind('direct');
  }, []);

  const prepareVideoPlayback = useCallback(async (file: File) => {
    if (videoTranscodingRef.current) return file;

    // GitHub: reuse IndexedDB H.264 from a previous visit — no re-convert overlay.
    if (OFFLINE_REVIEW_ONLY && !looksLikeH264Filename(file.name)) {
      const cached = await getCachedH264(file);
      if (cached) {
        assignVideoUrlFromFile(cached);
        setVideoPlaybackKind('h264');
        setVideoPlaybackError(null);
        const item = stateRef.current.playlist[stateRef.current.currentPlaylistIndex];
        if (item?.id) {
          gpuFileReadyRef.current.set(item.id, cached);
          setState((prev) => {
            const playlist = [...prev.playlist];
            const idx = playlist.findIndex((p) => p.id === item.id);
            if (idx >= 0) playlist[idx] = { ...playlist[idx], file: cached };
            const next = { ...prev, playlist };
            stateRef.current = next;
            return next;
          });
        }
        return cached;
      }
    }

    videoTranscodingRef.current = true;
    setVideoTranscoding(true);
    setVideoPlaybackError(null);
    try {
      // GitHub Pages: convert unsupported codecs (e.g. mp4v) in-browser via ffmpeg.wasm.
      // Local: use GPU ffmpeg when needed.
      const ready = OFFLINE_REVIEW_ONLY
        ? await ensureBrowserPlayableViaWasm(file)
        : await ensureGpuH264File(file, INFERENCE_API_BASE);
      assignVideoUrlFromFile(ready);
      setVideoPlaybackKind(ready === file ? 'direct' : 'h264');
      const item = stateRef.current.playlist[stateRef.current.currentPlaylistIndex];
      if (item?.id) {
        gpuFileReadyRef.current.set(item.id, ready);
        if (ready !== item.file) {
          setState((prev) => {
            const playlist = [...prev.playlist];
            const idx = playlist.findIndex((p) => p.id === item.id);
            if (idx >= 0) playlist[idx] = { ...playlist[idx], file: ready };
            const next = { ...prev, playlist };
            stateRef.current = next;
            return next;
          });
        }
      }
      return ready;
    } catch (err) {
      console.error('Video preparation failed:', err);
      convertFailedRef.current.add(`${file.name}:${file.size}:${file.lastModified}`);
      setVideoPlaybackError(
        OFFLINE_REVIEW_ONLY
          ? `This MP4 uses a codec Chrome cannot play (often MPEG-4/mp4v). In-browser convert failed: ${
              err instanceof Error ? err.message : String(err)
            }. Prefer *_h264.mp4 clips in the prediction ZIP.`
          : `This video is not playable in the browser (often HEVC). Convert it to H.264 first. ` +
            `Local ffmpeg server should be on ${INFERENCE_API_BASE}. ` +
            `${err instanceof Error ? err.message : String(err)}`,
      );
      return file;
    } finally {
      videoTranscodingRef.current = false;
      setVideoTranscoding(false);
    }
  }, [assignVideoUrlFromFile]);

  // Frame the <video> is ACTUALLY presenting (tracked via requestVideoFrameCallback).
  // The ball overlay is drawn against this so the box always sits on the visible ball,
  // even on fast-motion frames where an HTML5 seek can land a frame away from the target.
  const [presentedBallFrame, setPresentedBallFrame] = useState<number | null>(null);
  // PTS (seconds) of decode-frame 0, measured at runtime. Anchors frame<->time
  // math to the video's real timeline so box index == inference decode index.
  const ballBaseTimeRef = useRef<number | null>(null);
  const seekIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const autoStepIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const ballFrameStepFpsRef = useRef(5);
  const stateRef = useRef(state);
  const processingRef = useRef(false);
  const appModeRef = useRef(appMode);

  const cyclePlaybackRate = () => {
    const rates = [0.25, 0.5, 1, 1.5, 2];
    const currentIndex = rates.indexOf(playbackRate);
    const nextIndex = (currentIndex + 1) % rates.length;
    setPlaybackRate(rates[nextIndex]);
  };

  const clampBallFrameStepFps = (value: number) => Math.min(60, Math.max(1, Math.round(value) || 1));

  const handleBallFrameStepFpsChange = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    setBallFrameStepFps(clampBallFrameStepFps(parsed));
  };

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    appModeRef.current = appMode;
  }, [appMode]);

  // Restore last workflow (VNL / Touch Block annotations live in browser storage on GitHub Pages).
  useEffect(() => {
    const savedMode = localStorage.getItem(APP_MODE_STORAGE_KEY);
    if (savedMode === 'vnl' && OFFLINE_REVIEW_ONLY) {
      const folderSnapshot = loadActiveVnlFolder();
      if (folderSnapshot && folderSnapshot.playlist.length > 0) {
        vnlFolderKeyRef.current = folderSnapshot.folderKey;
        vnlFolderLabelRef.current = folderSnapshot.folderLabel;
        const restored = storedFolderToAppState(folderSnapshot);
        stateRef.current = restored;
        setState(restored);
        setAppMode('vnl');
        setVnlAwaitingFolder(true);
        return;
      }
    }
    if (savedMode === 'touch_block' && OFFLINE_REVIEW_ONLY) {
      const folderSnapshot = loadActiveTouchBlockFolder();
      if (folderSnapshot && folderSnapshot.playlist.length > 0) {
        touchBlockFolderKeyRef.current = folderSnapshot.folderKey;
        touchBlockFolderLabelRef.current = folderSnapshot.folderLabel;
        const restored = storedTouchBlockFolderToAppState(folderSnapshot);
        stateRef.current = restored;
        setState(restored);
        setAppMode('touch_block');
        setTouchBlockAwaitingFolder(true);
        return;
      }
    }
    if (savedMode === 'touch' || savedMode === 'touch_block' || savedMode === 'ball' || savedMode === 'vnl') {
      switchWorkflowMode(savedMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    touchDetectorRef.current = touchDetector;
  }, [touchDetector]);

  useEffect(() => {
    ballFrameStepFpsRef.current = ballFrameStepFps;
  }, [ballFrameStepFps]);

  useEffect(() => {
    return () => {
      if (seekIntervalRef.current) clearInterval(seekIntervalRef.current);
      if (autoStepIntervalRef.current) clearInterval(autoStepIntervalRef.current);
      if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
    };
  }, []);

  // Continuously track the frame the browser actually presents (ball mode only),
  // so the overlay box is always drawn for the visible frame, not the requested one.
  // A new video means the calibrated base PTS is stale.
  useEffect(() => {
    ballBaseTimeRef.current = null;
  }, [videoUrl]);

  useEffect(() => {
    if (appMode !== 'ball') {
      setPresentedBallFrame(null);
      return;
    }
    const video = videoRef.current as unknown as {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    } | null;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;

    let handle = 0;
    let cancelled = false;
    const loop = (_now: number, meta: { mediaTime: number }) => {
      if (cancelled) return;
      const s = stateRef.current;
      const it = s.playlist[s.currentPlaylistIndex];
      const t = getBallPlaybackTiming(s.videoMetadata, it?.inferenceVideoMeta);
      const base = ballBaseTimeRef.current ?? 0;
      const f = mediaTimeToFrame(meta.mediaTime, t.fps, base, t.frame_count - 1);
      setPresentedBallFrame((prev) => (prev === f ? prev : f));
      // Keep the frame label in sync with the pixels the browser is actually showing.
      if (!isSeekingRef.current && appModeRef.current === 'ball') {
        setState((prev) => (prev.currentFrame === f ? prev : { ...prev, currentFrame: f }));
      }
      handle = video.requestVideoFrameCallback!(loop);
    };
    handle = video.requestVideoFrameCallback(loop);
    return () => {
      cancelled = true;
      if (typeof video.cancelVideoFrameCallback === 'function' && handle) {
        video.cancelVideoFrameCallback(handle);
      }
    };
  }, [appMode, videoUrl]);

  useEffect(() => {
    if (OFFLINE_REVIEW_ONLY) {
      setBackendHealth(null);
      return;
    }
    if (appMode !== 'touch' && appMode !== 'touch_block' && appMode !== 'ball' && appMode !== 'vnl') return;
    fetch(`${INFERENCE_API_BASE}/api/health`)
      .then((res) => (res.ok ? res.json() : null))
      .then((health) => {
        if (!health) return;
        setBackendHealth(health);
        if (appMode === 'ball') {
          if (health.ball_triplet_configured !== 'true' && ballEngine === 'triplet') {
            setBallEngine('yolo26');
          }
          if (health.ball_sideview_configured !== 'true' && ballEngine === 'side_view') {
            setBallEngine('yolo26');
          }
        }
        if (appMode === 'touch' && health.touch_sideview_configured !== 'true' && touchDetector === 'side_view') {
          setTouchDetector('default');
        }
      })
      .catch((err) => console.warn('Backend health check failed:', err));
  }, [appMode]);

  const resetPlayerState = useCallback(() => {
    setState(EMPTY_APP_STATE);
    clearVideoUrl();
    setBatchProgress({ isRunning: false, completed: 0, total: 0, lastFps: 0, avgTimeSec: 0 });
    processingRef.current = false;
  }, [clearVideoUrl]);

  const switchWorkflowMode = useCallback((mode: WorkflowMode) => {
    const prev = workflowFromAppMode(appModeRef.current);
    if (prev) {
      persistWorkflowState(prev, stateRef.current);
    }

    setBatchProgress({ isRunning: false, completed: 0, total: 0, lastFps: 0, avgTimeSec: 0 });
    processingRef.current = false;
    clearVideoUrl();

    const restored = loadWorkflowState(mode);
    if (mode === 'vnl' && OFFLINE_REVIEW_ONLY) {
      const folderSnapshot = loadActiveVnlFolder();
      if (folderSnapshot && folderSnapshot.playlist.length > 0) {
        vnlFolderKeyRef.current = folderSnapshot.folderKey;
        vnlFolderLabelRef.current = folderSnapshot.folderLabel;
        const fromFolder = storedFolderToAppState(folderSnapshot);
        setState(fromFolder);
        stateRef.current = fromFolder;
        setVnlAwaitingFolder(true);
        setAppMode(mode);
        localStorage.setItem(APP_MODE_STORAGE_KEY, mode);
        return;
      }
    }
    if (mode === 'touch_block' && OFFLINE_REVIEW_ONLY) {
      const folderSnapshot = loadActiveTouchBlockFolder();
      if (folderSnapshot && folderSnapshot.playlist.length > 0) {
        touchBlockFolderKeyRef.current = folderSnapshot.folderKey;
        touchBlockFolderLabelRef.current = folderSnapshot.folderLabel;
        const fromFolder = storedTouchBlockFolderToAppState(folderSnapshot);
        setState(fromFolder);
        stateRef.current = fromFolder;
        setTouchBlockAwaitingFolder(true);
        setAppMode(mode);
        localStorage.setItem(APP_MODE_STORAGE_KEY, mode);
        return;
      }
    }
    if (restored) {
      setState(restored);
    } else {
      setState(EMPTY_APP_STATE);
    }

    setAppMode(mode);
    localStorage.setItem(APP_MODE_STORAGE_KEY, mode);
  }, [clearVideoUrl]);

  const returnToHome = useCallback(() => {
    const prev = workflowFromAppMode(appModeRef.current);
    if (prev) {
      persistWorkflowState(prev, stateRef.current);
    }
    localStorage.removeItem(APP_MODE_STORAGE_KEY);
    resetPlayerState();
    setAppMode('home');
  }, [resetPlayerState]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  const parsePredictionLabel = (rawLabel: unknown): { label: SkillLabel; classId: number } | null => {
    if (typeof rawLabel !== 'string') return null;
    const normalized = rawLabel.trim().toLowerCase();
    return LABEL_TO_SKILL[normalized] || null;
  };

  const parsePredictionsFile = (data: unknown): { events: AppState['events']; startFrame: number | null; endFrame: number | null } => {
    const payload = data as PredictionImportPayload;
    const candidates: PredictionLike[] = Array.isArray(payload?.predictions)
      ? payload.predictions
      : Array.isArray(payload?.events)
        ? payload.events
        : Array.isArray(data)
          ? (data as PredictionLike[])
          : [];

    const importedEvents = candidates
      .map((item) => {
        const rawFrame = item?.frame;
        const frame = typeof rawFrame === 'string' ? Number(rawFrame) : rawFrame;
        if (typeof frame !== 'number' || Number.isNaN(frame)) return null;

        const parsedFromLabel = parsePredictionLabel(item?.label ?? item?.skill);
        if (parsedFromLabel) {
          return {
            frame: Math.round(frame),
            skill: parsedFromLabel.label,
            class_id: parsedFromLabel.classId,
            confidence: item?.confidence ?? 1.0,
            source: 'auto' as const
          };
        }

        const classId = item?.class_id;
        if (typeof classId === 'number' && classId >= 0 && classId <= 6) {
          const match = Object.values(SKILL_MAP).find((s) => s.classId === classId);
          if (!match) return null;
          return {
            frame: Math.round(frame),
            skill: match.label,
            class_id: classId,
            confidence: item?.confidence ?? 1.0,
            source: 'auto' as const
          };
        }
        return null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const sortedUniqueEvents = Array.from(
      importedEvents
        .reduce((acc, event) => acc.set(event.frame, event), new Map<number, (typeof importedEvents)[number]>())
        .values()
    );

    // Apply Greedy NMS (window = 10)
    const nmsWindow = 10;
    const sortedByConf = [...sortedUniqueEvents].sort((a, b) => (b.confidence ?? 1.0) - (a.confidence ?? 1.0));
    const keptEvents: typeof sortedUniqueEvents = [];
    for (const ev of sortedByConf) {
      if (!keptEvents.some(k => Math.abs(k.frame - ev.frame) <= nmsWindow)) {
        keptEvents.push(ev);
      }
    }
    const finalEvents = keptEvents.sort((a, b) => a.frame - b.frame);
    const startFrame = payload?.rally?.start_frame ?? payload?.start_frame ?? null;
    const endFrame = payload?.rally?.end_frame ?? payload?.end_frame ?? null;
    
    console.log(`[parsePredictionsFile] Parsed ${finalEvents.length} events from payload.`);

    return {
      events: finalEvents,
      startFrame: typeof startFrame === 'number' ? startFrame : null,
      endFrame: typeof endFrame === 'number' ? endFrame : null,
    };
  };

  const alignManualActionsToEvents = (actions: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: PlayerBox }[], events: SkillEvent[], threshold = 5) => {
    const snappedActions = actions.map(action => {
      let closestEvent: SkillEvent | null = null;
      let minDiff = threshold + 1;
      for (const ev of events) {
        const diff = Math.abs(ev.frame - action.frame);
        if (diff < minDiff) {
          minDiff = diff;
          closestEvent = ev;
        }
      }
      if (closestEvent && minDiff > 0) {
        return { ...action, frame: closestEvent.frame };
      }
      return action;
    });

    const uniqueActionsMap = new Map<string, any>();
    snappedActions.forEach(action => {
      const actType = action.action || 'add';
      const key = `${action.frame}_${action.track_id}_${actType}`;
      
      // If the action is draw_box, we definitely want to store it to keep coordinates
      if (actType === 'draw_box') {
        uniqueActionsMap.set(key, action);
      } else {
        // For add/remove, if there's already one of the SAME type, we can skip to deduplicate
        // But we preserve the object so we don't lose anything else
        if (!uniqueActionsMap.has(key)) {
          uniqueActionsMap.set(key, action);
        }
      }
    });

    return Array.from(uniqueActionsMap.values());
  };

  const applySkillHeuristics = (events: SkillEvent[], rally: Rally = { start_frame: null, end_frame: null }, frameCount = 0): SkillEvent[] => {
    if (events.length === 0) return events;

    let modified = applySixSkillPostprocess(events, rally, frameCount);
    modified = JSON.parse(JSON.stringify(modified)) as SkillEvent[];

    // Helper to update skill and its associated class_id
    const updateSkill = (event: SkillEvent, newSkill: string) => {
      event.skill = newSkill as SkillLabel;
      if (LABEL_TO_SKILL[newSkill]) {
        event.class_id = LABEL_TO_SKILL[newSkill].classId;
      }
    };

    // Rule 4: Remove consecutive duplicates of toss, serve, attack, block (same label only)
    let i = 0;
    while (i < modified.length - 1) {
      const current = modified[i];
      const next = modified[i + 1];
      
      const isTargetSkill = ['toss', 'serve', 'attack', 'block'].includes(current.skill);
      
      if (current.skill === next.skill && isTargetSkill) {
        const conf1 = current.confidence ?? 1.0;
        const conf2 = next.confidence ?? 1.0;
        
        if (conf1 >= conf2) {
          modified.splice(i + 1, 1);
        } else {
          modified.splice(i, 1);
          continue; // check the new current element
        }
      } else {
        i++;
      }
    }

    // NEW RULE: Only one reception allowed per video/rally. Subsequent ones become digs.
    let hasSeenReception = false;
    for (let i = 0; i < modified.length; i++) {
      if (modified[i].skill === 'reception') {
        if (hasSeenReception) {
          updateSkill(modified[i], 'dig');
        } else {
          hasSeenReception = true;
        }
      }
    }

    for (let i = 0; i < modified.length; i++) {
      // 3-skill window (Rule 2 & 3)
      if (i <= modified.length - 3) {
        const e1 = modified[i];
        const e2 = modified[i+1];
        const e3 = modified[i+2];

        // Rule 3: toss -> serve -> set/dig becomes toss -> serve -> reception
        if (e1.skill === 'toss' && e2.skill === 'serve' && (e3.skill === 'set' || e3.skill === 'dig')) {
          updateSkill(e3, 'reception');
        }

        // Rule 2: reception/dig -> dig -> attack/block becomes reception/dig -> set -> attack/block
        if ((e1.skill === 'reception' || e1.skill === 'dig') && e2.skill === 'dig' && (e3.skill === 'attack' || e3.skill === 'block')) {
          updateSkill(e2, 'set');
        }
      }
      
      // 2-skill window (Rule 1)
      if (i <= modified.length - 2) {
        const e1 = modified[i];
        const e2 = modified[i+1];
        
        // Rule 1: reception -> dig becomes reception -> set
        if (e1.skill === 'reception' && e2.skill === 'dig') {
          updateSkill(e2, 'set');
        }
      }
    }

    return modified;
  };


  const inferTouchPeaksOnly = async (file: File, model: 'default' | 'side_view' = 'side_view') => {
    const formData = new FormData();
    formData.append('video', file);
    formData.append('touch_model', model);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 900_000);
    try {
      const res = await fetch(`${INFERENCE_API_BASE}/api/infer/touch`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Touch inference failed: ${err}`);
      }
      return res.json() as Promise<{
        video_name?: string;
        touch_peaks?: number[];
        touch_model?: string;
        frame_count?: number;
        video_fps?: number;
      }>;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Touch inference timed out. Check the GPU tunnel (./connect_gpu.sh).');
      }
      if (err instanceof TypeError) {
        throw new Error(
          `Cannot reach inference backend at ${INFERENCE_API_BASE}. Run ./connect_gpu.sh on your laptop.`,
        );
      }
      throw err;
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const inferSingleVideo = async (
    file: File,
    mode: 'touch' | 'ball' | 'vnl',
    engine: 'yolo26' | 'side_view' | 'triplet' = 'yolo26',
  ) => {
    const formData = new FormData();
    formData.append('video', file);
    if (mode === 'ball') {
      let selected = engine;
      if (selected === 'triplet' && backendHealth?.ball_triplet_configured !== 'true') {
        selected = 'yolo26';
      }
      if (selected === 'side_view' && backendHealth?.ball_sideview_configured !== 'true') {
        selected = 'yolo26';
      }
      formData.append('ball_model', selected);
      formData.append('use_triplet', selected === 'triplet' ? 'true' : 'false');
    }
    if (mode === 'touch') {
      let selectedTouch = touchDetector;
      if (selectedTouch === 'side_view' && backendHealth?.touch_sideview_configured !== 'true') {
        selectedTouch = 'default';
      }
      formData.append('touch_model', selectedTouch);
    }
    const endpoint =
      mode === 'ball' ? '/api/infer/ball' : '/api/infer/skill5';
    // VNL while sharing GPU with training can take much longer than solo GPU runs.
    const timeoutMs = mode === 'vnl' ? 1_800_000 : 900_000; // 30m VNL / 15m others
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${INFERENCE_API_BASE}${endpoint}`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Inference failed: ${err}`);
      }
      return res.json();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Inference timed out after ${Math.round(timeoutMs / 60000)} min. ` +
          `If training is sharing the GPU, wait longer or retry. Backend: ${INFERENCE_API_BASE}`,
        );
      }
      if (err instanceof TypeError) {
        throw new Error(
          `Cannot reach inference backend at ${INFERENCE_API_BASE}. Run ./connect_gpu.sh on your laptop.`,
        );
      }
      throw err;
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const inferAssignPlayer = async (
    file: File,
    events: SkillEvent[],
    trackingBoxes?: Record<number, PlayerBox[]>,
    engine: 'slowfast' | 'yolo' = 'slowfast',
    rawTrackingJson?: string,
  ) => {
    try {
      const formData = new FormData();
      formData.append('video', file);
      formData.append('skill_events', JSON.stringify(events));
      formData.append('engine', engine);
      if (rawTrackingJson && rawTrackingJson.trim()) {
        formData.append(
          'tracking_json_file',
          new Blob([rawTrackingJson], { type: 'application/json' }),
          'tracking.json',
        );
      } else if (trackingBoxes && Object.keys(trackingBoxes).length > 0) {
        const serialized = JSON.stringify(trackingBoxes);
        if (serialized.length > 900_000) {
          formData.append(
            'tracking_json_file',
            new Blob([serialized], { type: 'application/json' }),
            'tracking_boxes.json',
          );
        } else {
          formData.append('tracking_boxes', serialized);
        }
      }
      const res = await fetch(`${INFERENCE_API_BASE}/api/infer/assign_player`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Assign player inference failed: ${err}`);
      }
      return res.json();
    } catch (err) {
      console.error('Assign player inference failed:', err);
      throw err;
    }
  };

  const uploadToDrive = async (token: string, folderId: string | undefined, filename: string, blob: Blob, existingId?: string) => {
    let fileId = existingId;
    if (!fileId && folderId) {
      try {
        const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${filename}' and '${folderId}' in parents and trashed=false&fields=files(id)`;
        const res = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (data.files && data.files.length > 0) {
          fileId = data.files[0].id; // Use existing file instead of creating duplicate
        }
      } catch (err) {
        console.error('Failed to search Drive for existing file:', err);
      }
    }

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    let method = 'POST';
    const metadata: any = { name: filename };
    
    if (fileId) {
      url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`;
      method = 'PATCH';
    } else if (folderId) {
      metadata.parents = [folderId];
    }
    
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const uploadRes = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, body: form });
    const uploadData = await uploadRes.json();
    return uploadData.id as string;
  };

  useEffect(() => {
    if (OFFLINE_REVIEW_ONLY || appModeRef.current === 'vnl' || appModeRef.current === 'touch_block') {
      if (batchProgress.isRunning) {
        processingRef.current = false;
        setBatchProgress((prev) => ({ ...prev, isRunning: false }));
      }
      return;
    }
    if (batchProgress.isRunning && !processingRef.current) {
      processingRef.current = true;
      const processedIds = new Set<string>();

      const processNextRecursive = async () => {
        const currentPlaylist = stateRef.current.playlist;
        const workflowMode: WorkflowMode =
          appModeRef.current === 'ball' ? 'ball' : appModeRef.current === 'vnl' ? 'vnl' : 'touch';
        const nextIndex = currentPlaylist.findIndex(
          (p) => !isItemAlgorithmApplied(p, workflowMode) && !processedIds.has(p.id) && (p.file || p.driveUrl),
        );
        
        if (nextIndex === -1) {
          processingRef.current = false;
          setBatchProgress(prev => ({ ...prev, isRunning: false }));
          
          // Automatically download the batch ZIP when finished!
          const annotated = currentPlaylist.filter((p) => isItemAlgorithmApplied(p, workflowMode));
          if (annotated.length > 0) {
            exportAllToZip(
              annotated,
              true,
              includeMp4InZip,
              workflowMode === 'ball' ? 'ball' : workflowMode === 'vnl' ? 'vnl' : 'touch',
            ).then(blob => {
              if (blob && googleTokenRef.current) {
                const metadata = { name: `${getBatchZipFilename(workflowMode).replace('.zip', '')}_${Date.now()}.zip`, mimeType: 'application/zip' };
                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', blob);

                fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${googleTokenRef.current}` },
                  body: form
                })
                .then(res => {
                  if (res.ok) window.alert('Successfully uploaded batch annotations to Google Drive!');
                  else throw new Error('Upload failed');
                })
                .catch(err => {
                  console.error('Drive upload error:', err);
                  window.alert('Failed to upload to Google Drive. The file was still downloaded to your local machine.');
                });
              }
            });
          }
          return;
        }
      
        try {
          const item = currentPlaylist[nextIndex];
          processedIds.add(item.id);
          let fileToInfer = item.file;
          
          if (!fileToInfer && item.driveUrl) {
            const res = await fetch(item.driveUrl, { headers: { Authorization: `Bearer ${googleTokenRef.current}` } });
            const blob = await res.blob();
            fileToInfer = new File([blob], item.name, { type: 'video/mp4' });
          }

          // Ball + touch: send original MP4 to the GPU (YOLO/SlowFast decode any common codec).
          // Skip H.264 prep — it only slows review/upload and was not needed for classic ball tracking.
          // VNL still converts on playback when the browser cannot decode HEVC.
          let payload: any = null;
          let heuristicallyCorrected: any[] = [];
          let startFrame = item.rally?.start_frame ?? null;
          let endFrame = item.rally?.end_frame ?? null;
          let newPlayerBoxes: Record<number, PlayerBox[]> = {};
          let rejectedBallBoxes: Record<number, PlayerBox[]> = {};
          let touchAssignSucceeded = workflowMode !== 'touch';

          if (workflowMode === 'ball') {
            payload = await inferSingleVideo(fileToInfer!, 'ball', ballEngine);

            let ballTrackingData = payload.ball_tracking || payload.predictions;
            const payloadWidth = Number(payload?.width) || undefined;
            const payloadHeight = Number(payload?.height) || undefined;

            // YOLO26 only: filter false positives (static / outliers / legs).
            // Side View Ball: keep every raw detection — no pink "removed" overlay.
            if (ballEngine === 'yolo26' && ballTrackingData && Array.isArray(ballTrackingData)) {
              const { predictions: filtered, rejected, stats } = applyBallPostprocess(ballTrackingData, {
                frameWidth: payloadWidth || 1280,
                frameHeight: payloadHeight || 720,
              });
              ballTrackingData = filtered;
              rejectedBallBoxes = predictionsToBallBoxMap(rejected, payloadWidth, payloadHeight, true);
              setBallPostprocessEnabled(true);
              console.log(`[ball postprocess] ${item.name}:`, stats);
            } else {
              setBallPostprocessEnabled(false);
              rejectedBallBoxes = {};
            }
            
            if (ballTrackingData && Array.isArray(ballTrackingData)) {
              newPlayerBoxes = predictionsToBallBoxMap(ballTrackingData, payloadWidth, payloadHeight, false);
            }
            startFrame = 0;
            endFrame = payload.frame_count > 0 ? payload.frame_count - 1 : 999999;
            console.log(`[batch] Ball tracking events parsed: ${ballTrackingData?.length || 0}`);
            setBallEditMode(false);
          } else if (workflowMode === 'vnl') {
            console.log(`[batch] Skipping VNL inference for ${item.name} — manual annotation only.`);
            heuristicallyCorrected = [...(item.events || [])];
          } else {
            const useSideViewTouchOnly = touchDetectorRef.current === 'side_view';

            if (useSideViewTouchOnly) {
              // Side View Touch: peaks only — no skill model, no player assignment, no tracking JSON.
              if (item.events && item.events.length > 0) {
                console.log(`[batch] Skipping Side View Touch for ${item.name} — using existing events.`);
                heuristicallyCorrected = [...item.events];
              } else {
                const touchPayload = await inferTouchPeaksOnly(fileToInfer!, 'side_view');
                const peaks = Array.isArray(touchPayload.touch_peaks) ? touchPayload.touch_peaks : [];
                heuristicallyCorrected = peaks.map((frame) => ({
                  frame: Number(frame),
                  skill: 'touch' as SkillLabel,
                  class_id: SKILL_CLASS_IDS.touch,
                  confidence: 1,
                  source: 'auto' as const,
                }));
                payload = touchPayload;
                startFrame = 0;
                endFrame =
                  touchPayload.frame_count && touchPayload.frame_count > 0
                    ? touchPayload.frame_count - 1
                    : endFrame;
                console.log(`[batch] Side View Touch peaks: ${heuristicallyCorrected.length}`);
              }
              touchAssignSucceeded = true;
            } else if (item.events && item.events.length > 0) {
              console.log(
                `[batch] Skipping skill inference for ${item.name} — using existing events for player assignment.`,
              );
              heuristicallyCorrected = [...item.events];
            } else {
              payload = await inferSingleVideo(fileToInfer!, 'touch');
              const parsed = parsePredictionsFile(payload);
              heuristicallyCorrected = applySkillHeuristics(
                parsed.events,
                { start_frame: parsed.startFrame, end_frame: parsed.endFrame },
                payload?.frame_count ?? item.videoMetadata?.frame_count ?? 0,
              );
              startFrame = parsed.startFrame ?? startFrame;
              endFrame = parsed.endFrame ?? endFrame;
              console.log(
                `[batch] Original events: ${parsed.events.length}, Corrected events: ${heuristicallyCorrected.length}`,
              );
            }

            if (!useSideViewTouchOnly) {
            // Pass pre-existing player boxes as tracking JSON to bypass SparseRCNN.
            // Send the original (compact) JSON to the API; backend extends to full video length.
            const trackingBoxesForApi = (item.playerBoxes && Object.keys(item.playerBoxes).length > 0) 
              ? item.playerBoxes 
              : undefined;
            const videoFrameCount =
              (payload as { frame_count?: number } | null)?.frame_count ??
              item.videoMetadata?.frame_count ??
              0;
            const originalTrackingCoverage = getTrackingCoverage(trackingBoxesForApi);
            let displayPlayerBoxes = trackingBoxesForApi;
            if (trackingBoxesForApi && videoFrameCount > 0) {
              if (originalTrackingCoverage.maxFrame >= 0 && videoFrameCount > originalTrackingCoverage.maxFrame + 1) {
                console.log(
                  `[batch] Extending tracking for ${item.name}: ` +
                  `${originalTrackingCoverage.maxFrame + 1} tracked frames -> ${videoFrameCount} video frames (backend will extend for inference)`
                );
                displayPlayerBoxes = extendPlayerBoxesToFrameCount(trackingBoxesForApi, videoFrameCount);
              }
            }
            const eventsBeyondOriginalTracking = heuristicallyCorrected.filter(
              (ev) => originalTrackingCoverage.maxFrame >= 0 && ev.frame > originalTrackingCoverage.maxFrame
            );

            if (eventsBeyondOriginalTracking.length > 0) {
              console.warn(
                `[batch] ${eventsBeyondOriginalTracking.length} skill event(s) are beyond original tracking coverage ` +
                `for ${item.name}; backend will extend boxes for assignment`
              );
            }

            // Deep clone the player boxes to avoid React state mutation issues
            if (displayPlayerBoxes) {
              for (const [fStr, boxes] of Object.entries(displayPlayerBoxes)) {
                newPlayerBoxes[parseInt(fStr, 10)] = boxes.map(b => ({ ...b }));
              }
            } else if (item.playerBoxes) {
              for (const [fStr, boxes] of Object.entries(item.playerBoxes)) {
                newPlayerBoxes[parseInt(fStr, 10)] = boxes.map(b => ({ ...b }));
              }
            }
            
            touchAssignSucceeded = heuristicallyCorrected.length === 0;

            try {
              if (heuristicallyCorrected.length > 0) {
                if (!hasTouchTrackingData(item)) {
                  const stem = item.name.replace(/\.[^/.]+$/, '');
                  touchAssignSucceeded = false;
                  window.alert(
                    `Touch player assignment skipped for "${item.name}".\n\n` +
                    `No player tracking JSON was loaded. Upload the matching tracking JSON with the video ` +
                    `(for example "${stem}_resync_v2.json") in the same batch, then run inference again.`
                  );
                } else {
                const assignPayload = await inferAssignPlayer(
                  fileToInfer!,
                  heuristicallyCorrected,
                  trackingBoxesForApi,
                  inferenceEngine,
                  item.rawJsonString,
                );
                const assignEvents: AssignPlayerResult[] = assignPayload.events || [];
                touchAssignSucceeded = true;
                
                // 1. Update heuristicallyCorrected with player_id
                heuristicallyCorrected = heuristicallyCorrected.map(hc => {
                  const playerId = extractAssignedTrackId(findAssignmentForFrame(assignEvents, hc.frame));
                  return playerId !== undefined ? { ...hc, player_id: playerId } : hc;
                });

                // 2. Mark active player boxes for +/- 2 frames around each touch
                assignEvents.forEach((ev) => {
                  const frame = Number(ev.frame);
                  if (Number.isNaN(frame)) return;

                  const activeTrackId = extractAssignedTrackId(ev);
                  if (activeTrackId === undefined) return;

                  // Always activate the assigned track on existing tracking JSON boxes
                  markActivePlayerOnFrames(newPlayerBoxes, frame, activeTrackId, ev.pred_box_xyxy);

                  // Process candidates when SparseRCNN returns per-player boxes
                  if (ev.candidates && Array.isArray(ev.candidates)) {
                    ev.candidates.forEach((cand) => {
                      if (!cand.box || cand.box.length !== 4 || cand.tid === undefined) return;
                      const trackId = Number(cand.tid);
                      if (Number.isNaN(trackId)) return;
                      const isActive = trackId === activeTrackId;
                      const box = cand.box;

                      for (let f = frame - 2; f <= frame + 2; f++) {
                        if (!newPlayerBoxes[f]) newPlayerBoxes[f] = [];
                        const existingBox = newPlayerBoxes[f].find((b) => Number(b.track_id) === trackId);
                        if (!existingBox) {
                          newPlayerBoxes[f].push({
                            x_min: box[0],
                            y_min: box[1],
                            x_max: box[2],
                            y_max: box[3],
                            track_id: trackId,
                            is_active: isActive,
                          });
                        } else if (isActive) {
                          existingBox.is_active = true;
                        }
                      }
                    });
                  }
                });
                }
              }
            } catch (err) {
              touchAssignSucceeded = false;
              console.error('Touch player assignment failed for', item.name, err);
              const errText = err instanceof Error ? err.message : String(err);
              const payloadTooLarge = /exceeded maximum size|1024KB/i.test(errText);
              let guidance =
                'Check that the backend is running and the touch-player model is configured.';
              if (payloadTooLarge) {
                guidance =
                  'The tracking JSON upload was too large for the backend. Refresh the page and retry — ' +
                  'the app now sends compact tracking data and extends it on the server.';
              } else if (!hasTouchTrackingData(item)) {
                const stem = item.name.replace(/\.[^/.]+$/, '');
                guidance =
                  `Upload a matching tracking JSON alongside the video (for example "${stem}_resync_v2.json") ` +
                  `in the same batch upload, then run again.`;
              }
              window.alert(
                `Touch player assignment failed for "${item.name}". Skills were detected, but no players were auto-assigned.\n\n` +
                `${guidance}\n\n` +
                `Error: ${errText}`
              );
            }
            } // end !useSideViewTouchOnly
          }
          
          const videoFps = payload ? (payload as any).video_fps : null;
          const inferenceVideoMeta =
            workflowMode === 'ball' || workflowMode === 'vnl'
              ? buildInferenceVideoMeta(payload ?? {}) ?? item.inferenceVideoMeta
              : item.inferenceVideoMeta;
          const updatedVideoMetadata = (() => {
            if (workflowMode === 'ball' && inferenceVideoMeta) {
              return {
                filename: item.name,
                fps: inferenceVideoMeta.fps,
                frame_count: inferenceVideoMeta.frame_count,
                width: inferenceVideoMeta.width,
                height: inferenceVideoMeta.height,
                duration: inferenceVideoMeta.frame_count / inferenceVideoMeta.fps,
              };
            }
            if (workflowMode === 'vnl') {
              const inferred = buildVideoMetadataFromInference(item.name, payload, item.videoMetadata);
              if (!inferred) return item.videoMetadata ?? null;
              const browserDuration =
                videoRef.current && Number.isFinite(videoRef.current.duration) && videoRef.current.duration > 0
                  ? videoRef.current.duration
                  : item.videoMetadata?.duration ?? inferred.duration;
              return {
                ...inferred,
                duration: browserDuration,
                width: videoRef.current?.videoWidth || inferred.width,
                height: videoRef.current?.videoHeight || inferred.height,
              };
            }
            if (item.videoMetadata) {
              return {
                ...item.videoMetadata,
                fps: videoFps ?? item.videoMetadata.fps,
              };
            }
            return item.videoMetadata ?? null;
          })();
          
          const alignedManualActions = alignManualActionsToEvents(item.manualActions || [], heuristicallyCorrected, 5);
          if (alignedManualActions.length > 0 && item.rawJsonString) {
             // Re-apply any manual overrides but preserve the new AI tracking boxes
             const oldBoxes = parseJSONAnnotations(item.rawJsonString, alignedManualActions).parsed;
             for (const [frameStr, boxes] of Object.entries(oldBoxes)) {
               const f = parseInt(frameStr, 10);
               if (!newPlayerBoxes[f]) {
                 newPlayerBoxes[f] = boxes;
               } else {
                 // For frames that have AI predictions, we keep the AI boxes as they have the is_active status
               }
             }
          }

          const updatedItem = (workflowMode === 'touch' && !touchAssignSucceeded)
            ? {
                ...item,
                events: heuristicallyCorrected,
                manualActions: alignedManualActions,
                playerBoxes: newPlayerBoxes,
                rally: {
                  start_frame: startFrame ?? item.rally?.start_frame ?? null,
                  end_frame: endFrame ?? item.rally?.end_frame ?? null,
                },
                videoMetadata: updatedVideoMetadata,
                isTouchAlgorithmApplied: false,
                isSkillAlgorithmApplied: false,
              }
            : withAlgorithmApplied({
            ...item,
            events: heuristicallyCorrected,
            manualActions: alignedManualActions,
            playerBoxes: newPlayerBoxes,
            inferenceBallBoxes: workflowMode === 'ball' ? cloneBallBoxes(newPlayerBoxes) : item.inferenceBallBoxes,
            rejectedBallBoxes: workflowMode === 'ball' ? rejectedBallBoxes : item.rejectedBallBoxes,
            inferenceVideoMeta:
              workflowMode === 'ball' || workflowMode === 'vnl'
                ? inferenceVideoMeta
                : item.inferenceVideoMeta,
            rally: {
              start_frame: startFrame ?? item.rally?.start_frame ?? null,
              end_frame: endFrame ?? item.rally?.end_frame ?? null
            },
            videoMetadata: updatedVideoMetadata,
          }, workflowMode);

          setState(prev => {
            console.log(`[batch] setState callback. prev.currentPlaylistIndex=${prev.currentPlaylistIndex}, nextIndex=${nextIndex}`);
            const newPlaylist = [...prev.playlist];
            newPlaylist[nextIndex] = updatedItem;
            
            if (prev.currentPlaylistIndex === nextIndex) {
              console.log(`[batch] Updating main state events to length: ${heuristicallyCorrected.length}`);
              const next = {
                ...prev,
                playlist: newPlaylist,
                events: heuristicallyCorrected,
                rally: updatedItem.rally ?? prev.rally,
                playerBoxes: newPlayerBoxes,
                videoMetadata: updatedItem.videoMetadata ?? prev.videoMetadata,
              };
              stateRef.current = next;
              return next;
            }
            console.log(`[batch] NOT updating main state events! Mismatch index.`);
            const next = { ...prev, playlist: newPlaylist };
            stateRef.current = next;
            return next;
          });

          // Upload individual XML back to Google Drive
          if (googleTokenRef.current && (item.driveFolderId || item.driveXmlId)) {
            const xml = generateXMLString(
              item.videoMetadata || { filename: item.name, fps: 30, width: 0, height: 0, duration: 0, frame_count: 0 },
              updatedItem.rally ?? { start_frame: null, end_frame: null },
              heuristicallyCorrected,
              newPlayerBoxes,
              workflowMode,
            );
            const xmlBlob = new Blob([xml], { type: 'application/xml' });
            const xmlStem = item.name.replace(/\.[^/.]+$/, '');
            const xmlFilename = getXmlExportFilename(xmlStem, workflowMode);

            uploadToDrive(googleTokenRef.current!, item.driveFolderId, xmlFilename, xmlBlob, item.driveXmlId)
              .then(xmlId => {
                if (xmlId) {
                  setState(prev => {
                    const np = [...prev.playlist];
                    np[nextIndex] = { ...np[nextIndex], driveXmlId: xmlId };
                    return { ...prev, playlist: np };
                  });
                }
              }).catch(console.error);

          }
          
          const fps = payload ? ((payload as any).inference_fps || 0) : 0;
          const inferenceTime = payload ? ((payload as any).inference_time_sec || 0) : 0;
          setBatchProgress(prev => {
             const newCompleted = prev.completed + 1;
             const newAvg = prev.avgTimeSec === 0 ? inferenceTime : ((prev.avgTimeSec * prev.completed) + inferenceTime) / newCompleted;
             return { ...prev, completed: newCompleted, lastFps: fps, avgTimeSec: newAvg };
          });
        } catch (err) {
          console.error('Batch inference failed for', currentPlaylist[nextIndex].name, err);
          const pipelineLabel = appModeRef.current === 'ball'
            ? 'Ball tracking'
            : appModeRef.current === 'vnl'
              ? 'VNL event spotting'
              : 'Touch skill / player assignment';
          window.alert(
            `Failed to run ${pipelineLabel} for ${currentPlaylist[nextIndex].name}. ` +
            `Is your backend server running at ${INFERENCE_API_BASE}?\n\n` +
            `Error details: ${err}`,
          );
          processingRef.current = false;
          setBatchProgress(prev => ({ ...prev, isRunning: false }));
          return;
        }

        setTimeout(processNextRecursive, 0);
      };
      
      processNextRecursive();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchProgress.isRunning]);

  useEffect(() => {
    if (!batchProgress.isRunning) {
      processingRef.current = false;
    }
  }, [batchProgress.isRunning]);

  useEffect(() => {
    if (!batchProgress.isRunning && batchProgress.total > 0 && batchProgress.completed === batchProgress.total && state.playlist.length > 0) {
      const index = state.currentPlaylistIndex;
      const item = state.playlist[index];
      if (!videoUrlRef.current && item?.file) {
        assignVideoUrlFromFile(item.file);
      }
      if ((item.videoMetadata?.frame_count ?? 0) > 0 || (item.events?.length ?? 0) > 0) {
        setState((prev) => ({
          ...prev,
          events: item.events ?? prev.events,
          rally: item.rally ?? prev.rally,
          videoMetadata: item.videoMetadata ?? prev.videoMetadata,
        }));
      }
    }
  }, [batchProgress.isRunning, batchProgress.completed, batchProgress.total, state.playlist, state.currentPlaylistIndex, assignVideoUrlFromFile]);

  // Autosave per workflow mode (touch and ball stay isolated)
  useEffect(() => {
    if (appMode !== 'touch' && appMode !== 'touch_block' && appMode !== 'ball' && appMode !== 'vnl') return;

    console.log(`[DEBUG] state.events changed! Length: ${state.events.length}`);
    const currentPlaylist = [...state.playlist];
    if (currentPlaylist.length > 0 && currentPlaylist[state.currentPlaylistIndex]) {
      currentPlaylist[state.currentPlaylistIndex] = {
        ...currentPlaylist[state.currentPlaylistIndex],
        events: state.events,
        rally: state.rally,
        manualActions: state.manualActions,
        playerBoxes: state.playerBoxes,
        videoMetadata: state.videoMetadata,
        isCompleted: (state.rally.start_frame !== null && state.rally.end_frame !== null),
      };
    }

    persistWorkflowState(appMode, {
      ...state,
      playlist: currentPlaylist,
    });

    if (OFFLINE_REVIEW_ONLY && appMode === 'vnl' && vnlFolderKeyRef.current) {
      persistVnlFolder(vnlFolderKeyRef.current, vnlFolderLabelRef.current, {
        ...state,
        playlist: currentPlaylist,
      });
    }
    if (appMode === 'touch_block' && touchBlockFolderKeyRef.current) {
      persistTouchBlockFolder(touchBlockFolderKeyRef.current, touchBlockFolderLabelRef.current, {
        ...state,
        playlist: currentPlaylist,
      });
    }
  }, [state, appMode]);

  const loadVideoIntoPlayer = (item: PlaylistItem) => {
    if (item.file) {
      const cached = gpuFileReadyRef.current.get(item.id);
      if (OFFLINE_REVIEW_ONLY) {
        // Prefer memory/IndexedDB H.264; otherwise play original (onError will convert once and cache).
        if (cached) {
          assignVideoUrlFromFile(cached);
          setVideoPlaybackKind(cached === item.file ? 'direct' : 'h264');
        } else if (looksLikeH264Filename(item.file.name)) {
          assignVideoUrlFromFile(item.file);
          setVideoPlaybackKind('direct');
          gpuFileReadyRef.current.set(item.id, item.file);
        } else {
          const original = item.file;
          void getCachedH264(original).then((fromDisk) => {
            const stillCurrent =
              stateRef.current.playlist[stateRef.current.currentPlaylistIndex]?.id === item.id;
            if (!stillCurrent) return;
            if (fromDisk) {
              gpuFileReadyRef.current.set(item.id, fromDisk);
              assignVideoUrlFromFile(fromDisk);
              setVideoPlaybackKind('h264');
              setState((prev) => {
                const playlist = [...prev.playlist];
                const idx = playlist.findIndex((p) => p.id === item.id);
                if (idx < 0) return prev;
                playlist[idx] = { ...playlist[idx], file: fromDisk };
                const next = { ...prev, playlist };
                stateRef.current = next;
                return next;
              });
            } else {
              assignVideoUrlFromFile(original);
              setVideoPlaybackKind('direct');
            }
          });
        }
      } else if (appMode === 'ball' || appMode === 'touch') {
        assignVideoUrlFromFile(cached ?? item.file);
        setVideoPlaybackKind(cached && cached !== item.file ? 'h264' : 'direct');
      } else {
        // Local VNL: play MP4 directly; convert only on decode error.
        assignVideoUrlFromFile(cached ?? item.file);
        setVideoPlaybackKind(cached && cached !== item.file ? 'h264' : 'direct');
      }
    } else if (item.driveUrl) {
      if (googleTokenRef.current) {
        assignVideoUrlFromRemote(`${item.driveUrl}&access_token=${googleTokenRef.current}`);
      } else {
        assignVideoUrlFromRemote(item.driveUrl);
      }
    } else {
      setVideoPlaybackError('Video file not in memory. Re-upload the MP4 to view playback.');
    }

    const itemMeta = item.inferenceVideoMeta;
    const baseMetadata = item.videoMetadata || {
      filename: item.name,
      fps: 30,
      width: 0,
      height: 0,
      duration: 0,
      frame_count: 0,
    };
    const syncedMetadata =
      (appMode === 'ball' || appMode === 'vnl') && itemMeta
        ? {
            filename: item.name,
            fps: itemMeta.fps,
            frame_count: itemMeta.frame_count,
            width: itemMeta.width,
            height: itemMeta.height,
            duration: itemMeta.frame_count / itemMeta.fps,
          }
        : baseMetadata;

    const repairedMetadata =
      appMode === 'vnl' && syncedMetadata.frame_count === 0 && (item.events?.length ?? 0) > 0
        ? {
            ...syncedMetadata,
            frame_count: Math.max(
              item.rally?.end_frame ?? 0,
              ...item.events!.map((e) => e.frame),
            ) + 1,
          }
        : syncedMetadata;

    setState(prev => ({
      ...prev,
      videoMetadata: repairedMetadata,
      rally: item.rally || { start_frame: null, end_frame: null },
      events: item.events || [],
      playerBoxes: item.playerBoxes || {},
      manualActions: item.manualActions || [],
      currentFrame: 0
    }));
    setBallEditMode(false);
    stopAutoStep();
  };

  const handlePlaylistFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const workflowMode: WorkflowMode =
      appModeRef.current === 'ball'
        ? 'ball'
        : appModeRef.current === 'vnl'
          ? 'vnl'
          : appModeRef.current === 'touch_block'
            ? 'touch_block'
            : 'touch';
    
    const fileArray = Array.from(files);
    const videoFiles = fileArray.filter(f => f.type.startsWith('video/') || f.name.toLowerCase().endsWith('.mp4'));
    const zipFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.zip'));
    const jsonFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.json'));
    const xmlFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.xml'));
    
    let parsedAnnotations: Record<string, any> = {};
    let parsedJsonAnnotations: Record<string, any> = {};
    let extractedVideos: File[] = [];
    if (zipFiles.length > 0) {
      try {
        const result = await parseZIPAnnotations(zipFiles[0]);
        parsedAnnotations = result.annotations;
        parsedJsonAnnotations = result.jsonAnnotations || {};
        extractedVideos = result.videos;
        console.log(`Loaded annotations for ${Object.keys(parsedAnnotations).length} videos from ZIP.`);
        console.log(`Extracted ${extractedVideos.length} videos from ZIP.`);
      } catch (e) {
        console.error("Error parsing ZIP", e);
        window.alert("Failed to read the ZIP file. It may be too large or corrupted.");
      }
    }

    for (const jsonFile of jsonFiles) {
      try {
        const text = await jsonFile.text();
        const result = parseJSONAnnotations(text, []);
        let stem = normalizeAnnotationStem(jsonFile.name.replace(/\.json$/i, ''));
        parsedJsonAnnotations[stem] = result;
      } catch (err) {
        console.error(`Failed to parse standalone JSON: ${jsonFile.name}`, err);
      }
    }

    for (const xmlFile of xmlFiles) {
      try {
        const text = await xmlFile.text();
        const parsed = parseXMLAnnotations(text);
        let stem = normalizeAnnotationStem(xmlFile.name.replace(/\.xml$/i, ''));
        parsedAnnotations[stem] = parsed;
      } catch (err) {
        console.error(`Failed to parse standalone XML: ${xmlFile.name}`, err);
      }
    }

    const allVideoFiles = [...videoFiles, ...extractedVideos];

    if (allVideoFiles.length === 0) {
      window.alert("No video files found! Please upload MP4 videos along with your ZIP file, or ensure your ZIP contains MP4s.");
      return;
    }
    // GitHub Pages: MP4-only uploads are fine for manual VNL / touch / ball annotation.
    // XML/JSON is optional (only needed when reviewing existing predictions).

    gpuFileReadyRef.current.clear();

    let vnlFolderSnapshot = null;
    let touchBlockFolderSnapshot = null;
    if (workflowMode === 'vnl' && allVideoFiles.length > 0) {
      const folderKey = computeVnlFolderKey(allVideoFiles.map((f) => f.name));
      vnlFolderKeyRef.current = folderKey;
      vnlFolderLabelRef.current = getVnlFolderLabelFromFiles(allVideoFiles);
      vnlFolderSnapshot = loadVnlFolder(folderKey);
      setVnlAwaitingFolder(false);
    }
    if (workflowMode === 'touch_block' && allVideoFiles.length > 0) {
      const folderKey = computeTouchBlockFolderKey(allVideoFiles.map((f) => f.name));
      touchBlockFolderKeyRef.current = folderKey;
      touchBlockFolderLabelRef.current = getTouchBlockFolderLabelFromFiles(allVideoFiles);
      touchBlockFolderSnapshot = loadTouchBlockFolder(folderKey);
      setTouchBlockAwaitingFolder(false);
    }

    const newPlaylistItems: PlaylistItem[] = await Promise.all(allVideoFiles.map(async (file) => {
      const displayName = file.name.replace(/^.*[/\\]/, '') || file.name;
      let existing = stateRef.current.playlist.find(
        (p) => p.name === displayName || p.name.replace(/^.*[/\\]/, '') === displayName,
      );
      const storedItem = workflowMode === 'vnl'
        ? findStoredVnlItem(vnlFolderSnapshot, displayName)
        : workflowMode === 'touch_block'
          ? findStoredTouchBlockItem(touchBlockFolderSnapshot, displayName)
          : undefined;

      let itemEvents = workflowMode === 'ball' ? [] : (existing?.events || storedItem?.events || []);
      let itemRally = existing?.rally || storedItem?.rally || { start_frame: null, end_frame: null };
      const itemId =
        workflowMode === 'vnl' || workflowMode === 'touch_block'
          ? displayName
          : `${displayName}${file.lastModified}`;
      const isNewUpload =
        workflowMode === 'vnl' || workflowMode === 'touch_block'
          ? !existing && !storedItem
          : (!existing || existing.id !== itemId);
      let isApplied = existing && !isNewUpload ? isItemAlgorithmApplied(existing, workflowMode) : false;
      if (workflowMode === 'vnl') {
        // VNL is manual annotation: never auto-infer. Restore browser-saved labels when re-opening folder.
        isApplied = (itemEvents.length > 0) || !!storedItem || !!existing;
        if (storedItem?.events?.length) {
          itemEvents = storedItem.events;
          itemRally = storedItem.rally ?? itemRally;
        }
      }
      if (workflowMode === 'touch_block') {
        isApplied = true;
        if (storedItem?.rally) itemRally = storedItem.rally;
      }
      let itemPlayerBoxes = workflowMode === 'ball' ? {} : (existing?.playerBoxes || {});
      let itemRawJson = workflowMode === 'ball' ? undefined : (existing?.rawJsonString || undefined);
      let itemManualActions = workflowMode === 'ball'
        ? []
        : (existing?.manualActions || storedItem?.manualActions || []);
      let jsonFps: number | undefined = undefined;

      const nativeFps = await detectVideoFps(file);

      const stem = file.name.replace(/\.[^/.]+$/, '');
      const matchAnnotationKey = (keys: string[]): string => {
        if (keys.includes(stem)) return stem;
        const stemNorm = normalizeAnnotationStem(stem);
        if (keys.includes(stemNorm)) return stemNorm;
        const found = keys.find((k) => annotationKeysMatch(stem, k));
        return found || stem;
      };
      const xmlKey = matchAnnotationKey(Object.keys(parsedAnnotations));
      const jsonKey = matchAnnotationKey(Object.keys(parsedJsonAnnotations));

      if (isTouchFamilyMode(workflowMode) && parsedAnnotations[xmlKey]) {
        if (
          workflowMode === 'touch_block' ||
          !existing ||
          (!isItemAlgorithmApplied(existing, workflowMode) && (!existing.events || existing.events.length === 0))
        ) {
          const xmlEvents = parsedAnnotations[xmlKey].events as SkillEvent[];
          const xmlRally = parsedAnnotations[xmlKey].rally;
          if (workflowMode === 'touch_block') {
            // Keep XML skills; merge browser-saved blocks + ball dots so refresh does not wipe work.
            itemEvents = mergeTouchBlockEvents(xmlEvents, storedItem?.events || existing?.events);
            itemRally = storedItem?.rally || existing?.rally || xmlRally;
          } else {
            itemEvents = xmlEvents;
            itemRally = xmlRally;
          }
          isApplied = OFFLINE_REVIEW_ONLY || workflowMode === 'touch_block';
        }
      } else if (isTouchFamilyMode(workflowMode) && (OFFLINE_REVIEW_ONLY || workflowMode === 'touch_block')) {
        // Manual skill / block annotation — MP4 only is allowed; XML preferred for touch_block.
        isApplied = true;
        if (workflowMode === 'touch_block' && (storedItem?.events?.length || existing?.events?.length)) {
          itemEvents = mergeTouchBlockEvents(itemEvents, storedItem?.events || existing?.events);
        }
      } else if (workflowMode === 'vnl' && parsedAnnotations[xmlKey]) {
        // VNL is always manual: load XML if present, never queue inference.
        itemEvents = parsedAnnotations[xmlKey].events;
        itemRally = parsedAnnotations[xmlKey].rally;
        isApplied = true;
      } else if (workflowMode === 'ball') {
        if (parsedJsonAnnotations[jsonKey]?.parsed && Object.keys(parsedJsonAnnotations[jsonKey].parsed).length > 0) {
          itemPlayerBoxes = parsedJsonAnnotations[jsonKey].parsed;
          itemRawJson = parsedJsonAnnotations[jsonKey].rawJsonString;
          jsonFps = parsedJsonAnnotations[jsonKey].videoFps;
          isApplied = true;
        } else if (parsedAnnotations[xmlKey]?.playerBoxes && Object.keys(parsedAnnotations[xmlKey].playerBoxes).length > 0) {
          itemPlayerBoxes = parsedAnnotations[xmlKey].playerBoxes;
          isApplied = true;
        } else if (OFFLINE_REVIEW_ONLY) {
          // Manual ball annotation on GitHub — open MP4 with empty boxes; no prediction ZIP required.
          isApplied = true;
          itemPlayerBoxes = existing?.playerBoxes || {};
        }
      }

      if (itemEvents.length > 0 && itemManualActions.length > 0) {
        itemManualActions = alignManualActionsToEvents(itemManualActions, itemEvents, 5);
      }

      if (isTouchFamilyMode(workflowMode) && parsedJsonAnnotations[jsonKey]) {
        const parsedResult = itemManualActions.length > 0 
          ? parseJSONAnnotations(parsedJsonAnnotations[jsonKey].rawJsonString, itemManualActions)
          : parsedJsonAnnotations[jsonKey];
          
        itemPlayerBoxes = parsedResult.parsed;
        itemRawJson = parsedResult.rawJsonString;
        jsonFps = parsedResult.videoFps;
      }
      
      const finalFps = nativeFps || jsonFps || existing?.videoMetadata?.fps || 30;

      let newVideoMetadata = existing?.videoMetadata || null;
      if (newVideoMetadata) {
        newVideoMetadata = { ...newVideoMetadata, fps: finalFps };
      } else {
        newVideoMetadata = { filename: file.name, fps: finalFps, width: 0, height: 0, duration: 0, frame_count: 0 };
      }

      return {
        id: itemId,
        name: displayName,
        file,
        events: itemEvents,
        rally: itemRally,
        playerBoxes: itemPlayerBoxes,
        inferenceBallBoxes: workflowMode === 'ball' ? cloneBallBoxes(itemPlayerBoxes) : existing?.inferenceBallBoxes,
        rawJsonString: itemRawJson,
        manualActions: itemManualActions,
        isTouchAlgorithmApplied: isTouchFamilyMode(workflowMode) ? isApplied : existing?.isTouchAlgorithmApplied,
        isBallAlgorithmApplied: workflowMode === 'ball' ? isApplied : existing?.isBallAlgorithmApplied,
        isSkillAlgorithmApplied: isTouchFamilyMode(workflowMode) ? isApplied : existing?.isSkillAlgorithmApplied,
        isVnlAlgorithmApplied: workflowMode === 'vnl' ? isApplied : existing?.isVnlAlgorithmApplied,
        videoMetadata: newVideoMetadata,
        isCompleted: existing?.isCompleted || false
      };
    }));

    const total = newPlaylistItems.length;
    // Hosted builds never call localhost or run inference. Even unmatched videos
    // remain available for manual correction instead of starting the batch worker.
    const completed = OFFLINE_REVIEW_ONLY
      ? total
      : newPlaylistItems.filter((p) => isItemAlgorithmApplied(p, workflowMode)).length;

    const syncIndex =
      workflowMode === 'vnl' && vnlFolderSnapshot
        ? Math.min(
            Math.max(0, vnlFolderSnapshot.currentPlaylistIndex),
            Math.max(0, newPlaylistItems.length - 1),
          )
        : workflowMode === 'touch_block' && touchBlockFolderSnapshot
          ? Math.min(
              Math.max(0, touchBlockFolderSnapshot.currentPlaylistIndex),
              Math.max(0, newPlaylistItems.length - 1),
            )
          : 0;
    const syncItem = newPlaylistItems[syncIndex] ?? newPlaylistItems[0];
    const isRestoring = stateRef.current.videoMetadata?.filename === syncItem?.name;
    const savedFrame =
      workflowMode === 'vnl' && vnlFolderSnapshot
        ? (vnlFolderSnapshot.playlist[syncIndex]?.savedFrame ?? 0)
        : workflowMode === 'touch_block' && touchBlockFolderSnapshot
          ? (touchBlockFolderSnapshot.playlist[syncIndex]?.savedFrame ?? 0)
          : (isRestoring ? stateRef.current.currentFrame : 0);
    const syncedState: AppState = {
      ...stateRef.current,
      playlist: newPlaylistItems,
      currentPlaylistIndex: syncIndex,
      videoMetadata: syncItem?.videoMetadata || {
        filename: syncItem?.name ?? '',
        fps: 30,
        width: 0,
        height: 0,
        duration: 0,
        frame_count: 0,
      },
      rally: syncItem?.rally || { start_frame: null, end_frame: null },
      events: syncItem?.events || [],
      playerBoxes: syncItem?.playerBoxes || {},
      currentFrame: savedFrame,
    };
    stateRef.current = syncedState;
    setState(syncedState);

    if (workflowMode === 'vnl' && vnlFolderKeyRef.current) {
      persistVnlFolder(vnlFolderKeyRef.current, vnlFolderLabelRef.current, syncedState);
    }
    if (workflowMode === 'touch_block' && touchBlockFolderKeyRef.current) {
      persistTouchBlockFolder(touchBlockFolderKeyRef.current, touchBlockFolderLabelRef.current, syncedState);
    }

    if (syncItem?.file) {
      if (OFFLINE_REVIEW_ONLY) {
        // Prefer previously converted H.264 from IndexedDB (survives refresh).
        let playFile = syncItem.file;
        if (!looksLikeH264Filename(syncItem.file.name)) {
          const cached = await getCachedH264(syncItem.file);
          if (cached) {
            playFile = cached;
            gpuFileReadyRef.current.set(syncItem.id, cached);
            const playlist = [...syncedState.playlist];
            const idx = playlist.findIndex((p) => p.id === syncItem.id);
            if (idx >= 0) playlist[idx] = { ...playlist[idx], file: cached };
            syncedState.playlist = playlist;
            stateRef.current = syncedState;
            setState(syncedState);
          }
        } else {
          gpuFileReadyRef.current.set(syncItem.id, syncItem.file);
        }
        assignVideoUrlFromFile(playFile);
        setVideoPlaybackKind(playFile === syncItem.file ? 'direct' : 'h264');
      } else if (workflowMode === 'vnl') {
        // Local VNL: try MP4 first; convert on decode error.
        assignVideoUrlFromFile(syncItem.file);
        setVideoPlaybackKind('direct');
      } else {
        assignVideoUrlFromFile(syncItem.file);
      }
    }

    // Warm playlist cache from IndexedDB in the background (same browser, after refresh).
    if (OFFLINE_REVIEW_ONLY) {
      void Promise.all(
        newPlaylistItems.map(async (item) => {
          if (!item.file || looksLikeH264Filename(item.file.name) || gpuFileReadyRef.current.has(item.id)) {
            return;
          }
          const cached = await getCachedH264(item.file);
          if (!cached) return;
          gpuFileReadyRef.current.set(item.id, cached);
          setState((prev) => {
            const playlist = [...prev.playlist];
            const idx = playlist.findIndex((p) => p.id === item.id);
            if (idx < 0) return prev;
            playlist[idx] = { ...playlist[idx], file: cached };
            const next = { ...prev, playlist };
            stateRef.current = next;
            return next;
          });
        }),
      );
    }

    // GitHub/local review: trust *_h264 exports from inference; never playlist-wide re-convert.
    newPlaylistItems.forEach((item) => {
      if (item.file && looksLikeH264Filename(item.file.name)) {
        gpuFileReadyRef.current.set(item.id, item.file);
      }
    });

    if (total > 0) {
      processingRef.current = false;
      const runBatch =
        workflowMode !== 'vnl' &&
        workflowMode !== 'touch_block' &&
        !OFFLINE_REVIEW_ONLY &&
        completed < total;
      setBatchProgress({
        isRunning: runBatch,
        completed: workflowMode === 'vnl' ? total : completed,
        total,
        lastFps: 0,
        avgTimeSec: 0,
      });
    }
  };


  const saveCurrentVideoState = () => {
    setState(prev => {
      const newPlaylist = [...prev.playlist];
      if (prev.playlist.length > 0) {
        newPlaylist[prev.currentPlaylistIndex] = {
          ...newPlaylist[prev.currentPlaylistIndex],
          videoMetadata: prev.videoMetadata,
          rally: prev.rally,
          events: prev.events,
          manualActions: prev.manualActions,
          playerBoxes: prev.playerBoxes,
          isCompleted: (prev.rally.start_frame !== null && prev.rally.end_frame !== null)
        };
      }
      return { ...prev, playlist: newPlaylist };
    });
  };

  const changeVideo = (index: number) => {
    if (index >= 0 && index < state.playlist.length) {
      saveCurrentVideoState();
      
      setState(prev => ({
        ...prev,
        currentPlaylistIndex: index
      }));
      
      setTimeout(() => {
        setState(prev => {
          loadVideoIntoPlayer(prev.playlist[index]);
          return prev;
        });
      }, 0);
    }
  };

  const currentPlaylistItem = state.playlist[state.currentPlaylistIndex];
  const playbackTiming = useMemo(
    () => getTimingForMode(
      appMode,
      state.videoMetadata,
      (appMode === 'ball' || appMode === 'vnl') ? currentPlaylistItem?.inferenceVideoMeta : undefined,
    ),
    [state.videoMetadata, appMode, currentPlaylistItem?.inferenceVideoMeta],
  );

  const handleVideoLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const currentState = stateRef.current;
    const item = currentState.playlist[currentState.currentPlaylistIndex];
    const currentMeta = currentState.videoMetadata;
    const mode = appModeRef.current;
    const timing = getTimingForMode(
      mode,
      currentMeta,
      (mode === 'ball' || mode === 'vnl') ? item?.inferenceVideoMeta : undefined,
    );

    if (mode === 'ball') {
      const rvfc = (v as unknown as {
        requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
      }).requestVideoFrameCallback?.bind(v);
      const targetFrame = currentState.currentFrame;
      const seekToTarget = () => {
        if (targetFrame > 0) {
          v.currentTime = frameToMediaTime(targetFrame, timing.fps, ballBaseTimeRef.current ?? 0);
        }
      };
      if (rvfc) {
        if (v.currentTime !== 0) v.currentTime = 0;
        rvfc((_now, meta) => {
          ballBaseTimeRef.current = meta.mediaTime;
          seekToTarget();
        });
      } else {
        ballBaseTimeRef.current = 0;
        seekToTarget();
      }
    } else if (mode === 'vnl' && item?.inferenceVideoMeta) {
      if (currentState.currentFrame > 0) {
        v.currentTime = vnlMapFrameToTime(
          currentState.currentFrame,
          item.inferenceVideoMeta.frame_count,
          duration,
          item.inferenceVideoMeta.fps,
        );
      }
    } else if (currentState.currentFrame > 0) {
      v.currentTime = frameToTime(currentState.currentFrame, timing.fps, false);
    }

    v.playbackRate = playbackRate;

    setState((prev) => {
      const prevItem = prev.playlist[prev.currentPlaylistIndex];
      const inferMeta = prevItem?.inferenceVideoMeta;
      const filename = prev.videoMetadata?.filename ?? prevItem?.name ?? 'video.mp4';
      if (mode === 'vnl' && inferMeta) {
        return {
          ...prev,
          videoMetadata: {
            filename,
            width: v.videoWidth || inferMeta.width || prev.videoMetadata?.width || 1280,
            height: v.videoHeight || inferMeta.height || prev.videoMetadata?.height || 720,
            duration,
            fps: inferMeta.fps,
            frame_count: inferMeta.frame_count,
          },
        };
      }
      const prevTiming = getBallPlaybackTiming(
        prev.videoMetadata,
        mode === 'ball' ? inferMeta : undefined,
      );
      const keepInferenceTiming = mode === 'ball' && !!inferMeta;
      const browserFrameCount = Math.ceil(duration * prevTiming.fps);
      return {
        ...prev,
        videoMetadata: {
          filename,
          width: v.videoWidth || prev.videoMetadata?.width || prevTiming.width,
          height: v.videoHeight || prev.videoMetadata?.height || prevTiming.height,
          duration,
          fps: prevTiming.fps,
          frame_count: keepInferenceTiming
            ? Math.max(inferMeta!.frame_count, browserFrameCount)
            : Math.max(browserFrameCount, prev.videoMetadata?.frame_count ?? 0),
        },
      };
    });
  };

  const seekToFrame = useCallback((frame: number) => {
    if (!videoRef.current) return;
    const item = state.playlist[state.currentPlaylistIndex];
    const timing = getTimingForMode(
      appMode,
      state.videoMetadata,
      (appMode === 'ball' || appMode === 'vnl') ? item?.inferenceVideoMeta : undefined,
    );
    const maxFrame = Math.max(0, timing.frame_count - 1);
    const safeFrame = Math.max(0, Math.min(frame, maxFrame));
    const video = videoRef.current;

    let targetTime: number;
    // In ball mode, anchor frame->time to the calibrated base PTS so the seek
    // lands on the exact frame the inference indexed (decode order), for every rally.
    if (appMode === 'ball') {
      targetTime = ballBaseTimeRef.current !== null
        ? frameToMediaTime(safeFrame, timing.fps, ballBaseTimeRef.current)
        : frameToTimeByDuration(safeFrame, video.duration, timing.frame_count);
    } else if (appMode === 'vnl' && item?.inferenceVideoMeta && video.duration > 0) {
      targetTime = vnlMapFrameToTime(
        safeFrame,
        item.inferenceVideoMeta.frame_count,
        video.duration,
        item.inferenceVideoMeta.fps,
      );
    } else {
      targetTime = frameToTime(safeFrame, timing.fps, false);
    }

    if (!Number.isFinite(targetTime)) return;

    // While step-play / hold-seek is active, wait for each seek to land before
    // requesting the next frame. Updating currentTime faster than decode freezes
    // the picture while the frame counter keeps racing ahead.
    const stepping =
      autoStepIntervalRef.current !== null || seekIntervalRef.current !== null;

    if (seekTimeoutRef.current) {
      clearTimeout(seekTimeoutRef.current);
      seekTimeoutRef.current = null;
    }

    const alreadyThere = Math.abs(video.currentTime - targetTime) < 1e-4;
    if (!alreadyThere) {
      isSeekingRef.current = true;
      pendingSeekFrameRef.current = safeFrame;
      video.currentTime = targetTime;
      // Some browsers skip 'seeked' when the assigned time rounds to the same media time.
      seekTimeoutRef.current = setTimeout(() => {
        if (pendingSeekFrameRef.current === safeFrame) {
          isSeekingRef.current = false;
          pendingSeekFrameRef.current = null;
        }
        seekTimeoutRef.current = null;
      }, 350);
    } else {
      isSeekingRef.current = false;
      pendingSeekFrameRef.current = null;
    }

    setState(prev => {
      let newBoxes = prev.playerBoxes;

      if (appMode === 'ball' && ballEditMode && safeFrame === prev.currentFrame + 1) {
        const currentBoxes = prev.playerBoxes[prev.currentFrame] || [];
        const nextBoxes = prev.playerBoxes[safeFrame] || [];
        if (currentBoxes.length > 0 && nextBoxes.length === 0) {
          newBoxes = {
            ...prev.playerBoxes,
            [safeFrame]: [{ ...currentBoxes[0], source: 'manual' as const }],
          };
        }
      } else if (appMode !== 'ball' && safeFrame === prev.currentFrame + 1) {
        const currentBoxes = prev.playerBoxes[prev.currentFrame] || [];
        const nextBoxes = prev.playerBoxes[safeFrame] || [];
        const missingBoxes = currentBoxes.filter(
          cb => !nextBoxes.some(nb => nb.track_id === cb.track_id)
        );

        if (missingBoxes.length > 0) {
          const copiedBoxes = missingBoxes.map(b => ({ ...b }));
          newBoxes = {
            ...prev.playerBoxes,
            [safeFrame]: [...nextBoxes, ...copiedBoxes]
          };
        }
      }

      // During step-play, let onSeeked / presented-frame drive currentFrame so the
      // counter cannot outrun the pixels on screen.
      const frameUpdate =
        video.paused && !stepping ? { currentFrame: safeFrame } : {};
      if (newBoxes !== prev.playerBoxes) {
        return { ...prev, ...frameUpdate, playerBoxes: newBoxes };
      }
      if (video.paused && !stepping && safeFrame !== prev.currentFrame) {
        return { ...prev, currentFrame: safeFrame };
      }
      // Still bump the counter when already on the target (seeked may not fire).
      if (video.paused && stepping && alreadyThere && safeFrame !== prev.currentFrame) {
        return { ...prev, currentFrame: safeFrame };
      }
      return prev;
    });
  }, [state.videoMetadata, state.playlist, state.currentPlaylistIndex, appMode, ballEditMode]);

  /** Touch Skill Block Only: ←/→ jump between attack frames (all other skills stay visible). */
  const seekAdjacentAttack = useCallback((direction: -1 | 1) => {
    const events = stateRef.current.events || [];
    const attacks = events
      .filter((e) => e.skill === 'attack' || e.skill === 'spike')
      .map((e) => e.frame)
      .sort((a, b) => a - b);
    if (attacks.length === 0) {
      window.alert('No attack labels found in this video. Load an XML that includes attack tags.');
      return;
    }
    const current = stateRef.current.currentFrame;
    if (direction > 0) {
      const next = attacks.find((f) => f > current) ?? attacks[0];
      seekToFrame(next);
    } else {
      const prev = [...attacks].reverse().find((f) => f < current) ?? attacks[attacks.length - 1];
      seekToFrame(prev);
    }
  }, [seekToFrame]);

  const seekNextPendingAttack = useCallback(() => {
    const next = findNextPendingAttackFrame(stateRef.current.events || [], stateRef.current.currentFrame);
    if (next === null) {
      window.alert('All attacks already have a block + ball contact dot.');
      return;
    }
    seekToFrame(next);
  }, [seekToFrame]);

  const attackBlockProgress = useMemo(
    () => (appMode === 'touch_block' ? buildAttackBlockProgress(state.events || []) : []),
    [appMode, state.events],
  );

  const attackProgressSummary = useMemo(() => {
    if (appMode !== 'touch_block') return null;
    const done = attackBlockProgress.filter((p) => p.status === 'done').length;
    const partial = attackBlockProgress.filter((p) => p.status === 'block_no_dot').length;
    const pending = attackBlockProgress.filter((p) => p.status === 'pending').length;
    return { total: attackBlockProgress.length, done, partial, pending };
  }, [appMode, attackBlockProgress]);

  // Re-align playback when VNL inference metadata arrives (after batch) or preview source changes.
  useEffect(() => {
    if (appMode !== 'vnl' || !currentPlaylistItem?.inferenceVideoMeta?.frame_count) return;
    if (!videoRef.current || !Number.isFinite(videoRef.current.duration) || videoRef.current.duration <= 0) return;
    seekToFrame(stateRef.current.currentFrame);
  }, [
    appMode,
    currentPlaylistItem?.inferenceVideoMeta?.frame_count,
    videoUrl,
    videoPlaybackKind,
    seekToFrame,
  ]);

  const ballBoxesForDisplay = useMemo((): Record<number, PlayerBox[]> => {
    if (appMode !== 'ball') return state.playerBoxes;
    if (ballEditMode) return state.playerBoxes;
    const item = currentPlaylistItem;
    // Use the saved working copy (includes draws/moves/deletes), not raw inference.
    return item?.playerBoxes ?? state.playerBoxes;
  }, [appMode, ballEditMode, state.playerBoxes, currentPlaylistItem?.playerBoxes]);

  const rejectedBallBoxesForDisplay = useMemo((): Record<number, PlayerBox[]> => {
    if (appMode !== 'ball' || ballEditMode || !showRejectedBallBoxes) return {};
    return currentPlaylistItem?.rejectedBallBoxes ?? {};
  }, [appMode, ballEditMode, showRejectedBallBoxes, currentPlaylistItem?.rejectedBallBoxes]);

  const ballOverlayFrame = useMemo(() => {
    if (appMode === 'ball' && presentedBallFrame !== null) {
      return presentedBallFrame;
    }
    return state.currentFrame;
  }, [appMode, presentedBallFrame, state.currentFrame]);

  const toggleBallEditMode = () => {
    if (appMode !== 'ball') return;
    setBallEditMode((prev) => {
      const next = !prev;
      if (next) {
        setState((s) => {
          const item = s.playlist[s.currentPlaylistIndex];
          const base = mergeBallBoxes(item?.inferenceBallBoxes, item?.playerBoxes ?? s.playerBoxes);
          const editable = cloneBallBoxes(base);
          const newPlaylist = [...s.playlist];
          if (newPlaylist[s.currentPlaylistIndex]) {
            newPlaylist[s.currentPlaylistIndex] = {
              ...newPlaylist[s.currentPlaylistIndex],
              playerBoxes: editable,
            };
          }
          return { ...s, playlist: newPlaylist, playerBoxes: editable };
        });
      } else {
        setState((s) => {
          const edited = cloneBallBoxes(s.playerBoxes);
          const newPlaylist = [...s.playlist];
          if (newPlaylist[s.currentPlaylistIndex]) {
            newPlaylist[s.currentPlaylistIndex] = {
              ...newPlaylist[s.currentPlaylistIndex],
              playerBoxes: edited,
            };
          }
          return { ...s, playlist: newPlaylist, playerBoxes: edited };
        });
      }
      return next;
    });
  };

  const stopAutoStep = useCallback(() => {
    if (autoStepIntervalRef.current) {
      clearInterval(autoStepIntervalRef.current);
      autoStepIntervalRef.current = null;
    }
    setIsAutoStepping(false);
    videoRef.current?.pause();
  }, []);

  const startAutoStep = useCallback((direction: 1 | -1 = 1) => {
    if (autoStepIntervalRef.current) {
      clearInterval(autoStepIntervalRef.current);
      autoStepIntervalRef.current = null;
    }
    videoRef.current?.pause();
    setIsAutoStepping(true);

    const tick = () => {
      if (appModeRef.current !== 'ball') {
        stopAutoStep();
        return;
      }
      // Wait until the previous seek actually painted before advancing.
      if (isSeekingRef.current) return;
      const s = stateRef.current;
      const item = s.playlist[s.currentPlaylistIndex];
      const timing = getBallPlaybackTiming(s.videoMetadata, item?.inferenceVideoMeta);
      const maxFrame = Math.max(0, timing.frame_count - 1);
      const base = pendingSeekFrameRef.current ?? s.currentFrame;
      const next = base + direction;
      if (next < 0 || next > maxFrame) {
        stopAutoStep();
        return;
      }
      seekToFrame(next);
    };

    autoStepIntervalRef.current = setInterval(tick, 1000 / ballFrameStepFpsRef.current);
  }, [seekToFrame, stopAutoStep]);

  const togglePlayPause = useCallback(() => {
    if (appModeRef.current === 'ball') {
      if (autoStepIntervalRef.current) {
        stopAutoStep();
      } else {
        startAutoStep(1);
      }
      return;
    }
    if (videoRef.current?.paused) videoRef.current.play();
    else videoRef.current?.pause();
  }, [startAutoStep, stopAutoStep]);

  useEffect(() => {
    if (!isAutoStepping || appMode !== 'ball') return;
    startAutoStep(1);
  }, [ballFrameStepFps]); // eslint-disable-line react-hooks/exhaustive-deps

  const heldFrameKeyRef = useRef<string | null>(null);
  const holdStepFrameRef = useRef<number | null>(null);

  const stopContinuousSeek = useCallback(() => {
    if (seekIntervalRef.current) {
      clearInterval(seekIntervalRef.current);
      seekIntervalRef.current = null;
    }
    holdStepFrameRef.current = null;
  }, []);

  const startContinuousSeek = useCallback((delta: number) => {
    stopAutoStep();
    const s = stateRef.current;
    const startFrame = holdStepFrameRef.current ?? s.currentFrame;
    const first = startFrame + delta;
    holdStepFrameRef.current = first;
    seekToFrame(first);

    const intervalMs = appModeRef.current === 'ball' ? 1000 / ballFrameStepFpsRef.current : 100;
    if (seekIntervalRef.current) clearInterval(seekIntervalRef.current);
    seekIntervalRef.current = setInterval(() => {
      if (!videoRef.current) return;
      if (isSeekingRef.current) return;
      const cur = stateRef.current;
      const item = cur.playlist[cur.currentPlaylistIndex];
      const timing = getTimingForMode(
        appModeRef.current,
        cur.videoMetadata,
        (appModeRef.current === 'ball' || appModeRef.current === 'vnl')
          ? item?.inferenceVideoMeta
          : undefined,
      );
      const maxFrame = Math.max(0, timing.frame_count - 1);
      const baseFrame = holdStepFrameRef.current ?? cur.currentFrame;
      const next = baseFrame + delta;
      if (next < 0 || next > maxFrame) {
        stopContinuousSeek();
        return;
      }
      holdStepFrameRef.current = next;
      seekToFrame(next);
    }, intervalMs);
  }, [seekToFrame, stopAutoStep, stopContinuousSeek]);

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || isSeekingRef.current || video.paused) return;
    const item = state.playlist[state.currentPlaylistIndex];
    const timing = getTimingForMode(
      appMode,
      state.videoMetadata,
      (appMode === 'ball' || appMode === 'vnl') ? item?.inferenceVideoMeta : undefined,
    );
    const maxFrame = Math.max(0, timing.frame_count - 1);
    const frame = appMode === 'ball'
      ? (ballBaseTimeRef.current !== null
          ? mediaTimeToFrame(video.currentTime, timing.fps, ballBaseTimeRef.current, maxFrame)
          : timeToFrameByDuration(video.currentTime, video.duration, timing.frame_count))
      : appMode === 'vnl' && item?.inferenceVideoMeta && video.duration > 0
        ? vnlMapTimeToFrame(
            video.currentTime,
            item.inferenceVideoMeta.frame_count,
            video.duration,
            item.inferenceVideoMeta.fps,
          )
        : timeToFrame(video.currentTime, timing.fps, maxFrame);
    setState(prev => {
      if (frame === prev.currentFrame) return prev;
      return { ...prev, currentFrame: frame };
    });
  };

  const handleVideoSeeked = () => {
    if (!videoRef.current) return;
    const item = state.playlist[state.currentPlaylistIndex];
    const timing = getTimingForMode(
      appMode,
      state.videoMetadata,
      (appMode === 'ball' || appMode === 'vnl') ? item?.inferenceVideoMeta : undefined,
    );
    const maxFrame = Math.max(0, timing.frame_count - 1);
    const decodedFrame = appMode === 'ball'
      ? (ballBaseTimeRef.current !== null
          ? mediaTimeToFrame(videoRef.current.currentTime, timing.fps, ballBaseTimeRef.current, maxFrame)
          : timeToFrameByDuration(videoRef.current.currentTime, videoRef.current.duration, timing.frame_count))
      : appMode === 'vnl' && item?.inferenceVideoMeta && videoRef.current.duration > 0
        ? vnlMapTimeToFrame(
            videoRef.current.currentTime,
            item.inferenceVideoMeta.frame_count,
            videoRef.current.duration,
            item.inferenceVideoMeta.fps,
          )
        : timeToFrame(videoRef.current.currentTime, timing.fps, maxFrame);

    pendingSeekFrameRef.current = null;
    isSeekingRef.current = false;
    if (seekTimeoutRef.current) {
      clearTimeout(seekTimeoutRef.current);
      seekTimeoutRef.current = null;
    }
    setState(prev => (prev.currentFrame === decodedFrame ? prev : { ...prev, currentFrame: decodedFrame }));
  };

  const addEvent = (skillInfo: { label: SkillLabel; classId: number }) => {
    saveToHistory(state);
    setState(prev => {
      const filtered = prev.events.filter(e => e.frame !== prev.currentFrame);
      return {
        ...prev,
        events: [...filtered, { frame: prev.currentFrame, skill: skillInfo.label, class_id: skillInfo.classId, source: 'manual' as const }]
      };
    });
  };

  const setEventContactPoint = useCallback((xy: [number, number], skillFilter?: SkillLabel) => {
    saveToHistory(stateRef.current);
    setState(prev => {
      const frame = prev.currentFrame;
      const target = prev.events.find((e) =>
        e.frame === frame && (!skillFilter || e.skill === skillFilter),
      );
      if (!target) return prev;
      const events = prev.events.map((e) =>
        e.frame === frame && (!skillFilter || e.skill === skillFilter)
          ? {
              ...e,
              xy,
              source: 'manual' as const,
            }
          : e,
      );
      return { ...prev, events };
    });
  }, []);

  const setVnlEventContactPoint = useCallback((xy: [number, number]) => {
    setEventContactPoint(xy);
  }, [setEventContactPoint]);

  const handleVnlVideoClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (appModeRef.current !== 'vnl') return;
    const video = videoRef.current;
    if (!video) return;
    const xy = getNormalizedVideoClick(video, e.clientX, e.clientY);
    if (!xy) return;
    const frame = stateRef.current.currentFrame;
    if (!stateRef.current.events.some((ev) => ev.frame === frame)) return;
    e.preventDefault();
    e.stopPropagation();
    setVnlEventContactPoint(xy);
  }, [setVnlEventContactPoint]);

  /** Touch Skill Block Only: click video to place ball contact dot on the current block. */
  const handleTouchBlockVideoClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (appModeRef.current !== 'touch_block') return;
    const video = videoRef.current;
    if (!video) return;
    const frame = stateRef.current.currentFrame;
    const hasBlock = stateRef.current.events.some((ev) => ev.frame === frame && ev.skill === 'block');
    if (!hasBlock) {
      window.alert('Press 7 to add a block on this frame first, then click the ball contact position.');
      return;
    }
    const xy = getNormalizedVideoClick(video, e.clientX, e.clientY);
    if (!xy) return;
    e.preventDefault();
    e.stopPropagation();
    setEventContactPoint(xy, 'block');
  }, [setEventContactPoint]);

  const setRallyBound = (type: 'start' | 'end') => {
    setState(prev => ({
      ...prev,
      rally: {
        ...prev.rally,
        [type === 'start' ? 'start_frame' : 'end_frame']: prev.currentFrame
      }
    }));
  };

  const clearBallBoxesAtFrame = (frame: number) => {
    saveToHistory(state);
    setState(prev => {
      const newBoxes = { ...prev.playerBoxes, [frame]: [] };
      const newPlaylist = [...prev.playlist];
      if (newPlaylist[prev.currentPlaylistIndex]) {
        newPlaylist[prev.currentPlaylistIndex] = {
          ...newPlaylist[prev.currentPlaylistIndex],
          playerBoxes: newBoxes,
        };
      }
      return { ...prev, playlist: newPlaylist, playerBoxes: newBoxes };
    });
  };

  const deleteCurrentFrameData = () => {
    if (appMode === 'ball') {
      clearBallBoxesAtFrame(state.currentFrame);
      return;
    }

    saveToHistory(state);
    setState(prev => {
      const isStart = prev.rally.start_frame === prev.currentFrame;
      const isEnd = prev.rally.end_frame === prev.currentFrame;
      const eventToDelete = prev.events.find(e => e.frame === prev.currentFrame);
      
      let updatedBoxes = prev.playerBoxes;
      if (eventToDelete && eventToDelete.player_id !== undefined) {
        updatedBoxes = { ...prev.playerBoxes };
        for (let f = prev.currentFrame - 5; f <= prev.currentFrame + 5; f++) {
          if (updatedBoxes[f]) {
            updatedBoxes[f] = updatedBoxes[f].map(b => 
              String(b.track_id) === String(eventToDelete.player_id) ? { ...b, is_active: false } : b
            );
          }
        }
      }
      
      return {
        ...prev,
        rally: {
          start_frame: isStart ? null : prev.rally.start_frame,
          end_frame: isEnd ? null : prev.rally.end_frame,
        },
        events: prev.events.filter(e => e.frame !== prev.currentFrame),
        playerBoxes: updatedBoxes
      };
    });
  };

  const handleAssignPlayer = (frame: number, trackId: number) => {
    saveToHistory(state);
    setState(prev => {
      const currentActions = prev.manualActions || [];
      const isCurrentlyAssigned = currentActions.some(m => m.frame === frame && m.track_id === trackId && (m.action === 'add' || !m.action));
      
      // Find if another player is already assigned to this frame
      const oldAssignedPlayerId = prev.events.find(e => e.frame === frame)?.player_id;
      const assigningNewPlayer = !isCurrentlyAssigned;
      
      // Filter out existing add/remove actions for this player, but PRESERVE draw_box actions!
      let newActions = currentActions.filter(m => !(m.frame === frame && m.track_id === trackId && m.action !== 'draw_box'));
      
      if (assigningNewPlayer && oldAssignedPlayerId !== undefined && oldAssignedPlayerId !== trackId) {
        // Remove the old assigned player from actions (also preserving draw_box if any)
        newActions = newActions.filter(m => !(m.frame === frame && m.track_id === oldAssignedPlayerId && m.action !== 'draw_box'));
        newActions.push({ frame, track_id: oldAssignedPlayerId, action: 'remove' as const });
      }

      if (assigningNewPlayer) {
        newActions.push({ frame, track_id: trackId });
      } else {
        newActions.push({ frame, track_id: trackId, action: 'remove' as const });
      }
      
      // Update is_active without re-parsing JSON to preserve drawn boxes
      // Update across the +/- 2 frame window to ensure the timeline correctly reflects the replacement immediately
      let newBoxes = { ...prev.playerBoxes };
      for (let f = frame - 2; f <= frame + 2; f++) {
        if (newBoxes[f]) {
          newBoxes[f] = newBoxes[f].map(b => {
            if (b.track_id === trackId) {
              return { ...b, is_active: !isCurrentlyAssigned };
            }
            if (assigningNewPlayer && oldAssignedPlayerId !== undefined && b.track_id === oldAssignedPlayerId) {
              return { ...b, is_active: false };
            }
            return b;
          });
        }
      }
      
      // Update the event's player_id if there is an event at this frame
      const newEvents = prev.events.map(ev => {
        if (ev.frame === frame) {
          return { ...ev, player_id: isCurrentlyAssigned ? undefined : trackId };
        }
        return ev;
      });
      
      return {
        ...prev,
        manualActions: newActions,
        playerBoxes: newBoxes,
        events: newEvents
      };
    });
    
    // Clear the selection so the green active highlight becomes visible
    setSelectedTrackId(null);
  };

  const handleDeleteEvent = (frame: number) => {
    saveToHistory(state);
    setState(prev => {
      const eventToDelete = prev.events.find(ev => ev.frame === frame);
      const newEvents = prev.events.filter(ev => ev.frame !== frame);
      
      // If the event had a player assigned, we should un-assign them so the green highlight and timeline grid goes away
      let updatedBoxes = prev.playerBoxes;
      if (eventToDelete && eventToDelete.player_id !== undefined) {
        updatedBoxes = { ...prev.playerBoxes };
        for (let f = frame - 5; f <= frame + 5; f++) {
          if (updatedBoxes[f]) {
            updatedBoxes[f] = updatedBoxes[f].map(b => 
              String(b.track_id) === String(eventToDelete.player_id) ? { ...b, is_active: false } : b
            );
          }
        }
      }
      
      return { ...prev, events: newEvents, playerBoxes: updatedBoxes };
    });
  };

  const handleDeleteBox = (trackIdToDelete: number) => {
    saveToHistory(state);
    setState(prev => {
      // Remove it from playerBoxes
      const currentBoxes = prev.playerBoxes[prev.currentFrame] || [];
      const newBoxes = currentBoxes.filter(b => b.track_id !== trackIdToDelete);
      const updatedPlayerBoxes = {
        ...prev.playerBoxes,
        [prev.currentFrame]: newBoxes,
      };
      
      // Also remove it from manualActions just in case it was assigned!
      const currentActions = prev.manualActions || [];
      const newActions = currentActions.filter(a => !(a.frame === prev.currentFrame && a.track_id === trackIdToDelete));
      
      // If it was the assigned player for the event, clear it
      const newEvents = prev.events.map(ev => {
        if (ev.frame === prev.currentFrame && ev.player_id === trackIdToDelete) {
          return { ...ev, player_id: undefined };
        }
        return ev;
      });

      const newPlaylist = [...prev.playlist];
      if (appMode === 'ball' && newPlaylist[prev.currentPlaylistIndex]) {
        newPlaylist[prev.currentPlaylistIndex] = {
          ...newPlaylist[prev.currentPlaylistIndex],
          playerBoxes: updatedPlayerBoxes,
        };
      }

      return {
        ...prev,
        playlist: newPlaylist,
        playerBoxes: updatedPlayerBoxes,
        manualActions: newActions,
        events: newEvents
      };
    });
    if (selectedTrackId === trackIdToDelete) {
      setSelectedTrackId(null);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const key = e.key.toLowerCase();

      if (appMode === 'vnl' && ['1', '2', '3', '4', '5', '6', '7', '8'].includes(key)) {
        const def = VNL_LABEL_DEFS.find((d) => d.hotkey === key);
        if (def) addEvent({ label: def.label as SkillLabel, classId: def.classId });
        e.preventDefault();
        return;
      }

      if (appMode !== 'vnl' && appMode !== 'touch_block' && ['1', '2', '3', '4', '5', '6', '7'].includes(key)) {
        const skillMap: Record<string, { label: SkillLabel; classId: number }> = {
          '1': { label: 'toss', classId: SKILL_CLASS_IDS.toss },
          '2': { label: 'serve', classId: SKILL_CLASS_IDS.serve },
          '3': { label: 'reception', classId: SKILL_CLASS_IDS.reception },
          '4': { label: 'set', classId: SKILL_CLASS_IDS.set },
          '5': { label: 'dig', classId: SKILL_CLASS_IDS.dig },
          '6': { label: 'attack', classId: SKILL_CLASS_IDS.attack },
          '7': { label: 'block', classId: SKILL_CLASS_IDS.block },
        };
        addEvent(skillMap[key]);
        e.preventDefault();
        return;
      }

      // Touch Skill Block Only: focus on adding block (7). Other skill keys still work.
      if (appMode === 'touch_block' && ['1', '2', '3', '4', '5', '6', '7'].includes(key)) {
        const skillMap: Record<string, { label: SkillLabel; classId: number }> = {
          '1': { label: 'toss', classId: SKILL_CLASS_IDS.toss },
          '2': { label: 'serve', classId: SKILL_CLASS_IDS.serve },
          '3': { label: 'reception', classId: SKILL_CLASS_IDS.reception },
          '4': { label: 'set', classId: SKILL_CLASS_IDS.set },
          '5': { label: 'dig', classId: SKILL_CLASS_IDS.dig },
          '6': { label: 'attack', classId: SKILL_CLASS_IDS.attack },
          '7': { label: 'block', classId: SKILL_CLASS_IDS.block },
        };
        addEvent(skillMap[key]);
        e.preventDefault();
        return;
      }

      if (key === 's' && appMode !== 'vnl') {
        setRallyBound('start');
        e.preventDefault();
      } else if (key === 'e' && appMode !== 'vnl') {
        setRallyBound('end');
        e.preventDefault();
      } else if (key === 'delete' || key === 'backspace') {
        deleteCurrentFrameData();
        e.preventDefault();
      } else if (key === 'a') {
        if (appMode === 'vnl') {
          e.preventDefault();
          return;
        }
        if (selectedTrackId !== null) {
          handleAssignPlayer(state.currentFrame, selectedTrackId);
        } else {
          window.alert("Please click on a player's bounding box first to select them, then press 'A'.");
        }
        e.preventDefault();
      } else if (appMode === 'touch_block' && (key === 'arrowleft' || key === 'arrowright')) {
        stopAutoStep();
        stopContinuousSeek();
        if (!e.repeat) seekAdjacentAttack(key === 'arrowright' ? 1 : -1);
        e.preventDefault();
      } else if (appMode === 'touch_block' && (key === ',' || key === '<' || key === '.' || key === '>')) {
        stopAutoStep();
        if (!e.repeat) {
          const step = (key === '.' || key === '>') ? (e.shiftKey ? 5 : 1) : (e.shiftKey ? -5 : -1);
          startContinuousSeek(step);
          heldFrameKeyRef.current = key;
        }
        e.preventDefault();
      } else if (key === 'arrowleft' || key === ',' || key === '<') {
        stopAutoStep();
        if (!e.repeat) {
          const step = e.shiftKey ? -5 : -1;
          startContinuousSeek(step);
          heldFrameKeyRef.current = key;
        }
        e.preventDefault();
      } else if (key === 'arrowright' || key === '.' || key === '>') {
        stopAutoStep();
        if (!e.repeat) {
          const step = e.shiftKey ? 5 : 1;
          startContinuousSeek(step);
          heldFrameKeyRef.current = key;
        }
        e.preventDefault();
      } else if (key === ' ') {
        togglePlayPause();
        e.preventDefault();
      } else if (key === 'z') {
        setInteractionMode(prev => prev === 'draw' ? 'zoom' : 'draw');
        e.preventDefault();
      } else if (key === 'escape') {
        setViewTransform({ zoom: 1, tx: 0, ty: 0 });
        e.preventDefault();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', ',', '.', '<', '>'].includes(key) && heldFrameKeyRef.current === key) {
        stopContinuousSeek();
        heldFrameKeyRef.current = null;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      stopContinuousSeek();
    };
  }, [seekToFrame, selectedTrackId, appMode, togglePlayPause, stopAutoStep, startContinuousSeek, stopContinuousSeek, seekAdjacentAttack]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      fullscreenRef.current?.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  const resetZoom = () => {
    setViewTransform({ zoom: 1, tx: 0, ty: 0 });
  };

  const getMousePos = (e: React.MouseEvent<SVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return null;
    let pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    pt = pt.matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };

  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (appMode === 'ball' && !ballEditMode) return;
    if (!state.videoMetadata) return;
    const pos = getMousePos(e);
    if (!pos) return;
    
    // Prevent default browser drag-and-drop behavior from hijacking mousemove
    e.preventDefault();
    
    setDrawingBox({ startX: pos.x, startY: pos.y, currentX: pos.x, currentY: pos.y });
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const pos = getMousePos(e);
    if (!pos || !state.videoMetadata) return;
    
    if (draggingBox) {
      const dx = pos.x - draggingBox.startX;
      const dy = pos.y - draggingBox.startY;
      
      setState(prev => {
        const currentBoxes = prev.playerBoxes[prev.currentFrame] || [];
        const newBoxes = currentBoxes.map(b => {
          if (b.track_id === draggingBox.trackId) {
            return {
              ...b,
              x_min: draggingBox.initialBox.x_min + dx,
              x_max: draggingBox.initialBox.x_max + dx,
              y_min: draggingBox.initialBox.y_min + dy,
              y_max: draggingBox.initialBox.y_max + dy,
              source: 'manual' as const,
            };
          }
          return b;
        });
        return {
          ...prev,
          playerBoxes: { ...prev.playerBoxes, [prev.currentFrame]: newBoxes }
        };
      });
      return;
    }

    if (resizingBox) {
      const dx = pos.x - resizingBox.startX;
      const dy = pos.y - resizingBox.startY;
      
      setState(prev => {
        const currentBoxes = prev.playerBoxes[prev.currentFrame] || [];
        const newBoxes = currentBoxes.map(b => {
          if (b.track_id === resizingBox.trackId) {
            let { x_min, y_min, x_max, y_max } = resizingBox.initialBox;
            const { corner } = resizingBox;
            
            if (corner === 'tl') {
              x_min = Math.min(x_min + dx, x_max - 5);
              y_min = Math.min(y_min + dy, y_max - 5);
            } else if (corner === 'tr') {
              x_max = Math.max(x_max + dx, x_min + 5);
              y_min = Math.min(y_min + dy, y_max - 5);
            } else if (corner === 'bl') {
              x_min = Math.min(x_min + dx, x_max - 5);
              y_max = Math.max(y_max + dy, y_min + 5);
            } else if (corner === 'br') {
              x_max = Math.max(x_max + dx, x_min + 5);
              y_max = Math.max(y_max + dy, y_min + 5);
            }
            
            return { ...b, x_min, y_min, x_max, y_max, source: 'manual' as const };
          }
          return b;
        });
        return {
          ...prev,
          playerBoxes: { ...prev.playerBoxes, [prev.currentFrame]: newBoxes }
        };
      });
      return;
    }

    if (!drawingBox) return;
    setDrawingBox(prev => prev ? { ...prev, currentX: pos.x, currentY: pos.y } : null);
  };

  const handleSvgMouseUp = () => {
    if (draggingBox || resizingBox) {
      if (appMode === 'ball' && ballEditMode) {
        setState((prev) => {
          const newPlaylist = [...prev.playlist];
          if (newPlaylist[prev.currentPlaylistIndex]) {
            newPlaylist[prev.currentPlaylistIndex] = {
              ...newPlaylist[prev.currentPlaylistIndex],
              playerBoxes: prev.playerBoxes,
            };
          }
          return { ...prev, playlist: newPlaylist };
        });
      }
      setDraggingBox(null);
      setResizingBox(null);
      return;
    }

    if (!drawingBox || !state.videoMetadata) return;
    
    const x_min = Math.min(drawingBox.startX, drawingBox.currentX);
    const x_max = Math.max(drawingBox.startX, drawingBox.currentX);
    const y_min = Math.min(drawingBox.startY, drawingBox.currentY);
    const y_max = Math.max(drawingBox.startY, drawingBox.currentY);
    
    if (x_max - x_min > 10 && y_max - y_min > 10) {
      if (interactionMode === 'zoom') {
        const wrapper = wrapperRef.current;
        if (wrapper) {
          const W = wrapper.clientWidth;
          const H = wrapper.clientHeight;
          const vW = state.videoMetadata.width || 1280;
          const vH = state.videoMetadata.height || 720;
          
          const s = Math.min(W / vW, H / vH);
          const Ox = (W - vW * s) / 2;
          const Oy = (H - vH * s) / 2;
          
          const cx = x_min + (x_max - x_min) / 2;
          const cy = y_min + (y_max - y_min) / 2;
          
          const px = Ox + cx * s;
          const py = Oy + cy * s;
          
          const boxW = (x_max - x_min) * s;
          const boxH = (y_max - y_min) * s;
          
          let targetZ = Math.min(W / boxW, H / boxH);
          targetZ = Math.min(Math.max(targetZ, 1), 6); // Cap at 6x zoom
          
          setViewTransform({ zoom: targetZ, tx: 0, ty: 0 });
          
          setTimeout(() => {
            if (wrapperRef.current) {
              wrapperRef.current.scrollLeft = (px * targetZ) - (W / 2);
              wrapperRef.current.scrollTop = (py * targetZ) - (H / 2);
            }
          }, 50);
        }
      } else {
        const highestTrackId = Math.max(0, ...Object.values(state.playerBoxes).flatMap(frameBoxes => frameBoxes.map(b => b.track_id)));
        
        const newBox: PlayerBox = {
          x_min, y_min, x_max, y_max,
          track_id: highestTrackId + 1,
          is_active: false,
          conf: 1.0,
          source: 'manual',
        };
        
        saveToHistory(state);
        setState(prev => {
          const newBoxesState = { ...prev.playerBoxes };
          if (appMode === 'ball') {
            newBoxesState[prev.currentFrame] = [{ ...newBox }];
          } else {
            newBoxesState[prev.currentFrame] = [...(newBoxesState[prev.currentFrame] || []), { ...newBox }];
          }

          const newPlaylist = [...prev.playlist];
          if (appMode === 'ball' && newPlaylist[prev.currentPlaylistIndex]) {
            newPlaylist[prev.currentPlaylistIndex] = {
              ...newPlaylist[prev.currentPlaylistIndex],
              playerBoxes: newBoxesState,
            };
          }
          
          return {
            ...prev,
            playlist: newPlaylist,
            playerBoxes: newBoxesState,
            manualActions: [...(prev.manualActions || []), { 
              frame: prev.currentFrame, 
              track_id: newBox.track_id, 
              action: 'draw_box', 
              box: newBox 
            }]
          };
        });
        
        setSelectedTrackId(newBox.track_id);
      }
    }
    
    setDrawingBox(null);
  };

  const getValidationWarnings = () => {
    const warnings: { type: string, msg: string }[] = [];
    if (!state.videoMetadata) return warnings;

    if (state.rally.start_frame !== null && state.rally.end_frame !== null) {
      if (state.rally.end_frame < state.rally.start_frame) {
        warnings.push({ type: 'error', msg: 'end_rally is before start_rally' });
      }
    }
    
    state.events.forEach(ev => {
      if (appMode === 'vnl') return;
      const boxes = state.playerBoxes[ev.frame] || [];
      
      const visibleBoxes = boxes.filter(b => {
        const width = b.x_max - b.x_min;
        const height = b.y_max - b.y_min;
        const isOffScreen = b.x_max < 0 || b.y_max < 0 || b.x_min > (state.videoMetadata?.width || 1280) || b.y_min > (state.videoMetadata?.height || 720);
        return width > 5 && height > 5 && !isOffScreen;
      });

      if (visibleBoxes.length < 12) {
        warnings.push({ type: 'warning', msg: `Frame ${ev.frame} (${ev.skill}) has only ${visibleBoxes.length}/12 visible players. Draw missing boxes if needed.` });
      }
    });
    
    return warnings;
  };

  const currentVnlEvent = useMemo(
    () => (appMode === 'vnl' ? state.events.find((e) => e.frame === state.currentFrame) : undefined),
    [appMode, state.events, state.currentFrame],
  );

  const currentBlockEvent = useMemo(
    () =>
      appMode === 'touch_block'
        ? state.events.find((e) => e.frame === state.currentFrame && e.skill === 'block')
        : undefined,
    [appMode, state.events, state.currentFrame],
  );

  const currentVnlDotPosition = useMemo(() => {
    const video = videoRef.current;
    const container = video?.parentElement;
    if (!currentVnlEvent?.xy || !video || !container) return null;
    return normalizedVideoPointToContainerPercent(currentVnlEvent.xy, video, container);
  }, [currentVnlEvent, state.currentFrame, videoUrl]);

  const currentBlockDotPosition = useMemo(() => {
    const video = videoRef.current;
    const container = video?.parentElement;
    if (!currentBlockEvent?.xy || !video || !container) return null;
    return normalizedVideoPointToContainerPercent(currentBlockEvent.xy, video, container);
  }, [currentBlockEvent, state.currentFrame, videoUrl]);

  const vnlSyncWarning = useMemo(() => {
    if (appMode !== 'vnl') return null;
    const inferMeta = currentPlaylistItem?.inferenceVideoMeta;
    const duration =
      videoRef.current && Number.isFinite(videoRef.current.duration) && videoRef.current.duration > 0
        ? videoRef.current.duration
        : state.videoMetadata?.duration ?? 0;
    if (!inferMeta?.frame_count || duration <= 0) return null;

    const browserFrames = estimateBrowserFrameCount(duration, inferMeta.fps);
    const parts: string[] = [];
    if (videoPlaybackKind === 'h264') {
      parts.push('Using GPU-transcoded H.264 (same file for playback and inference).');
    }
    if (browserFrames + 1 < inferMeta.frame_count) {
      parts.push(
        `Preview ~${browserFrames} frames vs inference ${inferMeta.frame_count}. Skills after frame ${browserFrames - 1} may not match video.`,
      );
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }, [
    appMode,
    currentPlaylistItem?.inferenceVideoMeta,
    state.videoMetadata?.duration,
    videoPlaybackKind,
  ]);

  const warnings = getValidationWarnings();

  // Calculate active frame ranges from the JSON data
  const activeRanges = useMemo(() => {
    if (!state.playerBoxes || appMode === 'ball') return [];
    
    // Group active frames by track_id
    const trackActiveFrames: Record<number, number[]> = {};
    
    Object.keys(state.playerBoxes).forEach(frameStr => {
      const frame = parseInt(frameStr, 10);
      const boxes = state.playerBoxes[frame];
      if (boxes) {
        boxes.forEach(box => {
          if (box.is_active) {
            if (!trackActiveFrames[box.track_id]) trackActiveFrames[box.track_id] = [];
            trackActiveFrames[box.track_id].push(frame);
          }
        });
      }
    });
    
    // Convert to contiguous ranges
    const ranges: { trackId: number, start: number, end: number }[] = [];
    
    Object.entries(trackActiveFrames).forEach(([trackIdStr, frames]) => {
      const trackId = parseInt(trackIdStr, 10);
      frames.sort((a, b) => a - b);
      
      if (frames.length === 0) return;
      
      let currentStart = frames[0];
      let currentEnd = frames[0];
      
      for (let i = 1; i < frames.length; i++) {
        const frame = frames[i];
        if (frame === currentEnd + 1) {
          currentEnd = frame;
        } else {
          ranges.push({ trackId, start: currentStart, end: currentEnd });
          currentStart = frame;
          currentEnd = frame;
        }
      }
      ranges.push({ trackId, start: currentStart, end: currentEnd });
    });
    
    // Add skill info to ranges
    const rangesWithSkill = ranges.map(range => {
      // Find event that overlaps this range, or is close to it
      const event = state.events.find(e => e.frame >= range.start - 5 && e.frame <= range.end + 5);
      return { 
        ...range, 
        skillName: event ? event.skill : 'default'
      };
    });
    
    // Sort by start frame
    return rangesWithSkill.sort((a, b) => a.start - b.start);
  }, [state.playerBoxes, state.events]);
  if (!isAuthenticated) {
    return (
      <div className="landing-container" style={{ 
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', 
        minHeight: '100vh', padding: '2rem',
        background: 'radial-gradient(circle at 50% 50%, #151e2e 0%, #060913 100%)',
        overflow: 'hidden'
      }}>
        <VolleyballParticles />
        
        {/* LOGO & TITLE SECTION */}
        <div style={{ textAlign: 'center', marginBottom: '2.5rem', animation: 'fadeInDown 0.8s ease-out', position: 'relative', zIndex: 10 }}>
          <div style={{ position: 'relative', display: 'inline-block', marginBottom: '0.5rem' }}>
            <div style={{ position: 'absolute', top: '50%', left: '50%', width: '150px', height: '150px', background: 'radial-gradient(circle, rgba(59, 130, 246, 0.2) 0%, transparent 70%)', transform: 'translate(-50%, -50%)', filter: 'blur(20px)', zIndex: 0 }}></div>
            <img src={`${import.meta.env.BASE_URL}logo.png?v=9`} alt="Veritas Pro Logo" style={{ width: '130px', height: '130px', position: 'relative', zIndex: 1, filter: 'drop-shadow(0 10px 20px rgba(0,0,0,0.5))' }} />
          </div>
          
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, margin: '0 0 0.5rem 0', letterSpacing: '-1px', color: '#ffffff', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>
            Veritas Pro
          </h1>
          <p style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '4px', margin: 0, color: '#3b82f6', textShadow: '0 1px 5px rgba(0,0,0,0.5)' }}>
            POWERED BY THELIOS.AI
          </p>
        </div>

        {/* SECURE LOGIN CARD */}
        <div style={{ 
          position: 'relative', zIndex: 10,
          width: '100%', maxWidth: '400px', padding: '2.5rem',
          background: 'rgba(15, 20, 30, 0.7)', border: '1px solid rgba(255,255,255,0.05)', 
          borderRadius: '16px', boxShadow: '0 20px 50px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.1)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          animation: 'fadeInUp 0.8s ease-out 0.2s both'
        }}>
          <p style={{ margin: '0 0 2rem 0', color: 'white', fontWeight: 600, fontSize: '1.2rem', textAlign: 'center' }}>Secure Login</p>
          
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div>
              <label htmlFor="username" style={{ display: 'block', marginBottom: '0.5rem', color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem', fontWeight: 500 }}>Username</label>
              <input 
                id="username"
                name="username"
                type="text" 
                value={loginUsername}
                onChange={e => setLoginUsername(e.target.value)}
                style={{ width: '100%', padding: '0.9rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)', color: 'white', outline: 'none', transition: 'all 0.2s', fontSize: '0.95rem' }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px rgba(59,130,246,0.2)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'rgba(255,255,255,0.05)'; e.target.style.boxShadow = 'none'; }}
                placeholder="admin"
                autoComplete="username"
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="password" style={{ display: 'block', marginBottom: '0.5rem', color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem', fontWeight: 500 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input 
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"} 
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  style={{ width: '100%', padding: '0.9rem 1rem', paddingRight: '2.5rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)', color: 'white', outline: 'none', transition: 'all 0.2s', fontSize: '0.95rem' }}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px rgba(59,130,246,0.2)'; }}
                  onBlur={(e) => { e.target.style.borderColor = 'rgba(255,255,255,0.05)'; e.target.style.boxShadow = 'none'; }}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
                <button 
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{ position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 0, display: 'flex', transition: 'color 0.2s' }}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'white'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            
            {loginError && <div style={{ color: 'var(--color-attack)', fontSize: '0.85rem', textAlign: 'center', background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem', borderRadius: '6px' }}>{loginError}</div>}
            
            <button type="submit" className="btn" style={{ width: '100%', padding: '1rem', marginTop: '1rem', background: '#3b82f6', color: 'white', fontWeight: 600, fontSize: '1rem', borderRadius: '8px', boxShadow: '0 4px 20px 0 rgba(59, 130, 246, 0.4)', border: 'none', cursor: 'pointer', transition: 'transform 0.1s, box-shadow 0.2s' }}
                    onMouseDown={e => e.currentTarget.style.transform = 'scale(0.98)'}
                    onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}>
              Sign In &rarr;
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (appMode === 'block_clip') {
    return <BlockClipAnnotator onBack={returnToHome} />;
  }

  if (!videoUrl) {
    // Full-screen wait only when inference is running but playback is not ready yet (rare).
    if (batchProgress.total > 0 && batchProgress.isRunning && state.playlist.length === 0) {
      const pipelineLabel =
        appMode === 'ball' ? 'Ball tracking' : appMode === 'vnl' ? 'VNL event spotting' : 'Touch & skill';
      return (
        <div className="landing-container">
          <div className="landing-card" style={{ maxWidth: '600px', width: '100%' }}>
            <h1 className="landing-title">Running {pipelineLabel}…</h1>
            <p className="landing-subtitle">
              Processing video {Math.min(batchProgress.completed + 1, batchProgress.total)} of {batchProgress.total}
              {batchProgress.avgTimeSec > 0 ? (
                <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)' }}>
                  ETA: {Math.floor((batchProgress.avgTimeSec * (batchProgress.total - batchProgress.completed)) / 60)}m {Math.round((batchProgress.avgTimeSec * (batchProgress.total - batchProgress.completed)) % 60)}s
                </span>
              ) : (
                <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)' }}>
                  Calculating ETA...
                </span>
              )}
            </p>
            <div style={{ width: '100%', height: '12px', background: 'rgba(255,255,255,0.1)', borderRadius: '6px', overflow: 'hidden', marginTop: '2rem' }}>
              <div
                style={{
                  width: `${(batchProgress.completed / batchProgress.total) * 100}%`,
                  height: '100%',
                  background: appMode === 'vnl' ? '#8b5cf6' : 'var(--primary)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <p style={{ textAlign: 'center', marginTop: '1rem', color: 'rgba(255,255,255,0.7)' }}>
              {Math.round((batchProgress.completed / batchProgress.total) * 100)}% Complete
              {batchProgress.lastFps > 0 ? (
                <span style={{ marginLeft: '15px', color: '#4ade80' }}>({batchProgress.lastFps} FPS)</span>
              ) : (
                <span style={{ marginLeft: '15px', color: '#4ade80' }}>(Calculating FPS...)</span>
              )}
            </p>
          </div>
        </div>
      );
    }

    const downloadDocumentation = () => {
      const docText = `VERITAS PRO - DETAILED USER GUIDE

=========================================
1. INITIAL SETUP & UPLOADING FILES
=========================================
- The platform requires both MP4 video files and their corresponding JSON tracking data.
- You can drag and drop individual MP4 and JSON files directly into the "Upload Local Files" dropzone.
- Alternatively, you can drop a ZIP file containing paired MP4/JSON files to load an entire match at once.
- Once loaded, files appear in the left Playlist sidebar.

=========================================
2. AUTOMATED BATCH PROCESSING
=========================================
- When you upload files, the system will automatically check if skill annotations already exist.
- If missing, the platform will automatically send your video through our AI backend pipeline.
- You can choose which AI Engine to use (SlowFast or YOLO27) by toggling the switch on the homepage BEFORE uploading.
- The backend assigns active players to all touch events (Serve, Toss, Reception, Dig, Set, Attack) automatically.
- Wait for the progress bar to complete. Your annotated videos will then be ready for review.

=========================================
3. VIDEO PLAYER & ANNOTATION REVIEW
=========================================
- Click a video in the sidebar to open the player.
- Player bounding boxes are shown in red (passive) or green (active).
- The timeline shows all detected skill events as colored ticks.
- Use the [-5f], [-1f], [+1f], [+5f] buttons to navigate frame by frame, or click directly on the timeline.

=========================================
4. MANUAL ADJUSTMENTS & HOTKEYS
=========================================
If the AI made a mistake, you can easily fix it:
- [1-7] : Assign a specific skill to the exact current frame.
  (1=Toss, 2=Serve, 3=Reception, 4=Set, 5=Dig, 6=Attack, 7=Block)
- [Del] : Delete all skill annotations on the current frame.
- [S] / [E] : Mark the Start and End frame of a rally.
- [A] : Auto-select the currently active player box.

Modifying Bounding Boxes:
- Double-Click Box : Instantly assign that player to the active skill event on the current frame.
- Right-Click Box : Delete the bounding box entirely.
- Click & Drag on Video : Manually draw a brand new tracking box for a player the AI missed.

=========================================
5. EXPORTING TRAINING DATA
=========================================
- Once you have reviewed all videos in the playlist, click the "Batch ZIP" button in the bottom left corner of the sidebar.
- This will compile all your verified annotations into perfectly formatted JSON and CVAT-compatible XML datasets.
- Ensure you select "Include MP4s in ZIP" if you also want the original video clips packaged alongside the data.

Enjoy using Veritas Pro!
`;
      const blob = new Blob([docText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Veritas_Pro_User_Guide.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    return (
      <div className="landing-container" style={{ 
        display: 'flex', flexDirection: 'column',
        height: '100vh', overflowY: 'auto',
        background: 'radial-gradient(circle at 50% 0%, rgba(59, 130, 246, 0.15) 0%, rgba(5, 5, 5, 1) 50%, rgba(5, 5, 5, 1) 100%)'
      }}>
        
        {/* RESPONSIVE CENTERING WRAPPER */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          minHeight: '100%', padding: '2rem', width: '100%'
        }}>
          <div style={{ flexGrow: 1 }} />
        
        {/* HEADER SECTION */}
        <div style={{ textAlign: 'center', marginBottom: '2rem', animation: 'fadeInDown 0.8s ease-out' }}>
          <div style={{ position: 'relative', display: 'inline-block', marginBottom: '1.5rem' }}>
            <div style={{ position: 'absolute', top: '50%', left: '50%', width: '150px', height: '150px', background: 'radial-gradient(circle, rgba(59, 130, 246, 0.4) 0%, transparent 70%)', transform: 'translate(-50%, -50%)', filter: 'blur(20px)', zIndex: 0 }}></div>
            <img src={`${import.meta.env.BASE_URL}logo.png?v=9`} alt="Veritas Pro Logo" style={{ width: '100px', height: '100px', position: 'relative', zIndex: 1 }} />
          </div>
          <h1 style={{ fontSize: '3.5rem', fontWeight: 800, margin: '0 0 0.5rem 0', letterSpacing: '-1px', background: 'linear-gradient(135deg, #ffffff 0%, #94a3b8 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Veritas Pro
          </h1>
          <p style={{ fontSize: '0.85rem', fontWeight: 700, letterSpacing: '3px', margin: 0, color: 'var(--primary)' }}>
            POWERED BY THELIOS.AI
          </p>
          <p style={{ fontSize: '1.1rem', color: 'var(--text-muted)', maxWidth: '500px', margin: '1.5rem auto 0 auto', lineHeight: 1.5 }}>
            {OFFLINE_REVIEW_ONLY
              ? 'Review and correct precomputed annotations entirely in your browser.'
              : appMode === 'ball'
                ? 'Advanced ball tracking and batch processing pipeline.'
                : appMode === 'vnl'
                  ? 'Manual VNL annotation on full rally videos. No auto inference.'
                  : 'Advanced skill tracking and batch processing pipeline.'}<br/>
            {OFFLINE_REVIEW_ONLY
              ? 'Upload a ZIP containing matching video and XML/JSON files. No video or annotation data leaves your computer.'
              : 'Load individual rallies or entire match datasets to begin.'}
          </p>
        </div>

        {appMode === 'home' ? (
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '3rem', animation: 'fadeInUp 0.8s ease-out' }}>
            <div 
              onClick={() => switchWorkflowMode('touch')}
              style={{
                width: '320px', padding: '2rem', borderRadius: '16px', cursor: 'pointer',
                background: 'rgba(59, 130, 246, 0.05)', border: '1px solid rgba(59, 130, 246, 0.3)',
                boxShadow: '0 10px 30px -10px rgba(59, 130, 246, 0.2)', transition: 'all 0.3s ease',
                textAlign: 'center'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.background = 'rgba(59, 130, 246, 0.1)'; e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.6)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)'; e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.3)'; }}
            >
              <MousePointer2 size={40} color="#3b82f6" style={{ margin: '0 auto 1rem auto' }} />
              <h3 style={{ margin: '0 0 0.5rem 0', color: 'white', fontSize: '1.25rem' }}>Touch & Skill Annotation</h3>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
                Identify active player touches and automatically classify volleyball skills.
              </p>
            </div>

            <div
              onClick={() => switchWorkflowMode('touch_block')}
              style={{
                width: '320px', padding: '2rem', borderRadius: '16px', cursor: 'pointer',
                background: 'rgba(168, 223, 35, 0.08)', border: '1px solid rgba(168, 223, 35, 0.4)',
                boxShadow: '0 10px 30px -10px rgba(168, 223, 35, 0.25)', transition: 'all 0.3s ease',
                textAlign: 'center'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.background = 'rgba(168, 223, 35, 0.15)'; e.currentTarget.style.borderColor = 'rgba(168, 223, 35, 0.7)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.background = 'rgba(168, 223, 35, 0.08)'; e.currentTarget.style.borderColor = 'rgba(168, 223, 35, 0.4)'; }}
            >
              <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'linear-gradient(135deg, #a8df23, #73882d)', margin: '0 auto 1rem auto', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.7rem', color: '#111' }}>
                BLK
              </div>
              <h3 style={{ margin: '0 0 0.5rem 0', color: 'white', fontSize: '1.25rem' }}>Touch Skill Block Only</h3>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
                Load match video + XML (all skills shown). ←/→ jump attacks; &lt;/&gt; step frames; press 7 to add block, then click the video to place the ball contact dot for 7-class training.
              </p>
            </div>
            
            <div 
              onClick={() => switchWorkflowMode('ball')}
              style={{
                width: '320px', padding: '2rem', borderRadius: '16px', cursor: 'pointer',
                background: 'rgba(251, 191, 36, 0.05)', border: '1px solid rgba(251, 191, 36, 0.3)',
                boxShadow: '0 10px 30px -10px rgba(251, 191, 36, 0.2)', transition: 'all 0.3s ease',
                textAlign: 'center'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.background = 'rgba(251, 191, 36, 0.1)'; e.currentTarget.style.borderColor = 'rgba(251, 191, 36, 0.6)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.background = 'rgba(251, 191, 36, 0.05)'; e.currentTarget.style.borderColor = 'rgba(251, 191, 36, 0.3)'; }}
            >
              <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: '#fbbf24', margin: '0 auto 1rem auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', border: '2px solid rgba(0,0,0,0.5)', position: 'relative' }}>
                  <div style={{ position: 'absolute', top: '50%', left: '0', right: '0', height: '2px', background: 'rgba(0,0,0,0.5)', transform: 'translateY(-50%)' }} />
                  <div style={{ position: 'absolute', left: '50%', top: '0', bottom: '0', width: '2px', background: 'rgba(0,0,0,0.5)', transform: 'translateX(-50%)' }} />
                </div>
              </div>
              <h3 style={{ margin: '0 0 0.5rem 0', color: 'white', fontSize: '1.25rem' }}>Ball Tracking Annotation</h3>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
                Track ball trajectories and verify bounding box detections automatically.
              </p>
            </div>

            <div
              onClick={() => {
                setAppMode('block_clip');
                localStorage.setItem(APP_MODE_STORAGE_KEY, 'block_clip');
              }}
              style={{
                width: '320px', padding: '2rem', borderRadius: '16px', cursor: 'pointer',
                background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.3)',
                boxShadow: '0 10px 30px -10px rgba(16, 185, 129, 0.2)', transition: 'all 0.3s ease',
                textAlign: 'center'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.background = 'rgba(16, 185, 129, 0.1)'; e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.6)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.background = 'rgba(16, 185, 129, 0.05)'; e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.3)'; }}
            >
              <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'linear-gradient(135deg, #10b981, #059669)', margin: '0 auto 1rem auto', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.75rem', color: 'white' }}>
                A/B
              </div>
              <h3 style={{ margin: '0 0 0.5rem 0', color: 'white', fontSize: '1.25rem' }}>Attack / Block Clips</h3>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
                Annotate 25-frame attack/block clips with four key frames: pre-attack, attack, block, and end block.
              </p>
            </div>

            <div
              onClick={() => switchWorkflowMode('vnl')}
              style={{
                width: '320px', padding: '2rem', borderRadius: '16px', cursor: 'pointer',
                background: 'rgba(139, 92, 246, 0.05)', border: '1px solid rgba(139, 92, 246, 0.3)',
                boxShadow: '0 10px 30px -10px rgba(139, 92, 246, 0.2)', transition: 'all 0.3s ease',
                textAlign: 'center'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.background = 'rgba(139, 92, 246, 0.1)'; e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.6)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.background = 'rgba(139, 92, 246, 0.05)'; e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.3)'; }}
            >
              <Zap size={40} color="#8b5cf6" style={{ margin: '0 auto 1rem auto' }} />
              <h3 style={{ margin: '0 0 0.5rem 0', color: 'white', fontSize: '1.25rem' }}>VNL</h3>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
                Manual annotation — no auto inference. Use keys 1–8 for toss, serve, receive, set, dig, attack, block, score.
              </p>
            </div>
          </div>
        ) : (
          <div style={{ width: '100%', maxWidth: '700px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <button 
              onClick={returnToHome}
              className="btn outline"
              style={{ position: 'absolute', top: '1.5rem', left: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', zIndex: 50 }}
            >
              <ArrowLeft size={16} /> Back to Selection
            </button>
            
            <h2 style={{ color: appMode === 'ball' ? '#fbbf24' : appMode === 'vnl' ? '#8b5cf6' : appMode === 'touch_block' ? '#a8df23' : '#3b82f6', marginBottom: '1.5rem', fontSize: '1.5rem' }}>
              {appMode === 'ball'
                ? 'Ball Tracking Mode'
                : appMode === 'vnl'
                  ? 'VNL Manual Annotation'
                  : appMode === 'touch_block'
                    ? 'Touch Skill Block Only'
                    : 'Player Touch & Skill Mode'}
            </h2>

            {appMode === 'touch_block' && (
              <div
                style={{
                  marginBottom: '1.5rem',
                  maxWidth: '760px',
                  padding: '0.85rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(168, 223, 35, 0.12)',
                  border: '1px solid rgba(168, 223, 35, 0.4)',
                  color: '#eab308',
                  textAlign: 'center',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                }}
              >
                Load match <strong>MP4 + XML</strong>. Skills are saved in this browser — after refresh, open the <strong>same folder</strong> again.
                Use <strong>← / →</strong> for attacks, <strong>&lt; / &gt;</strong> for frames, <strong>7</strong> + <strong>click</strong> for block ball-dot.
                Green = done (block+dot), yellow = block missing dot, gray = still needs block.
              </div>
            )}

            {appMode === 'touch_block' && touchBlockAwaitingFolder && state.playlist.length > 0 && (
              <div
                style={{
                  marginBottom: '1rem',
                  maxWidth: '760px',
                  padding: '0.75rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(251, 191, 36, 0.15)',
                  border: '1px solid rgba(251, 191, 36, 0.45)',
                  color: '#fde68a',
                  textAlign: 'center',
                  fontSize: '0.9rem',
                }}
              >
                Restored {state.playlist.length} video(s) + your block annotations from browser storage — pick the same folder below to play videos.
              </div>
            )}

            {appMode === 'vnl' && !OFFLINE_REVIEW_ONLY && (
              <div
                style={{
                  marginBottom: '1.5rem',
                  padding: '0.65rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(139, 92, 246, 0.1)',
                  border: '1px solid rgba(139, 92, 246, 0.35)',
                  color: '#ddd6fe',
                  fontSize: '0.9rem',
                }}
              >
                Manual annotation: no GPU inference. Upload MP4s and label skills yourself with keys 1–8.
              </div>
            )}

            {OFFLINE_REVIEW_ONLY && appMode === 'vnl' && (
              <div
                style={{
                  marginBottom: '1.5rem',
                  maxWidth: '720px',
                  padding: '0.85rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(139, 92, 246, 0.12)',
                  border: '1px solid rgba(139, 92, 246, 0.35)',
                  color: '#ddd6fe',
                  textAlign: 'center',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                }}
              >
                Labels are saved in this browser. Open <strong>MP4</strong> files (or the same folder) after refresh — your skill annotations will reload automatically.
                {vnlAwaitingFolder && state.playlist.length > 0 && (
                  <div style={{ marginTop: '0.5rem', color: '#fbbf24' }}>
                    Restored {state.playlist.length} video(s) from browser storage — pick the folder below to play videos.
                  </div>
                )}
              </div>
            )}

            {OFFLINE_REVIEW_ONLY && appMode !== 'vnl' && appMode !== 'touch' && appMode !== 'ball' && (
              <div
                style={{
                  marginBottom: '1.5rem',
                  maxWidth: '620px',
                  padding: '0.85rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.35)',
                  color: '#a7f3d0',
                  textAlign: 'center',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                }}
              >
                Review-only website: inference is disabled. Upload predictions made on the local tool, correct them, then download the updated ZIP/XML.
              </div>
            )}

            {OFFLINE_REVIEW_ONLY && appMode === 'touch' && (
              <div
                style={{
                  marginBottom: '1.5rem',
                  maxWidth: '720px',
                  padding: '0.85rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(59, 130, 246, 0.12)',
                  border: '1px solid rgba(59, 130, 246, 0.35)',
                  color: '#bfdbfe',
                  textAlign: 'center',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                }}
              >
                Manual skill annotation — open rally <strong>MP4</strong> files or a folder. XML/JSON is optional.
              </div>
            )}

            {OFFLINE_REVIEW_ONLY && appMode === 'ball' && (
              <div
                style={{
                  marginBottom: '1.5rem',
                  maxWidth: '720px',
                  padding: '0.85rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(251, 191, 36, 0.12)',
                  border: '1px solid rgba(251, 191, 36, 0.35)',
                  color: '#fde68a',
                  textAlign: 'center',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                }}
              >
                Manual ball annotation — open rally <strong>MP4</strong> files directly. Prediction ZIP/XML/JSON is optional.
              </div>
            )}

            {appMode === 'touch' && !OFFLINE_REVIEW_ONLY && (
              <div style={{ marginBottom: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'fadeInDown 0.8s ease-out', gap: '1.25rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>
                    Select Touch Detector
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-card)', padding: '0.35rem', borderRadius: '12px', border: '1px solid var(--border)', width: '420px', maxWidth: '95vw', boxShadow: '0 4px 20px -5px rgba(0,0,0,0.5)' }}>
                    <button
                      onClick={() => setTouchDetector('default')}
                      style={{
                        flex: 1, padding: '0.6rem 0.75rem', fontSize: '0.85rem', fontWeight: 600, borderRadius: '8px', cursor: 'pointer',
                        background: touchDetector === 'default' ? 'var(--primary)' : 'transparent',
                        color: touchDetector === 'default' ? 'white' : 'var(--text-muted)',
                        border: 'none', transition: 'all 0.2s',
                        boxShadow: touchDetector === 'default' ? '0 2px 10px rgba(59, 130, 246, 0.4)' : 'none'
                      }}
                    >
                      Default Touch
                    </button>
                    <button
                      onClick={() => {
                        if (backendHealth?.touch_sideview_configured !== 'true') {
                          window.alert('Side View Touch is not configured on the backend. Using Default Touch instead.');
                          setTouchDetector('default');
                          return;
                        }
                        setTouchDetector('side_view');
                      }}
                      disabled={backendHealth?.touch_sideview_configured !== 'true'}
                      title={
                        backendHealth?.touch_sideview_configured === 'true'
                          ? (backendHealth.touch_sideview_model || 'Side View SlowFast touch (best epoch 10)')
                          : 'Side View Touch weights not installed on backend'
                      }
                      style={{
                        flex: 1, padding: '0.6rem 0.75rem', fontSize: '0.85rem', fontWeight: 600, borderRadius: '8px',
                        cursor: backendHealth?.touch_sideview_configured === 'true' ? 'pointer' : 'not-allowed',
                        background: touchDetector === 'side_view' ? '#38bdf8' : 'transparent',
                        color: touchDetector === 'side_view' ? '#000' : 'var(--text-muted)',
                        opacity: backendHealth?.touch_sideview_configured === 'true' ? 1 : 0.45,
                        border: 'none', transition: 'all 0.2s',
                        boxShadow: touchDetector === 'side_view' ? '0 2px 10px rgba(56, 189, 248, 0.4)' : 'none'
                      }}
                    >
                      Side View Touch
                    </button>
                  </div>
                  {touchDetector === 'side_view' && (
                    <p style={{ color: '#7dd3fc', fontSize: '0.8rem', marginTop: '0.5rem', textAlign: 'center', maxWidth: '420px' }}>
                      Peaks only — no skill classification and no tracking JSON / player assign.
                    </p>
                  )}
                  {backendHealth && backendHealth.touch_sideview_configured !== 'true' && (
                    <p style={{ color: '#f87171', fontSize: '0.8rem', marginTop: '0.5rem', textAlign: 'center' }}>
                      Side View Touch is not fully configured on the backend.
                    </p>
                  )}
                </div>

                {touchDetector !== 'side_view' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>
                    Select Touch Player Engine
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-card)', padding: '0.35rem', borderRadius: '12px', border: '1px solid var(--border)', width: '320px', boxShadow: '0 4px 20px -5px rgba(0,0,0,0.5)' }}>
                    <button
                      onClick={() => setInferenceEngine('slowfast')}
                      style={{
                        flex: 1, padding: '0.6rem 1rem', fontSize: '0.9rem', fontWeight: 600, borderRadius: '8px', cursor: 'pointer',
                        background: inferenceEngine === 'slowfast' ? 'var(--primary)' : 'transparent',
                        color: inferenceEngine === 'slowfast' ? 'white' : 'var(--text-muted)',
                        border: 'none', transition: 'all 0.2s',
                        boxShadow: inferenceEngine === 'slowfast' ? '0 2px 10px rgba(59, 130, 246, 0.4)' : 'none'
                      }}
                    >
                      SlowFast
                    </button>
                    <button
                      onClick={() => setInferenceEngine('yolo')}
                      style={{
                        flex: 1, padding: '0.6rem 1rem', fontSize: '0.9rem', fontWeight: 600, borderRadius: '8px', cursor: 'pointer',
                        background: inferenceEngine === 'yolo' ? '#10b981' : 'transparent',
                        color: inferenceEngine === 'yolo' ? 'white' : 'var(--text-muted)',
                        border: 'none', transition: 'all 0.2s',
                        boxShadow: inferenceEngine === 'yolo' ? '0 2px 10px rgba(16, 185, 129, 0.4)' : 'none'
                      }}
                    >
                      YOLO27
                    </button>
                  </div>
                </div>
                )}
              </div>
            )}

            {appMode === 'ball' && !OFFLINE_REVIEW_ONLY && (
              <div style={{ marginBottom: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'fadeInDown 0.8s ease-out' }}>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>
                  Select Ball Tracking Engine
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-card)', padding: '0.35rem', borderRadius: '12px', border: '1px solid var(--border)', width: '480px', maxWidth: '95vw', boxShadow: '0 4px 20px -5px rgba(0,0,0,0.5)' }}>
                  <button
                    onClick={() => setBallEngine('yolo26')}
                    style={{
                      flex: 1, padding: '0.6rem 0.75rem', fontSize: '0.85rem', fontWeight: 600, borderRadius: '8px', cursor: 'pointer',
                      background: ballEngine === 'yolo26' ? '#fbbf24' : 'transparent',
                      color: ballEngine === 'yolo26' ? '#000' : 'var(--text-muted)',
                      border: 'none', transition: 'all 0.2s',
                      boxShadow: ballEngine === 'yolo26' ? '0 2px 10px rgba(251, 191, 36, 0.4)' : 'none'
                    }}
                  >
                    YOLO26
                  </button>
                  <button
                    onClick={() => {
                      if (backendHealth?.ball_sideview_configured !== 'true') {
                        window.alert('Side View Ball is not configured on the backend. Using YOLO26 instead.');
                        setBallEngine('yolo26');
                        return;
                      }
                      setBallEngine('side_view');
                    }}
                    disabled={backendHealth?.ball_sideview_configured !== 'true'}
                    title={backendHealth?.ball_sideview_configured === 'true' ? 'Use Side View Ball YOLO26 v2 (prev + 18 rallies + batch24 + batch5)' : 'Side View Ball weights not installed on backend'}
                    style={{
                      flex: 1, padding: '0.6rem 0.75rem', fontSize: '0.85rem', fontWeight: 600, borderRadius: '8px',
                      cursor: backendHealth?.ball_sideview_configured === 'true' ? 'pointer' : 'not-allowed',
                      background: ballEngine === 'side_view' ? '#38bdf8' : 'transparent',
                      color: ballEngine === 'side_view' ? '#000' : 'var(--text-muted)',
                      opacity: backendHealth?.ball_sideview_configured === 'true' ? 1 : 0.45,
                      border: 'none', transition: 'all 0.2s',
                      boxShadow: ballEngine === 'side_view' ? '0 2px 10px rgba(56, 189, 248, 0.4)' : 'none'
                    }}
                  >
                    Side View Ball v2
                  </button>
                  <button
                    onClick={() => {
                      if (backendHealth?.ball_triplet_configured !== 'true') {
                        window.alert('Triplet U-Net is not configured on the backend. Using YOLO26 instead.');
                        setBallEngine('yolo26');
                        return;
                      }
                      setBallEngine('triplet');
                    }}
                    disabled={backendHealth?.ball_triplet_configured !== 'true'}
                    title={backendHealth?.ball_triplet_configured === 'true' ? 'Use Triplet U-Net ball tracker' : 'Triplet weights not installed on backend'}
                    style={{
                      flex: 1, padding: '0.6rem 0.75rem', fontSize: '0.85rem', fontWeight: 600, borderRadius: '8px',
                      cursor: backendHealth?.ball_triplet_configured === 'true' ? 'pointer' : 'not-allowed',
                      background: ballEngine === 'triplet' ? '#fbbf24' : 'transparent',
                      color: ballEngine === 'triplet' ? '#000' : 'var(--text-muted)',
                      opacity: backendHealth?.ball_triplet_configured === 'true' ? 1 : 0.45,
                      border: 'none', transition: 'all 0.2s',
                      boxShadow: ballEngine === 'triplet' ? '0 2px 10px rgba(251, 191, 36, 0.4)' : 'none'
                    }}
                  >
                    Triplet U-Net
                  </button>
                </div>
                {backendHealth && backendHealth.ball_configured !== 'true' && (
                  <p style={{ color: '#f87171', fontSize: '0.8rem', marginTop: '0.75rem', textAlign: 'center' }}>
                    YOLO26 ball tracking is not fully configured on the backend.
                  </p>
                )}
                {backendHealth && backendHealth.ball_sideview_configured !== 'true' && (
                  <p style={{ color: '#f87171', fontSize: '0.8rem', marginTop: '0.5rem', textAlign: 'center' }}>
                    Side View Ball is not fully configured on the backend.
                  </p>
                )}
              </div>
            )}


        {/* DROPZONE */}
        <label 
          className="premium-dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void handlePlaylistFiles(e.dataTransfer.files); }}
          style={{ 
            width: '100%', maxWidth: '700px', padding: '0.75rem 1.5rem', 
            background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.15)', 
            borderRadius: '12px', textAlign: 'center', cursor: 'pointer', transition: 'all 0.3s ease',
            boxShadow: '0 5px 20px -10px rgba(0,0,0,0.5)', marginBottom: '1rem', position: 'relative', overflow: 'hidden'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)';
            e.currentTarget.style.borderColor = 'var(--primary)';
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 10px 30px -10px rgba(59, 130, 246, 0.3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 5px 20px -10px rgba(0,0,0,0.5)';
          }}
        >
          <div style={{ background: 'rgba(59, 130, 246, 0.1)', width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 0.5rem auto', color: 'var(--primary)' }}>
            <Upload size={18} />
          </div>
          <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.25rem 0', color: 'white' }}>
            {appMode === 'touch_block'
              ? 'Open Match Video + XML'
              : OFFLINE_REVIEW_ONLY && (appMode === 'vnl' || appMode === 'touch' || appMode === 'ball')
              ? 'Open MP4 Videos'
              : OFFLINE_REVIEW_ONLY
                ? 'Upload Prediction ZIP'
                : 'Upload Local Files'}
          </h2>
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.8rem' }}>
            {appMode === 'touch_block'
              ? <>Drag & drop <strong>MP4 + XML</strong> together (e.g. <code>video-32608.mp4</code> + <code>annotations_32608.xml</code>), or choose files / folder.</>
              : OFFLINE_REVIEW_ONLY && appMode === 'vnl'
              ? <>Drag & drop <strong>MP4</strong> files, or choose files / a folder. Labels stay in this browser after refresh.</>
              : OFFLINE_REVIEW_ONLY && appMode === 'touch'
                ? <>Drag & drop <strong>MP4</strong> files, or choose files / a folder. XML/JSON not required.</>
              : OFFLINE_REVIEW_ONLY && appMode === 'ball'
                ? <>Drag & drop <strong>MP4</strong> files for manual ball annotation. Prediction ZIP is optional.</>
              : OFFLINE_REVIEW_ONLY
                ? <>Drag & drop a <strong>ZIP</strong> containing matching <strong>video + XML/JSON</strong> files.</>
                : <>Drag & drop your <strong>MP4</strong>, <strong>ZIP</strong>, <strong>XML</strong>, or <strong>JSON</strong> files here to start annotating.</>}
          </p>
          {appMode === 'touch_block' ? (
            <>
              <input
                id="touch-block-files-input"
                type="file"
                multiple
                accept="video/mp4,video/*,.mp4,.mov,.m4v,application/xml,text/xml,.xml,application/zip,.zip"
                onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }}
                style={{ display: 'none' }}
              />
              <input
                id="touch-block-folder-input"
                type="file"
                multiple
                accept="video/mp4,video/*,.mp4,application/xml,text/xml,.xml"
                onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }}
                style={{ display: 'none' }}
                {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              />
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    document.getElementById('touch-block-files-input')?.click();
                  }}
                >
                  Choose MP4 + XML
                </button>
                <button
                  type="button"
                  className="btn outline"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    document.getElementById('touch-block-folder-input')?.click();
                  }}
                >
                  Choose folder
                </button>
              </div>
            </>
          ) : OFFLINE_REVIEW_ONLY && (appMode === 'vnl' || appMode === 'touch' || appMode === 'ball') ? (
            <>
              <input
                id="manual-mp4-input"
                type="file"
                multiple
                accept="video/mp4,video/*,.mp4,.mov,.m4v"
                onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }}
                style={{ display: 'none' }}
              />
              <input
                id="manual-folder-input"
                type="file"
                multiple
                accept="video/mp4,video/*,.mp4"
                onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }}
                style={{ display: 'none' }}
                {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              />
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    document.getElementById('manual-mp4-input')?.click();
                  }}
                >
                  Choose MP4 files
                </button>
                <button
                  type="button"
                  className="btn outline"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    document.getElementById('manual-folder-input')?.click();
                  }}
                >
                  Choose folder
                </button>
              </div>
            </>
          ) : (
          <input
            type="file"
            accept={OFFLINE_REVIEW_ONLY ? "application/zip,.zip" : "video/mp4,application/zip,.zip,application/xml,text/xml,.xml,application/json,.json"}
            multiple={!OFFLINE_REVIEW_ONLY}
            onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }}
            style={{ display: 'none' }}
          />
          )}
        </label>

        {/* FEATURE CARDS (Replaces old Documentation list) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', width: '100%', maxWidth: '900px' }}>
          
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: '#fbbf24', marginBottom: '0.8rem' }}><Settings size={24} /></div>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.5rem 0', color: 'white' }}>Hotkeys</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>
              {appMode === 'ball' 
                ? <>Use <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>←</code> & <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>→</code> to navigate frames. Use <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>Ctrl+Z</code> to undo.</>
                : <>Use keys <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>1-6</code> for assigning skills. Use <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>S</code> & <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>E</code> to mark rally boundaries.</>}
            </p>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: '#4ade80', marginBottom: '0.8rem' }}><FileVideo size={24} /></div>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.5rem 0', color: 'white' }}>Bounding Boxes</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>
              {appMode === 'ball'
                ? "Default view shows raw YOLO inference only (same as the Python script). Click Edit to correct boxes — then → carries the box to the next frame."
                : "Click & drag over players to track. Double-click any box to instantly assign them to the active frame's skill."}
            </p>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: '#a78bfa', marginBottom: '0.8rem' }}><Download size={24} /></div>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.5rem 0', color: 'white' }}>Export Data</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>Click Batch ZIP in the sidebar to securely download perfectly synced JSON/XML datasets for model training.</p>
          </div>
          
        </div>

        <div style={{ marginTop: '3rem' }}>
          <button onClick={downloadDocumentation} className="btn outline" style={{ fontSize: '0.85rem', padding: '0.6rem 1.2rem', borderRadius: '20px', color: 'var(--text-muted)', borderColor: 'rgba(255,255,255,0.2)' }}>
            Download Detailed Guide (.txt)
          </button>
        </div>
        </div>
        )}
        
          <div style={{ flexGrow: 1 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* PLAYLIST SIDEBAR */}
      <div
        className="sidebar"
        style={{
          minWidth: appMode === 'touch_block' ? '260px' : '200px',
          maxWidth: appMode === 'touch_block' ? '300px' : '250px',
          overflowY: 'hidden',
        }}
      >
        
        {/* BRANDING HEADER */}
        <div style={{ flexShrink: 0, paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', paddingLeft: '0.5rem' }}>
          <img src={`${import.meta.env.BASE_URL}logo.png?v=9`} alt="Veritas Pro Logo" style={{ width: '42px', height: '42px' }} />
          <div>
            <h1 style={{ fontSize: '1.2rem', letterSpacing: '1px', textTransform: 'uppercase', margin: 0, fontWeight: 700, lineHeight: 1.1, textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>Veritas Pro</h1>
            <p style={{ fontSize: '0.6rem', color: 'var(--primary)', letterSpacing: '1px', margin: 0, fontWeight: 700, marginTop: '2px', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>BY THELIOS.AI</p>
          </div>
        </div>

        {/* PLAYLIST PANEL */}
        <div
          className="glass-panel sidebar-section"
          style={{
            flex: appMode === 'touch_block' ? '0 1 38%' : 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            maxHeight: appMode === 'touch_block' ? '38%' : undefined,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h2 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Playlist ({state.currentPlaylistIndex + 1} / {state.playlist.length})
            </h2>
            <button 
              className="btn outline icon-only" 
              onClick={() => {
                returnToHome();
              }}
              title="Return to Home"
              style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', borderRadius: '6px' }}
            >
              Home
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.2rem' }}>
            {state.playlist.map((item, index) => {
              const isActive = index === state.currentPlaylistIndex;
              const workflowMode: WorkflowMode =
                appMode === 'ball' ? 'ball' : appMode === 'vnl' ? 'vnl' : 'touch';
              const algorithmApplied = isItemAlgorithmApplied(item, workflowMode);
              return (
                <div 
                  key={item.id} 
                  onClick={() => changeVideo(index)}
                  style={{ 
                    padding: '0.6rem 0.8rem', 
                    background: isActive ? 'linear-gradient(90deg, rgba(59, 130, 246, 0.25) 0%, transparent 100%)' : 'transparent',
                    borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                    borderRadius: '0 8px 8px 0',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? 'white' : 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{ 
                      width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                      backgroundColor: algorithmApplied ? '#10b981' : '#ef4444',
                      boxShadow: algorithmApplied ? '0 0 5px rgba(16,185,129,0.5)' : '0 0 5px rgba(239,68,68,0.5)'
                    }} title={algorithmApplied ? 'Algorithm Completed' : 'Algorithm Pending'} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  </div>
                  {item.isCompleted && <CheckCircle size={14} color="var(--color-serve)" />}
                </div>
              );
            })}
          </div>

          {batchProgress.isRunning && (
            <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.8)', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                <span>Processing... ({batchProgress.completed}/{batchProgress.total})</span>
                <span>{Math.round((batchProgress.completed / batchProgress.total) * 100)}%</span>
              </div>
              <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden', marginBottom: '4px' }}>
                <div style={{ width: `${(batchProgress.completed / batchProgress.total) * 100}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.3s ease' }} />
              </div>
              <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)' }}>
                {batchProgress.avgTimeSec > 0 ? (
                  <>ETA: {Math.floor((batchProgress.avgTimeSec * (batchProgress.total - batchProgress.completed)) / 60)}m {Math.round((batchProgress.avgTimeSec * (batchProgress.total - batchProgress.completed)) % 60)}s</>
                ) : (
                  <>Calculating ETA...</>
                )}
              </div>
            </div>
          )}

          {warnings.length > 0 && (
            <div style={{ maxHeight: '150px', overflowY: 'auto', marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.5rem', flexShrink: 0 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '0.5rem', color: 'var(--color-attack)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <AlertTriangle size={14} /> Validation Warnings
              </div>
              {warnings.map((w, i) => (
                <div key={i} className={`validation-warning ${w.type}`} style={{ padding: '0.4rem', fontSize: '0.75rem', marginBottom: '4px' }}>
                  {w.type === 'error' ? <AlertCircle size={14} /> : <AlertTriangle size={14} />}
                  <span>{w.msg}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', cursor: 'pointer', color: 'rgba(255,255,255,0.7)' }}>
              <input 
                type="checkbox" 
                checked={includeMp4InZip} 
                onChange={(e) => setIncludeMp4InZip(e.target.checked)} 
                style={{ cursor: 'pointer' }}
              />
              Include MP4s in ZIP (May freeze browser for large batches)
            </label>
            <button 
              className="btn" 
              onClick={() => {
                saveCurrentVideoState(); // Save current before exporting
                
                // Construct the updated playlist immediately to ensure the ZIP has the latest manual edits
                // for the currently viewed video, because setState is asynchronous.
                const updatedPlaylist = [...state.playlist];
                if (updatedPlaylist[state.currentPlaylistIndex]) {
                  updatedPlaylist[state.currentPlaylistIndex] = {
                    ...updatedPlaylist[state.currentPlaylistIndex],
                    rally: state.rally,
                    events: state.events,
                    playerBoxes: state.playerBoxes,
                  };
                }
                
                exportAllToZip(
                  updatedPlaylist,
                  true,
                  includeMp4InZip,
                  appMode === 'ball' ? 'ball' : appMode === 'vnl' ? 'vnl' : 'touch',
                );
              }}
            >
              <Download size={16} /> Batch ZIP
            </button>


          </div>
        </div>

        {appMode === 'touch_block' && attackProgressSummary && (
          <div
            className="glass-panel sidebar-section"
            style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
          >
            <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.35rem' }}>
              <span>Attacks</span>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#a8df23' }}>
                {attackProgressSummary.done}/{attackProgressSummary.total} done
              </span>
            </h2>
            <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginBottom: '0.55rem', lineHeight: 1.35 }}>
              <span style={{ color: '#4ade80' }}>●</span> block+dot{' '}
              <span style={{ color: '#fbbf24' }}>●</span> block only{' '}
              <span style={{ color: '#64748b' }}>●</span> pending
            </div>
            <button
              className="btn"
              onClick={seekNextPendingAttack}
              style={{
                width: '100%',
                marginBottom: '0.55rem',
                background: '#a8df23',
                color: '#111',
                border: 'none',
                fontWeight: 700,
                fontSize: '0.8rem',
                padding: '0.55rem 0.6rem',
                flexShrink: 0,
              }}
              title="Jump to next attack still needing work"
            >
              Next pending attack
              {attackProgressSummary.pending + attackProgressSummary.partial > 0
                ? ` (${attackProgressSummary.pending + attackProgressSummary.partial} left)`
                : ' ✓'}
            </button>
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '0.28rem' }}>
              {attackBlockProgress.length === 0 ? (
                <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>No attacks in XML yet.</div>
              ) : (
                attackBlockProgress.map((row) => {
                  const isCurrent =
                    state.currentFrame === row.attackFrame ||
                    (row.blockFrame !== undefined && state.currentFrame === row.blockFrame);
                  const statusColor =
                    row.status === 'done' ? '#4ade80' : row.status === 'block_no_dot' ? '#fbbf24' : '#64748b';
                  const statusLabel =
                    row.status === 'done' ? 'done' : row.status === 'block_no_dot' ? 'no dot' : 'pending';
                  return (
                    <button
                      key={`atk-${row.attackIndex}-${row.attackFrame}`}
                      type="button"
                      onClick={() =>
                        seekToFrame(
                          row.status === 'block_no_dot' && row.blockFrame != null
                            ? row.blockFrame
                            : row.attackFrame,
                        )
                      }
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        width: '100%',
                        textAlign: 'left',
                        padding: '0.38rem 0.5rem',
                        borderRadius: '8px',
                        border: isCurrent ? '1px solid #a8df23' : '1px solid rgba(148,163,184,0.25)',
                        background: isCurrent ? 'rgba(168,223,35,0.12)' : 'rgba(15,23,42,0.45)',
                        color: '#e2e8f0',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        flexShrink: 0,
                      }}
                      title={
                        row.status === 'done'
                          ? `Attack #${row.attackIndex} @ f${row.attackFrame} — block+dot done`
                          : row.status === 'block_no_dot'
                            ? `Attack #${row.attackIndex} — block at f${row.blockFrame}, click video for ball dot`
                            : `Attack #${row.attackIndex} @ f${row.attackFrame} — press 7 then click for block+dot`
                      }
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: statusColor,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: 700, minWidth: '1.5rem' }}>#{row.attackIndex}</span>
                      <span style={{ opacity: 0.85 }}>f{row.attackFrame}</span>
                      <span style={{ marginLeft: 'auto', color: statusColor, fontWeight: 600, fontSize: '0.68rem' }}>
                        {statusLabel}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* MAIN CONTENT */}
      <div className="main-content" ref={fullscreenRef}>
        <div className="glass-panel video-wrapper" style={{ 
          flex: 1,
          minHeight: 0,
          position: 'relative', 
          overflow: viewTransform.zoom > 1 ? 'auto' : 'hidden',
        }} ref={wrapperRef}>
          <div style={{
            position: 'absolute',
            inset: 0,
            width: viewTransform.zoom > 1 ? `${viewTransform.zoom * 100}%` : '100%',
            height: viewTransform.zoom > 1 ? `${viewTransform.zoom * 100}%` : '100%',
            maxWidth: viewTransform.zoom > 1 ? 'none' : '100%',
            background: '#000',
            transformOrigin: 'top left',
          }}>
            <video 
              ref={videoRef} 
              src={videoUrl} 
              onLoadedMetadata={handleVideoLoaded}
              onLoadedData={() => {
                const v = videoRef.current;
                if (!v) return;
                const frame = stateRef.current.currentFrame;
                if (frame > 0) {
                  const item = stateRef.current.playlist[stateRef.current.currentPlaylistIndex];
                  const mode = appModeRef.current;
                  const timing = getTimingForMode(
                    mode,
                    stateRef.current.videoMetadata,
                    (mode === 'ball' || mode === 'vnl')
                      ? item?.inferenceVideoMeta
                      : undefined,
                  );
                  if (mode === 'vnl' && item?.inferenceVideoMeta && v.duration > 0) {
                    v.currentTime = vnlMapFrameToTime(
                      frame,
                      item.inferenceVideoMeta.frame_count,
                      v.duration,
                      item.inferenceVideoMeta.fps,
                    );
                  } else {
                    v.currentTime = frameToTime(frame, timing.fps, false);
                  }
                } else {
                  v.currentTime = 0;
                }
                setVideoPlaybackError(null);
              }}
              onTimeUpdate={handleTimeUpdate}
              onSeeked={handleVideoSeeked}
              onError={() => {
                // Do not overwrite the "converting…" overlay with a failure while convert is in flight.
                if (videoTranscodingRef.current) return;

                const item = stateRef.current.playlist[stateRef.current.currentPlaylistIndex];
                const fileKey = item?.file
                  ? `${item.file.name}:${item.file.size}:${item.file.lastModified}`
                  : '';
                // Local: GPU H.264. GitHub Pages: in-browser ffmpeg.wasm for mp4v/etc.
                if (
                  item?.file &&
                  !looksLikeH264Filename(item.file.name) &&
                  !convertFailedRef.current.has(fileKey) &&
                  !gpuFileReadyRef.current.has(item.id)
                ) {
                  void prepareVideoPlayback(item.file);
                  return;
                }
                const v = videoRef.current;
                const code = v?.error?.code;
                const reason =
                  code === 3 ? 'decode error (codec not supported in browser)'
                    : code === 4 ? 'format not supported'
                      : code === 2 ? 'network error'
                        : 'load error';
                setVideoPlaybackError(
                  OFFLINE_REVIEW_ONLY
                    ? `Video failed to load (${reason}). This clip is MPEG-4/mp4v (Chrome cannot play it). Click another *_h264.mp4 in the playlist, or wait for in-browser convert on this file.`
                    : `Video failed to load (${reason}). If this is HEVC, wait for H.264 conversion or use an H.264 MP4.`,
                );
              }}
              controls={false}
              preload="auto"
              playsInline
              crossOrigin={videoUrl.startsWith('blob:') ? undefined : 'anonymous'}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
            {(videoTranscoding || videoPlaybackError || (!currentPlaylistItem?.file && !currentPlaylistItem?.driveUrl)) && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(0,0,0,0.82)',
                  zIndex: 20,
                  padding: '1.5rem',
                  textAlign: 'center',
                  color: 'white',
                  fontSize: '0.95rem',
                  lineHeight: 1.5,
                }}
              >
                {videoTranscoding
                  ? (OFFLINE_REVIEW_ONLY
                      ? 'Converting this rally to H.264 in your browser (once). Saved in this browser — after refresh, re-open the same MP4 and it will load from cache (no re-convert). First time also downloads ffmpeg (~25MB).'
                      : 'Converting this rally to H.264 for browser playback (once). Other rallies stay usable.')
                  : (videoPlaybackError ?? 'Video file not in memory. Re-upload the MP4 to view playback.')}
              </div>
            )}
            {appMode === 'vnl' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 5,
                  cursor: currentVnlEvent ? 'crosshair' : 'default',
                }}
                onClick={handleVnlVideoClick}
                title={
                  currentVnlEvent
                    ? 'Click to set or move the contact dot for this skill'
                    : 'Add a skill with 1–8, then click to place the contact dot'
                }
              />
            )}
            {appMode === 'touch_block' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 7,
                  cursor: currentBlockEvent ? 'crosshair' : 'default',
                }}
                onClick={handleTouchBlockVideoClick}
                title={
                  currentBlockEvent
                    ? 'Click to set or move the ball contact dot for this block'
                    : 'Press 7 to add block, then click where the ball is contacted'
                }
              />
            )}
            {appMode === 'vnl' && currentVnlEvent?.xy && currentVnlDotPosition && (
              <div
                style={{
                  position: 'absolute',
                  left: `${currentVnlDotPosition.left}%`,
                  top: `${currentVnlDotPosition.top}%`,
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  border: '2px solid white',
                  background: `var(--color-${currentVnlEvent.skill})`,
                  transform: 'translate(-50%, -50%)',
                  boxShadow: '0 0 10px rgba(255,255,255,0.8)',
                  pointerEvents: 'none',
                  zIndex: 6,
                }}
              />
            )}
            {appMode === 'touch_block' && currentBlockEvent?.xy && currentBlockDotPosition && (
              <div
                style={{
                  position: 'absolute',
                  left: `${currentBlockDotPosition.left}%`,
                  top: `${currentBlockDotPosition.top}%`,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: '2px solid white',
                  background: 'var(--color-block, #a8df23)',
                  transform: 'translate(-50%, -50%)',
                  boxShadow: '0 0 12px rgba(168, 223, 35, 0.9)',
                  pointerEvents: 'none',
                  zIndex: 8,
                }}
                title="Block ball contact"
              />
            )}
            {showBoundingBoxes && state.videoMetadata && appMode !== 'vnl' && appMode !== 'touch_block' && (
              <svg 
                ref={svgRef}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'auto', zIndex: 5, cursor: interactionMode === 'zoom' ? 'zoom-in' : 'crosshair' }}
                viewBox={`0 0 ${playbackTiming.width} ${playbackTiming.height}`}
                preserveAspectRatio="xMidYMid meet"
                onMouseDown={handleSvgMouseDown}
                onMouseMove={handleSvgMouseMove}
                onMouseUp={handleSvgMouseUp}
                onMouseLeave={handleSvgMouseUp}
              >
                {(rejectedBallBoxesForDisplay[ballOverlayFrame] || []).map((box, idx) => {
                  const color = '#f472b6';
                  return (
                    <g key={`rejected-${idx}`} style={{ pointerEvents: 'none' }}>
                      <rect
                        x={box.x_min}
                        y={box.y_min}
                        width={box.x_max - box.x_min}
                        height={box.y_max - box.y_min}
                        fill="none"
                        stroke={color}
                        strokeWidth="4"
                      />
                      <rect
                        x={box.x_min - 2}
                        y={box.y_min - 22}
                        width="95"
                        height="22"
                        fill={color}
                      />
                      <text
                        x={box.x_min + 4}
                        y={box.y_min - 6}
                        fill="#000"
                        fontSize="14"
                        fontWeight="bold"
                      >
                        {`Ball ${(box.conf || 0).toFixed(2)}`}
                      </text>
                    </g>
                  );
                })}
                {[...(ballBoxesForDisplay[ballOverlayFrame] || [])]
                  .sort((a, b) => {
                    const areaA = (a.x_max - a.x_min) * (a.y_max - a.y_min);
                    const areaB = (b.x_max - b.x_min) * (b.y_max - b.y_min);
                    return areaB - areaA; // Sort descending: biggest first, smallest last (on top)
                  })
                  .map((box, idx) => {
                  if (showOnlyActiveBoxes && !box.is_active) return null;
                  const isSelected = selectedTrackId === box.track_id;
                  const isBall = appMode === 'ball';
                  const color = isBall ? '#fbbf24' : (box.is_active ? '#4ade80' : '#ef4444');
                  return (
                    <g 
                      key={idx} 
                      style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                      onMouseDown={(e) => {
                        if (appMode === 'ball' && !ballEditMode) return;
                        e.stopPropagation();
                        const pos = getMousePos(e);
                        if (!pos) return;
                        saveToHistory(state);
                        setDraggingBox({ trackId: box.track_id, startX: pos.x, startY: pos.y, initialBox: { ...box } });
                      }}
                      onClick={() => !isBall && setSelectedTrackId(box.track_id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (window.confirm("Delete this bounding box?")) {
                          handleDeleteBox(box.track_id);
                        }
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (isBall) return; // No player assignment in ball mode
                        const hasEvent = state.events.some(ev => ev.frame === state.currentFrame);
                        if (hasEvent) {
                          handleAssignPlayer(state.currentFrame, box.track_id);
                        } else {
                          window.alert("No skill event found on this exact frame. Please create a skill first before assigning a player.");
                        }
                      }}
                    >
                      {/* Invisible larger rect to make clicking easier */}
                      <rect 
                        x={box.x_min - 10} 
                        y={box.y_min - 10} 
                        width={(box.x_max - box.x_min) + 20} 
                        height={(box.y_max - box.y_min) + 20} 
                        fill="transparent" 
                      />
                      <rect 
                        x={box.x_min} 
                        y={box.y_min} 
                        width={box.x_max - box.x_min} 
                        height={box.y_max - box.y_min} 
                        fill={isSelected ? 'rgba(255,255,255,0.2)' : 'none'} 
                        stroke={isSelected ? '#fff' : color} 
                        strokeWidth={isSelected ? "6" : "4"} 
                      />
                      <rect 
                        x={box.x_min - 2} 
                        y={box.y_min - 22} 
                        width={isBall ? "95" : "50"} 
                        height="22" 
                        fill={isSelected ? '#fff' : color} 
                      />
                      <text 
                        x={box.x_min + 4} 
                        y={box.y_min - 6} 
                        fill={isSelected ? '#000' : (isBall ? '#000' : '#fff')} 
                        fontSize="14" 
                        fontWeight="bold"
                      >
                        {isBall ? `Ball ${(box.conf || 0).toFixed(2)}` : `ID: ${box.track_id}`}
                      </text>

                      {/* Resize Handles */}
                      {[
                        { corner: 'tl', x: box.x_min, y: box.y_min, cursor: 'nwse-resize' },
                        { corner: 'tr', x: box.x_max, y: box.y_min, cursor: 'nesw-resize' },
                        { corner: 'bl', x: box.x_min, y: box.y_max, cursor: 'nesw-resize' },
                        { corner: 'br', x: box.x_max, y: box.y_max, cursor: 'nwse-resize' }
                      ].map((h, i) => (
                        <rect
                          key={i}
                          x={h.x - (8 / viewTransform.zoom) / 2}
                          y={h.y - (8 / viewTransform.zoom) / 2}
                          width={8 / viewTransform.zoom}
                          height={8 / viewTransform.zoom}
                          fill="white"
                          stroke={color}
                          strokeWidth={2 / viewTransform.zoom}
                          cursor={h.cursor}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const pos = getMousePos(e);
                            if (!pos) return;
                            saveToHistory(state);
                            setResizingBox({ trackId: box.track_id, startX: pos.x, startY: pos.y, initialBox: { ...box }, corner: h.corner as 'tl'|'tr'|'bl'|'br' });
                          }}
                        />
                      ))}
                    </g>
                  );
                })}
                
                {drawingBox && (
                  <rect 
                    x={Math.min(drawingBox.startX, drawingBox.currentX)}
                    y={Math.min(drawingBox.startY, drawingBox.currentY)}
                    width={Math.abs(drawingBox.currentX - drawingBox.startX)}
                    height={Math.abs(drawingBox.currentY - drawingBox.startY)}
                    fill={interactionMode === 'zoom' ? "rgba(59, 130, 246, 0.2)" : "rgba(255,255,255,0.2)"}
                    stroke={interactionMode === 'zoom' ? "#3b82f6" : "#fff"}
                    strokeWidth="4"
                    strokeDasharray="5,5"
                    style={{ pointerEvents: 'none' }}
                  />
                )}
              </svg>
            )}
            {(() => {
              const activeEvent = state.events.find(e => e.frame === state.currentFrame);
              if (activeEvent) {
                return (
                  <div style={{
                    position: 'absolute',
                    top: '20px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    padding: '8px 24px',
                    borderRadius: '8px',
                    fontSize: '2rem',
                    fontWeight: 'bold',
                    textTransform: 'uppercase',
                    backgroundColor: `var(--color-${activeEvent.skill})`,
                    color: '#fff',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    zIndex: 10,
                    pointerEvents: 'none',
                    letterSpacing: '2px',
                    textShadow: '0 2px 4px rgba(0,0,0,0.3)'
                  }}>
                    {activeEvent.skill}
                  </div>
                );
              }
              return null;
            })()}
          </div>
        </div>

        <div className="glass-panel video-controls">
          <div className="controls-row">
            <button 
              className="btn outline icon-only" 
              onMouseDown={() => startContinuousSeek(-5)}
              onMouseUp={stopContinuousSeek}
              onMouseLeave={stopContinuousSeek}
              onTouchStart={() => startContinuousSeek(-5)}
              onTouchEnd={stopContinuousSeek}
            >-5f</button>
            {appMode === 'touch_block' && (
              <button className="btn outline" onClick={() => seekAdjacentAttack(-1)} title="Previous attack (←)">
                ← Attack
              </button>
            )}
            <button 
              className="btn outline icon-only" 
              onMouseDown={() => startContinuousSeek(-1)}
              onMouseUp={stopContinuousSeek}
              onMouseLeave={stopContinuousSeek}
              onTouchStart={() => startContinuousSeek(-1)}
              onTouchEnd={stopContinuousSeek}
            >-1f</button>
            <button className={`btn ${appMode === 'ball' && isAutoStepping ? 'active' : ''}`} onClick={togglePlayPause}>
              {appMode === 'ball' ? (isAutoStepping ? 'Pause Step' : 'Step Play') : 'Play / Pause'}
            </button>
            <button 
              className="btn outline icon-only" 
              onMouseDown={() => startContinuousSeek(1)}
              onMouseUp={stopContinuousSeek}
              onMouseLeave={stopContinuousSeek}
              onTouchStart={() => startContinuousSeek(1)}
              onTouchEnd={stopContinuousSeek}
            >+1f</button>
            {appMode === 'touch_block' && (
              <button className="btn outline" onClick={() => seekAdjacentAttack(1)} title="Next attack (→)">
                Attack →
              </button>
            )}
            {appMode === 'touch_block' && (
              <button
                className="btn"
                onClick={() =>
                  addEvent({ label: 'block', classId: SKILL_CLASS_IDS.block })
                }
                title="Add Block on current frame (hotkey 7), then click video for ball contact dot"
                style={{
                  background: 'var(--color-block, #ef4444)',
                  color: '#fff',
                  border: 'none',
                  fontWeight: 700,
                }}
              >
                Block
              </button>
            )}
            {appMode === 'touch_block' && (
              <button
                className="btn"
                onClick={seekNextPendingAttack}
                title="Jump to next attack that still needs a block + ball dot"
                style={{ background: '#a8df23', color: '#111', border: 'none', fontWeight: 700 }}
              >
                Next pending
              </button>
            )}
            <button 
              className="btn outline icon-only" 
              onMouseDown={() => startContinuousSeek(5)}
              onMouseUp={stopContinuousSeek}
              onMouseLeave={stopContinuousSeek}
              onTouchStart={() => startContinuousSeek(5)}
              onTouchEnd={stopContinuousSeek}
            >+5f</button>
            
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {appMode === 'ball' && (
                  <button
                    className={`btn outline ${ballEditMode ? 'active' : ''}`}
                    onClick={toggleBallEditMode}
                    title={ballEditMode ? 'Exit edit mode (saves your changes)' : 'Edit mode: draw, drag, or carry box forward when stepping frames'}
                    style={{
                      padding: '0.5rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      borderColor: ballEditMode ? '#fbbf24' : undefined,
                      color: ballEditMode ? '#fbbf24' : undefined,
                    }}
                  >
                    <Pencil size={16} />
                    {ballEditMode ? 'Editing' : 'Edit'}
                  </button>
                )}
                <button 
                  className={`btn outline ${!showBoundingBoxes ? 'active' : ''}`}
                  onClick={() => setShowBoundingBoxes(prev => !prev)}
                  title={showBoundingBoxes ? "Hide Bounding Boxes" : "Show Bounding Boxes"}
                  style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  {showBoundingBoxes ? <EyeOff size={16} /> : <Eye size={16} />}
                  {showBoundingBoxes ? 'Hide All' : 'Show All'}
                </button>
                <button 
                  className={`btn outline ${showOnlyActiveBoxes ? 'active' : ''}`}
                  onClick={() => setShowOnlyActiveBoxes(prev => !prev)}
                  title={showOnlyActiveBoxes ? "Show All Boxes" : "Show Only Active Boxes"}
                  style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                  disabled={!showBoundingBoxes}
                >
                  <Eye size={16} />
                  {showOnlyActiveBoxes ? 'All Players' : 'Active Only'}
                </button>
                {appMode === 'ball' ? (
                  <label
                    title="Frames per second when holding > or arrow keys"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontFamily: 'monospace' }}
                  >
                    <input
                      type="number"
                      min={1}
                      max={60}
                      step={1}
                      value={ballFrameStepFps}
                      onChange={(e) => handleBallFrameStepFpsChange(e.target.value)}
                      style={{
                        width: '52px',
                        padding: '0.35rem',
                        borderRadius: '6px',
                        border: '1px solid rgba(255,255,255,0.2)',
                        background: 'rgba(0,0,0,0.3)',
                        color: 'inherit',
                        textAlign: 'center',
                      }}
                    />
                    f/s
                  </label>
                ) : (
                  <button 
                    className="btn outline"
                    onClick={cyclePlaybackRate}
                    title="Change Playback Speed"
                    style={{ padding: '0.5rem', fontFamily: 'monospace', width: '60px' }}
                  >
                    {playbackRate}x
                  </button>
                )}
                <div style={{ fontFamily: 'monospace', fontSize: '1.2rem' }}>
                  Frame: {(appMode === 'ball' ? ballOverlayFrame : state.currentFrame)} / {playbackTiming.frame_count || 0}
                  {appMode === 'ball' && (
                    <span style={{ fontSize: '0.8rem', color: presentedBallFrame === state.currentFrame ? '#4ade80' : '#fbbf24', marginLeft: '0.5rem' }}>
                      (shown: {presentedBallFrame ?? 'n/a'})
                    </span>
                  )}
                </div>
                <button 
                  className="btn outline icon-only" 
                  onClick={() => changeVideo(state.currentPlaylistIndex - 1)}
                  disabled={state.currentPlaylistIndex === 0}
                  title="Previous Video"
                >
                  <ArrowLeft size={16} />
                </button>
                <button 
                  className="btn outline icon-only" 
                  onClick={() => changeVideo(state.currentPlaylistIndex + 1)}
                  disabled={state.currentPlaylistIndex >= state.playlist.length - 1}
                  title="Next Video"
                >
                  <ArrowRight size={16} />
                </button>
                
                <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.2)', margin: '0 0.5rem' }} />
                
                <button 
                  className={`btn outline ${interactionMode === 'draw' ? 'active' : ''}`}
                  onClick={() => setInteractionMode('draw')}
                  title="Draw Bounding Box Mode"
                  style={{ padding: '0.5rem' }}
                  disabled={appMode === 'ball' && !ballEditMode}
                >
                  <MousePointer2 size={16} />
                </button>
                <button 
                  className={`btn outline ${interactionMode === 'zoom' ? 'active' : ''}`}
                  onClick={() => setInteractionMode('zoom')}
                  title="Marquee Zoom Mode"
                  style={{ padding: '0.5rem' }}
                >
                  <Search size={16} />
                </button>
                <button 
                  className="btn outline"
                  onClick={resetZoom}
                  title="Reset Zoom"
                  disabled={viewTransform.zoom === 1}
                  style={{ padding: '0.5rem', fontFamily: 'monospace' }}
                >
                  {Math.round(viewTransform.zoom * 100)}%
                </button>
                
                <button 
                  className="btn outline icon-only"
                  onClick={toggleFullscreen}
                  title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
                  style={{ marginLeft: '0.5rem' }}
                >
                  {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                </button>
              </div>
            </div>
          </div>
          
          <div className="scrub-bar-container" onClick={(e) => {
            if (!playbackTiming.frame_count) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            seekToFrame(Math.round(percent * playbackTiming.frame_count));
          }}>
            <div className="scrub-bar-track">
              {playbackTiming.frame_count > 0 && (
                <div 
                  className="scrub-bar-fill" 
                  style={{ width: `${(state.currentFrame / playbackTiming.frame_count) * 100}%` }}
                />
              )}
              {playbackTiming.frame_count > 0 && (
                <div 
                  className="scrub-bar-thumb" 
                  style={{ left: `${(state.currentFrame / playbackTiming.frame_count) * 100}%` }}
                />
              )}
            </div>
          </div>
        </div>

        {/* TIMELINE */}
        {appMode !== 'ball' && (
          <div className="glass-panel timeline" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.8rem' }}>
            <div className="timeline-track" style={{ position: 'relative', width: '100%', height: '30px' }}>
              {state.rally.start_frame !== null && playbackTiming.frame_count > 0 && (
                <div 
                  className="timeline-marker" 
                  style={{ left: `${(state.rally.start_frame / playbackTiming.frame_count) * 100}%`, backgroundColor: 'var(--color-rally)', height: '100%', top: 0 }}
                  title="Start Rally"
                  onClick={() => seekToFrame(state.rally.start_frame!)}
                />
              )}
              {state.rally.end_frame !== null && playbackTiming.frame_count > 0 && (
                <div 
                  className="timeline-marker" 
                  style={{ left: `${(state.rally.end_frame / playbackTiming.frame_count) * 100}%`, backgroundColor: 'var(--color-rally)', height: '100%', top: 0 }}
                  title="End Rally"
                  onClick={() => seekToFrame(state.rally.end_frame!)}
                />
              )}
              
              {/* Active window blocks on the timeline */}
              {playbackTiming.frame_count > 0 && activeRanges.map((range, idx) => {
                const startPct = (range.start / playbackTiming.frame_count) * 100;
                const widthPct = ((range.end - range.start) / playbackTiming.frame_count) * 100;
                const skillColor = range.skillName !== 'default' ? `var(--color-${range.skillName})` : '#4ade80';
                return (
                  <div
                    key={`active-win-${idx}`}
                    style={{
                      position: 'absolute',
                      left: `${startPct}%`,
                      width: `${Math.max(widthPct, 0.2)}%`,
                      height: '100%',
                      backgroundColor: skillColor,
                      opacity: 0.3,
                      borderLeft: `1px solid ${skillColor}`,
                      borderRight: `1px solid ${skillColor}`,
                      top: 0,
                      cursor: 'pointer',
                      zIndex: 1
                    }}
                    title={`Player ${range.trackId} active: ${range.start} to ${range.end}`}
                    onClick={() => seekToFrame(range.start)}
                  />
                )
              })}

              {playbackTiming.frame_count > 0 && state.events
                .filter((event) => {
                  const skillName = (event.skill || '').toString().toLowerCase();
                  return skillName !== 'start_rally' && skillName !== 'end_rally';
                })
                .map(event => {
                const skillName = (event.skill || (event as any).label || '').toString();
                const abbreviation = {
                  'toss': 'T',
                  'serve': 'Sr',
                  'reception': 'R',
                  'receive': 'Rc',
                  'set': 'St',
                  'dig': 'D',
                  'attack': 'A',
                  'block': 'B',
                  'score': 'Sc',
                  'spike': 'A',
                }[skillName] || (skillName ? skillName.charAt(0).toUpperCase() : '?');

                return (
                  <div 
                    key={event.frame}
                    className="timeline-skill-marker" 
                    style={{ 
                      left: `${(event.frame / playbackTiming.frame_count) * 100}%`, 
                      backgroundColor: `var(--color-${skillName}, #94a3b8)`, 
                      zIndex: 2 
                    }}
                    title={`${skillName} at frame ${event.frame}`}
                    onClick={() => seekToFrame(event.frame)}
                  >
                    {abbreviation}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.85rem', maxHeight: '150px', overflowY: 'auto', paddingRight: '4px' }}>
              {activeRanges.length === 0 && <span style={{ color: '#64748b' }}>No active players...</span>}
              {activeRanges.map((range, idx) => {
                const skillColor = range.skillName !== 'default' ? `var(--color-${range.skillName})` : '#4ade80';
                const bgNormal = range.skillName !== 'default' ? `color-mix(in srgb, ${skillColor} 15%, transparent)` : 'rgba(74, 222, 128, 0.15)';
                const bgHover = range.skillName !== 'default' ? `color-mix(in srgb, ${skillColor} 30%, transparent)` : 'rgba(74, 222, 128, 0.3)';
                const borderCol = range.skillName !== 'default' ? `color-mix(in srgb, ${skillColor} 40%, transparent)` : 'rgba(74, 222, 128, 0.4)';
                
                return (
                <div 
                  key={idx} 
                  style={{ 
                    background: bgNormal, 
                    border: `1px solid ${borderCol}`, 
                    padding: '4px 10px', 
                    borderRadius: '6px', 
                    cursor: 'pointer',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = bgHover}
                  onMouseLeave={(e) => e.currentTarget.style.background = bgNormal}
                  onClick={() => seekToFrame(range.start)}
                  title="Click to jump to this action"
                >
                  <strong style={{ color: skillColor }}>Player {range.trackId}:</strong> {range.start} - {range.end}
                </div>
              )})}
            </div>
          </div>
        )}
      </div>

      {/* RIGHT SIDEBAR */}
      <div className="sidebar">
        <div className="glass-panel sidebar-section">
          <h2><FileVideo size={20} /> Video Info</h2>
          <div style={{ fontSize: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div><strong>File:</strong> {state.videoMetadata?.filename}</div>
            <div><strong>Resolution:</strong> {state.videoMetadata?.width}x{state.videoMetadata?.height}</div>
            <div>
              <strong>FPS:</strong> <span style={{ marginLeft: '0.5rem', color: '#4ade80' }}>{state.videoMetadata?.fps || 'Detecting...'}</span>
            </div>
            {appMode === 'vnl' && currentPlaylistItem?.inferenceVideoMeta && (
              <div>
                <strong>Frames:</strong>{' '}
                inference {currentPlaylistItem.inferenceVideoMeta.frame_count}
                {((videoRef.current?.duration ?? 0) > 0 || (state.videoMetadata?.duration ?? 0) > 0) ? (
                  <span style={{ color: 'rgba(255,255,255,0.7)' }}>
                    {' '}
                    · playback ~{estimateBrowserFrameCount(
                      (videoRef.current?.duration ?? 0) > 0
                        ? videoRef.current?.duration ?? 0
                        : state.videoMetadata?.duration ?? 0,
                      currentPlaylistItem.inferenceVideoMeta.fps,
                    )}
                  </span>
                ) : null}
                {videoPlaybackKind === 'h264' && (
                  <span style={{ color: '#4ade80' }}> · GPU H.264</span>
                )}
              </div>
            )}
            {vnlSyncWarning && (
              <div
                style={{
                  marginTop: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: '6px',
                  background: 'rgba(251, 191, 36, 0.12)',
                  border: '1px solid rgba(251, 191, 36, 0.35)',
                  color: '#fcd34d',
                  fontSize: '0.8rem',
                  lineHeight: 1.4,
                }}
              >
                <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                {vnlSyncWarning}
              </div>
            )}
            {appMode === 'ball' && ballEngine === 'yolo26' && (
              <>
                <div>
                  <strong>YOLO post-process:</strong>{' '}
                  <span style={{ color: ballPostprocessEnabled ? '#4ade80' : '#fbbf24' }}>
                    {ballPostprocessEnabled ? 'ON (filters legs / static / outliers)' : 'OFF'}
                  </span>
                </div>
                {ballPostprocessEnabled && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 14,
                          height: 14,
                          border: '3px solid #fbbf24',
                          borderRadius: 2,
                        }}
                      />
                      <span>Kept (amber) — same YOLO box</span>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 14,
                          height: 14,
                          border: '3px solid #f472b6',
                          borderRadius: 2,
                          marginLeft: '0.75rem',
                        }}
                      />
                      <span>Removed (pink) — same box, different colour</span>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={showRejectedBallBoxes}
                        onChange={(e) => setShowRejectedBallBoxes(e.target.checked)}
                      />
                      Show removed boxes in pink (same position as YOLO detected)
                    </label>
                  </>
                )}
              </>
            )}
            {appMode === 'ball' && ballEngine === 'side_view' && (
              <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                Side View Ball v2: all raw detections kept (no post-process / pink removals).
              </div>
            )}
          </div>
        </div>

        <div className="glass-panel sidebar-section">
          <h2><Settings size={20} /> Hotkeys</h2>
          <div className="hotkey-legend">
            {appMode === 'ball' ? (
              <>
                <div><span className="hotkey">&gt;</span> Hold to step forward ({ballFrameStepFps} f/s)</div>
                <div><span className="hotkey">&lt;</span> Hold to step backward ({ballFrameStepFps} f/s)</div>
                <div><span className="hotkey">Space</span> Step play / pause</div>
                <div><span className="hotkey">Del</span> Clear Frame</div>
              </>
            ) : appMode === 'vnl' ? (
              <>
                <div><span className="hotkey">, / &lt;</span> Step back 1 frame (hold to scrub)</div>
                <div><span className="hotkey">. / &gt;</span> Step forward 1 frame (hold to scrub)</div>
                <div><span className="hotkey">Shift+, / Shift+.</span> Step ±5 frames</div>
                <div><span className="hotkey">Space</span> Play / pause</div>
                <div><span className="hotkey">Click</span> Place contact dot (after skill hotkey)</div>
                {VNL_LABEL_DEFS.map((def) => (
                  <div key={def.label}><span className="hotkey">{def.hotkey}</span> {def.label}</div>
                ))}
                <div><span className="hotkey">Del</span> Clear Frame</div>
              </>
            ) : appMode === 'touch_block' ? (
              <>
                <div><span className="hotkey">←</span> Previous attack</div>
                <div><span className="hotkey">→</span> Next attack</div>
                <div><span className="hotkey">, / &lt;</span> Step back 1 frame</div>
                <div><span className="hotkey">. / &gt;</span> Step forward 1 frame</div>
                <div><span className="hotkey">Shift+, / Shift+.</span> Step ±5 frames</div>
                <div><span className="hotkey">Space</span> Play / pause</div>
                <div><span className="hotkey">7</span> Add Block</div>
                <div><span className="hotkey">Click</span> Place ball contact dot on block</div>
                <div><span className="hotkey">1–6</span> Toss / Serve / Reception / Set / Dig / Attack</div>
                <div><span className="hotkey">S / E</span> Start / End Rally</div>
                <div><span className="hotkey">Del</span> Clear Frame</div>
              </>
            ) : (
              <>
                <div><span className="hotkey">, / &lt;</span> Step back 1 frame (hold to scrub)</div>
                <div><span className="hotkey">. / &gt;</span> Step forward 1 frame (hold to scrub)</div>
                <div><span className="hotkey">Shift+, / Shift+.</span> Step ±5 frames</div>
                <div><span className="hotkey">Space</span> Play / pause</div>
                <div><span className="hotkey">1</span> Toss</div>
                <div><span className="hotkey">2</span> Serve</div>
                <div><span className="hotkey">3</span> Reception</div>
                <div><span className="hotkey">4</span> Set</div>
                <div><span className="hotkey">5</span> Dig</div>
                <div><span className="hotkey">6</span> Attack</div>
                <div><span className="hotkey">7</span> Block</div>
                <div><span className="hotkey">S</span> Start Rally</div>
                <div><span className="hotkey">E</span> End Rally</div>
                <div><span className="hotkey">A</span> Active Player</div>
                <div><span className="hotkey">Del</span> Clear Frame</div>
              </>
            )}
          </div>
        </div>

        <div className="glass-panel sidebar-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <h2>Annotations</h2>
          
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <button className="btn outline" style={{ flex: 1, fontSize: '0.85rem' }} onClick={handleUndo} title="Undo last action">
              Undo
            </button>
            <button className="btn outline" style={{ flex: 1, fontSize: '0.85rem', borderColor: 'var(--color-attack)', color: 'var(--color-attack)' }} onClick={handleResetRally} title={appMode === 'ball' ? "Clear all tracked balls" : "Reset all manual annotations for this video"}>
              {appMode === 'ball' ? "Clear Tracking" : "Reset Rally"}
            </button>
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Frame</th>
                  <th>Label</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {state.rally.start_frame !== null && appMode !== 'ball' && appMode !== 'vnl' && (
                  <tr className={state.currentFrame === state.rally.start_frame ? 'active-row' : ''} onClick={() => seekToFrame(state.rally.start_frame!)} style={{ cursor: 'pointer' }}>
                    <td>{state.rally.start_frame}</td>
                    <td><span className="badge" style={{ background: 'var(--color-rally)' }}>start_rally</span></td>
                    <td>
                      <button className="btn icon-only outline" onClick={(e) => { e.stopPropagation(); setState(prev => ({ ...prev, rally: { ...prev.rally, start_frame: null } })) }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                )}
                
                {appMode === 'ball' ? (
                  Object.entries(ballBoxesForDisplay)
                    .map(([f, boxes]) => ({ frame: parseInt(f, 10), hasBall: boxes.length > 0 }))
                    .filter(x => x.hasBall)
                    .sort((a, b) => a.frame - b.frame)
                    .map(({ frame }) => {
                      const frameBoxes = ballBoxesForDisplay[frame] || [];
                      const isEdited = frameBoxes.some((b) => b.source === 'manual');
                      return (
                      <tr key={`ball-${frame}`} className={state.currentFrame === frame ? 'active-row' : ''} onClick={() => seekToFrame(frame)} style={{ cursor: 'pointer' }}>
                        <td>{frame}</td>
                        <td><span className="badge" style={{ background: '#eab308', color: '#000' }}>
                          {isEdited ? 'ball_edited' : 'ball_detected'}
                        </span></td>
                        <td>
                          <button 
                            className="btn icon-only outline" 
                            title="Delete ball from this frame"
                            disabled={!ballEditMode}
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              clearBallBoxesAtFrame(frame);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                    })
                ) : (
                  [...state.events]
                    .filter((event) => {
                      const skillName = (event.skill || '').toString().toLowerCase();
                      return skillName !== 'start_rally' && skillName !== 'end_rally';
                    })
                    .sort((a, b) => a.frame - b.frame).map(event => {
                    const skillName = (event.skill || (event as any).label || '').toString();
                    return (
                      <tr key={event.frame} className={state.currentFrame === event.frame ? 'active-row' : ''} onClick={() => seekToFrame(event.frame)} style={{ cursor: 'pointer' }}>
                        <td>{event.frame}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}>
                            <span className={`badge ${skillName}`} style={{ flexShrink: 0 }}>{skillName}</span>
                            {event.xy && (
                              <span
                                title={`Ball contact @ (${event.xy[0].toFixed(3)}, ${event.xy[1].toFixed(3)})`}
                                style={{
                                  width: 10,
                                  height: 10,
                                  borderRadius: '50%',
                                  background: skillName === 'block' ? 'var(--color-block)' : 'var(--primary)',
                                  border: '1px solid white',
                                  flexShrink: 0,
                                  boxShadow: '0 0 4px rgba(255,255,255,0.5)',
                                }}
                              />
                            )}
                            {event.player_id !== undefined && (
                               <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-attack)', flexShrink: 0 }}>ID: {event.player_id}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.25rem' }}>
                            {assigningEventFrame === event.frame ? (
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', maxWidth: '140px', alignItems: 'center' }}>
                                <span style={{ fontSize: '9px', color: '#999', width: '100%' }}>Select ID:</span>
                                {Array.from(new Set((state.playerBoxes[event.frame] || []).map(b => b.track_id))).sort((a,b) => a-b).map(id => (
                                  <button 
                                    key={id}
                                    className="btn outline"
                                    style={{ padding: '2px 6px', fontSize: '10px', minWidth: 'auto', minHeight: 'auto' }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleAssignPlayer(event.frame, id);
                                      setAssigningEventFrame(null);
                                    }}
                                  >
                                    {id}
                                  </button>
                                ))}
                                {(!state.playerBoxes[event.frame] || state.playerBoxes[event.frame].length === 0) && (
                                  <span style={{ fontSize: '10px', color: '#ef4444' }}>No players detected</span>
                                )}
                                <button 
                                  className="btn outline" 
                                  style={{ padding: '2px 6px', fontSize: '10px', minWidth: 'auto', minHeight: 'auto', borderColor: 'transparent', color: '#999' }}
                                  onClick={(e) => { e.stopPropagation(); setAssigningEventFrame(null); }}
                                >
                                  ×
                                </button>
                              </div>
                            ) : (
                              <button 
                                className="btn icon-only outline" 
                                title="Assign a player from this frame to this skill"
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  seekToFrame(event.frame);
                                  setAssigningEventFrame(event.frame);
                                }}>
                                <span style={{ fontSize: '10px', fontWeight: 'bold' }}>Assign</span>
                              </button>
                            )}
                            <button 
                              className="btn icon-only outline" 
                              title="Delete this skill"
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                handleDeleteEvent(event.frame);
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}

                {state.rally.end_frame !== null && appMode !== 'ball' && appMode !== 'vnl' && (
                  <tr className={state.currentFrame === state.rally.end_frame ? 'active-row' : ''} onClick={() => seekToFrame(state.rally.end_frame!)} style={{ cursor: 'pointer' }}>
                    <td>{state.rally.end_frame}</td>
                    <td><span className="badge" style={{ background: 'var(--color-rally)' }}>end_rally</span></td>
                    <td>
                      <button className="btn icon-only outline" onClick={(e) => { e.stopPropagation(); setState(prev => ({ ...prev, rally: { ...prev.rally, end_frame: null } })) }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

        </div>

      </div>
    </div>
  );
}

export default App;
