const LABEL_TO_SKILL = {
  toss: { label: 'toss', classId: 0 },
  serve: { label: 'serve', classId: 1 },
  reception: { label: 'reception', classId: 2 },
  receive: { label: 'reception', classId: 2 },
  set: { label: 'set', classId: 3 },
  dig: { label: 'dig', classId: 4 },
  attack: { label: 'attack', classId: 5 },
  block: { label: 'block', classId: 5 },
  'attack/block': { label: 'attack', classId: 5 },
};

const SKILL_MAP = {
  '1': { label: 'toss', classId: 0 },
  '2': { label: 'serve', classId: 1 },
  '3': { label: 'reception', classId: 2 },
  '4': { label: 'set', classId: 3 },
  '5': { label: 'dig', classId: 4 },
  '6': { label: 'attack', classId: 5 } // Combined attack/block
};

const parsePredictionLabel = (rawLabel) => {
  if (typeof rawLabel !== 'string') return null;
  const normalized = rawLabel.trim().toLowerCase();
  return LABEL_TO_SKILL[normalized] || null;
};

const payload = {"video_name":"rally_105.mp4","predictions":[{"frame":31,"label":"toss"},{"frame":50,"label":"serve"},{"frame":86,"label":"reception"},{"frame":90,"label":"reception"},{"frame":124,"label":"dig"},{"frame":166,"label":"attack/block"},{"frame":198,"label":"dig"},{"frame":202,"label":"dig"},{"frame":248,"label":"set"},{"frame":292,"label":"attack/block"},{"frame":309,"label":"dig"},{"frame":357,"label":"dig"},{"frame":362,"label":"dig"},{"frame":415,"label":"attack/block"},{"frame":420,"label":"attack/block"},{"frame":461,"label":"dig"},{"frame":481,"label":"dig"}],"inference_fps":0,"inference_time_sec":62.63,"frame_count":0};

let rawCandidates = payload.predictions;

const candidates = rawCandidates.filter(
  (item) => typeof item === 'object' && item !== null && 'frame' in item && ('label' in item || 'skill' in item || 'class_id' in item)
);

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
        source: 'auto'
      };
    }
    return null;
  })
  .filter((v) => v !== null);

const sortedUniqueEvents = [];
const seenFrames = new Set();
for (const ev of importedEvents) {
  if (!seenFrames.has(ev.frame)) {
    seenFrames.add(ev.frame);
    sortedUniqueEvents.push(ev);
  }
}
sortedUniqueEvents.sort((a, b) => a.frame - b.frame);

const nmsWindow = 10;
const sortedByConf = [...sortedUniqueEvents].sort((a, b) => (b.confidence ?? 1.0) - (a.confidence ?? 1.0));
const keptEvents = [];
for (const ev of sortedByConf) {
  if (!keptEvents.some(k => Math.abs(k.frame - ev.frame) <= nmsWindow)) {
    keptEvents.push(ev);
  }
}
const finalEvents = keptEvents.sort((a, b) => a.frame - b.frame);

console.log("finalEvents:", finalEvents.length);

const applySkillHeuristics = (events) => {
    if (events.length === 0) return events;

    let modified = JSON.parse(JSON.stringify(events));

    // Rule 1: No consecutive identical skills for toss, serve, attack, block
    let i = 0;
    while (i < modified.length - 1) {
      const current = modified[i];
      const next = modified[i + 1];
      
      const isTargetSkill = ['toss', 'serve', 'attack', 'block'].includes(current.skill);
      
      if (current.skill === next.skill && isTargetSkill) {
        // Delete the one with lower confidence, or arbitrarily the second if confidences are equal/missing
        const conf1 = current.confidence ?? 1.0;
        const conf2 = next.confidence ?? 1.0;
        
        if (conf1 >= conf2) {
          modified.splice(i + 1, 1);
        } else {
          modified.splice(i, 1);
        }
        // Do not increment i, re-check current i against the new i+1
      } else {
        i++;
      }
    }

    // Pass 2: Trigrams
    for (let i = 0; i < modified.length; i++) {
      if (i <= modified.length - 3) {
        const e1 = modified[i];
        const e2 = modified[i+1];
        const e3 = modified[i+2];

        // Rule 2: reception/dig -> dig -> attack/block  => middle dig becomes set
        const isE1RecOrDig = e1.skill === 'reception' || e1.skill === 'dig';
        const isE3AttOrBlk = e3.skill === 'attack' || e3.skill === 'block';
        if (isE1RecOrDig && e2.skill === 'dig' && isE3AttOrBlk) {
          e2.skill = 'set';
          e2.class_id = 3;
        }

        // Rule 3: toss -> serve -> dig => changes to set and reception
        if (e1.skill === 'toss' && e2.skill === 'serve' && e3.skill === 'dig') {
          e2.skill = 'set';
          e2.class_id = 3;
          e3.skill = 'reception';
          e3.class_id = 2;
        }
      }
      
      // Pass 3: Bigrams
      if (i <= modified.length - 2) {
        const current = modified[i];
        const next = modified[i + 1];

        // Rule 4: receive/dig -> set (already handled by model usually, but explicit rule requested:
        // "if receive after the next skill is dig then do the skill to set")
        // NOTE: Rule 2 covers reception->dig->attack. If we want ALL reception->dig to be reception->set:
        const isCurrentRecOrDig = current.skill === 'reception' || current.skill === 'dig';
        if (isCurrentRecOrDig && next.skill === 'dig') {
           next.skill = 'set';
           next.class_id = 3;
        }
      }
    }

    return modified;
  };

console.log("heuristicallyCorrected:", applySkillHeuristics(finalEvents).length);

