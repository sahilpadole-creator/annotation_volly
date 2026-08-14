import JSZip from 'jszip';
import type { SkillEvent, Rally, VideoMetadata, PlaylistItem, PlayerBox } from '../types';

const getVideoStem = (filename: string): string => filename.replace(/\.[^/.]+$/, '');

export const getXmlExportFilename = (stem: string, appMode: 'touch' | 'ball' | 'vnl' = 'touch'): string =>
  appMode === 'ball' ? `ball_tracking_${stem}.xml` : `annotations_${stem}.xml`;

export const getJsonExportFilename = (stem: string, appMode: 'touch' | 'ball' | 'vnl' = 'touch'): string =>
  appMode === 'ball' ? `${stem}_ball_tracking.json` : `${stem}_updated.json`;

export const getBatchZipFilename = (appMode: 'touch' | 'ball' | 'vnl' = 'touch'): string =>
  appMode === 'ball' ? 'ball_tracking_batch.zip' : appMode === 'vnl' ? 'vnl_annotations_batch.zip' : 'volleyball_annotations_batch.zip';

/** Strip export prefixes/suffixes so annotations match the video stem again. */
export const normalizeAnnotationStem = (stem: string): string => {
  const lastSlash = stem.lastIndexOf('/');
  const path = lastSlash >= 0 ? stem.substring(0, lastSlash + 1) : '';
  const name = lastSlash >= 0 ? stem.substring(lastSlash + 1) : stem;
  const normalized = name
    .replace(/^annotations_/, '')
    .replace(/^ball_tracking_/, '')
    .replace(/_updated$/, '')
    .replace(/_ball_tracking$/, '')
    .replace(/_skill_annotations$/, '');
  return `${path}${normalized}`;
};

const cloneBallBoxes = (boxes: Record<number, PlayerBox[]>): Record<number, PlayerBox[]> => {
  const out: Record<number, PlayerBox[]> = {};
  for (const [frameStr, frameBoxes] of Object.entries(boxes)) {
    out[Number(frameStr)] = frameBoxes.map((b) => ({ ...b }));
  }
  return out;
};

export const mergeBallBoxesForExport = (
  inference: Record<number, PlayerBox[]> | undefined,
  edits: Record<number, PlayerBox[]> | undefined,
): Record<number, PlayerBox[]> => {
  const merged = cloneBallBoxes(inference ?? {});
  if (!edits) return merged;
  for (const [frameStr, boxes] of Object.entries(edits)) {
    const frame = Number(frameStr);
    if (Number.isNaN(frame)) continue;
    if (boxes.length === 0) {
      delete merged[frame];
      continue;
    }
    const hasManual = boxes.some((b) => b.source === 'manual');
    const inferenceMissing = !merged[frame]?.length;
    if (hasManual || inferenceMissing) {
      merged[frame] = boxes.map((b) => ({ ...b }));
    }
  }
  return merged;
};

