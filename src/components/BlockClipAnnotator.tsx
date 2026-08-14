import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileVideo,
  Home,
  Pause,
  Play,
  Trash2,
  Upload,
} from 'lucide-react';
import { detectVideoFps } from '../utils/fpsUtils';
import type { VideoMetadata } from '../types';
import {
  BLOCK_CLIP_LABELS,
  type BlockClipItem,
  type BlockClipLabel,
  type BlockClipMarkers,
  countSetMarkers,
  exportBlockClipBatchZip,
  generateBlockClipXml,
  isBlockClipComplete,
  loadBlockClipPairsFromFiles,
  loadBlockClipPairsFromZip,
  loadBlockClipState,
  persistBlockClipState,
} from '../utils/blockClipAnnotation';

type Props = {
  onBack: () => void;
};

const frameToTime = (frame: number, fps: number): number => (frame + 0.5) / fps;

/** Frame-step playback speed when Play is active (frames per second). */
const CLIP_PLAYBACK_FPS = 3;

const getVideoMetadata = async (file: File): Promise<VideoMetadata> => {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video metadata'));
    });
    const detectedFps = await detectVideoFps(file).catch(() => null);
    const fps = detectedFps ?? 30;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const frame_count = Math.max(1, Math.round(duration * fps));
    return {
      filename: file.name,
      fps,
      width: video.videoWidth || 1280,
      height: video.videoHeight || 720,
      duration,
      frame_count,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
};

