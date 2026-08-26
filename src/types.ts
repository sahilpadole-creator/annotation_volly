export type SkillLabel =
  | 'toss' | 'serve' | 'reception' | 'set' | 'dig' | 'attack' | 'block'
  | 'receive' | 'score' | 'spike' | 'touch';

export interface SkillEvent {
  frame: number;
  skill: SkillLabel;
  class_id: number;
  confidence?: number;
  source?: 'auto' | 'manual';
  player_id?: number;
  /** VNL-STES normalized contact location [x, y] in 0–1 */
  xy?: [number, number];
}

export interface Rally {
  start_frame: number | null;
  end_frame: number | null;
}

export interface VideoMetadata {
  filename: string;
  fps: number;
  width: number;
  height: number;
  duration: number;
  frame_count: number;
}

/** OpenCV timing from ball inference — must match YOLO frame indices */
export interface InferenceVideoMeta {
  fps: number;
  frame_count: number;
  width: number;
  height: number;
}

export interface PlayerBox {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  track_id: number;
  is_active: boolean;
  conf?: number;
  /** inference = model output; manual = user-drawn or edited */
  source?: 'inference' | 'manual';
  /** True when this box was removed by YOLO post-processing (shown for review only). */
  postprocess_rejected?: boolean;
  /** Post-process filter that removed this detection (e.g. static_frozen). */
  reject_reason?: string;
}

export interface PlaylistItem {
  id: string;
  name: string;
  file?: File;
  driveUrl?: string;
  driveFolderId?: string;
  driveXmlId?: string;
  videoMetadata?: VideoMetadata | null;
  rally?: Rally;
  events?: SkillEvent[];
  playerBoxes?: Record<number, PlayerBox[]>;
  /** Raw YOLO inference output — never modified by frame stepping */
  inferenceBallBoxes?: Record<number, PlayerBox[]>;
  /** Detections removed by post-processing — shown in a different overlay color for review */
  rejectedBallBoxes?: Record<number, PlayerBox[]>;
  /** OpenCV video timing from ball inference API (frame index sync) */
  inferenceVideoMeta?: InferenceVideoMeta;
  rawJsonString?: string;
  manualActions?: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: PlayerBox }[];
  isCompleted?: boolean;
  /** @deprecated Use isTouchAlgorithmApplied */
  isSkillAlgorithmApplied?: boolean;
  isTouchAlgorithmApplied?: boolean;
  isBallAlgorithmApplied?: boolean;
  isVnlAlgorithmApplied?: boolean;
}

export interface AppState {
  playlist: PlaylistItem[];
  currentPlaylistIndex: number;
  videoMetadata: VideoMetadata | null;
  rally: Rally;
  events: SkillEvent[];
  playerBoxes: Record<number, PlayerBox[]>;
  rawJsonString?: string;
  manualActions: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: PlayerBox }[];
  currentFrame: number;
}
