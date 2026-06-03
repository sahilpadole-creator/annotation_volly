import { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Download, Settings, Trash2, AlertTriangle, AlertCircle, FileVideo, FolderArchive, ArrowRight, ArrowLeft, CheckCircle } from 'lucide-react';
import type { AppState, SkillLabel, PlaylistItem } from './types';
import { exportToXML, exportAllToZip, generateXMLString } from './utils/exportUtils';
import { GoogleDriveConnector } from './components/GoogleDriveConnector';
import { parseZIPAnnotations, parseXMLAnnotations } from './utils/importUtils';
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
  });

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

    return {
      events: finalEvents,
      startFrame: typeof startFrame === 'number' ? startFrame : null,
      endFrame: typeof endFrame === 'number' ? endFrame : null,
    };
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

      return {
        ...prev,
        events: deduplicated,
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
          // Load the first video now that batch is done
          if (currentPlaylist.length > 0 && !videoUrl) {
            loadVideoIntoPlayer(currentPlaylist[0]);
          }
          
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
          
          const updatedItem = {
            ...item,
            events: events,
            rally: {
              start_frame: startFrame ?? item.rally?.start_frame ?? null,
              end_frame: endFrame ?? item.rally?.end_frame ?? null
            },
            isSkillAlgorithmApplied: true
          };

          setState(prev => {
            const newPlaylist = [...prev.playlist];
            newPlaylist[nextIndex] = updatedItem;
            
            if (prev.currentPlaylistIndex === nextIndex) {
              return {
                ...prev,
                playlist: newPlaylist,
                events: events,
                rally: updatedItem.rally
              };
            }
            return { ...prev, playlist: newPlaylist };
          });

          // Upload individual XML back to Google Drive
          if (googleTokenRef.current && (item.driveFolderId || item.driveXmlId)) {
            const xml = generateXMLString(
              item.videoMetadata || { filename: item.name, fps: 30, width: 0, height: 0, duration: 0, frame_count: 0 },
              updatedItem.rally,
              events
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
      }
      setState(prev => ({
        ...prev,
        videoMetadata: item.videoMetadata || { filename: item.name, fps: 30, width: 0, height: 0, duration: 0, frame_count: 0 },
        rally: item.rally || { start_frame: null, end_frame: null },
        events: item.events || [],
        currentFrame: 0
      }));
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
          setState({ ...parsed.state, currentFrame: parsed.state.currentFrame || 0 });
        }
      } catch (e) {
        console.error("Failed to parse local storage", e);
      }
    }
  }, []);

  // Autosave
  useEffect(() => {
    if (state.playlist.length > 0 || state.videoMetadata) {
      // Keep playlist in sync with current events before saving
      const currentPlaylist = [...state.playlist];
      if (currentPlaylist.length > 0 && currentPlaylist[state.currentPlaylistIndex]) {
        currentPlaylist[state.currentPlaylistIndex] = {
           ...currentPlaylist[state.currentPlaylistIndex],
           events: state.events,
           rally: state.rally,
           videoMetadata: state.videoMetadata,
           isCompleted: (state.rally.start_frame !== null && state.rally.end_frame !== null)
        };
      }

      // Don't save Object URLs or File objects to localStorage
      const stateToSave = {
        ...state,
        playlist: currentPlaylist.map(item => ({ ...item, file: undefined }))
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
      currentFrame: 0
    }));
  };

  const handlePlaylistFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const fileArray = Array.from(files);
    const videoFiles = fileArray.filter(f => f.type.startsWith('video/') || f.name.toLowerCase().endsWith('.mp4'));
    const zipFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.zip'));
    
    let parsedAnnotations: Record<string, any> = {};
    let extractedVideos: File[] = [];
    if (zipFiles.length > 0) {
      try {
        const result = await parseZIPAnnotations(zipFiles[0]);
        parsedAnnotations = result.annotations;
        extractedVideos = result.videos;
        console.log(`Loaded annotations for ${Object.keys(parsedAnnotations).length} videos from ZIP.`);
        console.log(`Extracted ${extractedVideos.length} videos from ZIP.`);
      } catch (e) {
        console.error("Error parsing ZIP", e);
        window.alert("Failed to read the ZIP file. It may be too large or corrupted.");
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

      return {
        id: file.name + file.lastModified,
        name: file.name,
        file: file,
        events: itemEvents,
        rally: itemRally,
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
        currentFrame: savedFrame
      }));
    } else {
      setState(prev => ({
        ...prev,
        playlist: newPlaylistItems,
        currentPlaylistIndex: 0
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return;

      const key = e.key.toLowerCase();
      
      if (SKILL_MAP[key]) {
        addEvent(SKILL_MAP[key]);
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
  }, [state.currentFrame, seekToFrame]);

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
              <p>Drag & drop MP4 or ZIP files</p>
              <input type="file" accept="video/mp4,application/zip,.zip" multiple onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
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
                  <input type="file" accept="video/mp4" multiple onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
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
                setState({ playlist: [], currentPlaylistIndex: 0, videoMetadata: null, rally: { start_frame: null, end_frame: null }, events: [], currentFrame: 0 });
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
          />
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
        <div className="glass-panel timeline">
          <div className="timeline-track">
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
            {state.videoMetadata && state.events.map(event => (
              <div 
                key={event.frame}
                className="timeline-marker" 
                style={{ left: `${(event.frame / state.videoMetadata!.frame_count) * 100}%`, backgroundColor: `var(--color-${event.skill})` }}
                title={`${event.skill} at frame ${event.frame}`}
                onClick={() => seekToFrame(event.frame)}
              />
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
            <div><span className="hotkey">Del</span> Clear Frame</div>
          </div>
        </div>

        <div className="glass-panel sidebar-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <h2>Annotations</h2>
          
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
                
                {[...state.events].sort((a, b) => a.frame - b.frame).map(event => (
                  <tr key={event.frame} className={state.currentFrame === event.frame ? 'active-row' : ''} onClick={() => seekToFrame(event.frame)} style={{ cursor: 'pointer' }}>
                    <td>{event.frame}</td>
                    <td><span className={`badge ${event.skill}`}>{event.skill}</span></td>
                    <td>
                      <button className="btn icon-only outline" onClick={(e) => { e.stopPropagation(); setState(prev => ({ ...prev, events: prev.events.filter(ev => ev.frame !== event.frame) })) }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}

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
