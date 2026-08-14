import JSZip from 'jszip';
import type { VideoMetadata } from '../types';
import { normalizeAnnotationStem } from './exportUtils';

export type BlockClipLabel = 'attack_before' | 'attack' | 'block' | 'end_block';

export interface BlockClipMarkers {
  attack_before: number | null;
  attack: number | null;
  block: number | null;
  end_block: number | null;
}

export interface BlockClipItem {
  id: string;
  name: string;
  stem: string;
  file?: File;
  videoMetadata?: VideoMetadata | null;
  markers: BlockClipMarkers;
  /** Original XML text when loaded — meta section preserved on export */
  sourceXml?: string;
}

export const EMPTY_BLOCK_MARKERS: BlockClipMarkers = {
  attack_before: null,
  attack: null,
  block: null,
  end_block: null,
};

export const BLOCK_CLIP_LABELS: {
  key: BlockClipLabel;
  title: string;
  short: string;
  hotkey: string;
  color: string;
}[] = [
  { key: 'attack_before', title: 'Attack Before', short: 'Pre-attack', hotkey: '1', color: '#a855f7' },
  { key: 'attack', title: 'Attack', short: 'Attack', hotkey: '2', color: '#f59e0b' },
  { key: 'block', title: 'Block', short: 'Block', hotkey: '3', color: '#ef4444' },
  { key: 'end_block', title: 'End Block', short: 'End blk', hotkey: '4', color: '#10b981' },
];

export const BLOCK_CLIP_STORAGE_KEY = 'volleyball_block_clip_annotations';

const LABEL_SET = new Set<string>(BLOCK_CLIP_LABELS.map((l) => l.key));

export function countSetMarkers(markers: BlockClipMarkers): number {
  return BLOCK_CLIP_LABELS.filter(({ key }) => markers[key] !== null).length;
}

export function isBlockClipComplete(markers: BlockClipMarkers): boolean {
  return countSetMarkers(markers) === BLOCK_CLIP_LABELS.length;
}

/** Default attack frame inside 25f export clips (10 pre + attack + 14 post). */
export const DEFAULT_ATTACK_LOCAL_FRAME = 10;

export function parseClipFilenameHints(stem: string): Partial<BlockClipMarkers> {
  const base = stem.split('/').pop() || stem;
  const attackMatch = base.match(/_a(\d+)(?:_|$)/);
  const blockMatch = base.match(/_b(\d+)/);
  if (!attackMatch) return {};

  const attackGlobal = Number(attackMatch[1]);
  const blockGlobal = blockMatch ? Number(blockMatch[1]) : null;
  const clipStart = attackGlobal - DEFAULT_ATTACK_LOCAL_FRAME;

  const hints: Partial<BlockClipMarkers> = {
    attack: DEFAULT_ATTACK_LOCAL_FRAME,
  };
  if (blockGlobal !== null && !Number.isNaN(blockGlobal)) {
    hints.block = blockGlobal - clipStart;
  }
  return hints;
}

export function mergeMarkersWithHints(
  existing: BlockClipMarkers,
  hints: Partial<BlockClipMarkers>,
): BlockClipMarkers {
  const out = { ...existing };
  for (const { key } of BLOCK_CLIP_LABELS) {
    if (out[key] === null && hints[key] !== undefined && hints[key] !== null) {
      out[key] = hints[key]!;
    }
  }
  return out;
}

export function parseBlockClipXml(xmlString: string): BlockClipMarkers {
  const markers: BlockClipMarkers = { ...EMPTY_BLOCK_MARKERS };
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
  const images = xmlDoc.getElementsByTagName('image');

  for (let i = 0; i < images.length; i++) {
    const imageNode = images[i];
    const frameIdAttr = imageNode.getAttribute('id');
    if (!frameIdAttr) continue;
    const frame = parseInt(frameIdAttr, 10);
    if (Number.isNaN(frame)) continue;

    const tags = imageNode.getElementsByTagName('tag');
    for (let j = 0; j < tags.length; j++) {
      const tagLabel = tags[j].getAttribute('label');
      if (!tagLabel || !LABEL_SET.has(tagLabel)) continue;
      markers[tagLabel as BlockClipLabel] = frame;
    }
  }

  return markers;
}

function extractMetaBlock(xmlString: string): string | null {
  const match = xmlString.match(/<meta>[\s\S]*?<\/meta>/);
  return match ? match[0] : null;
}

