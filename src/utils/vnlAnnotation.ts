import type { SkillEvent, SkillLabel, VideoMetadata } from '../types';
import { SKILL_CLASS_IDS } from './skillPostprocess';

export type VnlLabel =
  | 'toss'
  | 'serve'
  | 'receive'
  | 'set'
  | 'dig'
  | 'attack'
  | 'block'
  | 'score';

export interface VnlEvent {
  frame: number;
  label: VnlLabel;
  score?: number;
  xy?: [number, number];
  source?: 'auto' | 'manual';
}

/** VNL hotkeys aligned with Touch & Skill: 1–7 skills + 8 score. */
export const VNL_LABEL_DEFS: Array<{
  label: VnlLabel;
  hotkey: string;
  color: string;
  classId: number;
}> = [
  { label: 'toss', hotkey: '1', color: '#a855f7', classId: SKILL_CLASS_IDS.toss },
  { label: 'serve', hotkey: '2', color: '#ec4899', classId: SKILL_CLASS_IDS.serve },
  { label: 'receive', hotkey: '3', color: '#3b82f6', classId: SKILL_CLASS_IDS.reception },
  { label: 'set', hotkey: '4', color: '#06b6d4', classId: SKILL_CLASS_IDS.set },
  { label: 'dig', hotkey: '5', color: '#10b981', classId: SKILL_CLASS_IDS.dig },
  { label: 'attack', hotkey: '6', color: '#f59e0b', classId: SKILL_CLASS_IDS.attack },
  { label: 'block', hotkey: '7', color: '#ef4444', classId: SKILL_CLASS_IDS.block },
  { label: 'score', hotkey: '8', color: '#a855f7', classId: 7 },
];

export const VNL_LABEL_TO_CLASS: Record<VnlLabel, number> = Object.fromEntries(
  VNL_LABEL_DEFS.map((d) => [d.label, d.classId]),
) as Record<VnlLabel, number>;

export const VNL_LABEL_TO_SKILL: Record<string, { label: SkillLabel; classId: number }> = Object.fromEntries(
  VNL_LABEL_DEFS.map((d) => [d.label, { label: d.label as SkillLabel, classId: d.classId }]),
);

/** Map legacy / model labels into the current VNL vocabulary. */
const VNL_LABEL_ALIASES: Record<string, VnlLabel> = {
  spike: 'attack',
  reception: 'receive',
};

export function normalizeVnlLabel(raw: string): VnlLabel | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'start_rally' || normalized === 'end_rally') return null;
  const aliased = VNL_LABEL_ALIASES[normalized] ?? normalized;
  return VNL_LABEL_DEFS.some((d) => d.label === aliased) ? (aliased as VnlLabel) : null;
}

/** Map STES API output into SkillEvent rows for the main annotator. */
export function parseVnlPredictionsToSkillEvents(data: unknown): SkillEvent[] {
  return parseVnlPredictions(data).map((e) => ({
    frame: e.frame,
    skill: e.label as SkillLabel,
    class_id: VNL_LABEL_TO_CLASS[e.label],
    confidence: e.score,
    xy: e.xy,
    source: e.source ?? 'auto',
  }));
}

export function parseVnlPredictions(data: unknown): VnlEvent[] {
  const candidates = Array.isArray(data)
    ? data
    : (data as { predictions?: unknown[] })?.predictions
      ?? (data as { events?: unknown[] })?.events
      ?? [];

  const imported: VnlEvent[] = [];

  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const frameRaw = row.frame;
    const frame = typeof frameRaw === 'number' ? Math.round(frameRaw) : Number(frameRaw);
    if (!Number.isFinite(frame)) continue;

    const labelRaw = String(row.label ?? row.skill ?? '').trim().toLowerCase();
    const label = normalizeVnlLabel(labelRaw);
    if (!label) continue;

    const score = typeof row.score === 'number' ? row.score : typeof row.confidence === 'number' ? row.confidence : undefined;
    let xy: [number, number] | undefined;
    if (Array.isArray(row.xy) && row.xy.length >= 2) {
      xy = [Number(row.xy[0]), Number(row.xy[1])];
    }

    imported.push({
      frame,
      label,
      score,
      xy,
      source: 'auto',
    });
  }

  const byFrame = new Map<number, VnlEvent>();
  for (const event of imported) {
    const existing = byFrame.get(event.frame);
    if (!existing || (event.score ?? 0) > (existing.score ?? 0)) {
      byFrame.set(event.frame, event);
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

export function generateVnlXml(metadata: VideoMetadata, events: VnlEvent[]): string {
  const eventsByFrame = new Map<number, VnlEvent>();
  for (const event of events) {
    eventsByFrame.set(event.frame, event);
  }

  const w = metadata.width || 1920;
  const h = metadata.height || 1080;
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n<annotations>\n  <version>1.1</version>\n';

  for (const frame of [...eventsByFrame.keys()].sort((a, b) => a - b)) {
    const event = eventsByFrame.get(frame)!;
    const pad = frame.toString().padStart(6, '0');
    xml += `  <image id="${frame}" name="frame_${pad}" width="${w}" height="${h}">\n`;
    const src = event.source ?? 'auto';
    xml += `    <tag label="${event.label}" source="${src}">\n`;
    if (event.score !== undefined) {
      xml += `      <attribute name="score">${event.score.toFixed(4)}</attribute>\n`;
    }
    if (event.xy) {
      xml += `      <attribute name="x">${event.xy[0].toFixed(4)}</attribute>\n`;
      xml += `      <attribute name="y">${event.xy[1].toFixed(4)}</attribute>\n`;
    }
    xml += '    </tag>\n';
    xml += '  </image>\n';
  }

  xml += '</annotations>\n';
  return xml;
}
