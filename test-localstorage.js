// Simulate the flow
let state = {
  playlist: [
    { name: "video.mp4", events: [{ frame: 1, skill: "serve" }] }
  ],
  currentPlaylistIndex: 0,
  events: [{ frame: 1, skill: "serve" }, { frame: 10, skill: "dig" }],
  rally: { start_frame: 0, end_frame: 100 },
  videoMetadata: { filename: "video.mp4" },
  currentFrame: 10
};

// Autosave runs
const currentPlaylist = [...state.playlist];
if (currentPlaylist.length > 0 && currentPlaylist[state.currentPlaylistIndex]) {
  currentPlaylist[state.currentPlaylistIndex] = {
     ...currentPlaylist[state.currentPlaylistIndex],
     events: state.events,
     rally: state.rally,
     videoMetadata: state.videoMetadata,
  };
}

const stateToSave = {
  ...state,
  playlist: currentPlaylist.map(item => ({ ...item, file: undefined }))
};
// console.log("Saved to LS:", JSON.stringify(stateToSave, null, 2));

// Refresh!
let loadedState = stateToSave;

// Upload video.mp4
const file = { name: "video.mp4", lastModified: 12345 };
const allVideoFiles = [file];

const newPlaylistItems = allVideoFiles.map(file => {
  const existing = loadedState.playlist.find(p => p.name === file.name);
  console.log("Found existing:", existing !== undefined, existing?.events);
  
  return {
    name: file.name,
    events: existing?.events || []
  };
});

console.log("New playlist items:", newPlaylistItems);