export default function BlockClipAnnotator({ onBack }: Props) {
  const [items, setItems] = useState<BlockClipItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  const currentIndexRef = useRef(currentIndex);
  const currentFrameRef = useRef(currentFrame);
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    currentFrameRef.current = currentFrame;
  }, [currentFrame]);

  const currentItem = items[currentIndex] ?? null;

  const stopStepPlay = useCallback(() => {
    if (stepIntervalRef.current) {
      clearInterval(stepIntervalRef.current);
      stepIntervalRef.current = null;
    }
    setIsPlaying(false);
    videoRef.current?.pause();
  }, []);

  const seekToFrame = useCallback((frame: number, pauseStep = true) => {
    const item = itemsRef.current[currentIndexRef.current];
    const meta = item?.videoMetadata;
    if (!meta || !videoRef.current) return;
    if (pauseStep) stopStepPlay();
    const safe = Math.max(0, Math.min(frame, meta.frame_count - 1));
    videoRef.current.pause();
    videoRef.current.currentTime = frameToTime(safe, meta.fps);
    setCurrentFrame(safe);
    currentFrameRef.current = safe;
  }, [stopStepPlay]);

  const startStepPlay = useCallback(() => {
    const item = itemsRef.current[currentIndexRef.current];
    const meta = item?.videoMetadata;
    if (!meta || !videoRef.current) return;

    stopStepPlay();

    if (currentFrameRef.current >= meta.frame_count - 1) {
      const video = videoRef.current;
      video.pause();
      video.currentTime = frameToTime(0, meta.fps);
      setCurrentFrame(0);
      currentFrameRef.current = 0;
    }

    setIsPlaying(true);
    stepIntervalRef.current = setInterval(() => {
      const curItem = itemsRef.current[currentIndexRef.current];
      const curMeta = curItem?.videoMetadata;
      const video = videoRef.current;
      if (!curMeta || !video) return;

      const next = currentFrameRef.current + 1;
      if (next >= curMeta.frame_count) {
        if (stepIntervalRef.current) {
          clearInterval(stepIntervalRef.current);
          stepIntervalRef.current = null;
        }
        setIsPlaying(false);
        return;
      }

      video.pause();
      video.currentTime = frameToTime(next, curMeta.fps);
      setCurrentFrame(next);
      currentFrameRef.current = next;
    }, 1000 / CLIP_PLAYBACK_FPS);
  }, [stopStepPlay]);

  const togglePlayPause = useCallback(() => {
    if (stepIntervalRef.current) stopStepPlay();
    else startStepPlay();
  }, [startStepPlay, stopStepPlay]);

  const loadItemAtIndex = useCallback(async (index: number, playlist: BlockClipItem[]) => {
    const item = playlist[index];
    if (!item?.file) return;

    let meta = item.videoMetadata;
    if (!meta) {
      meta = await getVideoMetadata(item.file);
      setItems((prev) => prev.map((p, i) => (i === index ? { ...p, videoMetadata: meta! } : p)));
    }

    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(item.file);
    setVideoUrl(url);
    setCurrentIndex(index);
    setCurrentFrame(0);
    currentFrameRef.current = 0;
    stopStepPlay();
  }, [videoUrl, stopStepPlay]);

  useEffect(() => {
    const saved = loadBlockClipState();
    if (!saved?.items.length) return;
    const restored: BlockClipItem[] = saved.items.map((row) => ({
      ...row,
      markers: { ...row.markers },
    }));
    setItems(restored);
    setCurrentIndex(Math.min(saved.currentIndex, restored.length - 1));
  }, []);

  useEffect(() => {
    if (!items.length) return;
    persistBlockClipState(items, currentIndex);
  }, [items, currentIndex]);

  useEffect(() => {
    if (!items.length || !items[currentIndex]?.file) return;
    if (items[currentIndex].videoMetadata && videoUrl) return;
    loadItemAtIndex(currentIndex, items);
  }, [items, currentIndex, loadItemAtIndex, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentItem?.videoMetadata) return;

    const onTimeUpdate = () => {
      const meta = currentItem.videoMetadata!;
      const frame = Math.floor(video.currentTime * meta.fps);
      const safe = Math.max(0, Math.min(frame, meta.frame_count - 1));
      setCurrentFrame(safe);
      currentFrameRef.current = safe;
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    return () => video.removeEventListener('timeupdate', onTimeUpdate);
  }, [currentItem?.videoMetadata, videoUrl]);

  useEffect(() => () => {
    if (stepIntervalRef.current) clearInterval(stepIntervalRef.current);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  const setMarker = useCallback((label: BlockClipLabel, frame: number) => {
    setItems((prev) => prev.map((item, idx) => {
      if (idx !== currentIndexRef.current) return item;
      const next: BlockClipMarkers = { ...item.markers };
      for (const { key } of BLOCK_CLIP_LABELS) {
        if (key === label) {
          next[key] = frame;
        } else if (next[key] === frame) {
          next[key] = null;
        }
      }
      return { ...item, markers: next };
    }));
  }, []);

  const clearMarkers = useCallback(() => {
    setItems((prev) => prev.map((item, idx) => {
      if (idx !== currentIndexRef.current) return item;
      return {
        ...item,
        markers: { attack_before: null, attack: null, block: null, end_block: null },
      };
    }));
  }, []);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    const zipFile = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip') ? files[0] : null;
    const { items: loaded } = zipFile
      ? await loadBlockClipPairsFromZip(zipFile)
      : await loadBlockClipPairsFromFiles(files);

    if (!loaded.length) {
      window.alert('No MP4 clips found. Upload a folder or ZIP with matching .mp4 and .xml files.');
      return;
    }

    const withMeta: BlockClipItem[] = [];
    for (const item of loaded) {
      if (!item.file) continue;
      const meta = await getVideoMetadata(item.file);
      withMeta.push({ ...item, videoMetadata: meta });
    }

    setItems(withMeta);
    setCurrentIndex(0);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl('');
    await loadItemAtIndex(0, withMeta);
  };

  const changeClip = useCallback((delta: number) => {
    const next = currentIndexRef.current + delta;
    const playlist = itemsRef.current;
    if (next < 0 || next >= playlist.length) return;
    loadItemAtIndex(next, playlist);
  }, [loadItemAtIndex]);

  const exportCurrentXml = () => {
    if (!currentItem?.videoMetadata) return;
    const xml = generateBlockClipXml(currentItem.videoMetadata, currentItem.markers, currentItem.sourceXml);
    const blob = new Blob([xml], { type: 'text/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentItem.stem.split('/').pop()}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportBatch = async () => {
    setIsExporting(true);
    try {
      const blob = await exportBlockClipBatchZip(items);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `block_clip_annotations_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  const completedCount = useMemo(
    () => items.filter((item) => isBlockClipComplete(item.markers)).length,
    [items],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const item = itemsRef.current[currentIndexRef.current];
      const meta = item?.videoMetadata;
      if (!meta) return;

      const label = BLOCK_CLIP_LABELS.find((l) => l.hotkey === e.key);
      if (label) {
        e.preventDefault();
        setMarker(label.key, currentFrame);
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === ',') {
        e.preventDefault();
        seekToFrame(currentFrame - 1);
      } else if (e.key === 'ArrowRight' || e.key === '.') {
        e.preventDefault();
        seekToFrame(currentFrame + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        changeClip(-1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        changeClip(1);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        clearMarkers();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [changeClip, clearMarkers, currentFrame, seekToFrame, setMarker, togglePlayPause]);

  const markerRows = BLOCK_CLIP_LABELS.map((def) => ({
    ...def,
    frame: currentItem?.markers[def.key] ?? null,
  }));

  return (
    <div className="app-container" style={{ padding: '0.75rem', gap: '0.75rem' }}>
      <div className="sidebar" style={{ minWidth: '220px', maxWidth: '280px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', paddingLeft: '0.25rem' }}>
          <img src={`${import.meta.env.BASE_URL}logo.png?v=9`} alt="Veritas Pro" style={{ width: '40px', height: '40px' }} />
          <div>
            <h1 style={{ fontSize: '1rem', margin: 0, fontWeight: 700 }}>Attack / Block Clips</h1>
            <p style={{ fontSize: '0.65rem', color: '#10b981', margin: 0, fontWeight: 700 }}>4-FRAME LABEL MODE</p>
          </div>
        </div>

        <div className="glass-panel sidebar-section" style={{ padding: '1rem' }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".mp4,.xml,.zip,video/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            id="block-clip-folder"
            type="file"
            multiple
            accept=".mp4,.xml,video/*"
            {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
            style={{ display: 'none' }}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button className="btn primary" style={{ width: '100%', marginBottom: '0.5rem' }} onClick={() => fileInputRef.current?.click()}>
            <Upload size={16} /> Upload Clips / ZIP
          </button>
          <button className="btn outline" style={{ width: '100%' }} onClick={() => document.getElementById('block-clip-folder')?.click()}>
            <FileVideo size={16} /> Upload Folder
          </button>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.75rem', lineHeight: 1.4 }}>
            Load 25f attack/block clips (.mp4 + matching .xml). Attack defaults to frame 10 from filename hints.
          </p>
        </div>

        <div className="glass-panel sidebar-section" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Clips ({currentIndex + 1}/{items.length || 0})
            </span>
            <button className="btn outline icon-only" onClick={onBack} title="Home" style={{ padding: '0.2rem 0.5rem' }}>
              <Home size={14} />
            </button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#10b981', marginBottom: '0.5rem' }}>
            Complete: {completedCount}/{items.length}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {items.map((item, index) => {
              const active = index === currentIndex;
              const done = isBlockClipComplete(item.markers);
              const partial = countSetMarkers(item.markers);
              return (
                <div
                  key={item.id}
                  onClick={() => loadItemAtIndex(index, items)}
                  style={{
                    padding: '0.55rem 0.7rem',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    background: active ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                    borderLeft: active ? '3px solid #10b981' : '3px solid transparent',
                    fontSize: '0.8rem',
                    color: active ? 'white' : 'var(--text-muted)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: done ? '#10b981' : partial > 0 ? '#f59e0b' : '#ef4444',
                    }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </span>
                    {done && <CheckCircle size={12} color="#10b981" />}
                  </div>
                  <div style={{ fontSize: '0.68rem', opacity: 0.7, marginTop: '2px' }}>
                    {partial}/4 labels
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="glass-panel sidebar-section" style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button className="btn outline" onClick={exportCurrentXml} disabled={!currentItem}>
            <Download size={14} /> Export This XML
          </button>
          <button className="btn primary" onClick={exportBatch} disabled={!items.length || isExporting}>
            <Download size={14} /> {isExporting ? 'Exporting…' : 'Export All (ZIP)'}
          </button>
        </div>
      </div>

      <div
        className="main-content"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          padding: 0,
          gap: 0,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {!currentItem ? (
          <div className="glass-panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem', margin: '0.5rem' }}>
            <FileVideo size={48} color="#10b981" />
            <h2 style={{ margin: 0 }}>Attack / Block Clip Annotator</h2>
            <p style={{ color: 'var(--text-muted)', maxWidth: '480px', textAlign: 'center', lineHeight: 1.5 }}>
              Upload reannotate clips (25 frames). Mark four key frames: attack before, attack, block, and end block.
            </p>
            <button className="btn primary" onClick={() => fileInputRef.current?.click()}>
              <Upload size={16} /> Load Clips
            </button>
            <button className="btn outline" onClick={onBack} style={{ marginTop: '0.5rem' }}>
              <ArrowLeft size={16} /> Back to Home
            </button>
          </div>
        ) : (
          <div style={{ position: 'relative', flex: 1, minHeight: 0, width: '100%', background: '#000' }}>
            <video
              ref={videoRef}
              src={videoUrl}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'block',
              }}
              onLoadedData={() => seekToFrame(currentFrame)}
            />

            {BLOCK_CLIP_LABELS.map((def) => {
              const frame = currentItem.markers[def.key];
              if (frame === null || frame !== currentFrame) return null;
              return (
                <div
                  key={def.key}
                  style={{
                    position: 'absolute',
                    top: '4.5rem',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: def.color,
                    color: 'white',
                    padding: '0.4rem 1rem',
                    borderRadius: '999px',
                    fontWeight: 700,
                    fontSize: '0.9rem',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                    zIndex: 3,
                    pointerEvents: 'none',
                  }}
                >
                  {def.title}
                </div>
              );
            })}

            {/* Top overlay — filename + label buttons */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 4,
                padding: '0.65rem 1rem',
                background: 'linear-gradient(180deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.35) 70%, transparent 100%)',
                backdropFilter: 'blur(4px)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: '1rem',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                  {currentItem.name}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.75)', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
                  Frame {currentFrame} / {(currentItem.videoMetadata?.frame_count ?? 1) - 1}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {markerRows.map((row) => (
                  <button
                    key={row.key}
                    className="btn outline"
                    onClick={() => setMarker(row.key, currentFrame)}
                    style={{
                      borderColor: row.color,
                      color: row.frame === currentFrame ? 'white' : row.color,
                      background: row.frame === currentFrame ? row.color : 'rgba(0,0,0,0.35)',
                      fontSize: '0.75rem',
                      padding: '0.35rem 0.6rem',
                      backdropFilter: 'blur(6px)',
                    }}
                    title={`${row.title} (key ${row.hotkey})`}
                  >
                    [{row.hotkey}] {row.short}
                    {row.frame !== null ? ` @${row.frame}` : ''}
                  </button>
                ))}
                <button
                  className="btn outline"
                  onClick={clearMarkers}
                  style={{
                    borderColor: 'var(--danger)',
                    color: 'var(--danger)',
                    background: 'rgba(0,0,0,0.35)',
                    fontSize: '0.75rem',
                    padding: '0.35rem 0.6rem',
                    backdropFilter: 'blur(6px)',
                  }}
                >
                  <Trash2 size={14} /> Clear
                </button>
              </div>
            </div>

            {/* Bottom overlay — timeline + scrubber on top of video */}
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                zIndex: 4,
                padding: '0.75rem 1rem 1rem',
                background: 'linear-gradient(0deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.45) 55%, transparent 100%)',
                backdropFilter: 'blur(6px)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.65rem' }}>
                <button
                  className="btn outline icon-only"
                  onClick={() => changeClip(-1)}
                  disabled={currentIndex <= 0}
                  style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)' }}
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  className="btn outline icon-only"
                  onClick={() => seekToFrame(currentFrame - 1)}
                  style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)' }}
                >
                  <ArrowLeft size={16} />
                </button>
                <button
                  className="btn outline icon-only"
                  onClick={togglePlayPause}
                  title={isPlaying ? `Pause (${CLIP_PLAYBACK_FPS} f/s)` : `Play (${CLIP_PLAYBACK_FPS} f/s)`}
                  style={{
                    background: isPlaying ? 'rgba(16, 185, 129, 0.45)' : 'rgba(0,0,0,0.35)',
                    borderColor: isPlaying ? '#10b981' : undefined,
                    backdropFilter: 'blur(6px)',
                    minWidth: '2.75rem',
                  }}
                >
                  {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.65)', minWidth: '2.5rem' }}>
                  {CLIP_PLAYBACK_FPS} f/s
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, (currentItem.videoMetadata?.frame_count ?? 1) - 1)}
                  value={currentFrame}
                  onChange={(e) => seekToFrame(Number(e.target.value))}
                  style={{ flex: 1, accentColor: '#10b981' }}
                />
                <button
                  className="btn outline icon-only"
                  onClick={() => seekToFrame(currentFrame + 1)}
                  style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)' }}
                >
                  <ArrowRight size={16} />
                </button>
                <button
                  className="btn outline icon-only"
                  onClick={() => changeClip(1)}
                  disabled={currentIndex >= items.length - 1}
                  style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)' }}
                >
                  <ChevronRight size={18} />
                </button>
              </div>

              <div
                style={{
                  position: 'relative',
                  height: '32px',
                  background: 'rgba(255,255,255,0.08)',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
              >
                {markerRows.map((row) => {
                  if (row.frame === null || !currentItem.videoMetadata) return null;
                  const pct = (row.frame / Math.max(1, currentItem.videoMetadata.frame_count - 1)) * 100;
                  return (
                    <div
                      key={row.key}
                      title={`${row.title} @ frame ${row.frame}`}
                      style={{
                        position: 'absolute',
                        left: `${pct}%`,
                        top: 0,
                        bottom: 0,
                        width: '3px',
                        background: row.color,
                        transform: 'translateX(-50%)',
                        boxShadow: `0 0 8px ${row.color}`,
                      }}
                    />
                  );
                })}
                <div
                  style={{
                    position: 'absolute',
                    left: `${(currentFrame / Math.max(1, (currentItem.videoMetadata?.frame_count ?? 1) - 1)) * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: '2px',
                    background: 'white',
                    transform: 'translateX(-50%)',
                    boxShadow: '0 0 6px rgba(255,255,255,0.8)',
                  }}
                />
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: '0.45rem',
                  fontSize: '0.72rem',
                  color: 'rgba(255,255,255,0.7)',
                  textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                }}
              >
                <span>Space play @ {CLIP_PLAYBACK_FPS} f/s · 1–4 label · ←/→ step · ↑/↓ clip</span>
                <span>{countSetMarkers(currentItem.markers)}/4 set</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
