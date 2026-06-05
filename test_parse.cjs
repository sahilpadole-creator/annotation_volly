const fs = require('fs');

const jsonString = fs.readFileSync('/home/sahil-padole/Documents/two_full_annotation_matches/touch_player_annotator/touch-player-tracking-data/volleymetrics-new-mathces/765873/upload/rally_6_resync_v2.json', 'utf8');

const data = JSON.parse(jsonString);
const playerBoxes = {};

if (data.tracks && Array.isArray(data.tracks)) {
  data.tracks.forEach(track => {
    const trackId = track.track_id;
    if (track.frames && Array.isArray(track.frames)) {
      track.frames.forEach(f => {
         const frame_idx = f.frame_num;
         const x_min = f.x;
         const y_min = f.y;
         const x_max = f.x + f.w;
         const y_max = f.y + f.h;
         
         if (x_max > x_min && y_max > y_min) {
           if (!playerBoxes[frame_idx]) {
             playerBoxes[frame_idx] = [];
           }
           playerBoxes[frame_idx].push({ track_id: trackId, x_min });
         }
      });
    }
  });
}
console.log("Frames parsed:", Object.keys(playerBoxes).length);
console.log("Boxes in frame 0:", playerBoxes[0]);
