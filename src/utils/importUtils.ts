import JSZip from 'jszip';
import type { SkillEvent, Rally, SkillLabel, PlayerBox } from '../types';
import { normalizeAnnotationStem } from './exportUtils';

export interface ParsedAnnotations {
  rally: Rally;
  events: SkillEvent[];
  playerBoxes?: Record<number, PlayerBox[]>;
}

export const parseJSONAnnotations = (
  jsonString: string, 
  manualActions: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: any }[] = []
): { parsed: Record<number, PlayerBox[]>, rawJsonString: string, videoFps?: number } => {
  try {
    const data = JSON.parse(jsonString);
    const playerBoxes: Record<number, PlayerBox[]> = {};

    if (Array.isArray(data.ball_tracking)) {
      data.ball_tracking.forEach((entry: any) => {
        const frame = Number(entry?.frame);
        if (Number.isNaN(frame)) return;
        let x_min: number | undefined;
        let y_min: number | undefined;
        let x_max: number | undefined;
        let y_max: number | undefined;
        if (Array.isArray(entry.box) && entry.box.length >= 4) {
          [x_min, y_min, x_max, y_max] = entry.box.map((v: unknown) => Number(v));
        } else if (
          entry.x_min !== undefined &&
          entry.y_min !== undefined &&
          entry.x_max !== undefined &&
          entry.y_max !== undefined
        ) {
          x_min = Number(entry.x_min);
          y_min = Number(entry.y_min);
          x_max = Number(entry.x_max);
          y_max = Number(entry.y_max);
        }
        if (
          x_min === undefined ||
          y_min === undefined ||
          x_max === undefined ||
          y_max === undefined ||
          !(x_max > x_min && y_max > y_min)
        ) {
          return;
        }
        playerBoxes[frame] = [{
          x_min,
          y_min,
          x_max,
          y_max,
          track_id: 1,
          is_active: true,
          conf: Number(entry.conf) || 0,
          source: 'inference',
        }];
      });
      return { parsed: playerBoxes, rawJsonString: jsonString, videoFps: data.fps || data.video_fps };
    }
    
    // Check if new format with 'tracks' array
    if (data.tracks && Array.isArray(data.tracks)) {
      data.tracks.forEach((track: any) => {
        const trackId = track.track_id;
        const activeFrames = new Set<number>();
        const removedFrames = new Set<number>();
        
        // Track actions (ball_carrier)
        if (track.frames && Array.isArray(track.frames)) {
          track.frames.forEach((f: any) => {
            if (f.ball_carrier === true) {
              // Add a window of +/- 2 frames
              for (let i = f.frame_num - 2; i <= f.frame_num + 2; i++) {
                activeFrames.add(i);
              }
            }
          });
        }
        
        // Manual actions
        manualActions.forEach(mAct => {
          if (mAct.track_id === trackId) {
            if (mAct.action === 'remove') {
              for (let i = mAct.frame - 2; i <= mAct.frame + 2; i++) {
                removedFrames.add(i);
                activeFrames.delete(i);
              }
            } else {
              for (let i = mAct.frame - 2; i <= mAct.frame + 2; i++) {
                activeFrames.add(i);
                removedFrames.delete(i);
              }
            }
          }
        });
        
        if (track.frames && Array.isArray(track.frames)) {
          track.frames.forEach((f: any) => {
             const frame_idx = f.frame_num;
             
             let x_min = 0, y_min = 0, x_max = 0, y_max = 0;
             // Priority 1: standard XYXY native
             if (f.x_min !== undefined && f.y_min !== undefined && f.x_max !== undefined && f.y_max !== undefined) {
               x_min = f.x_min; y_min = f.y_min; x_max = f.x_max; y_max = f.y_max;
             } 
             // Priority 2: x, y, x2, y2
             else if (f.x !== undefined && f.y !== undefined && f.x2 !== undefined && f.y2 !== undefined) {
               x_min = f.x; y_min = f.y; x_max = f.x2; y_max = f.y2;
             }
             // Priority 3: standard XYWH (BoTSORT native)
             else if (f.x !== undefined && f.y !== undefined && f.w !== undefined && f.h !== undefined) {
               x_min = f.x; y_min = f.y; x_max = f.x + f.w; y_max = f.y + f.h;
             }
             
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
                 is_active: activeFrames.has(frame_idx) && !removedFrames.has(frame_idx)
               });
             }
          });
        }
      });
      // Do NOT return here, so that manual actions can be processed below
    } else {
      // Otherwise, process old format: data.players
    const players = data.players || {};
    for (const [pKey, pData] of Object.entries(players)) {
      const anyData = pData as any;
      let trackId = -1;
      try {
        trackId = parseInt(pKey.split('_')[1], 10);
      } catch {
        // ignore
      }
      
      const activeFrames = new Set<number>();
      const removedFrames = new Set<number>();
      
      if (anyData.action && Array.isArray(anyData.action)) {
        anyData.action.forEach((act: any) => {
          if (act && typeof act.frame === 'number') {
            for (let f = act.frame - 2; f <= act.frame + 2; f++) {
              activeFrames.add(f);
            }
          }
        });
      }

      manualActions.forEach(mAct => {
        if (mAct.track_id === trackId) {
          if (mAct.action === 'remove') {
            for (let f = mAct.frame - 2; f <= mAct.frame + 2; f++) {
              removedFrames.add(f);
              activeFrames.delete(f);
            }
          } else {
            for (let f = mAct.frame - 2; f <= mAct.frame + 2; f++) {
              activeFrames.add(f);
              removedFrames.delete(f);
            }
          }
        }
      });
      
      const x_min_list = anyData.x_min || [];
      const y_min_list = anyData.y_min || [];
      const x_max_list = anyData.x_max || [];
      const y_max_list = anyData.y_max || [];
      
      const maxLen = Math.min(x_min_list.length, y_min_list.length, x_max_list.length, y_max_list.length);
      
      for (let frame_idx = 0; frame_idx < maxLen; frame_idx++) {
        const x_min = x_min_list[frame_idx];
        const y_min = y_min_list[frame_idx];
        const x_max = x_max_list[frame_idx];
        const y_max = y_max_list[frame_idx];
        
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
            is_active: activeFrames.has(frame_idx) && !removedFrames.has(frame_idx)
          });
        }
        }
      }
    }
    
    // Process manually drawn boxes
    manualActions.forEach(mAct => {
      if (mAct.action === 'draw_box' && mAct.box) {
        for (let i = mAct.frame - 2; i <= mAct.frame + 2; i++) {
          if (i >= 0) {
            if (!playerBoxes[i]) playerBoxes[i] = [];
            if (!playerBoxes[i].some(b => b.track_id === mAct.track_id)) {
              playerBoxes[i].push({ ...mAct.box, is_active: false });
            }
          }
        }
      }
    });

    // Apply manual add/remove to all boxes again to ensure drawn boxes get activated properly
    manualActions.forEach(mAct => {
      if (mAct.action === 'add' || !mAct.action) { // Default is 'add' if not specified in old format
        for (let i = mAct.frame - 2; i <= mAct.frame + 2; i++) {
          if (playerBoxes[i]) {
            const box = playerBoxes[i].find(b => b.track_id === mAct.track_id);
            if (box) box.is_active = true;
          }
        }
      } else if (mAct.action === 'remove') {
        for (let i = mAct.frame - 2; i <= mAct.frame + 2; i++) {
          if (playerBoxes[i]) {
            const box = playerBoxes[i].find(b => b.track_id === mAct.track_id);
            if (box) box.is_active = false;
          }
        }
      }
    });
    
    return { parsed: playerBoxes, rawJsonString: jsonString, videoFps: data.fps || data.video_fps };
  } catch (err) {
    console.error("Failed to parse JSON annotations", err);
    return { parsed: {}, rawJsonString: jsonString, videoFps: undefined };
  }
};


