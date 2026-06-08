const fs = require('fs');
const rawStr = fs.readFileSync('/home/sahil-padole/Documents/two_full_annotation_matches/touch_player_annotator/touch-player-tracking-data/volleymetrics-new-mathces/765873/upload/rally_105_resync_v2.json', 'utf8');

const parseJSONAnnotations = (jsonString) => {
    const data = JSON.parse(jsonString);
    const playerBoxes = {};
    if (data.tracks && Array.isArray(data.tracks)) {
      data.tracks.forEach((track) => {
        const trackId = track.track_id;
        const activeFrames = new Set();
        if (track.frames && Array.isArray(track.frames)) {
          track.frames.forEach((f) => {
            if (f.ball_carrier === true) {
              for (let i = f.frame_num - 10; i <= f.frame_num + 10; i++) {
                activeFrames.add(i);
              }
            }
          });
        }
        if (track.frames && Array.isArray(track.frames)) {
          track.frames.forEach((f) => {
             const frame_idx = f.frame_num;
             const x_min = f.x;
             const y_min = f.y;
             const x_max = f.x + f.w;
             const y_max = f.y + f.h;
             
             if (x_max > x_min && y_max > y_min) {
               if (!playerBoxes[frame_idx]) {
                 playerBoxes[frame_idx] = [];
               }
               
               playerBoxes[frame_idx].push({
                 x_min,
                 y_min,
                 x_max,
                 y_max,
                 track_id: trackId,
                 is_active: activeFrames.has(frame_idx)
               });
             }
          });
        }
      });
      return { parsed: playerBoxes, rawJsonString: jsonString };
    }
}
const result = parseJSONAnnotations(rawStr);
console.log("Total frames with boxes:", Object.keys(result.parsed).length);
