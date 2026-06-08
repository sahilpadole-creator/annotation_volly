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

const payload = {"video_name":"rally_6.mp4","predictions":[{"frame":38,"label":"toss"},{"frame":81,"label":"serve"},{"frame":103,"label":"reception"},{"frame":144,"label":"set"},{"frame":157,"label":"attack/block"},{"frame":159,"label":"attack/block"},{"frame":161,"label":"attack/block"},{"frame":174,"label":"dig"},{"frame":177,"label":"dig"},{"frame":228,"label":"set"},{"frame":267,"label":"attack/block"}],"inference_fps":0,"inference_time_sec":50.62,"frame_count":0};

let rawCandidates = [];
if (Array.isArray(payload.predictions)) rawCandidates = payload.predictions;

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

    const classId = item?.class_id;
    if (typeof classId === 'number' && classId >= 0 && classId <= 5) {
      const match = Object.values(SKILL_MAP).find((s) => s.classId === classId);
      if (!match) return null;
      return {
        frame: Math.round(frame),
        skill: match.label,
        class_id: classId,
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