/** Extend partial tracking JSON to cover a longer video (forward/back-fill per track). */
export const extendPlayerBoxesToFrameCount = (
  playerBoxes: Record<number, PlayerBox[]>,
  frameCount: number,
): Record<number, PlayerBox[]> => {
  if (frameCount <= 0 || Object.keys(playerBoxes).length === 0) {
    return playerBoxes;
  }

  const trackFrames: Record<number, Record<number, PlayerBox>> = {};
  for (const [frameStr, boxes] of Object.entries(playerBoxes)) {
    const frame = parseInt(frameStr, 10);
    if (Number.isNaN(frame)) continue;
    for (const box of boxes) {
      if (!trackFrames[box.track_id]) trackFrames[box.track_id] = {};
      trackFrames[box.track_id][frame] = { ...box };
    }
  }

  const out: Record<number, PlayerBox[]> = {};
  for (const frames of Object.values(trackFrames)) {
    const sorted = Object.keys(frames).map(Number).sort((a, b) => a - b);
    if (sorted.length === 0) continue;

    const firstF = sorted[0];
    const lastF = sorted[sorted.length - 1];
    const firstBox = frames[firstF];
    const lastBox = frames[lastF];
    let prevF = firstF;

    for (let f = 0; f < frameCount; f++) {
      let box: PlayerBox;
      if (frames[f]) {
        box = { ...frames[f] };
        prevF = f;
      } else if (f < firstF) {
        box = { ...firstBox, is_active: false };
      } else if (f > lastF) {
        box = { ...lastBox, is_active: false };
      } else {
        box = { ...frames[prevF], is_active: false };
      }

      if (!out[f]) out[f] = [];
      out[f].push(box);
    }
  }

  return out;
};


