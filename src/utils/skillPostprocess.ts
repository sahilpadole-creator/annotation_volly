import type { SkillEvent, Rally, SkillLabel } from '../types';

const ATTACK_BLOCK_MERGED = 'attack/block';
const MERGED_DEFENSIVE_LABEL = 'reception/dig';

const ATTACK_BLOCK_LABELS = new Set(['attack', 'block', ATTACK_BLOCK_MERGED]);

export const SKILL_CLASS_IDS: Record<SkillLabel, number> = {
  toss: 0,
  serve: 1,
  reception: 2,
  set: 3,
  dig: 4,
  attack: 5,
  block: 6,
  receive: 2,
  score: 7,
  spike: 5,
};

function isAttackBlock(skill: string): boolean {
  return ATTACK_BLOCK_LABELS.has(skill.trim().toLowerCase());
}

function modelSkill(row: { skill?: string; skill_raw?: string }): string {
  const raw = row.skill_raw;
  if (raw !== undefined && String(raw).trim()) {
    return String(raw).trim().toLowerCase();
  }
  return String(row.skill ?? '').trim().toLowerCase();
}

/** Rule: set -> attack; close peaks: 1st=attack, 2nd=block; dedupe consecutive attack/block. */
export function applyAttackBlockSequenceRules(
  preds: SkillEvent[],
  clusterGap = 10,
): SkillEvent[] {
  if (!preds.length) return preds;

  const ordered = [...preds].sort((a, b) => a.frame - b.frame);
  const out: SkillEvent[] = [];

  for (const row of ordered) {
    const r: SkillEvent = { ...row };
    const sk = String(r.skill ?? '').trim().toLowerCase();
    if (!isAttackBlock(sk)) {
      out.push(r);
      continue;
    }

    const prevSkill = out.length
      ? String(out[out.length - 1].skill ?? '').trim().toLowerCase()
      : '';

    if (prevSkill === 'set') {
      r.skill = 'attack';
      r.class_id = SKILL_CLASS_IDS.attack;
    } else if (out.length && isAttackBlock(String(out[out.length - 1].skill ?? ''))) {
      const prevFrame = out[out.length - 1].frame;
      const curFrame = r.frame;
      if (curFrame - prevFrame <= clusterGap) {
        out[out.length - 1] = {
          ...out[out.length - 1],
          skill: 'attack',
          class_id: SKILL_CLASS_IDS.attack,
        };
        r.skill = 'block';
        r.class_id = SKILL_CLASS_IDS.block;
      } else if (sk === ATTACK_BLOCK_MERGED) {
        r.skill = 'attack';
        r.class_id = SKILL_CLASS_IDS.attack;
      }
    } else if (sk === ATTACK_BLOCK_MERGED) {
      r.skill = 'attack';
      r.class_id = SKILL_CLASS_IDS.attack;
    }

    out.push(r);
  }

  const deduped: SkillEvent[] = [];
  for (const r of out) {
    const sk = String(r.skill ?? '').trim().toLowerCase();
    if (
      deduped.length &&
      (sk === 'attack' || sk === 'block') &&
      ['attack', 'block'].includes(String(deduped[deduped.length - 1].skill ?? '').toLowerCase())
    ) {
      const prevConf = deduped[deduped.length - 1].confidence ?? 0;
      const curConf = r.confidence ?? 0;
      if (curConf > prevConf) {
        deduped.pop();
        deduped.push(r);
      }
      continue;
    }
    deduped.push(r);
  }
  return deduped;
}

/** Serve-anchored reception/dig split within rally spans. */
export function applyReceptionDigSkillSequenceRule(
  preds: SkillEvent[],
  rallies: Array<[number, number]>,
): SkillEvent[] {
  const defensive = new Set([MERGED_DEFENSIVE_LABEL, 'reception', 'dig']);
  const byFrame = new Map<number, SkillEvent>();
  for (const p of preds) {
    byFrame.set(p.frame, { ...p });
  }

  for (const [rs, re] of rallies) {
    const frames = [...byFrame.keys()].filter((f) => f >= rs && f <= re).sort((a, b) => a - b);
    let serveFrame: number | null = null;
    for (const frame of frames) {
      if (modelSkill(byFrame.get(frame)!) === 'serve') {
        serveFrame = frame;
        break;
      }
    }

    let seenReception = false;
    for (const frame of frames) {
      const row = byFrame.get(frame);
      if (!row) continue;
      const sk = modelSkill(row);
      if (!defensive.has(sk)) continue;

      const afterServe = serveFrame !== null && frame > serveFrame;
      if (!seenReception && (afterServe || serveFrame === null)) {
        row.skill = 'reception';
        row.class_id = SKILL_CLASS_IDS.reception;
        seenReception = true;
      } else {
        row.skill = 'dig';
        row.class_id = SKILL_CLASS_IDS.dig;
      }
    }
  }

  return preds.map((p) => byFrame.get(p.frame) ?? p);
}

export function ralliesFromRallyBounds(rally: Rally, frameCount: number): Array<[number, number]> {
  const start = rally.start_frame ?? 0;
  const end = rally.end_frame ?? Math.max(frameCount - 1, 0);
  if (end >= start) return [[start, end]];
  return [[0, Math.max(frameCount - 1, 0)]];
}

/** Normalize merged labels and apply 6-skill post-rules when importing raw model JSON. */
export function applySixSkillPostprocess(
  events: SkillEvent[],
  rally: Rally = { start_frame: null, end_frame: null },
  frameCount = 0,
): SkillEvent[] {
  const normalized = events.map((event) => {
    const skill = String(event.skill ?? '').trim().toLowerCase();
    if (skill === MERGED_DEFENSIVE_LABEL) {
      return { ...event, skill: 'reception' as SkillLabel, class_id: SKILL_CLASS_IDS.reception, skill_raw: MERGED_DEFENSIVE_LABEL } as SkillEvent & { skill_raw?: string };
    }
    if (skill === ATTACK_BLOCK_MERGED) {
      return { ...event, skill: 'attack' as SkillLabel, class_id: SKILL_CLASS_IDS.attack, skill_raw: ATTACK_BLOCK_MERGED } as SkillEvent & { skill_raw?: string };
    }
    const classId = SKILL_CLASS_IDS[skill as SkillLabel];
    if (classId !== undefined) {
      return { ...event, skill: skill as SkillLabel, class_id: classId };
    }
    return event;
  });

  const rallies = ralliesFromRallyBounds(rally, frameCount);
  const withReception = applyReceptionDigSkillSequenceRule(normalized, rallies);
  return applyAttackBlockSequenceRules(withReception);
}