export function generateBlockClipXml(
  metadata: VideoMetadata,
  markers: BlockClipMarkers,
  sourceXml?: string,
): string {
  const frameCount = Math.max(1, metadata.frame_count);
  const w = metadata.width || 1280;
  const h = metadata.height || 720;

  const markerFrames = new Map<number, BlockClipLabel[]>();
  for (const { key } of BLOCK_CLIP_LABELS) {
    const frame = markers[key];
    if (frame === null || frame < 0 || frame >= frameCount) continue;
    if (!markerFrames.has(frame)) markerFrames.set(frame, []);
    markerFrames.get(frame)!.push(key);
  }

  const meta = sourceXml ? extractMetaBlock(sourceXml) : null;
  const metaBlock = meta
    ? `  ${meta}\n`
    : `  <meta>
    <job>
      <size>${frameCount}</size>
      <mode>interpolation</mode>
      <start_frame>0</start_frame>
      <stop_frame>${frameCount - 1}</stop_frame>
      <labels>
        <label><name>attack_before</name><color>#a855f7</color><type>any</type></label>
        <label><name>attack</name><color>#f59e0b</color><type>any</type></label>
        <label><name>block</name><color>#ef4444</color><type>any</type></label>
        <label><name>end_block</name><color>#10b981</color><type>any</type></label>
      </labels>
    </job>
    <original_size>
      <width>${w}</width>
      <height>${h}</height>
    </original_size>
  </meta>
`;

  let xml = `<?xml version="1.0" encoding="utf-8"?>\n<annotations>\n${metaBlock}`;

  for (let frame = 0; frame < frameCount; frame++) {
    const padFrame = frame.toString().padStart(6, '0');
    const labels = markerFrames.get(frame);
    if (!labels?.length) {
      xml += `  <image id="${frame}" name="frame_${padFrame}" width="${w}" height="${h}" />\n`;
      continue;
    }
    xml += `  <image id="${frame}" name="frame_${padFrame}" width="${w}" height="${h}">`;
    for (const label of labels) {
      xml += `\n    <tag label="${label}" source="manual"></tag>`;
    }
    xml += `\n  </image>\n`;
  }

  xml += `</annotations>\n`;
  return xml;
}

export function markersToJsonRecord(
  stem: string,
  metadata: VideoMetadata,
  markers: BlockClipMarkers,
) {
  return {
    clip: stem,
    video: metadata.filename,
    fps: metadata.fps,
    frame_count: metadata.frame_count,
    width: metadata.width,
    height: metadata.height,
    attack_before_frame: markers.attack_before,
    attack_frame: markers.attack,
    block_frame: markers.block,
    end_block_frame: markers.end_block,
    complete: isBlockClipComplete(markers),
    exported_at: new Date().toISOString(),
  };
}

export async function loadBlockClipPairsFromFiles(files: File[]): Promise<{
  items: BlockClipItem[];
  xmlByStem: Record<string, string>;
}> {
  const videos = new Map<string, File>();
  const xmlByStem: Record<string, string> = {};

  for (const file of files) {
    const lower = file.name.toLowerCase();
    const pathStem = file.webkitRelativePath
      ? normalizeAnnotationStem(file.webkitRelativePath.replace(/\.[^/.]+$/, ''))
      : normalizeAnnotationStem(file.name.replace(/\.[^/.]+$/, ''));

    if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.avi')) {
      videos.set(pathStem, file);
    } else if (lower.endsWith('.xml')) {
      xmlByStem[pathStem] = await file.text();
    }
  }

  const items: BlockClipItem[] = [];
  for (const [stem, file] of videos.entries()) {
    const hints = parseClipFilenameHints(stem);
    let markers = { ...EMPTY_BLOCK_MARKERS };
    let sourceXml: string | undefined;

    if (xmlByStem[stem]) {
      sourceXml = xmlByStem[stem];
      markers = parseBlockClipXml(sourceXml);
    }
    markers = mergeMarkersWithHints(markers, hints);

    items.push({
      id: stem,
      name: file.name,
      stem,
      file,
      markers,
      sourceXml,
    });
  }

  items.sort((a, b) => a.stem.localeCompare(b.stem));
  return { items, xmlByStem };
}

export async function loadBlockClipPairsFromZip(zipFile: File): Promise<{
  items: BlockClipItem[];
  xmlByStem: Record<string, string>;
}> {
  const zip = await JSZip.loadAsync(zipFile);
  const files: File[] = [];

  for (const filename of Object.keys(zip.files)) {
    const entry = zip.files[filename];
    if (entry.dir) continue;
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.mp4') && !lower.endsWith('.xml') && !lower.endsWith('.mov') && !lower.endsWith('.avi')) {
      continue;
    }
    const blob = await entry.async('blob');
    const base = filename.split('/').pop() || filename;
    const type = lower.endsWith('.xml') ? 'text/xml' : 'video/mp4';
    const file = new File([blob], base, { type });
    Object.defineProperty(file, 'webkitRelativePath', { value: filename, configurable: true });
    files.push(file);
  }

  return loadBlockClipPairsFromFiles(files);
}

export async function exportBlockClipBatchZip(items: BlockClipItem[]): Promise<Blob> {
  const zip = new JSZip();
  const summary: ReturnType<typeof markersToJsonRecord>[] = [];

  for (const item of items) {
    if (!item.videoMetadata) continue;
    const xml = generateBlockClipXml(item.videoMetadata, item.markers, item.sourceXml);
    const xmlName = `${item.stem}.xml`;
    zip.file(xmlName, xml);
    summary.push(markersToJsonRecord(item.stem, item.videoMetadata, item.markers));
  }

  zip.file('block_clip_annotations_summary.json', JSON.stringify(summary, null, 2));
  return zip.generateAsync({ type: 'blob' });
}

export function persistBlockClipState(items: BlockClipItem[], currentIndex: number): void {
  localStorage.setItem(
    BLOCK_CLIP_STORAGE_KEY,
    JSON.stringify({
      currentIndex,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        stem: item.stem,
        markers: item.markers,
      })),
    }),
  );
}

export function loadBlockClipState(): { currentIndex: number; items: Pick<BlockClipItem, 'id' | 'name' | 'stem' | 'markers'>[] } | null {
  const raw = localStorage.getItem(BLOCK_CLIP_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.items || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}