export const parseXMLAnnotations = (xmlString: string): ParsedAnnotations => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, "text/xml");
  
  const rally: Rally = { start_frame: null, end_frame: null };
  const events: SkillEvent[] = [];
  const playerBoxes: Record<number, PlayerBox[]> = {};
  
  const LABEL_TO_SKILL: Record<string, { label: SkillLabel; classId: number }> = {
    toss: { label: 'toss', classId: 0 },
    serve: { label: 'serve', classId: 1 },
    reception: { label: 'reception', classId: 2 },
    set: { label: 'set', classId: 3 },
    dig: { label: 'dig', classId: 4 },
    attack: { label: 'attack', classId: 5 },
    block: { label: 'block', classId: 6 },
    receive: { label: 'receive', classId: 2 },
    score: { label: 'score', classId: 3 },
    spike: { label: 'spike', classId: 6 },
    'reception/dig': { label: 'reception', classId: 2 },
  };

  const images = xmlDoc.getElementsByTagName("image");
  for (let i = 0; i < images.length; i++) {
    const imageNode = images[i];
    const frameIdAttr = imageNode.getAttribute("id");
    if (!frameIdAttr) continue;
    const frame = parseInt(frameIdAttr, 10);
    if (isNaN(frame)) continue;
    
    const tags = imageNode.getElementsByTagName("tag");
    for (let j = 0; j < tags.length; j++) {
      const tagLabel = tags[j].getAttribute("label");
      if (!tagLabel) continue;
      
      if (tagLabel === "start_rally") {
        rally.start_frame = frame;
      } else if (tagLabel === "end_rally") {
        rally.end_frame = frame;
      } else {
        const normalized = tagLabel.toLowerCase();
        const matchedSkill = LABEL_TO_SKILL[normalized];
        if (matchedSkill) {
          let playerId: number | undefined = undefined;
          const attributes = tags[j].getElementsByTagName("attribute");
          for (let k = 0; k < attributes.length; k++) {
            if (attributes[k].getAttribute("name") === "player_id") {
              const pid = parseInt(attributes[k].textContent || "", 10);
              if (!isNaN(pid)) playerId = pid;
            }
          }
          
          events.push({
            frame,
            skill: matchedSkill.label,
            class_id: matchedSkill.classId,
            confidence: 1.0,
            player_id: playerId
          });
        }
      }
    }

    const boxes = imageNode.getElementsByTagName("box");
    for (let j = 0; j < boxes.length; j++) {
      const boxNode = boxes[j];
      const label = (boxNode.getAttribute("label") || "").toLowerCase();
      const xtl = Number(boxNode.getAttribute("xtl"));
      const ytl = Number(boxNode.getAttribute("ytl"));
      const xbr = Number(boxNode.getAttribute("xbr"));
      const ybr = Number(boxNode.getAttribute("ybr"));
      if (!(xbr > xtl && ybr > ytl)) continue;

      let conf: number | undefined;
      let trackId = label === "ball" ? 1 : -1;
      const attributes = boxNode.getElementsByTagName("attribute");
      for (let k = 0; k < attributes.length; k++) {
        const attrName = attributes[k].getAttribute("name");
        const attrValue = attributes[k].textContent || "";
        if (attrName === "conf") {
          const parsedConf = Number(attrValue);
          if (!Number.isNaN(parsedConf)) conf = parsedConf;
        } else if (attrName === "track_id") {
          const parsedId = Number(attrValue);
          if (!Number.isNaN(parsedId)) trackId = parsedId;
        }
      }

      if (!playerBoxes[frame]) playerBoxes[frame] = [];
      playerBoxes[frame].push({
        x_min: xtl,
        y_min: ytl,
        x_max: xbr,
        y_max: ybr,
        track_id: trackId,
        is_active: label === "ball" || true,
        conf,
        source: "inference",
      });
    }
  }
  
  return { rally, events, playerBoxes };
};