export const generateBallTrackingJSONString = (
  metadata: VideoMetadata,
  playerBoxes: Record<number, PlayerBox[]>,
): string => {
  const ballTracking = Object.entries(playerBoxes)
    .map(([frameStr, boxes]) => {
      const frame = Number(frameStr);
      if (Number.isNaN(frame) || boxes.length === 0) return null;
      const box = boxes[0];
      return {
        frame,
        box: [
          Number(box.x_min.toFixed(2)),
          Number(box.y_min.toFixed(2)),
          Number(box.x_max.toFixed(2)),
          Number(box.y_max.toFixed(2)),
        ],
        conf: box.conf ?? 1,
        source: box.source ?? 'inference',
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => a.frame - b.frame);

  const payload = {
    video: metadata.filename,
    fps: metadata.fps,
    width: metadata.width,
    height: metadata.height,
    frame_count: metadata.frame_count,
    frame_index_base: 0,
    ball_tracking: ballTracking,
    exported_at: new Date().toISOString(),
  };

  return JSON.stringify(payload, null, 2);
};

export const exportToJSON = (
  metadata: VideoMetadata,
  rally: Rally,
  events: SkillEvent[],
  annotator: string = ''
) => {
  // Sort events by frame ascending
  const sortedEvents = [...events].sort((a, b) => a.frame - b.frame);

  const payload = {
    video: metadata.filename,
    fps: metadata.fps,
    width: metadata.width,
    height: metadata.height,
    frame_count: metadata.frame_count,
    frame_index_base: 0,
    rally: {
      start_frame: rally.start_frame !== null ? rally.start_frame : 0,
      end_frame: rally.end_frame !== null ? rally.end_frame : metadata.frame_count - 1
    },
    events: sortedEvents,
    exported_at: new Date().toISOString(),
    annotator
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // stem
  const stem = getVideoStem(metadata.filename);
  a.download = getJsonExportFilename(stem, 'touch');
  a.click();
  URL.revokeObjectURL(url);
};

export const getUpdatedJSONString = (
  rawJsonString: string | undefined | null,
  manualActions: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: any }[],
  events?: { frame: number; skill?: string; player_id?: number; [key: string]: any }[],
  playerBoxes?: Record<number, PlayerBox[]>
): string | null => {
  try {
    let data: any = {};
    if (rawJsonString) {
      data = JSON.parse(rawJsonString);
    }

    if (!data.tracks || !Array.isArray(data.tracks)) {
      data.tracks = [];
    }

    // Embed current player boxes into the tracks structure so they are correctly exported
    if (playerBoxes && Object.keys(playerBoxes).length > 0) {
      Object.entries(playerBoxes).forEach(([frameStr, boxes]) => {
        const frameNum = parseInt(frameStr, 10);
        boxes.forEach(b => {
          let track = data.tracks.find((t: any) => t.track_id === b.track_id);
          if (!track) {
            track = { track_id: b.track_id, frames: [] };
            data.tracks.push(track);
          }
          const existingFrame = track.frames.find((f: any) => f.frame_num === frameNum);
          if (existingFrame) {
            existingFrame.ball_carrier = b.is_active || false;
            existingFrame.x = b.x_min;
            existingFrame.y = b.y_min;
            existingFrame.w = b.x_max - b.x_min;
            existingFrame.h = b.y_max - b.y_min;
          } else {
            track.frames.push({
              frame_num: frameNum,
              x: b.x_min,
              y: b.y_min,
              w: b.x_max - b.x_min,
              h: b.y_max - b.y_min,
              conf: 1.0,
              ball_carrier: b.is_active || false
            });
          }
        });
      });
    }
    
    if (data.tracks && Array.isArray(data.tracks)) {
      // New format
      manualActions.forEach(mAct => {
        let track = data.tracks.find((t: any) => t.track_id === mAct.track_id);
        
        // If track doesn't exist and we are drawing a box, create the track!
        if (!track && (mAct.action === 'draw_box' || mAct.action === 'add' || !mAct.action)) {
          track = { track_id: mAct.track_id, frames: [] };
          data.tracks.push(track);
        }

        if (track && track.frames) {
          // If we are drawing a box, we want to inject it into +-2 frames
          const framesToProcess = (mAct.action === 'draw_box' || mAct.action === 'add' || !mAct.action)
            ? [mAct.frame - 2, mAct.frame - 1, mAct.frame, mAct.frame + 1, mAct.frame + 2]
            : [mAct.frame];

          framesToProcess.forEach(fNum => {
            const frameObj = track.frames.find((f: any) => f.frame_num === fNum);
            if (frameObj) {
              frameObj.ball_carrier = mAct.action === 'remove' ? false : true;
            } else if (mAct.action !== 'remove') {
              // Read coordinates from the drawn box, if available
              const w = mAct.box ? (mAct.box.x_max - mAct.box.x_min) : 0;
              const h = mAct.box ? (mAct.box.y_max - mAct.box.y_min) : 0;
              const x = mAct.box ? mAct.box.x_min : 0;
              const y = mAct.box ? mAct.box.y_min : 0;
              
              track.frames.push({
                 frame_num: fNum,
                 x: x, y: y, w: w, h: h, conf: 1.0,
                 ball_carrier: true
              });
            }
          });
          
          // Sort frames
          track.frames.sort((a: any, b: any) => a.frame_num - b.frame_num);
        }
      });
    } else {
      // Old format
      manualActions.forEach(mAct => {
        const pKey = `player_${mAct.track_id}`;
        if (!data.players[pKey]) data.players[pKey] = {};
        if (!data.players[pKey].action) data.players[pKey].action = [];
        
        if (mAct.action === 'remove') {
          // Remove the action if it exists
          data.players[pKey].action = data.players[pKey].action.filter((a: any) => a.frame !== mAct.frame);
        } else {
          // Check if it already exists to avoid duplicates
          const exists = data.players[pKey].action.some((a: any) => a.frame === mAct.frame);
          if (!exists) {
            data.players[pKey].action.push({
              frame: mAct.frame,
              skill: "manual_active",
              side: "unknown"
            });
          }
        }
      });
    }
    
    // Update the main actions array with the current state.events to prevent reverting
    if (events && Array.isArray(events)) {
      data.actions = events.map(ev => ({
        frame: ev.frame,
        skill: ev.skill || "unknown",
        side: "unknown", // fallback
        active_players: ev.player_id !== undefined ? [ev.player_id] : []
      }));
    }
    
    return JSON.stringify(data, null, 2);
  } catch (e) {
    console.error("Failed to parse JSON for update", e);
    return null;
  }
};

export const exportUpdatedJSON = async (
  rawJsonString: string | undefined | null,
  manualActions: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: any }[],
  filename: string,
  includeMp4: boolean = false,
  videoFile?: File,
  events?: { frame: number; skill?: string; player_id?: number; [key: string]: any }[],
  playerBoxes?: Record<number, PlayerBox[]>
) => {
  try {
    const updatedJsonString = getUpdatedJSONString(rawJsonString, manualActions, events, playerBoxes);
    if (!updatedJsonString) return;

    const stem = filename.replace(/\.[^/.]+$/, "");
    
    if (includeMp4 && videoFile) {
      const zip = new JSZip();
      zip.file(`${stem}_updated.json`, updatedJsonString);
      zip.file(videoFile.name, videoFile);
      
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${stem}_updated_data.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const blob = new Blob([updatedJsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${stem}_updated.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    console.error("Failed to export updated JSON", e);
    alert("Failed to export updated JSON. See console for details.");
  }
};

export const generateXMLString = (
  metadata: VideoMetadata,
  rally: Rally,
  events: SkillEvent[],
  playerBoxes: Record<number, PlayerBox[]> = {},
  appMode: 'touch' | 'ball' | 'vnl' = 'touch'
): string => {
  let xml = `<?xml version="1.0" encoding="utf-8"?>\n<annotations>\n  <version>1.1</version>\n`;

  // Pre-compute events by frame
  const eventsByFrame = new Map<number, SkillEvent>();
  // If multiple events on same frame (which validation should prevent, but just in case),
  // requirement says keep highest priority: toss < serve < reception < set < dig < attack/block
  const priority = { toss: 0, serve: 1, reception: 2, receive: 2, set: 3, dig: 4, attack: 5, spike: 5, block: 6, score: 7 };
  
  if (appMode !== 'ball') {
    events.forEach(e => {
      if (!eventsByFrame.has(e.frame)) {
        eventsByFrame.set(e.frame, e);
      } else {
        const existing = eventsByFrame.get(e.frame)!;
        // @ts-ignore
        if (priority[e.skill] > priority[existing.skill]) {
          eventsByFrame.set(e.frame, e);
        }
      }
    });
  }

  const framesToOutput = new Set<number>();
  if (appMode !== 'ball') {
    if (appMode !== 'vnl') {
      if (rally.start_frame !== null) framesToOutput.add(rally.start_frame);
      if (rally.end_frame !== null) framesToOutput.add(rally.end_frame);
    }
    eventsByFrame.forEach((_, frame) => framesToOutput.add(frame));
  }
  
  // Add all frames that have bounding boxes
  Object.entries(playerBoxes).forEach(([frameStr, boxes]) => {
    if (boxes && boxes.length > 0) {
      framesToOutput.add(parseInt(frameStr, 10));
    }
  });

  const sortedFrames = Array.from(framesToOutput).sort((a, b) => a - b);

  for (const frame of sortedFrames) {
    const isStartRally = appMode !== 'ball' && appMode !== 'vnl' && rally.start_frame === frame;
    const isEndRally = appMode !== 'ball' && appMode !== 'vnl' && rally.end_frame === frame;
    const event = eventsByFrame.get(frame);

    const padFrame = frame.toString().padStart(6, '0');
    // Default to a 1920x1080 if width/height are 0
    const w = metadata.width || 1920;
    const h = metadata.height || 1080;
    xml += `  <image id="${frame}" name="frame_${padFrame}" width="${w}" height="${h}">\n`;
    
    if (isStartRally) {
      xml += `    <tag label="start_rally" source="manual"></tag>\n`;
    }
    
    if (event) {
      const src = event.source || 'manual';
      if (event.player_id !== undefined) {
        xml += `    <tag label="${event.skill}" source="${src}">\n`;
        xml += `      <attribute name="player_id">${event.player_id}</attribute>\n`;
        if (event.confidence !== undefined) {
          xml += `      <attribute name="score">${event.confidence.toFixed(4)}</attribute>\n`;
        }
        if (event.xy) {
          xml += `      <attribute name="x">${event.xy[0].toFixed(4)}</attribute>\n`;
          xml += `      <attribute name="y">${event.xy[1].toFixed(4)}</attribute>\n`;
        }
        xml += `    </tag>\n`;
      } else {
        if (event.confidence !== undefined || event.xy) {
          xml += `    <tag label="${event.skill}" source="${src}">\n`;
          if (event.confidence !== undefined) {
            xml += `      <attribute name="score">${event.confidence.toFixed(4)}</attribute>\n`;
          }
          if (event.xy) {
            xml += `      <attribute name="x">${event.xy[0].toFixed(4)}</attribute>\n`;
            xml += `      <attribute name="y">${event.xy[1].toFixed(4)}</attribute>\n`;
          }
          xml += `    </tag>\n`;
        } else {
          xml += `    <tag label="${event.skill}" source="${src}"></tag>\n`;
        }
      }
    }
    
    if (isEndRally) {
      xml += `    <tag label="end_rally" source="manual"></tag>\n`;
    }
    
    // Output bounding boxes for this frame if available
    const boxes = playerBoxes[frame];
    if (boxes && boxes.length > 0) {
      boxes.forEach(box => {
        if (appMode === 'ball') {
          xml += `    <box label="ball" xtl="${box.x_min.toFixed(2)}" ytl="${box.y_min.toFixed(2)}" xbr="${box.x_max.toFixed(2)}" ybr="${box.y_max.toFixed(2)}">\n`;
          if (box.conf !== undefined) {
             xml += `      <attribute name="conf">${box.conf.toFixed(3)}</attribute>\n`;
          }
          xml += `    </box>\n`;
        } else {
          // A box is assigned if there is an event on this frame AND the event's player_id matches the box's track_id
          const isAssigned = (event && event.player_id !== undefined && Number(event.player_id) === Number(box.track_id)) ? "true" : "false";
          const skillAttr = (isAssigned === "true" && event) ? `\n      <attribute name="skill">${event.skill}</attribute>` : "";
          
          xml += `    <box label="player" xtl="${box.x_min.toFixed(2)}" ytl="${box.y_min.toFixed(2)}" xbr="${box.x_max.toFixed(2)}" ybr="${box.y_max.toFixed(2)}">\n`;
          xml += `      <attribute name="track_id">${box.track_id}</attribute>\n`;
          xml += `      <attribute name="is_assigned">${isAssigned}</attribute>${skillAttr}\n`;
          xml += `    </box>\n`;
        }
      });
    }
    
    xml += `  </image>\n`;
  }

  xml += `</annotations>\n`;
  return xml;
};

export const exportToXML = (
  metadata: VideoMetadata,
  rally: Rally,
  events: SkillEvent[],
  playerBoxes: Record<number, PlayerBox[]> = {},
  appMode: 'touch' | 'ball' | 'vnl' = 'touch',
) => {
  const xml = generateXMLString(metadata, rally, events, playerBoxes, appMode);
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stem = getVideoStem(metadata.filename);
  a.download = getXmlExportFilename(stem, appMode);
  a.click();
  URL.revokeObjectURL(url);
};

export const exportAllToZip = async (playlist: PlaylistItem[], download = true, includeMp4 = false, appMode: 'touch' | 'ball' | 'vnl' = 'touch'): Promise<Blob | null> => {
  const zip = new JSZip();

  let hasData = false;
  playlist.forEach(item => {
    let itemHasData = false;
    const stem = getVideoStem(item.name);
    const hasEvents = item.events && item.events.length > 0;
    const hasBoxes = item.playerBoxes && Object.keys(item.playerBoxes).length > 0;
    const ballBoxes = appMode === 'ball'
      ? mergeBallBoxesForExport(item.inferenceBallBoxes, item.playerBoxes)
      : (item.playerBoxes || {});
    const hasBallBoxes = Object.keys(ballBoxes).length > 0;
    const meta = item.videoMetadata || { filename: item.name, fps: 30, width: 0, height: 0, duration: 0, frame_count: 0 };

    if (hasEvents || (appMode === 'ball' && hasBallBoxes)) {
      const xml = generateXMLString(
        meta,
        item.rally || { start_frame: null, end_frame: null },
        item.events || [],
        appMode === 'ball' ? ballBoxes : (item.playerBoxes || {}),
        appMode,
      );
      zip.file(getXmlExportFilename(stem, appMode), xml);
      itemHasData = true;
    }

    if (appMode === 'ball' && hasBallBoxes) {
      zip.file(
        getJsonExportFilename(stem, appMode),
        generateBallTrackingJSONString(meta, ballBoxes),
      );
      itemHasData = true;
    } else if (item.rawJsonString || hasEvents || hasBoxes) {
      const updatedJsonString = getUpdatedJSONString(
        item.rawJsonString,
        item.manualActions || [],
        item.events,
        item.playerBoxes,
      );
      if (updatedJsonString) {
        zip.file(getJsonExportFilename(stem, appMode), updatedJsonString);
        itemHasData = true;
      }
    }
    
    // Add MP4 if requested and we have some annotation data for it
    if (itemHasData) {
      hasData = true;
      if (includeMp4 && item.file) {
        zip.file(item.file.name, item.file);
      }
    }
  });

  if (!hasData) {
    alert("No annotated videos to export!");
    return null;
  }

  const content = await zip.generateAsync({ type: 'blob' });
  
  if (download) {
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = getBatchZipFilename(appMode);
    a.click();
    URL.revokeObjectURL(url);
  }
  
  return content;
};
