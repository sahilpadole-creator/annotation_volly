import { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Download, Settings, Trash2, AlertTriangle, AlertCircle, FileVideo, FolderArchive, ArrowRight, ArrowLeft, CheckCircle } from 'lucide-react';
import type { AppState, SkillLabel, PlaylistItem } from './types';
import { exportToXML, exportAllToZip } from './utils/exportUtils';
import { GoogleDriveConnector } from './components/GoogleDriveConnector';
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

type PredictionLike = { frame?: number | string; label?: string; skill?: string; class_id?: number };
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
  
  const [state, setState] = useState<AppState>({
    playlist: [],
    currentPlaylistIndex: 0,
    videoMetadata: null,
    rally: { start_frame: null, end_frame: null },
    events: [],
    currentFrame: 0,
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const importPredictionsInputRef = useRef<HTMLInputElement>(null);

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
          };
        }
        return null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const sortedUniqueEvents = Array.from(
      importedEvents
        .reduce((acc, event) => acc.set(event.frame, event), new Map<number, (typeof importedEvents)[number]>())
        .values()
    ).sort((a, b) => a.frame - b.frame);

    const startFrame = payload?.rally?.start_frame ?? payload?.start_frame ?? null;
    const endFrame = payload?.rally?.end_frame ?? payload?.end_frame ?? null;

    return {
      events: sortedUniqueEvents,
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
      const merged = new Map<number, AppState['events'][number]>();
      prev.events.forEach((e) => merged.set(e.frame, e));
      events.forEach((e) => merged.set(e.frame, e));
      const mergedEvents = Array.from(merged.values()).sort((a, b) => a.frame - b.frame);

      return {
        ...prev,
        events: mergedEvents,
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
          setState({ ...parsed.state, currentFrame: 0 });
        }
      } catch (e) {
        console.error("Failed to parse local storage", e);
      }
    }
  }, []);

  // Autosave
  useEffect(() => {
    if (state.playlist.length > 0 || state.videoMetadata) {
      // Don't save Object URLs or File objects to localStorage
      const stateToSave = {
        ...state,
        playlist: state.playlist.map(item => ({ ...item, file: undefined }))
      };
      localStorage.setItem('volleyball_annotations', JSON.stringify({ state: stateToSave }));
    }
  }, [state]);

  const loadVideoIntoPlayer = (item: PlaylistItem) => {
    if (item.file) {
      const url = URL.createObjectURL(item.file);
      setVideoUrl(url);
    } else if (item.driveUrl) {
      // We will try streaming it, but Drive requires CORS headers which alt=media might not have properly.
      // Often crossOrigin="anonymous" is needed, or we might need an access token in the URL.
      setVideoUrl(item.driveUrl);
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

  const handlePlaylistFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newPlaylist: PlaylistItem[] = Array.from(files).map((file) => ({
      id: file.name + file.lastModified,
      name: file.name,
      file: file
    }));
    
    setState(prev => ({ ...prev, playlist: newPlaylist, currentPlaylistIndex: 0 }));
    loadVideoIntoPlayer(newPlaylist[0]);
  };

  const handleDrivePlaylist = (playlist: PlaylistItem[]) => {
    setState(prev => ({ ...prev, playlist, currentPlaylistIndex: 0 }));
    if (playlist.length > 0) {
      loadVideoIntoPlayer(playlist[0]);
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
        events: [...filtered, { frame: prev.currentFrame, skill: skillInfo.label, class_id: skillInfo.classId }]
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.currentFrame, seekToFrame]);

  const getValidationWarnings = () => {
    const warnings: { type: string, msg: string }[] = [];
    if (!state.videoMetadata) return warnings;

    if (state.rally.start_frame === null) warnings.push({ type: 'error', msg: 'Missing start_rally' });
    if (state.rally.end_frame === null) warnings.push({ type: 'error', msg: 'Missing end_rally' });
    
    if (state.rally.start_frame !== null && state.rally.end_frame !== null) {
      if (state.rally.end_frame < state.rally.start_frame) {
        warnings.push({ type: 'error', msg: 'end_rally is before start_rally' });
      }
    }
    
    return warnings;
  };

  const warnings = getValidationWarnings();

  if (!videoUrl) {
    return (
      <div className="landing-container">
        <div className="landing-card">
          <h1 className="landing-title">Volleyball Annotator Pro</h1>
          <p className="landing-subtitle">
            Advanced skill tracking and batch processing pipeline.<br/>
            Load individual rallies or entire match datasets to begin.
          </p>
          
          <div className="landing-grid">
            <label className="landing-option">
              <div className="icon-wrapper">
                <Upload size={32} />
              </div>
              <h3>Local Files</h3>
              <p>Drag & drop MP4 files</p>
              <input type="file" accept="video/mp4" multiple onChange={(e) => handlePlaylistFiles(e.target.files)} style={{ display: 'none' }} />
            </label>

            <div className="landing-option">
              <div className="icon-wrapper">
                <FolderArchive size={32} />
              </div>
              <h3 style={{ marginBottom: '1rem' }}>Google Drive</h3>
              <GoogleDriveConnector onPlaylistLoaded={handleDrivePlaylist} />
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
          <h2>Playlist ({state.currentPlaylistIndex + 1}/{state.playlist.length})</h2>
          
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

          <button 
            className="btn" 
            style={{ marginTop: '1rem' }}
            onClick={() => {
              saveCurrentVideoState(); // Save current before exporting
              exportAllToZip(state.playlist);
            }}
          >
            <Download size={16} /> Batch ZIP
          </button>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="main-content">
        <div className="glass-panel video-wrapper">
          <video 
            ref={videoRef} 
            src={videoUrl} 
            onLoadedMetadata={handleVideoLoaded}
            onTimeUpdate={handleTimeUpdate}
            controls={false}
            crossOrigin="anonymous" // Needed for Drive URLs if they support it
          />
        </div>

        <div className="glass-panel video-controls">
          <div className="controls-row">
            <button className="btn outline icon-only" onClick={() => seekToFrame(state.currentFrame - 5)}>-5f</button>
            <button className="btn outline icon-only" onClick={() => seekToFrame(state.currentFrame - 1)}>-1f</button>
            <button className="btn" onClick={() => {
              if (videoRef.current?.paused) videoRef.current.play();
              else videoRef.current?.pause();
            }}>
              Play / Pause
            </button>
            <button className="btn outline icon-only" onClick={() => seekToFrame(state.currentFrame + 1)}>+1f</button>
            <button className="btn outline icon-only" onClick={() => seekToFrame(state.currentFrame + 5)}>+5f</button>
            
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

        <div className="glass-panel sidebar-section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
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
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;
