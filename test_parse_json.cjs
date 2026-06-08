const fs = require('fs');

const rawStr = fs.readFileSync('/home/sahil-padole/Documents/two_full_annotation_matches/touch_player_annotator/touch-player-tracking-data/volleymetrics-new-mathces/765873/upload/rally_105_resync_v2.json', 'utf8');

let frames;
try {
  const json = JSON.parse(rawStr);
  if (Array.isArray(json)) {
    frames = json;
  } else if (json && Array.isArray(json.frames)) {
    frames = json.frames;
  } else if (json && Array.isArray(json.predictions)) {
    frames = json.predictions;
  } else if (json && typeof json === 'object') {
    const vals = Object.values(json);
    if (vals.length > 0 && Array.isArray(vals[0])) {
        const sortedKeys = Object.keys(json).map(Number).sort((a,b)=>a-b);
        frames = sortedKeys.map(k => json[k]);
    } else {
        frames = [];
    }
  } else {
    frames = [];
  }
} catch (e) {
  console.log("Error parsing JSON:", e.message);
  process.exit(1);
}

let parsedBoxes = 0;
for (const frame of frames) {
    if (Array.isArray(frame)) parsedBoxes += frame.length;
}
console.log("Frames found:", frames.length);
console.log("Total boxes found:", parsedBoxes);
