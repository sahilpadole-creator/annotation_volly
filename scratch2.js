const snappedActions = [
  { frame: 188, track_id: 15, action: 'draw_box', box: {} },
  { frame: 188, track_id: 15 }
];

const uniqueActionsMap = new Map();
snappedActions.forEach(action => {
  const actType = action.action || 'add';
  const key = `${action.frame}_${action.track_id}_${actType}`;
  
  if (actType === 'draw_box') {
    uniqueActionsMap.set(key, action);
  } else {
    if (!uniqueActionsMap.has(key)) {
      uniqueActionsMap.set(key, action);
    }
  }
});

console.log(Array.from(uniqueActionsMap.values()));
