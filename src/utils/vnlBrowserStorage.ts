import type { AppState, PlaylistItem, Rally, SkillEvent } from '../types';

export const VNL_ACTIVE_FOLDER_KEY = 'volleyball_vnl_active_folder';
const VNL_FOLDER_PREFIX = 'volleyball_vnl_folder_';

export interface StoredVnlPlaylistItem {
  name: string;
  events: SkillEvent[];
  rally: Rally;
  manualActions: PlaylistItem['manualActions'];
  videoMetadata?: PlaylistItem['videoMetadata'];
  isCompleted?: boolean;
  savedFrame?: number;
}

export interface StoredVnlFolder {
  folderKey: string;
  folderLabel: string;
  updatedAt: number;
  currentPlaylistIndex: number;
  playlist: StoredVnlPlaylistItem[];
}

/** Stable key for a folder = sorted video basenames (same folder → same key in one browser). */
export function computeVnlFolderKey(videoNames: string[]): string {
  const basenames = videoNames
    .map((n) => n.replace(/^.*[/\\]/, '').toLowerCase())
    .filter(Boolean)
    .sort();
  let hash = 2166136261;
  for (const name of basenames) {
    for (let i = 0; i < name.length; i++) {
      hash ^= name.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0;
  }
  return `vnl_${(hash >>> 0).toString(36)}_${basenames.length}`;
}

export function getVnlFolderLabelFromFiles(files: File[]): string {
  const withPath = files.find((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath);
  if (withPath) {
    const rel = (withPath as File & { webkitRelativePath: string }).webkitRelativePath;
    const top = rel.split('/')[0];
    if (top) return top;
  }
  return files[0]?.name.replace(/\.[^/.]+$/, '') ?? 'VNL folder';
}

function storageKey(folderKey: string): string {
  return `${VNL_FOLDER_PREFIX}${folderKey}`;
}

export function setActiveVnlFolderKey(folderKey: string): void {
  localStorage.setItem(VNL_ACTIVE_FOLDER_KEY, folderKey);
}

export function getActiveVnlFolderKey(): string | null {
  return localStorage.getItem(VNL_ACTIVE_FOLDER_KEY);
}

export function playlistToStoredItems(
  playlist: PlaylistItem[],
  currentIndex: number,
  currentEvents: SkillEvent[],
  currentRally: Rally,
  currentManualActions: PlaylistItem['manualActions'],
  currentFrame: number,
): StoredVnlPlaylistItem[] {
  return playlist.map((item, idx) => ({
    name: item.name,
    events: idx === currentIndex ? currentEvents : (item.events ?? []),
    rally: idx === currentIndex ? currentRally : (item.rally ?? { start_frame: null, end_frame: null }),
    manualActions: idx === currentIndex ? (currentManualActions ?? []) : (item.manualActions ?? []),
    videoMetadata: item.videoMetadata ?? undefined,
    isCompleted: item.isCompleted,
    savedFrame: idx === currentIndex ? currentFrame : undefined,
  }));
}

export function persistVnlFolder(
  folderKey: string,
  folderLabel: string,
  state: AppState,
): void {
  const snapshot: StoredVnlFolder = {
    folderKey,
    folderLabel,
    updatedAt: Date.now(),
    currentPlaylistIndex: state.currentPlaylistIndex,
    playlist: playlistToStoredItems(
      state.playlist,
      state.currentPlaylistIndex,
      state.events,
      state.rally,
      state.manualActions,
      state.currentFrame,
    ),
  };
  localStorage.setItem(storageKey(folderKey), JSON.stringify(snapshot));
  setActiveVnlFolderKey(folderKey);
}

export function loadVnlFolder(folderKey: string): StoredVnlFolder | null {
  const raw = localStorage.getItem(storageKey(folderKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredVnlFolder;
    if (!parsed?.folderKey || !Array.isArray(parsed.playlist)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadActiveVnlFolder(): StoredVnlFolder | null {
  const key = getActiveVnlFolderKey();
  if (!key) return null;
  return loadVnlFolder(key);
}

export function storedFolderToAppState(snapshot: StoredVnlFolder): AppState {
  const current = snapshot.playlist[snapshot.currentPlaylistIndex] ?? snapshot.playlist[0];
  return {
    playlist: snapshot.playlist.map((item) => ({
      id: item.name,
      name: item.name,
      events: item.events ?? [],
      rally: item.rally ?? { start_frame: null, end_frame: null },
      manualActions: item.manualActions ?? [],
      videoMetadata: item.videoMetadata ?? null,
      isCompleted: item.isCompleted,
      isVnlAlgorithmApplied: (item.events?.length ?? 0) > 0,
    })),
    currentPlaylistIndex: Math.min(
      Math.max(0, snapshot.currentPlaylistIndex),
      Math.max(0, snapshot.playlist.length - 1),
    ),
    videoMetadata: current?.videoMetadata ?? null,
    rally: current?.rally ?? { start_frame: null, end_frame: null },
    events: current?.events ?? [],
    playerBoxes: {},
    manualActions: current?.manualActions ?? [],
    currentFrame: current?.savedFrame ?? 0,
  };
}

export function findStoredVnlItem(
  snapshot: StoredVnlFolder | null,
  videoName: string,
): StoredVnlPlaylistItem | undefined {
  if (!snapshot) return undefined;
  const base = videoName.replace(/^.*[/\\]/, '');
  return snapshot.playlist.find(
    (p) => p.name === videoName || p.name === base || p.name.replace(/^.*[/\\]/, '') === base,
  );
}
