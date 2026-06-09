import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Upload, Download, Settings, Trash2, AlertTriangle, AlertCircle, FileVideo, ArrowRight, ArrowLeft, CheckCircle, Eye, EyeOff } from 'lucide-react';
import type { AppState, SkillLabel, PlaylistItem, SkillEvent, PlayerBox } from './types';
import { exportAllToZip, generateXMLString } from './utils/exportUtils';
import { detectVideoFps } from './utils/fpsUtils';
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
  video_fps?: number;
};

const INFERENCE_API_BASE = import.meta.env.VITE_INFERENCE_API_BASE || 'http://localhost:8000';

function App() {
  const [videoUrl, setVideoUrl] = useState<string>('');
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

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginUsername === 'admin' && loginPassword === 'password123') {
      setIsAuthenticated(true);
      setLoginError('');
    } else {
      setLoginError('Invalid username or password');
    }
  };

  const historyRef = useRef<{
    events: SkillEvent[];
    manualActions: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: PlayerBox }[];
    playerBoxes: Record<number, any[]>;
  }[]>([]);

  const saveToHistory = (currentState: AppState) => {
    historyRef.current.push({
      events: JSON.parse(JSON.stringify(currentState.events)),
      manualActions: JSON.parse(JSON.stringify(currentState.manualActions)),
      playerBoxes: JSON.parse(JSON.stringify(currentState.playerBoxes))
    });
    // Keep history bounded to last 50 states
    if (historyRef.current.length > 50) {
      historyRef.current.shift();
    }
  };

  const handleUndo = () => {
    if (historyRef.current.length === 0) {
      window.alert("No more actions to undo.");
      return;
    }
    const previousState = historyRef.current.pop()!;
    setState(prev => ({
      ...prev,
      events: previousState.events,
      manualActions: previousState.manualActions,
      playerBoxes: previousState.playerBoxes
    }));
  };

  const handleResetRally = () => {
    if (window.confirm("Are you sure you want to completely reset all manual annotations for this video? This cannot be undone.")) {
      saveToHistory(state); // Save the current state before wiping it, just in case they want to undo the reset!
      setState(prev => {
        // Strip out manually drawn boxes (track_id >= 999000) and deactivate others
        const resetBoxes: Record<number, any[]> = {};
        Object.keys(prev.playerBoxes).forEach(fStr => {
          const f = parseInt(fStr, 10);
          resetBoxes[f] = prev.playerBoxes[f]
            .filter(b => b.track_id < 999000)
            .map(b => ({ ...b, is_active: false }));
        });

        // Strip player assignments from events and remove any manually created events
        const resetEvents = prev.events
          .filter(ev => ev.source !== 'manual')
          .map(ev => ({ ...ev, player_id: undefined }));

        return {
          ...prev,
          manualActions: [],
          playerBoxes: resetBoxes,
          events: resetEvents
        };
      });
    }
  };

  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [showOnlyActiveBoxes, setShowOnlyActiveBoxes] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [drawingBox, setDrawingBox] = useState<{ startX: number, startY: number, currentX: number, currentY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const cyclePlaybackRate = () => {
    const rates = [0.25, 0.5, 1, 1.5, 2];
    const currentIndex = rates.indexOf(playbackRate);
    const nextIndex = (currentIndex + 1) % rates.length;
    setPlaybackRate(rates[nextIndex]);
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const seekIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const stateRef = useRef(state);
  const processingRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

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

  const alignManualActionsToEvents = (actions: { frame: number; track_id: number; action?: 'add' | 'remove' | 'draw_box'; box?: PlayerBox }[], events: SkillEvent[], threshold = 5) => {
    const snappedActions = actions.map(action => {
      let closestEvent: SkillEvent | null = null;
      let minDiff = threshold + 1;
      for (const ev of events) {
        const diff = Math.abs(ev.frame - action.frame);
        if (diff < minDiff) {
          minDiff = diff;
          closestEvent = ev;
        }
      }
      if (closestEvent && minDiff > 0) {
        return { ...action, frame: closestEvent.frame };
      }
      return action;
    });

    const activePerFrame = new Map<number, number>();
    snappedActions.forEach(action => {
      if (action.action === 'remove') {
        if (activePerFrame.get(action.frame) === action.track_id) {
          activePerFrame.delete(action.frame);
        }
      } else {
        activePerFrame.set(action.frame, action.track_id);
      }
    });

    const finalActions: { frame: number; track_id: number; action?: 'remove' }[] = [];
    activePerFrame.forEach((track_id, frame) => {
      finalActions.push({ frame, track_id });
    });
    
    return finalActions;
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

    // NEW RULE: Only one reception allowed per video/rally. Subsequent ones become digs.
    let hasSeenReception = false;
    for (let i = 0; i < modified.length; i++) {
      if (modified[i].skill === 'reception') {
        if (hasSeenReception) {
          updateSkill(modified[i], 'dig');
        } else {
          hasSeenReception = true;
        }
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
          
          const videoFps = (payload as any).video_fps;
          
          const alignedManualActions = alignManualActionsToEvents(item.manualActions || [], heuristicallyCorrected, 5);
          let newPlayerBoxes = item.playerBoxes;
          if (alignedManualActions.length > 0 && item.rawJsonString) {
             newPlayerBoxes = parseJSONAnnotations(item.rawJsonString, alignedManualActions).parsed;
          }

          const updatedItem = {
            ...item,
            events: heuristicallyCorrected,
            manualActions: alignedManualActions,
            playerBoxes: newPlayerBoxes,
            rally: {
              start_frame: startFrame ?? item.rally?.start_frame ?? null,
              end_frame: endFrame ?? item.rally?.end_frame ?? null
            },
            videoMetadata: item.videoMetadata ? {
              ...item.videoMetadata,
              fps: videoFps ?? item.videoMetadata.fps,
            } : null,
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

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('volleyball_annotations');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.state) {
          // Sanitize any duplicated manual actions that were saved previously
          const cleanedActions = alignManualActionsToEvents(
            parsed.state.manualActions || [], 
            parsed.state.events || [], 
            5
          );
          
          let newBoxes = parsed.state.playerBoxes;
          if (parsed.state.playlist && parsed.state.playlist.length > 0) {
            const currentItem = parsed.state.playlist[parsed.state.currentPlaylistIndex || 0];
            if (currentItem && currentItem.rawJsonString) {
              const res = parseJSONAnnotations(currentItem.rawJsonString, cleanedActions);
              newBoxes = res.parsed;
            }
          }

          setState({ 
            ...parsed.state, 
            currentFrame: parsed.state.currentFrame || 0,
            manualActions: cleanedActions,
            playerBoxes: newBoxes
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
    const xmlFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.xml'));
    
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
        let stem = jsonFile.name.replace(/\.json$/i, '');
        if (stem.startsWith('annotations_')) {
          stem = stem.replace(/^annotations_/, '');
        }
        parsedJsonAnnotations[stem] = result;
      } catch (err) {
        console.error(`Failed to parse standalone JSON: ${jsonFile.name}`, err);
      }
    }

    for (const xmlFile of xmlFiles) {
      try {
        const text = await xmlFile.text();
        const parsed = parseXMLAnnotations(text);
        let stem = xmlFile.name.replace(/\.xml$/i, '');
        if (stem.startsWith('annotations_')) {
          stem = stem.replace(/^annotations_/, '');
        }
        parsedAnnotations[stem] = parsed;
      } catch (err) {
        console.error(`Failed to parse standalone XML: ${xmlFile.name}`, err);
      }
    }

    const allVideoFiles = [...videoFiles, ...extractedVideos];

    if (allVideoFiles.length === 0) {
      window.alert("No video files found! Please upload MP4 videos along with your ZIP file, or ensure your ZIP contains MP4s.");
      return;
    }

    const newPlaylistItems: PlaylistItem[] = await Promise.all(allVideoFiles.map(async file => {
      let existing = stateRef.current.playlist.find(p => p.name === file.name);
      
      let itemEvents = existing?.events || [];
      let itemRally = existing?.rally || { start_frame: null, end_frame: null };
      let isApplied = existing?.isSkillAlgorithmApplied || false;
      let itemPlayerBoxes = existing?.playerBoxes || {};
      let itemRawJson = existing?.rawJsonString || undefined;
      let itemManualActions = existing?.manualActions || [];

      // Detect native video FPS using MP4Box
      const nativeFps = await detectVideoFps(file);

      const stem = file.name.replace(/\.[^/.]+$/, '');
      if (parsedAnnotations[stem]) {
        if (!existing || (!existing.isSkillAlgorithmApplied && (!existing.events || existing.events.length === 0))) {
          itemEvents = parsedAnnotations[stem].events;
          itemRally = parsedAnnotations[stem].rally;
          isApplied = true;
        }
      }
      
      let jsonKey = stem;
      if (!parsedJsonAnnotations[jsonKey]) {
        const possibleKey = Object.keys(parsedJsonAnnotations).find(k => k.startsWith(stem + '_') || stem.startsWith(k + '_'));
        if (possibleKey) jsonKey = possibleKey;
      }

      if (itemEvents.length > 0 && itemManualActions.length > 0) {
        itemManualActions = alignManualActionsToEvents(itemManualActions, itemEvents, 5);
      }

      let jsonFps: number | undefined = undefined;

      if (parsedJsonAnnotations[jsonKey]) {
        const parsedResult = itemManualActions.length > 0 
          ? parseJSONAnnotations(parsedJsonAnnotations[jsonKey].rawJsonString, itemManualActions)
          : parsedJsonAnnotations[jsonKey];
          
        itemPlayerBoxes = parsedResult.parsed;
        itemRawJson = parsedResult.rawJsonString;
        jsonFps = parsedResult.videoFps;
      }
      
      // Determine the best available FPS
      const finalFps = nativeFps || jsonFps || existing?.videoMetadata?.fps || 30;

      // Update or create videoMetadata with the correct FPS
      let newVideoMetadata = existing?.videoMetadata || null;
      if (newVideoMetadata) {
        newVideoMetadata = { ...newVideoMetadata, fps: finalFps };
      } else {
        newVideoMetadata = { filename: file.name, fps: finalFps, width: 0, height: 0, duration: 0, frame_count: 0 };
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
        videoMetadata: newVideoMetadata,
        isCompleted: existing?.isCompleted || false
      };
    }));

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
    saveToHistory(state);
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
    saveToHistory(state);
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
    saveToHistory(state);
    setState(prev => {
      const currentActions = prev.manualActions || [];
      const isCurrentlyAssigned = currentActions.some(m => m.frame === frame && m.track_id === trackId && m.action !== 'remove');
      
      // Find if another player is already assigned to this frame
      const oldAssignedPlayerId = prev.events.find(e => e.frame === frame)?.player_id;
      const assigningNewPlayer = !isCurrentlyAssigned;
      
      let newActions = currentActions.filter(m => !(m.frame === frame && m.track_id === trackId));
      
      if (assigningNewPlayer && oldAssignedPlayerId !== undefined && oldAssignedPlayerId !== trackId) {
        // Remove the old assigned player from actions
        newActions = newActions.filter(m => !(m.frame === frame && m.track_id === oldAssignedPlayerId));
        newActions.push({ frame, track_id: oldAssignedPlayerId, action: 'remove' as const });
      }

      if (assigningNewPlayer) {
        newActions.push({ frame, track_id: trackId });
      } else {
        newActions.push({ frame, track_id: trackId, action: 'remove' as const });
      }
      
      // Update is_active without re-parsing JSON to preserve drawn boxes
      // Update across the +/- 2 frame window to ensure the timeline correctly reflects the replacement immediately
      let newBoxes = { ...prev.playerBoxes };
      for (let f = frame - 2; f <= frame + 2; f++) {
        if (newBoxes[f]) {
          newBoxes[f] = newBoxes[f].map(b => {
            if (b.track_id === trackId) {
              return { ...b, is_active: !isCurrentlyAssigned };
            }
            if (assigningNewPlayer && oldAssignedPlayerId !== undefined && b.track_id === oldAssignedPlayerId) {
              return { ...b, is_active: false };
            }
            return b;
          });
        }
      }
      
      // Update the event's player_id if there is an event at this frame
      const newEvents = prev.events.map(ev => {
        if (ev.frame === frame) {
          return { ...ev, player_id: isCurrentlyAssigned ? undefined : trackId };
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

  const handleDeleteBox = (trackIdToDelete: number) => {
    saveToHistory(state);
    setState(prev => {
      // Remove it from playerBoxes
      const currentBoxes = prev.playerBoxes[prev.currentFrame] || [];
      const newBoxes = currentBoxes.filter(b => b.track_id !== trackIdToDelete);
      
      // Also remove it from manualActions just in case it was assigned!
      const currentActions = prev.manualActions || [];
      const newActions = currentActions.filter(a => !(a.frame === prev.currentFrame && a.track_id === trackIdToDelete));
      
      // If it was the assigned player for the event, clear it
      const newEvents = prev.events.map(ev => {
        if (ev.frame === prev.currentFrame && ev.player_id === trackIdToDelete) {
          return { ...ev, player_id: undefined };
        }
        return ev;
      });

      return {
        ...prev,
        playerBoxes: {
          ...prev.playerBoxes,
          [prev.currentFrame]: newBoxes
        },
        manualActions: newActions,
        events: newEvents
      };
    });
    if (selectedTrackId === trackIdToDelete) {
      setSelectedTrackId(null);
    }
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

  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!state.videoMetadata) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const scaleX = state.videoMetadata.width / rect.width;
    const scaleY = state.videoMetadata.height / rect.height;
    
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    
    setDrawingBox({ startX: x, startY: y, currentX: x, currentY: y });
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!drawingBox || !state.videoMetadata) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const scaleX = state.videoMetadata.width / rect.width;
    const scaleY = state.videoMetadata.height / rect.height;
    
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    
    setDrawingBox(prev => prev ? { ...prev, currentX: x, currentY: y } : null);
  };

  const handleSvgMouseUp = () => {
    if (!drawingBox) return;
    
    const x_min = Math.min(drawingBox.startX, drawingBox.currentX);
    const x_max = Math.max(drawingBox.startX, drawingBox.currentX);
    const y_min = Math.min(drawingBox.startY, drawingBox.currentY);
    const y_max = Math.max(drawingBox.startY, drawingBox.currentY);
    
    if (x_max - x_min > 10 && y_max - y_min > 10) {
      const highestTrackId = Math.max(0, ...Object.values(state.playerBoxes).flatMap(frameBoxes => frameBoxes.map(b => b.track_id)));
      
      const newBox: PlayerBox = {
        x_min, y_min, x_max, y_max,
        track_id: highestTrackId + 1,
        is_active: false
      };
      
      saveToHistory(state);
      setState(prev => {
        const newBoxesState = { ...prev.playerBoxes };
        for (let f = prev.currentFrame - 2; f <= prev.currentFrame + 2; f++) {
          if (f >= 0) {
            newBoxesState[f] = [...(newBoxesState[f] || []), { ...newBox }];
          }
        }
        
        return {
          ...prev,
          playerBoxes: newBoxesState,
          manualActions: [...(prev.manualActions || []), { 
            frame: prev.currentFrame, 
            track_id: newBox.track_id, 
            action: 'draw_box', 
            box: newBox 
          }]
        };
      });
      
      setSelectedTrackId(newBox.track_id);
    }
    
    setDrawingBox(null);
  };

  const getValidationWarnings = () => {
    const warnings: { type: string, msg: string }[] = [];
    if (!state.videoMetadata) return warnings;

    if (state.rally.start_frame !== null && state.rally.end_frame !== null) {
      if (state.rally.end_frame < state.rally.start_frame) {
        warnings.push({ type: 'error', msg: 'end_rally is before start_rally' });
      }
    }
    
    state.events.forEach(ev => {
      const boxes = state.playerBoxes[ev.frame] || [];
      
      const visibleBoxes = boxes.filter(b => {
        const width = b.x_max - b.x_min;
        const height = b.y_max - b.y_min;
        const isOffScreen = b.x_max < 0 || b.y_max < 0 || b.x_min > (state.videoMetadata?.width || 1280) || b.y_min > (state.videoMetadata?.height || 720);
        return width > 5 && height > 5 && !isOffScreen;
      });

      if (visibleBoxes.length < 12) {
        warnings.push({ type: 'warning', msg: `Frame ${ev.frame} (${ev.skill}) has only ${visibleBoxes.length}/12 visible players. Draw missing boxes if needed.` });
      }
    });
    
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
    
    // Add skill info to ranges
    const rangesWithSkill = ranges.map(range => {
      // Find event that overlaps this range, or is close to it
      const event = state.events.find(e => e.frame >= range.start - 5 && e.frame <= range.end + 5);
      return { 
        ...range, 
        skillName: event ? event.skill : 'default'
      };
    });
    
    // Sort by start frame
    return rangesWithSkill.sort((a, b) => a.start - b.start);
  }, [state.playerBoxes, state.events]);
  if (!isAuthenticated) {
    return (
      <div className="landing-container" style={{ 
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', 
        minHeight: '100vh', padding: '2rem',
        background: 'radial-gradient(circle at 50% 50%, #151e2e 0%, #060913 100%)',
        overflow: 'hidden'
      }}>
        
        {/* MASSIVE BACKGROUND LOGO & TEXT */}
        <div style={{ position: 'absolute', top: '5%', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', zIndex: 0, width: '100%', pointerEvents: 'none' }}>
          <img src={`${import.meta.env.BASE_URL}logo.png?v=6`} alt="Veritas Pro Logo" style={{ width: '100%', maxWidth: '800px', objectFit: 'contain', filter: 'drop-shadow(0 20px 40px rgba(0,0,0,0.5))', marginBottom: '-40px', mixBlendMode: 'screen' }} />
          
          <h1 style={{ fontSize: '3.5rem', fontWeight: 800, margin: '0 0 0.5rem 0', letterSpacing: '-1px', color: '#ffffff', textShadow: '0 4px 20px rgba(0,0,0,0.8)' }}>
            Veritas Pro
          </h1>
          <p style={{ fontSize: '0.85rem', fontWeight: 700, letterSpacing: '4px', margin: 0, color: '#3b82f6', textShadow: '0 2px 10px rgba(0,0,0,0.8)' }}>
            POWERED BY HEELIOS.AI
          </p>
        </div>

        {/* SECURE LOGIN CARD (Overlapping) */}
        <div style={{ 
          position: 'relative', zIndex: 10,
          width: '100%', maxWidth: '400px', padding: '2.5rem', marginTop: '30vh',
          background: 'rgba(15, 20, 30, 0.7)', border: '1px solid rgba(255,255,255,0.05)', 
          borderRadius: '16px', boxShadow: '0 20px 50px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.1)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)'
        }}>
          <p style={{ margin: '0 0 2rem 0', color: 'white', fontWeight: 600, fontSize: '1.2rem', textAlign: 'center' }}>Secure Login</p>
          
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div>
              <label htmlFor="username" style={{ display: 'block', marginBottom: '0.5rem', color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem', fontWeight: 500 }}>Username</label>
              <input 
                id="username"
                name="username"
                type="text" 
                value={loginUsername}
                onChange={e => setLoginUsername(e.target.value)}
                style={{ width: '100%', padding: '0.9rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)', color: 'white', outline: 'none', transition: 'all 0.2s', fontSize: '0.95rem' }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px rgba(59,130,246,0.2)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'rgba(255,255,255,0.05)'; e.target.style.boxShadow = 'none'; }}
                placeholder="admin"
                autoComplete="username"
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="password" style={{ display: 'block', marginBottom: '0.5rem', color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem', fontWeight: 500 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input 
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"} 
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  style={{ width: '100%', padding: '0.9rem 1rem', paddingRight: '2.5rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)', color: 'white', outline: 'none', transition: 'all 0.2s', fontSize: '0.95rem' }}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px rgba(59,130,246,0.2)'; }}
                  onBlur={(e) => { e.target.style.borderColor = 'rgba(255,255,255,0.05)'; e.target.style.boxShadow = 'none'; }}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
                <button 
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{ position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 0, display: 'flex', transition: 'color 0.2s' }}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'white'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            
            {loginError && <div style={{ color: 'var(--color-attack)', fontSize: '0.85rem', textAlign: 'center', background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem', borderRadius: '6px' }}>{loginError}</div>}
            
            <button type="submit" className="btn" style={{ width: '100%', padding: '1rem', marginTop: '1rem', background: '#3b82f6', color: 'white', fontWeight: 600, fontSize: '1rem', borderRadius: '8px', boxShadow: '0 4px 20px 0 rgba(59, 130, 246, 0.4)', border: 'none', cursor: 'pointer', transition: 'transform 0.1s, box-shadow 0.2s' }}
                    onMouseDown={e => e.currentTarget.style.transform = 'scale(0.98)'}
                    onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}>
              Sign In &rarr;
            </button>
          </form>
        </div>
      </div>
    );
  }
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

    const downloadDocumentation = () => {
      const docText = `VERITAS PRO - USER GUIDE

1. Getting Started
   - Drag and drop your MP4 files, ZIP files, or JSON annotation files directly into the "Local Files" area.
   - The app will load them into the playlist sidebar on the left.

2. Navigation & Hotkeys
   - [S] : Mark the start of a rally.
   - [E] : Mark the end of a rally.
   - [A] : Select the currently active player bounding box.
   - [Del] : Delete all annotations on the current frame.
   - [1-6] : Assign a skill to the current frame (Toss, Serve, Reception, Set, Dig, Attack/Block).

3. Bounding Boxes
   - Double-click an existing bounding box to assign the player to the current skill event.
   - Click and drag anywhere on the video to manually draw a new bounding box.
   - Right-click any bounding box to instantly delete it.

4. Action Buttons Explained
   - Undo: Click this to instantly undo your last action (like drawing a box or assigning a player). It remembers your last 50 actions!
   - Reset Rally: Completely wipes all manual annotations, drawn boxes, and player assignments for the current video. 
   - Batch ZIP (Bottom Left): When you are completely finished annotating all videos in the playlist, click this to export your work. It will download a single ZIP file containing all your updated JSON and XML files.

Enjoy using Veritas Pro!
`;
      const blob = new Blob([docText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Veritas_Pro_User_Guide.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    return (
      <div className="landing-container" style={{ 
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', 
        minHeight: '100vh', padding: '2rem',
        background: 'radial-gradient(circle at 50% 0%, rgba(59, 130, 246, 0.15) 0%, rgba(5, 5, 5, 1) 50%, rgba(5, 5, 5, 1) 100%)'
      }}>
        
        {/* HEADER SECTION */}
        <div style={{ textAlign: 'center', marginBottom: '3rem', animation: 'fadeInDown 0.8s ease-out' }}>
          <div style={{ position: 'relative', display: 'inline-block', marginBottom: '1.5rem' }}>
            <div style={{ position: 'absolute', top: '50%', left: '50%', width: '150px', height: '150px', background: 'radial-gradient(circle, rgba(59, 130, 246, 0.4) 0%, transparent 70%)', transform: 'translate(-50%, -50%)', filter: 'blur(20px)', zIndex: 0 }}></div>
            <img src={`${import.meta.env.BASE_URL}logo.png?v=6`} alt="Veritas Pro Logo" style={{ width: '100px', height: '100px', position: 'relative', zIndex: 1, mixBlendMode: 'screen' }} />
          </div>
          <h1 style={{ fontSize: '3.5rem', fontWeight: 800, margin: '0 0 0.5rem 0', letterSpacing: '-1px', background: 'linear-gradient(135deg, #ffffff 0%, #94a3b8 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Veritas Pro
          </h1>
          <p style={{ fontSize: '0.85rem', fontWeight: 700, letterSpacing: '3px', margin: 0, color: 'var(--primary)' }}>
            POWERED BY THELIOS.AI
          </p>
          <p style={{ fontSize: '1.1rem', color: 'var(--text-muted)', maxWidth: '500px', margin: '1.5rem auto 0 auto', lineHeight: 1.5 }}>
            Advanced skill tracking and batch processing pipeline.<br/>
            Load individual rallies or entire match datasets to begin.
          </p>
        </div>

        {/* DROPZONE */}
        <label 
          className="premium-dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void handlePlaylistFiles(e.dataTransfer.files); }}
          style={{ 
            width: '100%', maxWidth: '700px', padding: '3rem 2rem', 
            background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.15)', 
            borderRadius: '16px', textAlign: 'center', cursor: 'pointer', transition: 'all 0.3s ease',
            boxShadow: '0 10px 40px -10px rgba(0,0,0,0.5)', marginBottom: '3rem', position: 'relative', overflow: 'hidden'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)';
            e.currentTarget.style.borderColor = 'var(--primary)';
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 15px 40px -10px rgba(59, 130, 246, 0.3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 10px 40px -10px rgba(0,0,0,0.5)';
          }}
        >
          <div style={{ background: 'rgba(59, 130, 246, 0.1)', width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto', color: 'var(--primary)' }}>
            <Upload size={32} />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0 0 0.5rem 0', color: 'white' }}>Upload Local Files</h2>
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.95rem' }}>Drag & drop your <strong>MP4</strong>, <strong>ZIP</strong>, or <strong>JSON</strong> files here to start annotating.</p>
          <input type="file" accept="video/mp4,application/zip,.zip,application/json,.json" multiple onChange={(e) => { void handlePlaylistFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
        </label>

        {/* FEATURE CARDS (Replaces old Documentation list) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', width: '100%', maxWidth: '900px' }}>
          
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: '#fbbf24', marginBottom: '0.8rem' }}><Settings size={24} /></div>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.5rem 0', color: 'white' }}>Hotkeys</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>Use keys <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>1-6</code> for assigning skills. Use <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>S</code> & <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>E</code> to mark rally boundaries.</p>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: '#4ade80', marginBottom: '0.8rem' }}><FileVideo size={24} /></div>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.5rem 0', color: 'white' }}>Bounding Boxes</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>Click & drag over players to track. Double-click any box to instantly assign them to the active frame's skill.</p>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: '#a78bfa', marginBottom: '0.8rem' }}><Download size={24} /></div>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.5rem 0', color: 'white' }}>Export Data</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>Click Batch ZIP in the sidebar to securely download perfectly synced JSON/XML datasets for model training.</p>
          </div>
          
        </div>

        <div style={{ marginTop: '3rem' }}>
          <button onClick={downloadDocumentation} className="btn outline" style={{ fontSize: '0.85rem', padding: '0.6rem 1.2rem', borderRadius: '20px', color: 'var(--text-muted)', borderColor: 'rgba(255,255,255,0.2)' }}>
            Download Full Guide (.txt)
          </button>
        </div>

      </div>
    );
  }

  return (
    <div className="app-container">
      {/* PLAYLIST SIDEBAR */}
      <div className="sidebar" style={{ minWidth: '200px', maxWidth: '250px', overflowY: 'hidden' }}>
        
        {/* BRANDING HEADER */}
        <div style={{ flexShrink: 0, paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', paddingLeft: '0.5rem' }}>
          <img src={`${import.meta.env.BASE_URL}logo.png?v=6`} alt="Veritas Pro Logo" style={{ width: '42px', height: '42px', mixBlendMode: 'screen' }} />
          <div>
            <h1 style={{ fontSize: '1.2rem', letterSpacing: '1px', textTransform: 'uppercase', margin: 0, fontWeight: 700, lineHeight: 1.1, textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>Veritas Pro</h1>
            <p style={{ fontSize: '0.6rem', color: 'var(--primary)', letterSpacing: '1px', margin: 0, fontWeight: 700, marginTop: '2px', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>BY THELIOS.AI</p>
          </div>
        </div>

        {/* PLAYLIST PANEL */}
        <div className="glass-panel sidebar-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h2 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Playlist ({state.currentPlaylistIndex + 1} / {state.playlist.length})
            </h2>
            <button 
              className="btn outline icon-only" 
              onClick={() => {
                setState({ playlist: [], currentPlaylistIndex: 0, videoMetadata: null, rally: { start_frame: null, end_frame: null }, events: [], currentFrame: 0, playerBoxes: {}, manualActions: [] });
                setVideoUrl('');
                setBatchProgress({ isRunning: false, completed: 0, total: 0, lastFps: 0, avgTimeSec: 0 });
              }}
              title="Return to Home"
              style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', borderRadius: '6px' }}
            >
              Home
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.2rem' }}>
            {state.playlist.map((item, index) => {
              const isActive = index === state.currentPlaylistIndex;
              return (
                <div 
                  key={item.id} 
                  onClick={() => changeVideo(index)}
                  style={{ 
                    padding: '0.6rem 0.8rem', 
                    background: isActive ? 'linear-gradient(90deg, rgba(59, 130, 246, 0.25) 0%, transparent 100%)' : 'transparent',
                    borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                    borderRadius: '0 8px 8px 0',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? 'white' : 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </div>
                {item.isCompleted && <CheckCircle size={14} color="var(--color-serve)" />}
              </div>
            );
          })}
          </div>

          {warnings.length > 0 && (
            <div style={{ maxHeight: '150px', overflowY: 'auto', marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.5rem', flexShrink: 0 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '0.5rem', color: 'var(--color-attack)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <AlertTriangle size={14} /> Validation Warnings
              </div>
              {warnings.map((w, i) => (
                <div key={i} className={`validation-warning ${w.type}`} style={{ padding: '0.4rem', fontSize: '0.75rem', marginBottom: '4px' }}>
                  {w.type === 'error' ? <AlertCircle size={14} /> : <AlertTriangle size={14} />}
                  <span>{w.msg}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
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
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
          {showBoundingBoxes && state.videoMetadata && (
            <svg 
              ref={svgRef}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'auto', zIndex: 5, cursor: 'crosshair' }}
              viewBox={`0 0 ${state.videoMetadata.width || 1280} ${state.videoMetadata.height || 720}`}
              preserveAspectRatio="xMidYMid meet"
              onMouseDown={handleSvgMouseDown}
              onMouseMove={handleSvgMouseMove}
              onMouseUp={handleSvgMouseUp}
              onMouseLeave={handleSvgMouseUp}
            >
              {(state.playerBoxes[state.currentFrame] || []).map((box, idx) => {
                if (showOnlyActiveBoxes && !box.is_active) return null;
                const isSelected = selectedTrackId === box.track_id;
                const color = box.is_active ? '#4ade80' : '#ef4444';
                return (
                  <g 
                    key={idx} 
                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    onClick={() => setSelectedTrackId(box.track_id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (window.confirm("Delete this bounding box?")) {
                        handleDeleteBox(box.track_id);
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      const hasEvent = state.events.some(ev => ev.frame === state.currentFrame);
                      if (hasEvent) {
                        handleAssignPlayer(state.currentFrame, box.track_id);
                      } else {
                        window.alert("No skill event found on this exact frame. Please create a skill first before assigning a player.");
                      }
                    }}
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
              
              {drawingBox && (
                <rect 
                  x={Math.min(drawingBox.startX, drawingBox.currentX)}
                  y={Math.min(drawingBox.startY, drawingBox.currentY)}
                  width={Math.abs(drawingBox.currentX - drawingBox.startX)}
                  height={Math.abs(drawingBox.currentY - drawingBox.startY)}
                  fill="rgba(255,255,255,0.2)"
                  stroke="#fff"
                  strokeWidth="4"
                  strokeDasharray="5,5"
                  style={{ pointerEvents: 'none' }}
                />
              )}
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
              <button 
                className={`btn outline ${!showBoundingBoxes ? 'active' : ''}`}
                onClick={() => setShowBoundingBoxes(prev => !prev)}
                title={showBoundingBoxes ? "Hide Bounding Boxes" : "Show Bounding Boxes"}
                style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                {showBoundingBoxes ? <EyeOff size={16} /> : <Eye size={16} />}
                {showBoundingBoxes ? 'Hide All' : 'Show All'}
              </button>
              <button 
                className={`btn outline ${showOnlyActiveBoxes ? 'active' : ''}`}
                onClick={() => setShowOnlyActiveBoxes(prev => !prev)}
                title={showOnlyActiveBoxes ? "Show All Boxes" : "Show Only Active Boxes"}
                style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                disabled={!showBoundingBoxes}
              >
                <Eye size={16} />
                {showOnlyActiveBoxes ? 'All Players' : 'Active Only'}
              </button>
              <button 
                className="btn outline"
                onClick={cyclePlaybackRate}
                title="Change Playback Speed"
                style={{ padding: '0.5rem', fontFamily: 'monospace', width: '60px' }}
              >
                {playbackRate}x
              </button>
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
              const skillColor = range.skillName !== 'default' ? `var(--color-${range.skillName})` : '#4ade80';
              return (
                <div
                  key={`active-win-${idx}`}
                  style={{
                    position: 'absolute',
                    left: `${startPct}%`,
                    width: `${Math.max(widthPct, 0.2)}%`,
                    height: '100%',
                    backgroundColor: skillColor,
                    opacity: 0.3,
                    borderLeft: `1px solid ${skillColor}`,
                    borderRight: `1px solid ${skillColor}`,
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
            {activeRanges.map((range, idx) => {
              const skillColor = range.skillName !== 'default' ? `var(--color-${range.skillName})` : '#4ade80';
              const bgNormal = range.skillName !== 'default' ? `color-mix(in srgb, ${skillColor} 15%, transparent)` : 'rgba(74, 222, 128, 0.15)';
              const bgHover = range.skillName !== 'default' ? `color-mix(in srgb, ${skillColor} 30%, transparent)` : 'rgba(74, 222, 128, 0.3)';
              const borderCol = range.skillName !== 'default' ? `color-mix(in srgb, ${skillColor} 40%, transparent)` : 'rgba(74, 222, 128, 0.4)';
              
              return (
              <div 
                key={idx} 
                style={{ 
                  background: bgNormal, 
                  border: `1px solid ${borderCol}`, 
                  padding: '4px 10px', 
                  borderRadius: '6px', 
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = bgHover}
                onMouseLeave={(e) => e.currentTarget.style.background = bgNormal}
                onClick={() => seekToFrame(range.start)}
                title="Click to jump to this action"
              >
                <strong style={{ color: skillColor }}>Player {range.trackId}:</strong> {range.start} - {range.end}
              </div>
            )})}
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
              <strong>FPS:</strong> <span style={{ marginLeft: '0.5rem', color: '#4ade80' }}>{state.videoMetadata?.fps || 'Detecting...'}</span>
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
          <h2>Annotations</h2>
          
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <button className="btn outline" style={{ flex: 1, fontSize: '0.85rem' }} onClick={handleUndo} title="Undo last action">
              Undo
            </button>
            <button className="btn outline" style={{ flex: 1, fontSize: '0.85rem', borderColor: 'var(--color-attack)', color: 'var(--color-attack)' }} onClick={handleResetRally} title="Reset all manual annotations for this video">
              Reset Rally
            </button>
          </div>

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
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}>
                          <span className={`badge ${skillName}`} style={{ flexShrink: 0 }}>{skillName}</span>
                          {event.player_id !== undefined && (
                             <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-attack)', flexShrink: 0 }}>ID: {event.player_id}</span>
                          )}
                        </div>
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

        </div>

      </div>
    </div>
  );
}

export default App;
