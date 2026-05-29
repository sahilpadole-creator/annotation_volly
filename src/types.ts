export type SkillLabel = 'toss' | 'serve' | 'reception' | 'set' | 'dig' | 'attack' | 'block';

export interface SkillEvent {
  frame: number;
  skill: SkillLabel;
  class_id: number;
  confidence?: number;
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

export interface PlaylistItem {
  id: string;
  name: string;
  file?: File;
  driveUrl?: string;
  videoMetadata?: VideoMetadata | null;
  rally?: Rally;
  events?: SkillEvent[];
  isCompleted?: boolean;
  isSkillAlgorithmApplied?: boolean;
}

export interface AppState {
  playlist: PlaylistItem[];
  currentPlaylistIndex: number;
  videoMetadata: VideoMetadata | null;
  rally: Rally;
  events: SkillEvent[];
  currentFrame: number;
}
