const currentActions = [
  { frame: 188, track_id: 15, action: 'draw_box', box: {} }
];
const frame = 188;
const trackId = 15;

const newActions = currentActions.filter(m => !(m.frame === frame && m.track_id === trackId && m.action !== 'draw_box'));
newActions.push({ frame, track_id: trackId });

console.log(newActions);
