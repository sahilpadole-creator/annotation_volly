import JSZip from 'jszip';
import type { SkillEvent, Rally, SkillLabel, PlayerBox } from '../types';

export interface ParsedAnnotations {
  rally: Rally;
  events: SkillEvent[];
}

export const parseJSONAnnotations = (
  jsonString: string, 
  manualActions: { frame: number; track_id: number; action?: 'add' | 'remove' }[] = []
): { parsed: Record<number, PlayerBox[]>, rawJsonString: string } => {
  try {
    const data = JSON.parse(jsonString);
    const playerBoxes: Record<number, PlayerBox[]> = {};
    
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
                 is_active: activeFrames.has(frame_idx) && !removedFrames.has(frame_idx)
               });
             }
          });
        }
      });
      
      return { parsed: playerBoxes, rawJsonString: jsonString };
    }

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
    
    return { parsed: playerBoxes, rawJsonString: jsonString };
  } catch (err) {
    console.error("Failed to parse JSON annotations", err);
    return { parsed: {}, rawJsonString: jsonString };
  }
};


export const parseXMLAnnotations = (xmlString: string): ParsedAnnotations => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, "text/xml");
  
  const rally: Rally = { start_frame: null, end_frame: null };
  const events: SkillEvent[] = [];
  
  const LABEL_TO_SKILL: Record<string, { label: SkillLabel; classId: number }> = {
    toss: { label: 'toss', classId: 0 },
    serve: { label: 'serve', classId: 1 },
    reception: { label: 'reception', classId: 2 },
    receive: { label: 'reception', classId: 2 },
    set: { label: 'set', classId: 3 },
    dig: { label: 'dig', classId: 4 },
    attack: { label: 'attack', classId: 5 },
    block: { label: 'block', classId: 5 },
    'attack/block': { label: 'attack', classId: 5 },
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
          events.push({
            frame,
            skill: matchedSkill.label,
            class_id: matchedSkill.classId,
            confidence: 1.0
          });
        }
      }
    }
  }
  
  return { rally, events };
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
        let stem = filename.replace(/\.xml$/i, '');
        const lastSlash = stem.lastIndexOf('/');
        if (lastSlash >= 0) {
          const path = stem.substring(0, lastSlash + 1);
          let base = stem.substring(lastSlash + 1);
          if (base.startsWith('annotations_')) base = base.replace(/^annotations_/, '');
          stem = path + base;
        } else {
          if (stem.startsWith('annotations_')) stem = stem.replace(/^annotations_/, '');
        }
        annotations[stem] = parsed;
      } catch (err) {
        console.error(`Failed to parse XML from ZIP: ${filename}`, err);
      }
    } else if (filename.toLowerCase().endsWith('.json')) {
      const jsonString = await file.async("string");
      try {
        const result = parseJSONAnnotations(jsonString);
        let stem = filename.replace(/\.json$/i, '');
        const lastSlash = stem.lastIndexOf('/');
        if (lastSlash >= 0) {
          stem = stem.substring(lastSlash + 1);
        }
        jsonAnnotations[stem] = result;
      } catch (err) {
        console.error(`Failed to parse JSON from ZIP: ${filename}`, err);
      }
    } else if (filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov') || filename.toLowerCase().endsWith('.avi')) {
      try {
        const blob = await file.async("blob");
        const videoFile = new File([blob], filename, { type: 'video/mp4' });
        videos.push(videoFile);
      } catch (err) {
        console.error(`Failed to extract video from ZIP: ${filename}`, err);
      }
    }
  }
  
  return { annotations, jsonAnnotations, videos };
};