export const parseZIPAnnotations = async (zipFile: File): Promise<{ annotations: Record<string, ParsedAnnotations>, jsonAnnotations: Record<string, {parsed: Record<number, PlayerBox[]>, rawJsonString: string}>, videos: File[] }> => {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(zipFile);
  const annotations: Record<string, ParsedAnnotations> = {};
  const jsonAnnotations: Record<string, {parsed: Record<number, PlayerBox[]>, rawJsonString: string}> = {};
  const videos: File[] = [];
  
  for (const filename of Object.keys(loadedZip.files)) {
    const file = loadedZip.files[filename];
    if (file.dir) continue;
    
    // We expect filenames like "annotations_video1.xml" or "video1.xml"
    if (filename.toLowerCase().endsWith('.xml')) {
      const xmlString = await file.async("string");
      try {
        const parsed = parseXMLAnnotations(xmlString);
        let stem = normalizeAnnotationStem(filename.replace(/\.xml$/i, ''));
        annotations[stem] = parsed;
      } catch (err) {
        console.error(`Failed to parse XML from ZIP: ${filename}`, err);
      }
    } else if (filename.toLowerCase().endsWith('.json')) {
      const jsonString = await file.async("string");
      try {
        const result = parseJSONAnnotations(jsonString);
        let stem = normalizeAnnotationStem(filename.replace(/\.json$/i, ''));
        jsonAnnotations[stem] = result;
      } catch (err) {
        console.error(`Failed to parse JSON from ZIP: ${filename}`, err);
      }
    } else if (filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov') || filename.toLowerCase().endsWith('.avi')) {
      try {
        const blob = await file.async("blob");
        const basename = filename.split("/").pop() || filename;
        const videoFile = new File([blob], basename, { type: "video/mp4" });
        videos.push(videoFile);
      } catch (err) {
        console.error(`Failed to extract video from ZIP: ${filename}`, err);
      }
    }
  }
  
  return { annotations, jsonAnnotations, videos };
};
