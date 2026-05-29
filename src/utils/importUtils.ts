import JSZip from 'jszip';
import type { SkillEvent, Rally, SkillLabel } from '../types';

export interface ParsedAnnotations {
  rally: Rally;
  events: SkillEvent[];
}

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

export const parseZIPAnnotations = async (zipFile: File): Promise<{ annotations: Record<string, ParsedAnnotations>, videos: File[] }> => {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(zipFile);
  const annotations: Record<string, ParsedAnnotations> = {};
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
  
  return { annotations, videos };
};
