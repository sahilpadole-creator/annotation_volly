import JSZip from 'jszip';
import type { SkillEvent, Rally, VideoMetadata, PlaylistItem } from '../types';

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
  const stem = metadata.filename.replace(/\.[^/.]+$/, "");
  a.download = `${stem}_skill_annotations.json`;
  a.click();
  URL.revokeObjectURL(url);
};

export const generateXMLString = (
  metadata: VideoMetadata,
  rally: Rally,
  events: SkillEvent[]
): string => {
  let xml = `<?xml version="1.0" encoding="utf-8"?>\n<annotations>\n  <version>1.1</version>\n`;

  // Pre-compute events by frame
  const eventsByFrame = new Map<number, SkillEvent>();
  // If multiple events on same frame (which validation should prevent, but just in case),
  // requirement says keep highest priority: toss < serve < reception < set < dig < attack/block
  const priority = { toss: 0, serve: 1, reception: 2, set: 3, dig: 4, attack: 5, block: 5 };
  
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

  for (let frame = 0; frame < metadata.frame_count; frame++) {
    const isStartRally = rally.start_frame === frame;
    const isEndRally = rally.end_frame === frame;
    const event = eventsByFrame.get(frame);

    if (isStartRally || isEndRally || event) {
      const padFrame = frame.toString().padStart(6, '0');
      xml += `  <image id="${frame}" name="frame_${padFrame}" width="${metadata.width}" height="${metadata.height}">\n`;
      
      if (isStartRally) {
        xml += `    <tag label="start_rally" source="manual"></tag>\n`;
      }
      
      if (event) {
        xml += `    <tag label="${event.skill}" source="manual"></tag>\n`;
      }
      
      if (isEndRally) {
        xml += `    <tag label="end_rally" source="manual"></tag>\n`;
      }
      
      xml += `  </image>\n`;
    }
  }

  xml += `</annotations>\n`;
  return xml;
};

export const exportToXML = (
  metadata: VideoMetadata,
  rally: Rally,
  events: SkillEvent[]
) => {
  const xml = generateXMLString(metadata, rally, events);
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stem = metadata.filename.replace(/\.[^/.]+$/, "");
  a.download = `annotations_${stem}.xml`;
  a.click();
  URL.revokeObjectURL(url);
};

export const exportAllToZip = async (playlist: PlaylistItem[]) => {
  const zip = new JSZip();

  let hasData = false;
  playlist.forEach(item => {
    if (item.videoMetadata && item.rally && item.events) {
      const xml = generateXMLString(item.videoMetadata, item.rally, item.events);
      const stem = item.name.replace(/\.[^/.]+$/, "");
      zip.file(`annotations_${stem}.xml`, xml);
      hasData = true;
    }
  });

  if (!hasData) {
    alert("No annotated videos to export!");
    return;
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = `volleyball_annotations_batch.zip`;
  a.click();
  URL.revokeObjectURL(url);
};
