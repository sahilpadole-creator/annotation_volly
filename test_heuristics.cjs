const LABEL_TO_SKILL = {
  toss: { label: 'toss', classId: 0 },
  serve: { label: 'serve', classId: 1 },
  reception: { label: 'reception', classId: 2 },
  set: { label: 'set', classId: 3 },
  dig: { label: 'dig', classId: 4 },
  attack: { label: 'attack', classId: 5 },
  block: { label: 'block', classId: 5 },
};

const applySkillHeuristics = (events) => {
  if (events.length === 0) return events;
  let modified = JSON.parse(JSON.stringify(events));
  const updateSkill = (event, newSkill) => {
    event.skill = newSkill;
    if (LABEL_TO_SKILL[newSkill]) {
      event.class_id = LABEL_TO_SKILL[newSkill].classId;
    }
  };

  let i = 0;
  while (i < modified.length - 1) {
    const current = modified[i];
    const next = modified[i + 1];
    const isTargetSkill = ['toss', 'serve', 'attack', 'block'].includes(current.skill);
    if (current.skill === next.skill && isTargetSkill) {
      const conf1 = current.confidence ?? 1.0;
      const conf2 = next.confidence ?? 1.0;
      if (conf1 >= conf2) {
        modified.splice(i + 1, 1);
      } else {
        modified.splice(i, 1);
        continue;
      }
    } else {
      i++;
    }
  }

  for (let i = 0; i < modified.length; i++) {
    if (i <= modified.length - 3) {
      const e1 = modified[i];
      const e2 = modified[i+1];
      const e3 = modified[i+2];
      if (e1.skill === 'toss' && e2.skill === 'serve' && (e3.skill === 'set' || e3.skill === 'dig')) {
        updateSkill(e3, 'reception');
      }
      if ((e1.skill === 'reception' || e1.skill === 'dig') && e2.skill === 'dig' && (e3.skill === 'attack' || e3.skill === 'block')) {
        updateSkill(e2, 'set');
      }
    }
    if (i <= modified.length - 2) {
      const e1 = modified[i];
      const e2 = modified[i+1];
      if (e1.skill === 'reception' && e2.skill === 'dig') {
        updateSkill(e2, 'set');
      }
    }
  }
  return modified;
};

const mock = [
  { frame: 100, skill: 'toss', confidence: 0.9 },
  { frame: 110, skill: 'toss', confidence: 0.8 },
  { frame: 120, skill: 'serve', confidence: 0.9 },
  { frame: 130, skill: 'serve', confidence: 0.95 },
  { frame: 140, skill: 'dig', confidence: 0.9 },
  { frame: 150, skill: 'dig', confidence: 0.9 },
  { frame: 160, skill: 'attack', confidence: 0.9 }
];

console.log("Original:", mock.length);
const corrected = applySkillHeuristics(mock);
console.log("Corrected:", corrected.length);
console.log(corrected);
