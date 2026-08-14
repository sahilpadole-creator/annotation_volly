import type { AppState, PlaylistItem } from '../types';

export type WorkflowMode = 'touch' | 'ball' | 'vnl';

export const WORKFLOW_STORAGE_KEYS: Record<WorkflowMode, string> = {
  touch: 'volleyball_annotations_touch',
  ball: 'volleyball_annotations_ball',
  vnl: 'volleyball_annotations_vnl',
};

const LEGACY_STORAGE_KEY = 'volleyball_annotations';
export const APP_MODE_STORAGE_KEY = 'volleyball_app_mode';

export const EMPTY_APP_STATE: AppState = {
  playlist: [],
  currentPlaylistIndex: 0,
  videoMetadata: null,
  rally: { start_frame: null, end_frame: null },
  events: [],
  currentFrame: 0,
  playerBoxes: {},
  manualActions: [],
};

export function workflowFromAppMode(
  appMode: 'home' | 'touch' | 'ball' | 'block_clip' | 'vnl',
): WorkflowMode | null {
  if (appMode === 'touch' || appMode === 'ball' || appMode === 'vnl') return appMode;
  return null;
}

export function isItemAlgorithmApplied(item: PlaylistItem, mode: WorkflowMode): boolean {
  if (mode === 'ball') return !!item.isBallAlgorithmApplied;
  if (mode === 'vnl') {
    return !!item.isVnlAlgorithmApplied && (item.events?.length ?? 0) > 0;
  }
  return !!(item.isTouchAlgorithmApplied ?? item.isSkillAlgorithmApplied);
}

export function withAlgorithmApplied(item: PlaylistItem, mode: WorkflowMode): PlaylistItem {
  if (mode === 'ball') return { ...item, isBallAlgorithmApplied: true };
  if (mode === 'vnl') return { ...item, isVnlAlgorithmApplied: true };
  return {
    ...item,
    isTouchAlgorithmApplied: true,
    isSkillAlgorithmApplied: true,
  };
}

function serializeState(state: AppState) {
  return {
    ...state,
    playerBoxes: {},
    playlist: state.playlist.map((item) => ({
      ...item,
      file: undefined,
      rawJsonString: undefined,
      playerBoxes: undefined,
    })),
  };
}

export function persistWorkflowState(mode: WorkflowMode, state: AppState): void {
  localStorage.setItem(
    WORKFLOW_STORAGE_KEYS[mode],
    JSON.stringify({ state: serializeState(state) }),
  );
}

export function loadWorkflowState(mode: WorkflowMode): AppState | null {
  const raw =
    localStorage.getItem(WORKFLOW_STORAGE_KEYS[mode]) ??
    (mode === 'touch' ? localStorage.getItem(LEGACY_STORAGE_KEY) : null);

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.state) return null;
    return {
      ...EMPTY_APP_STATE,
      ...parsed.state,
      playerBoxes: parsed.state.playerBoxes ?? {},
    };
  } catch {
    return null;
  }
}

export function clearWorkflowState(mode: WorkflowMode): void {
  localStorage.removeItem(WORKFLOW_STORAGE_KEYS[mode]);
  if (mode === 'touch') {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}
