export type SkillLabel = 'toss' | 'serve' | 'reception' | 'set' | 'dig' | 'attack' | 'block';

export interface SkillEvent {
  frame: number;
  skill: SkillLabel;
  class_id: number;
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

export interface AppState {
  videoMetadata: VideoMetadata | null;
  rally: Rally;
  events: SkillEvent[];
  currentFrame: number;
}
