import { parseJSONAnnotations } from './src/utils/importUtils';
const rawJson = JSON.stringify({ tracks: [] });
const manualActions = [
  { frame: 188, track_id: 15, action: 'draw_box' as const, box: { x_min: 100, y_min: 100, x_max: 200, y_max: 200, track_id: 15 } },
  { frame: 188, track_id: 15 }
];
const res = parseJSONAnnotations(rawJson, manualActions);
console.log(res);
