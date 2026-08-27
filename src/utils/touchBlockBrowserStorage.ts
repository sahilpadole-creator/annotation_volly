import type { AppState, PlaylistItem, Rally, SkillEvent } from '../types';
import {
  computeVnlFolderKey,
  getVnlFolderLabelFromFiles,
  type StoredVnlFolder,
  type StoredVnlPlaylistItem,
} from './vnlBrowserStorage';

export const TOUCH_BLOCK_ACTIVE_FOLDER_KEY = 'volleyball_touch_block_active_folder';
const TOUCH_BLOCK_FOLDER_PREFIX = 'volleyball_touch_block_folder_';

export type StoredTouchBlockFolder = StoredVnlFolder;
export type StoredTouchBlockPlaylistItem = StoredVnlPlaylistItem;

export const computeTouchBlockFolderKey = (videoNames: string[]): string =>
  computeVnlFolderKey(videoNames).replace(/^vnl_/, 'tb_');

export const getTouchBlockFolderLabelFromFiles = getVnlFolderLabelFromFiles;

function storageKey(folderKey: string): string {
  return `${TOUCH_BLOCK_FOLDER_PREFIX}${folderKey}`;
}

export function setActiveTouchBlockFolderKey(folderKey: string): void {
  localStorage.setItem(TOUCH_BLOCK_ACTIVE_FOLDER_KEY, folderKey);
}

export function getActiveTouchBlockFolderKey(): string | null {
  return localStorage.getItem(TOUCH_BLOCK_ACTIVE_FOLDER_KEY);
}

function playlistToStoredItems(
  playlist: PlaylistItem[],
  currentIndex: number,
  currentEvents: SkillEvent[],
  currentRally: Rally,
  currentManualActions: PlaylistItem['manualActions'],
  currentFrame: number,
): StoredTouchBlockPlaylistItem[] {
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

export function persistTouchBlockFolder(
  folderKey: string,
  folderLabel: string,
  state: AppState,
): void {
  const snapshot: StoredTouchBlockFolder = {
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
  setActiveTouchBlockFolderKey(folderKey);
}

export function loadTouchBlockFolder(folderKey: string): StoredTouchBlockFolder | null {
  const raw = localStorage.getItem(storageKey(folderKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredTouchBlockFolder;
    if (!parsed?.folderKey || !Array.isArray(parsed.playlist)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadActiveTouchBlockFolder(): StoredTouchBlockFolder | null {
  const key = getActiveTouchBlockFolderKey();
  if (!key) return null;
  return loadTouchBlockFolder(key);
}

export function storedTouchBlockFolderToAppState(snapshot: StoredTouchBlockFolder): AppState {
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
      isTouchAlgorithmApplied: true,
      isSkillAlgorithmApplied: true,
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

export function findStoredTouchBlockItem(
  snapshot: StoredTouchBlockFolder | null,
  videoName: string,
): StoredTouchBlockPlaylistItem | undefined {
  if (!snapshot) return undefined;
  const base = videoName.replace(/^.*[/\\]/, '');
  return snapshot.playlist.find(
    (p) => p.name === videoName || p.name === base || p.name.replace(/^.*[/\\]/, '') === base,
  );
}

/**
 * Merge freshly loaded XML skills with browser-saved annotations.
 * Keeps XML base skills; overlays manual blocks / contact dots / edits from storage.
 */
export function mergeTouchBlockEvents(
  xmlEvents: SkillEvent[],
  storedEvents: SkillEvent[] | undefined,
): SkillEvent[] {
  if (!storedEvents?.length) return xmlEvents;

  const keyOf = (e: SkillEvent) => `${e.frame}|${e.skill}`;
  const merged = new Map<string, SkillEvent>();

  for (const e of xmlEvents) merged.set(keyOf(e), { ...e });

  for (const e of storedEvents) {
    const key = keyOf(e);
    const existing = merged.get(key);
    const isBlock = e.skill === 'block';
    const hasDot = Array.isArray(e.xy) && e.xy.length === 2;
    const isManual = e.source === 'manual';

    if (!existing) {
      // New block (or other edit) only in browser storage
      if (isBlock || hasDot || isManual) merged.set(key, { ...e });
      continue;
    }

    // Prefer stored contact point / manual edits on same frame+skill
    if (hasDot || isManual || isBlock) {
      merged.set(key, {
        ...existing,
        ...e,
        xy: e.xy ?? existing.xy,
        source: e.source ?? existing.source,
        player_id: e.player_id ?? existing.player_id,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.frame - b.frame || a.skill.localeCompare(b.skill));
}

export type AttackBlockProgress = {
  attackIndex: number; // 1-based
  attackFrame: number;
  status: 'done' | 'block_no_dot' | 'pending';
  blockFrame?: number;
  hasBallDot: boolean;
};

/** Pair each attack with a nearby following block (for progress UI). */
export function buildAttackBlockProgress(
  events: SkillEvent[],
  windowFrames = 90,
): AttackBlockProgress[] {
  const attacks = events
    .filter((e) => e.skill === 'attack' || e.skill === 'spike')
    .map((e) => e.frame)
    .sort((a, b) => a - b);
  const blocks = events
    .filter((e) => e.skill === 'block')
    .slice()
    .sort((a, b) => a.frame - b.frame);

  const usedBlockFrames = new Set<number>();

  return attacks.map((attackFrame, idx) => {
    const block = blocks.find(
      (b) =>
        !usedBlockFrames.has(b.frame) &&
        b.frame >= attackFrame - 5 &&
        b.frame <= attackFrame + windowFrames,
    );
    if (block) usedBlockFrames.add(block.frame);
    const hasBallDot = !!(block?.xy && block.xy.length === 2);
    let status: AttackBlockProgress['status'] = 'pending';
    if (block && hasBallDot) status = 'done';
    else if (block) status = 'block_no_dot';
    return {
      attackIndex: idx + 1,
      attackFrame,
      status,
      blockFrame: block?.frame,
      hasBallDot,
    };
  });
}

export function findNextPendingAttackFrame(
  events: SkillEvent[],
  fromFrame: number,
): number | null {
  const progress = buildAttackBlockProgress(events);
  const next = progress.find((p) => p.status !== 'done' && p.attackFrame >= fromFrame)
    ?? progress.find((p) => p.status !== 'done');
  return next?.attackFrame ?? null;
}
