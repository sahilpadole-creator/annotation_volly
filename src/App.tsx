import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Download, Settings, Trash2, AlertTriangle, AlertCircle, FileVideo, Video } from 'lucide-react';
import type { AppState, SkillLabel } from './types';
import { exportToJSON, exportToXML } from './utils/exportUtils';
import './index.css';

const SKILL_MAP: Record<string, { label: SkillLabel; classId: number }> = {
  '1': { label: 'toss', classId: 0 },
  '2': { label: 'serve', classId: 1 },
  '3': { label: 'reception', classId: 2 },
  '4': { label: 'set', classId: 3 },
  '5': { label: 'dig', classId: 4 },
  '6': { label: 'attack', classId: 5 } // Combined attack/block
};

function App() {
  const [, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [state, setState] = useState<AppState>({
    videoMetadata: null,
    rally: { start_frame: null, end_frame: null },
    events: [],
    currentFrame: 0,
  });

  const videoRef = useRef<HTMLVideoElement>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('volleyball_annotations');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.state) {
          setState(parsed.state);
        }
      } catch (e) {
        console.error("Failed to parse local storage", e);
      }
    }
  }, []);

  // Autosave
  useEffect(() => {
    if (state.videoMetadata) {
      localStorage.setItem('volleyball_annotations', JSON.stringify({ state }));
    }
  }, [state]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      
      // We will parse metadata once video is loaded
      const defaultFps = 30; // We can add an input for this later
      setState(prev => ({
        ...prev,
        videoMetadata: {
          filename: file.name,
          fps: defaultFps,
          width: 0,
          height: 0,
          duration: 0,
          frame_count: 0
        }
      }));
    }
  };

  const handleVideoLoaded = () => {
    if (videoRef.current && state.videoMetadata) {
      const v = videoRef.current;
      const duration = v.duration;
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
    
    // Convert frame to time
    const time = safeFrame / state.videoMetadata.fps;
    videoRef.current.currentTime = time;
    setState(prev => ({ ...prev, currentFrame: safeFrame }));
  }, [state.videoMetadata]);

  const handleTimeUpdate = () => {
    if (!videoRef.current || !state.videoMetadata) return;
    // Calculate current frame based on time
    const frame = Math.round(videoRef.current.currentTime * state.videoMetadata.fps);
    if (frame !== state.currentFrame) {
      setState(prev => ({ ...prev, currentFrame: frame }));
    }
  };

  const addEvent = (skillInfo: { label: SkillLabel; classId: number }) => {
    setState(prev => {
      // Remove any existing event at this frame
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
      // Ignore if typing in input
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

  // Validation
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

    const sorted = [...state.events].sort((a, b) => a.frame - b.frame);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].frame - sorted[i-1].frame < 3) {
        warnings.push({ 
          type: 'warning', 
          msg: `Events at frames ${sorted[i-1].frame} and ${sorted[i].frame} are < 3 frames apart.`
        });
      }
    }
    
    return warnings;
  };

  const warnings = getValidationWarnings();

  if (!videoUrl) {
    return (
      <div className="app-container" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', maxWidth: '500px' }}>
          <Video size={48} style={{ color: 'var(--primary)', marginBottom: '1rem' }} />
          <h1 style={{ marginBottom: '1rem' }}>Volleyball Annotator</h1>
          <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>Upload a rally video to start annotating skills and touches.</p>
          
          <label className="upload-area" style={{ display: 'block' }}>
            <Upload size={32} style={{ marginBottom: '1rem', color: 'var(--primary)' }} />
            <div><strong>Drag & Drop</strong> or click to select MP4</div>
            <input type="file" accept="video/mp4" onChange={handleFileUpload} style={{ display: 'none' }} />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* MAIN CONTENT */}
      <div className="main-content">
        <div className="glass-panel video-wrapper">
          <video 
            ref={videoRef} 
            src={videoUrl} 
            onLoadedMetadata={handleVideoLoaded}
            onTimeUpdate={handleTimeUpdate}
            controls={false} // Custom controls
          />
          {/* Tracking Canvas Overlay could go here */}
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
            
            <div style={{ marginLeft: 'auto', fontFamily: 'monospace', fontSize: '1.2rem' }}>
              Frame: {state.currentFrame} / {state.videoMetadata?.frame_count || 0}
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

      {/* SIDEBAR */}
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
            <div><span className="hotkey">←/→</span> Step Frame</div>
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
            <button className="btn" style={{ flex: 1 }} onClick={() => {
              if (state.videoMetadata) exportToJSON(state.videoMetadata, state.rally, state.events);
            }} disabled={!state.videoMetadata || warnings.some(w => w.type === 'error')}>
              <Download size={16} /> JSON
            </button>
            <button className="btn outline" style={{ flex: 1 }} onClick={() => {
              if (state.videoMetadata) exportToXML(state.videoMetadata, state.rally, state.events);
            }} disabled={!state.videoMetadata || warnings.some(w => w.type === 'error')}>
              <Download size={16} /> XML
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;
