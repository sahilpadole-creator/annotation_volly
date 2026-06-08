import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Upload, Download, Settings, Trash2, AlertTriangle, AlertCircle, FileVideo, FolderArchive, ArrowRight, ArrowLeft, CheckCircle } from 'lucide-react';
import type { AppState, SkillLabel, PlaylistItem, SkillEvent } from './types';
import { exportToXML, exportAllToZip, generateXMLString, exportUpdatedJSON } from './utils/exportUtils';
import { GoogleDriveConnector } from './components/GoogleDriveConnector';
import { parseZIPAnnotations, parseXMLAnnotations, parseJSONAnnotations } from './utils/importUtils';
import './index.css';

const SKILL_MAP: Record<string, { label: SkillLabel; classId: number }> = {
  '1': { label: 'toss', classId: 0 },
  '2': { label: 'serve', classId: 1 },
  '3': { label: 'reception', classId: 2 },
  '4': { label: 'set', classId: 3 },
  '5': { label: 'dig', classId: 4 },
  '6': { label: 'attack', classId: 5 } // Combined attack/block
};

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

type PredictionLike = { frame?: number | string; label?: string; skill?: string; class_id?: number; confidence?: number };
type PredictionImportPayload = {
  video_name?: string;
  predictions?: PredictionLike[];
  events?: PredictionLike[];
  rally?: { start_frame?: number | null; end_frame?: number | null };
  start_frame?: number;
  end_frame?: number;
};

const INFERENCE_API_BASE = import.meta.env.VITE_INFERENCE_API_BASE || 'http://localhost:8000';

