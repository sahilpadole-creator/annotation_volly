export type SkillLabel = 'toss' | 'serve' | 'reception' | 'set' | 'dig' | 'attack' | 'block';

export interface SkillEvent {
  frame: number;
  skill: SkillLabel;
  class_id: number;
  confidence?: number;
  source?: 'auto' | 'manual';
  player_id?: number;
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

export interface PlayerBox {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  track_id: number;
  is_active: boolean;
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
  rawJsonString?: string;
  manualActions?: { frame: number; track_id: number; action?: 'add' | 'remove' }[];
  isCompleted?: boolean;
  isSkillAlgorithmApplied?: boolean;
}

export interface AppState {
  playlist: PlaylistItem[];
  currentPlaylistIndex: number;
  videoMetadata: VideoMetadata | null;
  rally: Rally;
  events: SkillEvent[];
  playerBoxes: Record<number, PlayerBox[]>;
  rawJsonString?: string;
  manualActions: { frame: number; track_id: number; action?: 'add' | 'remove' }[];
  currentFrame: number;
}