function App() {
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [isRunningTouch, setIsRunningTouch] = useState(false);
  const [isRunningSkill5, setIsRunningSkill5] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ isRunning: false, completed: 0, total: 0, lastFps: 0, avgTimeSec: 0 });
  const [includeMp4InZip, setIncludeMp4InZip] = useState(false);
  const googleTokenRef = useRef<string | null>(null);
  
  const [state, setState] = useState<AppState>({
    playlist: [],
    currentPlaylistIndex: 0,
    videoMetadata: null,
    rally: { start_frame: null, end_frame: null },
    events: [],
    currentFrame: 0,
    playerBoxes: {},
    manualActions: [],
  });

  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [destinationFolderId, setDestinationFolderId] = useState<string | null>(null);
  const importPredictionsInputRef = useRef<HTMLInputElement>(null);
  const seekIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const stateRef = useRef(state);
  const processingRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const parsePredictionLabel = (rawLabel: unknown): { label: SkillLabel; classId: number } | null => {
    if (typeof rawLabel !== 'string') return null;
    const normalized = rawLabel.trim().toLowerCase();
    return LABEL_TO_SKILL[normalized] || null;
  };

  const parsePredictionsFile = (data: unknown): { events: AppState['events']; startFrame: number | null; endFrame: number | null } => {
    const payload = data as PredictionImportPayload;
    const candidates: PredictionLike[] = Array.isArray(payload?.predictions)
      ? payload.predictions
      : Array.isArray(payload?.events)
        ? payload.events
        : Array.isArray(data)
          ? (data as PredictionLike[])
          : [];

    const importedEvents = candidates
      .map((item) => {
        const rawFrame = item?.frame;
        const frame = typeof rawFrame === 'string' ? Number(rawFrame) : rawFrame;
        if (typeof frame !== 'number' || Number.isNaN(frame)) return null;

        const parsedFromLabel = parsePredictionLabel(item?.label ?? item?.skill);
        if (parsedFromLabel) {
          return {
            frame: Math.round(frame),
            skill: parsedFromLabel.label,
            class_id: parsedFromLabel.classId,
            confidence: item?.confidence ?? 1.0,
            source: 'auto' as const
          };
        }

        const classId = item?.class_id;
        if (typeof classId === 'number' && classId >= 0 && classId <= 5) {
          const match = Object.values(SKILL_MAP).find((s) => s.classId === classId);
          if (!match) return null;
          return {
            frame: Math.round(frame),
            skill: match.label,
            class_id: classId,
            confidence: item?.confidence ?? 1.0,
            source: 'auto' as const
          };
        }
        return null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const sortedUniqueEvents = Array.from(
      importedEvents
        .reduce((acc, event) => acc.set(event.frame, event), new Map<number, (typeof importedEvents)[number]>())
        .values()
    );

    // Apply Greedy NMS (window = 10)
    const nmsWindow = 10;
    const sortedByConf = [...sortedUniqueEvents].sort((a, b) => (b.confidence ?? 1.0) - (a.confidence ?? 1.0));
    const keptEvents: typeof sortedUniqueEvents = [];
    for (const ev of sortedByConf) {
      if (!keptEvents.some(k => Math.abs(k.frame - ev.frame) <= nmsWindow)) {
        keptEvents.push(ev);
      }
    }
    const finalEvents = keptEvents.sort((a, b) => a.frame - b.frame);
    const startFrame = payload?.rally?.start_frame ?? payload?.start_frame ?? null;
    const endFrame = payload?.rally?.end_frame ?? payload?.end_frame ?? null;
    
    console.log(`[parsePredictionsFile] Parsed ${finalEvents.length} events from payload.`);

    return {
      events: finalEvents,
      startFrame: typeof startFrame === 'number' ? startFrame : null,
      endFrame: typeof endFrame === 'number' ? endFrame : null,
    };
  };

  const applySkillHeuristics = (events: SkillEvent[]): SkillEvent[] => {
    if (events.length === 0) return events;

    let modified = JSON.parse(JSON.stringify(events)) as SkillEvent[];

    // Helper to update skill and its associated class_id
    const updateSkill = (event: SkillEvent, newSkill: string) => {
      event.skill = newSkill as SkillLabel;
      if (LABEL_TO_SKILL[newSkill]) {
        event.class_id = LABEL_TO_SKILL[newSkill].classId;
      }
    };

    // Rule 4: Remove consecutive duplicates of toss, serve, attack/block
    let i = 0;
    while (i < modified.length - 1) {
      const current = modified[i];
      const next = modified[i + 1];
      
      const isTargetSkill = ['toss', 'serve', 'attack', 'block'].includes(current.skill);
      
      if (current.skill === next.skill && isTargetSkill) {
        const conf1 = current.confidence ?? 1.0;
        const conf2 = next.confidence ?? 1.0;
        
        if (conf1 >= conf2) {
          modified.splice(i + 1, 1);
        } else {
          modified.splice(i, 1);
          continue; // check the new current element
        }
      } else {
        i++;
      }
    }

    for (let i = 0; i < modified.length; i++) {
      // 3-skill window (Rule 2 & 3)
      if (i <= modified.length - 3) {
        const e1 = modified[i];
        const e2 = modified[i+1];
        const e3 = modified[i+2];

        // Rule 3: toss -> serve -> set/dig becomes toss -> serve -> reception
        if (e1.skill === 'toss' && e2.skill === 'serve' && (e3.skill === 'set' || e3.skill === 'dig')) {
          updateSkill(e3, 'reception');
        }

        // Rule 2: reception/dig -> dig -> attack/block becomes reception/dig -> set -> attack/block
        if ((e1.skill === 'reception' || e1.skill === 'dig') && e2.skill === 'dig' && (e3.skill === 'attack' || e3.skill === 'block')) {
          updateSkill(e2, 'set');
        }
      }
      
      // 2-skill window (Rule 1)
      if (i <= modified.length - 2) {
        const e1 = modified[i];
        const e2 = modified[i+1];
        
        // Rule 1: reception -> dig becomes reception -> set
        if (e1.skill === 'reception' && e2.skill === 'dig') {
          updateSkill(e2, 'set');
        }
      }
    }

    return modified;
  };

  const applyImportedPredictions = (parsed: PredictionImportPayload, sourceName: string) => {
    const { events, startFrame, endFrame } = parsePredictionsFile(parsed);

    if (events.length === 0) {
      window.alert('No valid predictions found in JSON. Expected predictions: [{frame, label}]');
      return false;
    }

    setState((prev) => {
      const allEvents = [...prev.events, ...events];
      
      // Apply Greedy NMS (window = 10)
      const nmsWindow = 10;
      const sortedByConf = [...allEvents].sort((a, b) => (b.confidence ?? 1.0) - (a.confidence ?? 1.0));
      const keptEvents: AppState['events'] = [];
      
      for (const ev of sortedByConf) {
        if (!keptEvents.some(k => Math.abs(k.frame - ev.frame) <= nmsWindow)) {
          keptEvents.push(ev);
        }
      }
      
      const deduplicated = keptEvents.sort((a, b) => a.frame - b.frame);
      const heuristicallyCorrected = applySkillHeuristics(deduplicated);

      return {
        ...prev,
        events: heuristicallyCorrected,
        rally: {
          start_frame: startFrame ?? prev.rally.start_frame,
          end_frame: endFrame ?? prev.rally.end_frame,
        },
      };
    });

    window.alert(`Imported ${events.length} predictions from ${sourceName}`);
    return true;
  };

  const handleImportPredictions = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as PredictionImportPayload;
      applyImportedPredictions(parsed, file.name);
    } catch (err) {
      console.error('Failed to import predictions', err);
      window.alert('Failed to import predictions JSON. Please check the file format.');
    }
  };

  const inferSingleVideo = async (file: File) => {
    const formData = new FormData();
    formData.append('video', file);
    const res = await fetch(`${INFERENCE_API_BASE}/api/infer/skill5`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      throw new Error(`Inference failed (${res.status})`);
    }
    return await res.json();
  };

  const uploadToDrive = async (token: string, folderId: string | undefined, filename: string, blob: Blob, existingId?: string) => {
    let fileId = existingId;
    if (!fileId && folderId) {
      try {
        const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${filename}' and '${folderId}' in parents and trashed=false&fields=files(id)`;
        const res = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (data.files && data.files.length > 0) {
          fileId = data.files[0].id; // Use existing file instead of creating duplicate
        }
      } catch (err) {
        console.error('Failed to search Drive for existing file:', err);
      }
    }

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    let method = 'POST';
    const metadata: any = { name: filename };
    
    if (fileId) {
      url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`;
      method = 'PATCH';
    } else if (folderId) {
      metadata.parents = [folderId];
    }
    
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const uploadRes = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, body: form });
    const uploadData = await uploadRes.json();
    return uploadData.id as string;
  };

  useEffect(() => {
    if (batchProgress.isRunning && !processingRef.current) {
      processingRef.current = true;
      const processedIds = new Set<string>();

      const processNextRecursive = async () => {
        const currentPlaylist = stateRef.current.playlist;
        const nextIndex = currentPlaylist.findIndex(p => !p.isSkillAlgorithmApplied && !processedIds.has(p.id) && (p.file || p.driveUrl));
        
        if (nextIndex === -1) {
          processingRef.current = false;
          setBatchProgress(prev => ({ ...prev, isRunning: false }));
          
          // Automatically download the batch ZIP when finished!
          const annotated = currentPlaylist.filter(p => p.isSkillAlgorithmApplied);
          if (annotated.length > 0) {
            exportAllToZip(annotated, true, includeMp4InZip).then(blob => {
              if (blob && googleTokenRef.current) {
                const metadata = { name: `volleyball_annotations_batch_${Date.now()}.zip`, mimeType: 'application/zip' };
                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', blob);

                fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${googleTokenRef.current}` },
                  body: form
                })
                .then(res => {
                  if (res.ok) window.alert('Successfully uploaded batch annotations to Google Drive!');
                  else throw new Error('Upload failed');
                })
                .catch(err => {
                  console.error('Drive upload error:', err);
                  window.alert('Failed to upload to Google Drive. The file was still downloaded to your local machine.');
                });
              }
            });
          }
          return;
        }
      
        try {
          const item = currentPlaylist[nextIndex];
          processedIds.add(item.id);
          let fileToInfer = item.file;
          
          if (!fileToInfer && item.driveUrl) {
            const res = await fetch(item.driveUrl, { headers: { Authorization: `Bearer ${googleTokenRef.current}` } });
            const blob = await res.blob();
            fileToInfer = new File([blob], item.name, { type: 'video/mp4' });
          }
          
          const payload = await inferSingleVideo(fileToInfer!);
          const { events, startFrame, endFrame } = parsePredictionsFile(payload);
          
          const heuristicallyCorrected = applySkillHeuristics(events);
          console.log(`[batch] Original events: ${events.length}, Corrected events: ${heuristicallyCorrected.length}`);
          
          const updatedItem = {
            ...item,
            events: heuristicallyCorrected,
            rally: {
              start_frame: startFrame ?? item.rally?.start_frame ?? null,
              end_frame: endFrame ?? item.rally?.end_frame ?? null
            },
            isSkillAlgorithmApplied: true
          };

          setState(prev => {
            console.log(`[batch] setState callback. prev.currentPlaylistIndex=${prev.currentPlaylistIndex}, nextIndex=${nextIndex}`);
            const newPlaylist = [...prev.playlist];
            newPlaylist[nextIndex] = updatedItem;
            
            if (prev.currentPlaylistIndex === nextIndex) {
              console.log(`[batch] Updating main state events to length: ${heuristicallyCorrected.length}`);
              return {
                ...prev,
                playlist: newPlaylist,
                events: heuristicallyCorrected,
                rally: updatedItem.rally
              };
            }
            console.log(`[batch] NOT updating main state events! Mismatch index.`);
            return { ...prev, playlist: newPlaylist };
          });

          // Upload individual XML back to Google Drive
          if (googleTokenRef.current && (item.driveFolderId || item.driveXmlId)) {
            const xml = generateXMLString(
              item.videoMetadata || { filename: item.name, fps: 30, width: 0, height: 0, duration: 0, frame_count: 0 },
              updatedItem.rally,
              heuristicallyCorrected
            );
            const xmlBlob = new Blob([xml], { type: 'application/xml' });
            const xmlFilename = `annotations_${item.name.replace(/\.[^/.]+$/, '')}.xml`;

            uploadToDrive(googleTokenRef.current!, item.driveFolderId, xmlFilename, xmlBlob, item.driveXmlId)
              .then(xmlId => {
                if (xmlId) {
                  setState(prev => {
                    const np = [...prev.playlist];
                    np[nextIndex] = { ...np[nextIndex], driveXmlId: xmlId };
                    return { ...prev, playlist: np };
                  });
                }
              }).catch(console.error);

          }
          
          const fps = (payload as any).inference_fps || 0;
          const inferenceTime = (payload as any).inference_time_sec || 0;
          setBatchProgress(prev => {
             const newCompleted = prev.completed + 1;
             const newAvg = prev.avgTimeSec === 0 ? inferenceTime : ((prev.avgTimeSec * prev.completed) + inferenceTime) / newCompleted;
             return { ...prev, completed: newCompleted, lastFps: fps, avgTimeSec: newAvg };
          });
        } catch (err) {
          console.error('Batch inference failed for', currentPlaylist[nextIndex].name, err);
          window.alert(`Failed to apply algorithm to ${currentPlaylist[nextIndex].name}. Is your backend server running at ${INFERENCE_API_BASE}?`);
          processingRef.current = false;
          setBatchProgress(prev => ({ ...prev, isRunning: false }));
          return;
        }

        setTimeout(processNextRecursive, 0);
      };
      
      processNextRecursive();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchProgress.isRunning]);

  useEffect(() => {
    if (!batchProgress.isRunning && batchProgress.total > 0 && batchProgress.completed === batchProgress.total && state.playlist.length > 0 && !videoUrl) {
      const item = state.playlist[0];
      if (item.file) {
        setVideoUrl(URL.createObjectURL(item.file));
      } else if (item.driveUrl) {
        setVideoUrl(item.driveUrl);
      }
    }
  }, [batchProgress.isRunning, batchProgress.completed, batchProgress.total, state.playlist, videoUrl]);

  const runTouchModel = async () => {
    const item = state.playlist[state.currentPlaylistIndex];
    if (!item?.file) {
      window.alert('Touch inference currently supports local uploaded video files only.');
      return;
    }
    setIsRunningTouch(true);
    try {
      const formData = new FormData();
      formData.append('video', item.file);
      const res = await fetch(`${INFERENCE_API_BASE}/api/infer/touch`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `Touch inference failed (${res.status})`);
      }
      const payload = await res.json();
      const count = Array.isArray(payload?.touch_peaks) ? payload.touch_peaks.length : 0;
      window.alert(`Touch inference complete. Peaks detected: ${count}`);
    } catch (err) {
      console.error('Touch inference failed', err);
      window.alert(`Touch inference failed: ${(err as Error).message}`);
    } finally {
      setIsRunningTouch(false);
    }
  };

  const runSkill5Model = async () => {
    const item = state.playlist[state.currentPlaylistIndex];
    if (!item?.file) {
      window.alert('Skill inference currently supports local uploaded video files only.');
      return;
    }
    setIsRunningSkill5(true);
    try {
      const formData = new FormData();
      formData.append('video', item.file);
      const res = await fetch(`${INFERENCE_API_BASE}/api/infer/skill5`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `Skill inference failed (${res.status})`);
      }
      const payload = await res.json();
      applyImportedPredictions(payload, 'Skill5 Model');
    } catch (err) {
      console.error('Skill inference failed', err);
      window.alert(`Skill inference failed: ${(err as Error).message}`);
    } finally {
      setIsRunningSkill5(false);
    }
  };

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('volleyball_annotations');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.state) {
          // If we have a playlist, don't load the object URLs directly, just metadata
          setState({ 
            ...parsed.state, 
            currentFrame: parsed.state.currentFrame || 0,
            manualActions: parsed.state.manualActions || [] 
          });
        }
      } catch (e) {
        console.error("Failed to parse local storage", e);
      }
    }
  }, []);

  // Autosave
  useEffect(() => {
    console.log(`[DEBUG] state.events changed! Length: ${state.events.length}`);
    if (state.playlist.length > 0 || state.videoMetadata) {
      // Keep playlist in sync with current events before saving
      const currentPlaylist = [...state.playlist];
      if (currentPlaylist.length > 0 && currentPlaylist[state.currentPlaylistIndex]) {
        currentPlaylist[state.currentPlaylistIndex] = {
           ...currentPlaylist[state.currentPlaylistIndex],
           events: state.events,
           rally: state.rally,
           manualActions: state.manualActions,
           videoMetadata: state.videoMetadata,
           isCompleted: (state.rally.start_frame !== null && state.rally.end_frame !== null)
        };
      }

      // Don't save Object URLs, File objects, or large JSON data to localStorage
      const stateToSave = {
        ...state,
        playerBoxes: {}, // Exclude from autosave
        playlist: currentPlaylist.map(item => ({ 
          ...item, 
          file: undefined,
          rawJsonString: undefined, // Exclude from autosave
          playerBoxes: undefined, // Exclude from autosave
        }))
      };
      localStorage.setItem('volleyball_annotations', JSON.stringify({ state: stateToSave }));
    }
  }, [state]);

  const loadVideoIntoPlayer = (item: PlaylistItem) => {
    if (item.file) {
      const url = URL.createObjectURL(item.file);
      setVideoUrl(url);
    } else if (item.driveUrl) {
      if (googleTokenRef.current) {
        // Appending the access token allows the <video> element to authenticate
        setVideoUrl(`${item.driveUrl}&access_token=${googleTokenRef.current}`);
      } else {
        setVideoUrl(item.driveUrl);
      }
    }

    setState(prev => ({
      ...prev,
      videoMetadata: item.videoMetadata || {
        filename: item.name,
        fps: 30, // Default
        width: 0,
        height: 0,
        duration: 0,
        frame_count: 0
      },
      rally: item.rally || { start_frame: null, end_frame: null },
      events: item.events || [],
      playerBoxes: item.playerBoxes || {},
      manualActions: item.manualActions || [],
      currentFrame: 0
    }));
  };

  const handlePlaylistFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const fileArray = Array.from(files);
    const videoFiles = fileArray.filter(f => f.type.startsWith('video/') || f.name.toLowerCase().endsWith('.mp4'));
    const zipFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.zip'));
    const jsonFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.json'));
    
    let parsedAnnotations: Record<string, any> = {};
    let parsedJsonAnnotations: Record<string, any> = {};
    let extractedVideos: File[] = [];
    if (zipFiles.length > 0) {
      try {
        const result = await parseZIPAnnotations(zipFiles[0]);
        parsedAnnotations = result.annotations;
        parsedJsonAnnotations = result.jsonAnnotations || {};
        extractedVideos = result.videos;
        console.log(`Loaded annotations for ${Object.keys(parsedAnnotations).length} videos from ZIP.`);
        console.log(`Extracted ${extractedVideos.length} videos from ZIP.`);
      } catch (e) {
        console.error("Error parsing ZIP", e);
        window.alert("Failed to read the ZIP file. It may be too large or corrupted.");
      }
    }

    for (const jsonFile of jsonFiles) {
      try {
        const text = await jsonFile.text();
        const result = parseJSONAnnotations(text, []);
        const stem = jsonFile.name.replace(/\.json$/i, '');
        parsedJsonAnnotations[stem] = result;
      } catch (err) {
        console.error(`Failed to parse standalone JSON: ${jsonFile.name}`, err);
      }
    }

    const allVideoFiles = [...videoFiles, ...extractedVideos];

    if (allVideoFiles.length === 0) {
      window.alert("No video files found! Please upload MP4 videos along with your ZIP file, or ensure your ZIP contains MP4s.");
      return;
    }

    const newPlaylistItems: PlaylistItem[] = allVideoFiles.map(file => {
      const existing = stateRef.current.playlist.find(p => p.name === file.name);
      
      let itemEvents = existing?.events || [];
      let itemRally = existing?.rally || { start_frame: null, end_frame: null };
      let isApplied = existing?.isSkillAlgorithmApplied || false;
      let itemPlayerBoxes = existing?.playerBoxes || {};
      let itemRawJson = existing?.rawJsonString || undefined;
      let itemManualActions = existing?.manualActions || [];

      // Failsafe: if the app claims the algorithm was applied but there are no events, 
      // it was likely stuck in a bugged state from a previous session. Reset it.
      if (isApplied && itemEvents.length === 0) {
        isApplied = false;
      }

      const stem = file.name.replace(/\.[^/.]+$/, '');
      if (parsedAnnotations[stem]) {
        // Only use ZIP annotations if we don't have autosaved progress for this video,
        // or if the autosaved progress is completely empty.
        // This prevents overwriting the user's manual corrections when they re-upload the ZIP.
        if (!existing || (!existing.isSkillAlgorithmApplied && (!existing.events || existing.events.length === 0))) {
          itemEvents = parsedAnnotations[stem].events;
          itemRally = parsedAnnotations[stem].rally;
          isApplied = true;
        }
      }
      
      let jsonKey = stem;
      if (!parsedJsonAnnotations[jsonKey]) {
        // Try fuzzy matching: check if any json key starts with the video stem case-insensitively
        const lowerStem = stem.toLowerCase();
        const possibleKey = Object.keys(parsedJsonAnnotations).find(k => {
          const lowerK = k.toLowerCase();
          return lowerK.startsWith(lowerStem) || lowerStem.startsWith(lowerK);
        });
        if (possibleKey) jsonKey = possibleKey;
      }
      
      if (parsedJsonAnnotations[jsonKey]) {
        // If there are existing manual actions for this video, we re-parse to apply them
        const parsedResult = itemManualActions.length > 0 
          ? parseJSONAnnotations(parsedJsonAnnotations[jsonKey].rawJsonString, itemManualActions)
          : parsedJsonAnnotations[jsonKey];
          
        itemPlayerBoxes = parsedResult.parsed;
        itemRawJson = parsedResult.rawJsonString;
        // Do NOT set isApplied = true here, because we still want to run the skill inference algorithm on the backend!
      }

      return {
        id: file.name + file.lastModified,
        name: file.name,
        file: file,
        events: itemEvents,
        rally: itemRally,
        playerBoxes: itemPlayerBoxes,
        rawJsonString: itemRawJson,
        manualActions: itemManualActions,
        isSkillAlgorithmApplied: isApplied,
        videoMetadata: existing?.videoMetadata || null,
        isCompleted: existing?.isCompleted || false,
        driveFolderId: destinationFolderId || undefined
      };
    });

    const total = newPlaylistItems.length;
    const completed = newPlaylistItems.filter(p => p.isSkillAlgorithmApplied).length;
    
    if (total > 0) {
      setBatchProgress({
        isRunning: completed < total,
        completed,
        total,
        lastFps: 0,
        avgTimeSec: 0
      });
    }

    if (completed === total && total > 0) {
      const item = newPlaylistItems[0];
      if (item.file) {
        const url = URL.createObjectURL(item.file);
        setVideoUrl(url);
      }
      
      const isRestoring = stateRef.current.videoMetadata?.filename === item.name;
      const savedFrame = isRestoring ? stateRef.current.currentFrame : 0;
      
      setState(prev => ({
        ...prev,
        playlist: newPlaylistItems,
        currentPlaylistIndex: 0,
        videoMetadata: item.videoMetadata || { filename: item.name, fps: 30, width: 0, height: 0, duration: 0, frame_count: 0 },
        rally: item.rally || { start_frame: null, end_frame: null },
        events: item.events || [],
        playerBoxes: item.playerBoxes || {},
        currentFrame: savedFrame
      }));
    } else {
      const item = newPlaylistItems[0];
      const isRestoring = stateRef.current.videoMetadata?.filename === item.name;
      const savedFrame = isRestoring ? stateRef.current.currentFrame : 0;
      
      setState(prev => ({
        ...prev,
        playlist: newPlaylistItems,
        currentPlaylistIndex: 0,
        videoMetadata: item.videoMetadata || { filename: item.name, fps: 30, width: 0, height: 0, duration: 0, frame_count: 0 },
        rally: item.rally || { start_frame: null, end_frame: null },
        events: item.events || [],
        playerBoxes: item.playerBoxes || {},
        currentFrame: savedFrame
      }));
    }
  };

  const handleDrivePlaylist = async (playlist: PlaylistItem[]) => {
    setState(prev => ({ ...prev, playlist, currentPlaylistIndex: 0 }));

    let finalPlaylist = playlist;
    if (googleTokenRef.current) {
      const updatedPlaylist = [...playlist];
      let hasUpdates = false;

      for (let i = 0; i < updatedPlaylist.length; i++) {
        const item = updatedPlaylist[i];
        if (item.driveXmlId) {
          try {
            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${item.driveXmlId}?alt=media`, {
              headers: { Authorization: `Bearer ${googleTokenRef.current}` }
            });
            if (res.ok) {
              const xmlText = await res.text();
              const parsed = parseXMLAnnotations(xmlText);
              updatedPlaylist[i] = {
                ...item,
                events: parsed.events,
                rally: parsed.rally,
                isSkillAlgorithmApplied: true
              };
              hasUpdates = true;
            }
          } catch (e) {
            console.error('Failed to fetch XML for', item.name, e);
          }
        }
      }

      if (hasUpdates) {
        finalPlaylist = updatedPlaylist;
        setState(prev => ({ ...prev, playlist: finalPlaylist }));
        if (finalPlaylist.length > 0) {
          // reload the first one in case it was updated
          setState(prev => ({
            ...prev,
            events: finalPlaylist[0].events || [],
            rally: finalPlaylist[0].rally || { start_frame: null, end_frame: null }
          }));
        }
      }
    }

    const total = finalPlaylist.length;
    const completed = finalPlaylist.filter(p => p.isSkillAlgorithmApplied).length;
    if (total > 0) {
      if (completed < total) {
        setBatchProgress({
          isRunning: true,
          completed,
          total,
          lastFps: 0,
          avgTimeSec: 0
        });
      } else {
        loadVideoIntoPlayer(finalPlaylist[0]);
      }
    }
  };

  const saveCurrentVideoState = () => {
    setState(prev => {
      const newPlaylist = [...prev.playlist];
      if (prev.playlist.length > 0) {
        newPlaylist[prev.currentPlaylistIndex] = {
          ...newPlaylist[prev.currentPlaylistIndex],
          videoMetadata: prev.videoMetadata,
          rally: prev.rally,
          events: prev.events,
          manualActions: prev.manualActions,
          isCompleted: (prev.rally.start_frame !== null && prev.rally.end_frame !== null)
        };
      }
      return { ...prev, playlist: newPlaylist };
    });
  };

  const changeVideo = (index: number) => {
    if (index >= 0 && index < state.playlist.length) {
      saveCurrentVideoState();
      
      setState(prev => ({
        ...prev,
        currentPlaylistIndex: index
      }));
      
      setTimeout(() => {
        setState(prev => {
          loadVideoIntoPlayer(prev.playlist[index]);
          return prev;
        });
      }, 0);
    }
  };

  const handleVideoLoaded = () => {
    if (videoRef.current && state.videoMetadata) {
      const v = videoRef.current;
      const duration = v.duration;
      // If we don't have valid duration yet
      if (isNaN(duration)) return;
      
      const fps = state.videoMetadata.fps;
      
      if (state.currentFrame > 0) {
        v.currentTime = state.currentFrame / fps;
      }
      
      setState(prev => ({
        ...prev,
        videoMetadata: {
          ...prev.videoMetadata!,
          width: v.videoWidth,
          height: v.videoHeight,
          duration: duration,
          frame_count: Math.floor(duration * fps)
        }
      }));
    }
  };

  const seekToFrame = useCallback((frame: number) => {
    if (!videoRef.current || !state.videoMetadata) return;
    const maxFrame = state.videoMetadata.frame_count - 1;
    const safeFrame = Math.max(0, Math.min(frame, maxFrame));
    
    const time = safeFrame / state.videoMetadata.fps;
    videoRef.current.currentTime = time;
    setState(prev => ({ ...prev, currentFrame: safeFrame }));
  }, [state.videoMetadata]);

  const startContinuousSeek = (delta: number) => {
    // Initial jump
    seekToFrame(state.currentFrame + delta);
    
    seekIntervalRef.current = setInterval(() => {
      if (!videoRef.current || !state.videoMetadata) return;
      const currentActualFrame = Math.round(videoRef.current.currentTime * state.videoMetadata.fps);
      seekToFrame(currentActualFrame + delta);
    }, 100);
  };

  const stopContinuousSeek = () => {
    if (seekIntervalRef.current) {
      clearInterval(seekIntervalRef.current);
      seekIntervalRef.current = null;
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current || !state.videoMetadata) return;
    const frame = Math.round(videoRef.current.currentTime * state.videoMetadata.fps);
    if (frame !== state.currentFrame) {
      setState(prev => ({ ...prev, currentFrame: frame }));
    }
  };

  const addEvent = (skillInfo: { label: SkillLabel; classId: number }) => {
    setState(prev => {
      const filtered = prev.events.filter(e => e.frame !== prev.currentFrame);
      return {
        ...prev,
        events: [...filtered, { frame: prev.currentFrame, skill: skillInfo.label, class_id: skillInfo.classId, source: 'manual' as const }]
      };
    });
  };

  const setRallyBound = (type: 'start' | 'end') => {
    setState(prev => ({
      ...prev,
      rally: {
        ...prev.rally,
        [type === 'start' ? 'start_frame' : 'end_frame']: prev.currentFrame
      }
    }));
  };

  const deleteCurrentFrameData = () => {
    setState(prev => {
      const isStart = prev.rally.start_frame === prev.currentFrame;
      const isEnd = prev.rally.end_frame === prev.currentFrame;
      
      return {
        ...prev,
        rally: {
          start_frame: isStart ? null : prev.rally.start_frame,
          end_frame: isEnd ? null : prev.rally.end_frame,
        },
        events: prev.events.filter(e => e.frame !== prev.currentFrame)
      };
    });
  };

  const handleAssignPlayer = (frame: number, trackId: number) => {
    setState(prev => {
      const currentActions = prev.manualActions || [];
      const filtered = currentActions.filter(m => !(m.frame === frame && m.track_id === trackId));
      const newActions = [...filtered, { frame, track_id: trackId }];
      
      // Re-parse the playerBoxes with the new actions
      const playlistItem = prev.playlist[prev.currentPlaylistIndex];
      let newBoxes = prev.playerBoxes;
      if (playlistItem?.rawJsonString) {
        const res = parseJSONAnnotations(playlistItem.rawJsonString, newActions);
        newBoxes = res.parsed;
      }
      
      // Update the event's player_id if there is an event at this frame
      const newEvents = prev.events.map(ev => {
        if (ev.frame === frame) {
          return { ...ev, player_id: trackId };
        }
        return ev;
      });
      
      return {
        ...prev,
        manualActions: newActions,
        playerBoxes: newBoxes,
        events: newEvents
      };
    });
    
    // Clear the selection so the green active highlight becomes visible
    setSelectedTrackId(null);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      const key = e.key.toLowerCase();
      
      if (['1', '2', '3', '4', '5', '6'].includes(key)) {
        const skillMap: Record<string, { label: SkillLabel; classId: number }> = {
          '1': { label: 'toss', classId: 0 },
          '2': { label: 'serve', classId: 1 },
          '3': { label: 'reception', classId: 2 },
          '4': { label: 'set', classId: 3 },
          '5': { label: 'dig', classId: 4 },
          '6': { label: 'attack', classId: 5 } // Using attack for both attack/block in UI
        };
        addEvent(skillMap[key]);
        e.preventDefault();
      } else if (key === 's') {
        setRallyBound('start');
        e.preventDefault();
      } else if (key === 'e') {
        setRallyBound('end');
        e.preventDefault();
      } else if (key === 'delete' || key === 'backspace') {
        deleteCurrentFrameData();
        e.preventDefault();
      } else if (key === 'a') {
        if (selectedTrackId !== null) {
          handleAssignPlayer(state.currentFrame, selectedTrackId);
        } else {
          window.alert("Please click on a player's bounding box first to select them, then press 'A'.");
        }
        e.preventDefault();
      } else if (key === 'arrowleft') {
        seekToFrame(state.currentFrame - 1);
        e.preventDefault();
      } else if (key === 'arrowright') {
        seekToFrame(state.currentFrame + 1);
        e.preventDefault();
      } else if (key === ' ') {
        if (videoRef.current) {
          if (videoRef.current.paused) videoRef.current.play();
          else videoRef.current.pause();
        }
        e.preventDefault();
      } else if (key === '<' || key === ',') {
        seekToFrame(state.currentFrame - 1);
        e.preventDefault();
      } else if (key === '>' || key === '.') {
        seekToFrame(state.currentFrame + 1);
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.currentFrame, seekToFrame, selectedTrackId]);

  const getValidationWarnings = () => {
    const warnings: { type: string, msg: string }[] = [];
    if (!state.videoMetadata) return warnings;

    if (state.rally.start_frame !== null && state.rally.end_frame !== null) {
      if (state.rally.end_frame < state.rally.start_frame) {
        warnings.push({ type: 'error', msg: 'end_rally is before start_rally' });
      }
    }
    
    return warnings;
  };

  const warnings = getValidationWarnings();

  // Calculate active frame ranges from the JSON data
  const activeRanges = useMemo(() => {
    if (!state.playerBoxes) return [];
    
    // Group active frames by track_id
    const trackActiveFrames: Record<number, number[]> = {};
    
    Object.keys(state.playerBoxes).forEach(frameStr => {
      const frame = parseInt(frameStr, 10);
      const boxes = state.playerBoxes[frame];
      if (boxes) {
        boxes.forEach(box => {
          if (box.is_active) {
            if (!trackActiveFrames[box.track_id]) trackActiveFrames[box.track_id] = [];
            trackActiveFrames[box.track_id].push(frame);
          }
        });
      }
    });
    
    // Convert to contiguous ranges
    const ranges: { trackId: number, start: number, end: number }[] = [];
    
    Object.entries(trackActiveFrames).forEach(([trackIdStr, frames]) => {
      const trackId = parseInt(trackIdStr, 10);
      frames.sort((a, b) => a - b);
      
      if (frames.length === 0) return;
      
      let currentStart = frames[0];
      let currentEnd = frames[0];
      
      for (let i = 1; i < frames.length; i++) {
        const frame = frames[i];
        if (frame === currentEnd + 1) {
          currentEnd = frame;
        } else {
          ranges.push({ trackId, start: currentStart, end: currentEnd });
          currentStart = frame;
          currentEnd = frame;
        }
      }
      ranges.push({ trackId, start: currentStart, end: currentEnd });
    });
    
    // Sort by start frame
    return ranges.sort((a, b) => a.start - b.start);
  }, [state.playerBoxes]);

  if (!videoUrl) {
    if (batchProgress.total > 0 && batchProgress.isRunning) {
      return (
        <div className="landing-container">
          <div className="landing-card" style={{ maxWidth: '600px', width: '100%' }}>
            <h1 className="landing-title">Applying Skill Algorithm...</h1>
            <p className="landing-subtitle">
              Processing video {Math.min(batchProgress.completed + 1, batchProgress.total)} of {batchProgress.total}
              {batchProgress.avgTimeSec > 0 ? (
                <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)' }}>
                  ETA: {Math.floor((batchProgress.avgTimeSec * (batchProgress.total - batchProgress.completed)) / 60)}m {Math.round((batchProgress.avgTimeSec * (batchProgress.total - batchProgress.completed)) % 60)}s
                </span>
              ) : (
                <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)' }}>
                  Calculating ETA...
                </span>
              )}
            </p>
            <div style={{ width: '100%', height: '12px', background: 'rgba(255,255,255,0.1)', borderRadius: '6px', overflow: 'hidden', marginTop: '2rem' }}>
              <div style={{ width: `${(batchProgress.completed / batchProgress.total) * 100}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.3s ease' }} />
            </div>
            <p style={{ textAlign: 'center', marginTop: '1rem', color: 'rgba(255,255,255,0.7)' }}>
              {Math.round((batchProgress.completed / batchProgress.total) * 100)}% Complete
              {batchProgress.lastFps > 0 ? (
                <span style={{ marginLeft: '15px', color: '#4ade80' }}>({batchProgress.lastFps} FPS)</span>
              ) : (
                <span style={{ marginLeft: '15px', color: '#4ade80' }}>(Calculating FPS...)</span>
              )}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="landing-container">
        <div className="landing-card">
          <h1 className="landing-title">Volleyball Annotator Pro</h1>
          <p className="landing-subtitle">
            Advanced skill tracking and batch processing pipeline.<br/>
            Load individual rallies or entire match datasets to begin.
          </p>
          
          <div className="landing-grid">
            <label 
              className="landing-option"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void handlePlaylistFiles(e.dataTransfer.files); }}
            >
              <div className="icon-wrapper">
                <Upload size={32} />
              </div>
              <h3>1. Local Files (No Sync)</h3>
              <p>Drag & drop MP4, ZIP, or JSON files</p>
              <input type="file" accept="video/mp4,application/zip,.zip,application/json,.json" multiple onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
            </label>

            <div className="landing-option">
              <div className="icon-wrapper">
                <FolderArchive size={32} />
              </div>
              <h3 style={{ marginBottom: '1rem' }}>2. Process Local & Sync</h3>
              <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', marginBottom: '1rem' }}>Process local videos and automatically upload only XMLs to Google Drive.</p>
              {!destinationFolderId ? (
                <GoogleDriveConnector mode="destination" onDestinationSelected={(id) => setDestinationFolderId(id)} onTokenReceived={(t) => { googleTokenRef.current = t; }} buttonText="Select Destination Folder" />
              ) : (
                <label className="btn" style={{ width: '100%', cursor: 'pointer', textAlign: 'center', display: 'block', backgroundColor: 'var(--primary)' }}>
                  Now Select Local Videos
                  <input type="file" accept="video/mp4,application/json,.json" multiple onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
                </label>
              )}
            </div>

            <div className="landing-option">
              <div className="icon-wrapper">
                <FolderArchive size={32} />
              </div>
              <h3 style={{ marginBottom: '1rem' }}>3. Cloud Load</h3>
              <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', marginBottom: '1rem' }}>Load and process from a Google Drive folder.</p>
              <GoogleDriveConnector onPlaylistLoaded={handleDrivePlaylist} onTokenReceived={(t) => { googleTokenRef.current = t; window.alert('Google Drive connected!'); }} buttonText="Select Cloud Folder" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* PLAYLIST SIDEBAR */}
      <div className="sidebar" style={{ minWidth: '200px', maxWidth: '250px' }}>
        <div className="glass-panel sidebar-section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>Playlist ({state.currentPlaylistIndex + 1}/{state.playlist.length})</h2>
            <button 
              className="btn outline icon-only" 
              onClick={() => {
                setState({ playlist: [], currentPlaylistIndex: 0, videoMetadata: null, rally: { start_frame: null, end_frame: null }, events: [], currentFrame: 0, playerBoxes: {}, manualActions: [] });
                setVideoUrl('');
                setBatchProgress({ isRunning: false, completed: 0, total: 0, lastFps: 0, avgTimeSec: 0 });
              }}
              title="Return to Home"
            >
              Home
            </button>
          </div>
          
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
            {state.playlist.map((item, index) => (
              <div 
                key={item.id} 
                onClick={() => changeVideo(index)}
                style={{ 
                  padding: '0.5rem', 
                  backgroundColor: index === state.currentPlaylistIndex ? 'var(--primary-dark)' : 'rgba(255,255,255,0.05)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
              >
                <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </div>
                {item.isCompleted && <CheckCircle size={14} color="var(--color-serve)" />}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', cursor: 'pointer', color: 'rgba(255,255,255,0.7)' }}>
              <input 
                type="checkbox" 
                checked={includeMp4InZip} 
                onChange={(e) => setIncludeMp4InZip(e.target.checked)} 
                style={{ cursor: 'pointer' }}
              />
              Include MP4s in ZIP (May freeze browser for large batches)
            </label>
            <button 
              className="btn" 
              onClick={() => {
                saveCurrentVideoState(); // Save current before exporting
                
                // Construct the updated playlist immediately to ensure the ZIP has the latest manual edits
                // for the currently viewed video, because setState is asynchronous.
                const updatedPlaylist = [...state.playlist];
                if (updatedPlaylist[state.currentPlaylistIndex]) {
                  updatedPlaylist[state.currentPlaylistIndex] = {
                    ...updatedPlaylist[state.currentPlaylistIndex],
                    rally: state.rally,
                    events: state.events,
                  };
                }
                
                exportAllToZip(updatedPlaylist, true, includeMp4InZip);
              }}
            >
              <Download size={16} /> Batch ZIP
            </button>

            {state.playlist[state.currentPlaylistIndex]?.rawJsonString && (
              <button 
                className="btn" 
                style={{ backgroundColor: 'var(--color-serve)', marginTop: '0.5rem' }}
                onClick={() => {
                  const item = state.playlist[state.currentPlaylistIndex];
                  if (item?.rawJsonString) {
                    exportUpdatedJSON(item.rawJsonString, state.manualActions, item.name, includeMp4InZip, item.file);
                  }
                }}
              >
                <Download size={16} /> Download JSON
              </button>
            )}
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="main-content">
        <div className="glass-panel video-wrapper" style={{ position: 'relative' }}>
          <video 
            ref={videoRef} 
            src={videoUrl} 
            onLoadedMetadata={handleVideoLoaded}
            onTimeUpdate={handleTimeUpdate}
            controls={false}
            crossOrigin="anonymous" // Needed for Drive URLs if they support it
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
          {state.videoMetadata && state.playerBoxes && state.playerBoxes[state.currentFrame] && (
            <svg 
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }}
              viewBox={`0 0 ${state.videoMetadata.width || 1280} ${state.videoMetadata.height || 720}`}
              preserveAspectRatio="xMidYMid meet"
            >
              {state.playerBoxes[state.currentFrame].map((box, idx) => {
                const isSelected = selectedTrackId === box.track_id;
                const color = box.is_active ? '#4ade80' : '#ef4444';
                return (
                  <g 
                    key={idx} 
                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    onClick={() => setSelectedTrackId(box.track_id)}
                  >
                    {/* Invisible larger rect to make clicking easier */}
                    <rect 
                      x={box.x_min - 10} 
                      y={box.y_min - 10} 
                      width={(box.x_max - box.x_min) + 20} 
                      height={(box.y_max - box.y_min) + 20} 
                      fill="transparent" 
                    />
                    <rect 
                      x={box.x_min} 
                      y={box.y_min} 
                      width={box.x_max - box.x_min} 
                      height={box.y_max - box.y_min} 
                      fill={isSelected ? 'rgba(255,255,255,0.2)' : 'none'} 
                      stroke={isSelected ? '#fff' : color} 
                      strokeWidth={isSelected ? "6" : "4"} 
                    />
                    <rect 
                      x={box.x_min - 2} 
                      y={box.y_min - 22} 
                      width="50" 
                      height="22" 
                      fill={isSelected ? '#fff' : color} 
                    />
                    <text 
                      x={box.x_min + 4} 
                      y={box.y_min - 6} 
                      fill={isSelected ? '#000' : '#fff'} 
                      fontSize="14" 
                      fontWeight="bold"
                    >
                      ID: {box.track_id}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
          {(() => {
            const activeEvent = state.events.find(e => e.frame === state.currentFrame);
            if (activeEvent) {
              return (
                <div style={{
                  position: 'absolute',
                  top: '20px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  padding: '8px 24px',
                  borderRadius: '8px',
                  fontSize: '2rem',
                  fontWeight: 'bold',
                  textTransform: 'uppercase',
                  backgroundColor: `var(--color-${activeEvent.skill})`,
                  color: '#fff',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                  zIndex: 10,
                  pointerEvents: 'none',
                  letterSpacing: '2px',
                  textShadow: '0 2px 4px rgba(0,0,0,0.3)'
                }}>
                  {activeEvent.skill}
                </div>
              );
            }
            return null;
          })()}
        </div>

        <div className="glass-panel video-controls">
          <div className="controls-row">
            <button 
              className="btn outline icon-only" 
              onMouseDown={() => startContinuousSeek(-5)}
              onMouseUp={stopContinuousSeek}
              onMouseLeave={stopContinuousSeek}
              onTouchStart={() => startContinuousSeek(-5)}
              onTouchEnd={stopContinuousSeek}
            >-5f</button>
            <button 
              className="btn outline icon-only" 
              onMouseDown={() => startContinuousSeek(-1)}
              onMouseUp={stopContinuousSeek}
              onMouseLeave={stopContinuousSeek}
              onTouchStart={() => startContinuousSeek(-1)}
              onTouchEnd={stopContinuousSeek}
            >-1f</button>
            <button className="btn" onClick={() => {
              if (videoRef.current?.paused) videoRef.current.play();
              else videoRef.current?.pause();
            }}>
              Play / Pause
            </button>
            <button 
              className="btn outline icon-only" 
              onMouseDown={() => startContinuousSeek(1)}
              onMouseUp={stopContinuousSeek}
              onMouseLeave={stopContinuousSeek}
              onTouchStart={() => startContinuousSeek(1)}
              onTouchEnd={stopContinuousSeek}
            >+1f</button>
            <button 
              className="btn outline icon-only" 
              onMouseDown={() => startContinuousSeek(5)}
              onMouseUp={stopContinuousSeek}
              onMouseLeave={stopContinuousSeek}
              onTouchStart={() => startContinuousSeek(5)}
              onTouchEnd={stopContinuousSeek}
            >+5f</button>
            
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ fontFamily: 'monospace', fontSize: '1.2rem' }}>
                Frame: {state.currentFrame} / {state.videoMetadata?.frame_count || 0}
              </div>
              <button 
                className="btn outline icon-only" 
                onClick={() => changeVideo(state.currentPlaylistIndex - 1)}
                disabled={state.currentPlaylistIndex === 0}
                title="Previous Video"
              >
                <ArrowLeft size={16} />
              </button>
              <button 
                className="btn outline icon-only" 
                onClick={() => changeVideo(state.currentPlaylistIndex + 1)}
                disabled={state.currentPlaylistIndex === state.playlist.length - 1}
                title="Next Video"
              >
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
          
          <div className="scrub-bar-container" onClick={(e) => {
            if (!state.videoMetadata) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            seekToFrame(Math.round(percent * state.videoMetadata.frame_count));
          }}>
            <div className="scrub-bar-track">
              {state.videoMetadata && (
                <div 
                  className="scrub-bar-fill" 
                  style={{ width: `${(state.currentFrame / state.videoMetadata.frame_count) * 100}%` }}
                />
              )}
              {state.videoMetadata && (
                <div 
                  className="scrub-bar-thumb" 
                  style={{ left: `${(state.currentFrame / state.videoMetadata.frame_count) * 100}%` }}
                />
              )}
            </div>
          </div>
        </div>

        {/* TIMELINE */}
        <div className="glass-panel timeline" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.8rem' }}>
          <div className="timeline-track" style={{ position: 'relative', width: '100%', height: '30px' }}>
            {state.rally.start_frame !== null && state.videoMetadata && (
              <div 
                className="timeline-marker" 
                style={{ left: `${(state.rally.start_frame / state.videoMetadata.frame_count) * 100}%`, backgroundColor: 'var(--color-rally)', height: '100%', top: 0 }}
                title="Start Rally"
                onClick={() => seekToFrame(state.rally.start_frame!)}
              />
            )}
            {state.rally.end_frame !== null && state.videoMetadata && (
              <div 
                className="timeline-marker" 
                style={{ left: `${(state.rally.end_frame / state.videoMetadata.frame_count) * 100}%`, backgroundColor: 'var(--color-rally)', height: '100%', top: 0 }}
                title="End Rally"
                onClick={() => seekToFrame(state.rally.end_frame!)}
              />
            )}
            
            {/* Active window blocks on the timeline */}
            {state.videoMetadata && activeRanges.map((range, idx) => {
              const startPct = (range.start / state.videoMetadata!.frame_count) * 100;
              const widthPct = ((range.end - range.start) / state.videoMetadata!.frame_count) * 100;
              return (
                <div
                  key={`active-win-${idx}`}
                  style={{
                    position: 'absolute',
                    left: `${startPct}%`,
                    width: `${Math.max(widthPct, 0.2)}%`,
                    height: '100%',
                    backgroundColor: 'rgba(74, 222, 128, 0.3)',
                    borderLeft: '1px solid #4ade80',
                    borderRight: '1px solid #4ade80',
                    top: 0,
                    cursor: 'pointer',
                    zIndex: 1
                  }}
                  title={`Player ${range.trackId} active: ${range.start} to ${range.end}`}
                  onClick={() => seekToFrame(range.start)}
                />
              )
            })}

            {state.videoMetadata && state.events.map(event => {
              const skillName = (event.skill || (event as any).label || '').toString();
              const abbreviation = {
                'toss': 'T',
                'serve': 'Sr',
                'reception': 'R',
                'set': 'St',
                'dig': 'D',
                'attack': 'A',
                'block': 'B'
              }[skillName] || (skillName ? skillName.charAt(0).toUpperCase() : '?');

              return (
                <div 
                  key={event.frame}
                  className="timeline-skill-marker" 
                  style={{ 
                    left: `${state.videoMetadata!.frame_count > 0 ? (event.frame / state.videoMetadata!.frame_count) * 100 : 0}%`, 
                    backgroundColor: `var(--color-${skillName})`, 
                    zIndex: 2 
                  }}
                  title={`${skillName} at frame ${event.frame}`}
                  onClick={() => seekToFrame(event.frame)}
                >
                  {abbreviation}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.85rem', maxHeight: '150px', overflowY: 'auto', paddingRight: '4px' }}>
            {activeRanges.length === 0 && <span style={{ color: '#64748b' }}>No active players...</span>}
            {activeRanges.map((range, idx) => (
              <div 
                key={idx} 
                style={{ 
                  background: 'rgba(74, 222, 128, 0.15)', 
                  border: '1px solid rgba(74, 222, 128, 0.4)', 
                  padding: '4px 10px', 
                  borderRadius: '6px', 
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(74, 222, 128, 0.3)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(74, 222, 128, 0.15)'}
                onClick={() => seekToFrame(range.start)}
                title="Click to jump to this action"
              >
                <strong style={{ color: '#4ade80' }}>Player {range.trackId}:</strong> {range.start} - {range.end}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT SIDEBAR */}
      <div className="sidebar">
        <div className="glass-panel sidebar-section">
          <h2><FileVideo size={20} /> Video Info</h2>
          <div style={{ fontSize: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div><strong>File:</strong> {state.videoMetadata?.filename}</div>
            <div><strong>Resolution:</strong> {state.videoMetadata?.width}x{state.videoMetadata?.height}</div>
            <div>
              <strong>FPS:</strong> 
              <input 
                type="number" 
                value={state.videoMetadata?.fps || 30} 
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (val > 0) {
                    setState(prev => ({
                      ...prev, 
                      videoMetadata: { ...prev.videoMetadata!, fps: val, frame_count: Math.floor((prev.videoMetadata?.duration || 0) * val) }
                    }));
                  }
                }}
                style={{ marginLeft: '0.5rem', width: '60px', background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white', padding: '0.2rem', borderRadius: '4px' }}
              />
            </div>
          </div>
        </div>

        <div className="glass-panel sidebar-section">
          <h2><Settings size={20} /> Hotkeys</h2>
          <div className="hotkey-legend">
            <div><span className="hotkey">1</span> Toss</div>
            <div><span className="hotkey">2</span> Serve</div>
            <div><span className="hotkey">3</span> Reception</div>
            <div><span className="hotkey">4</span> Set</div>
            <div><span className="hotkey">5</span> Dig</div>
            <div><span className="hotkey">6</span> Attack/Block</div>
            <div><span className="hotkey">S</span> Start Rally</div>
            <div><span className="hotkey">E</span> End Rally</div>
            <div><span className="hotkey">A</span> Active Player</div>
            <div><span className="hotkey">Del</span> Clear Frame</div>
          </div>
        </div>

        <div className="glass-panel sidebar-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <h2 style={{color: 'red'}}>Annotations (DEBUG LENGTH: {state.events.length})</h2>
          <div style={{color: 'yellow', fontSize: '10px', wordBreak: 'break-all'}}>
            {JSON.stringify(state.events.slice(0, 2))}
          </div>
          
          {warnings.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              {warnings.map((w, i) => (
                <div key={i} className={`validation-warning ${w.type}`}>
                  {w.type === 'error' ? <AlertCircle size={16} /> : <AlertTriangle size={16} />}
                  <span>{w.msg}</span>
                </div>
              ))}
            </div>
          )}

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Frame</th>
                  <th>Label</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {state.rally.start_frame !== null && (
                  <tr className={state.currentFrame === state.rally.start_frame ? 'active-row' : ''} onClick={() => seekToFrame(state.rally.start_frame!)} style={{ cursor: 'pointer' }}>
                    <td>{state.rally.start_frame}</td>
                    <td><span className="badge" style={{ background: 'var(--color-rally)' }}>start_rally</span></td>
                    <td>
                      <button className="btn icon-only outline" onClick={(e) => { e.stopPropagation(); setState(prev => ({ ...prev, rally: { ...prev.rally, start_frame: null } })) }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                )}
                
                {[...state.events].sort((a, b) => a.frame - b.frame).map(event => {
                  const skillName = (event.skill || (event as any).label || '').toString();
                  return (
                    <tr key={event.frame} className={state.currentFrame === event.frame ? 'active-row' : ''} onClick={() => seekToFrame(event.frame)} style={{ cursor: 'pointer' }}>
                      <td>{event.frame}</td>
                      <td>
                        <span className={`badge ${skillName}`}>{skillName}</span>
                        {event.player_id !== undefined && (
                           <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-attack)' }}>ID: {event.player_id}</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <button 
                            className="btn icon-only outline" 
                            title="Assign selected player to this skill"
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              if (selectedTrackId !== null) {
                                handleAssignPlayer(event.frame, selectedTrackId);
                              } else {
                                window.alert("Please click a red player bounding box on the video first to select a player!");
                              }
                            }}>
                            <span style={{ fontSize: '10px', fontWeight: 'bold' }}>Assign</span>
                          </button>
                          <button className="btn icon-only outline" onClick={(e) => { e.stopPropagation(); setState(prev => ({ ...prev, events: prev.events.filter(ev => ev.frame !== event.frame) })) }}><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {state.rally.end_frame !== null && (
                  <tr className={state.currentFrame === state.rally.end_frame ? 'active-row' : ''} onClick={() => seekToFrame(state.rally.end_frame!)} style={{ cursor: 'pointer' }}>
                    <td>{state.rally.end_frame}</td>
                    <td><span className="badge" style={{ background: 'var(--color-rally)' }}>end_rally</span></td>
                    <td>
                      <button className="btn icon-only outline" onClick={(e) => { e.stopPropagation(); setState(prev => ({ ...prev, rally: { ...prev.rally, end_frame: null } })) }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <input
              ref={importPredictionsInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0] || null;
                void handleImportPredictions(file);
                e.target.value = '';
              }}
            />
            <button
              className="btn outline"
              style={{ flex: 1 }}
              onClick={() => importPredictionsInputRef.current?.click()}
            >
              <Upload size={16} /> Import Predictions (JSON)
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              className="btn outline"
              style={{ flex: 1 }}
              onClick={() => { void runTouchModel(); }}
              disabled={isRunningTouch || isRunningSkill5}
            >
              <Settings size={16} /> {isRunningTouch ? 'Running Touch...' : 'Run Touch Model'}
            </button>
            <button
              className="btn outline"
              style={{ flex: 1 }}
              onClick={() => { void runSkill5Model(); }}
              disabled={isRunningTouch || isRunningSkill5}
            >
              <Settings size={16} /> {isRunningSkill5 ? 'Running Skill5...' : 'Run 5-class Skill'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="btn outline" style={{ flex: 1 }} onClick={() => {
              if (state.videoMetadata) exportToXML(state.videoMetadata, state.rally, state.events);
            }} disabled={!state.videoMetadata || warnings.some(w => w.type === 'error')}>
              <Download size={16} /> Cur XML
            </button>
            {googleTokenRef.current && (
              <button className="btn outline" style={{ flex: 1 }} onClick={() => {
                const item = state.playlist[state.currentPlaylistIndex];
                if (!state.videoMetadata) return;
                
                // Update the playlist snapshot so it's fresh
                saveCurrentVideoState();

                // Generate XML using the CURRENT active state, not the old playlist item
                const xml = generateXMLString(state.videoMetadata, state.rally, state.events);
                const xmlBlob = new Blob([xml], { type: 'application/xml' });
                const xmlFilename = `annotations_${item.name.replace(/\.[^/.]+$/, '')}.xml`;

                uploadToDrive(googleTokenRef.current!, item.driveFolderId, xmlFilename, xmlBlob, item.driveXmlId)
                  .then(xmlId => {
                    if (xmlId) {
                      setState(prev => {
                        const np = [...prev.playlist];
                        np[state.currentPlaylistIndex] = { ...np[state.currentPlaylistIndex], driveXmlId: xmlId };
                        return { ...prev, playlist: np };
                      });
                      window.alert('Saved to Google Drive!');
                    }
                  }).catch(e => { console.error(e); window.alert('Failed to save to Google Drive'); });
              }}>
                <FolderArchive size={16} /> Sync Drive
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;
