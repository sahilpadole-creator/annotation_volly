/** Probe whether the browser can decode this file (metadata load). */
export function probeVideoFilePlayability(file: File, timeoutMs = 12_000): Promise<boolean> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(ok);
    };

    const timer = window.setTimeout(() => finish(false), timeoutMs);
    video.onloadedmetadata = () => finish(video.videoWidth > 0 && video.videoHeight > 0);
    video.onerror = () => finish(false);
    video.src = url;
  });
}

/** GPU-server H.264 transcode (same file used for playback + inference). */
export async function fetchGpuH264Video(file: File, apiBase: string): Promise<{ blob: Blob; filename: string }> {
  const form = new FormData();
  form.append('video', file, file.name);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 600_000);
  try {
    const res = await fetch(`${apiBase}/api/video/preview`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `GPU H.264 transcode failed (${res.status})`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const stem = file.name.replace(/\.[^/.]+$/, '');
    const filename = match?.[1] ?? `${stem}_h264.mp4`;
    return { blob, filename };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/** True when the file was already exported/converted as H.264 (e.g. after inference). */
export function looksLikeH264Filename(name: string): boolean {
  return /_h264\.(mp4|mov|m4v)$/i.test(name);
}

type FFmpegInstance = import('@ffmpeg/ffmpeg').FFmpeg;
let ffmpegSingleton: FFmpegInstance | null = null;
let ffmpegLoadPromise: Promise<FFmpegInstance> | null = null;

async function getBrowserFfmpeg(): Promise<FFmpegInstance> {
  if (ffmpegSingleton?.loaded) return ffmpegSingleton;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ffmpeg = new FFmpeg();
    // Single-thread core: works on GitHub Pages without COOP/COEP SharedArrayBuffer.
    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegSingleton = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await ffmpegLoadPromise;
  } catch (err) {
    ffmpegLoadPromise = null;
    throw err;
  }
}

/**
 * GitHub Pages / offline: play as-is when the browser can decode it;
 * otherwise re-encode MPEG-4 Part 2 (mp4v) → H.264 in the browser via ffmpeg.wasm.
 */
export async function ensureBrowserPlayableViaWasm(
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<File> {
  if (looksLikeH264Filename(file.name)) return file;

  const directOk = await probeVideoFilePlayability(file, 6_000);
  if (directOk) return file;

  const ffmpeg = await getBrowserFfmpeg();
  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)));
  };
  ffmpeg.on('progress', progressHandler);

  const ext = (file.name.match(/\.[^/.]+$/)?.[0] || '.mp4').toLowerCase();
  const inputName = `input${ext}`;
  const outputName = 'output_h264.mp4';
  const stem = file.name.replace(/\.[^/.]+$/, '').replace(/_h264$/i, '');
  const outFilename = `${stem}_h264.mp4`;

  try {
    const { fetchFile } = await import('@ffmpeg/util');
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    // ultrafast keeps large rally clips usable in-browser (mp4v → h264).
    await ffmpeg.exec([
      '-i', inputName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outputName,
    ]);
    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    // Copy into a plain ArrayBuffer-backed view (avoids SharedArrayBuffer typing issues).
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new File([copy], outFilename, { type: 'video/mp4' });
  } finally {
    ffmpeg.off('progress', progressHandler);
    try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }
  }
}

/**
 * Return a browser-playable H.264 File. Uses original when Chrome can decode it;
 * otherwise transcodes on the GPU server (fast ffmpeg). Same file for inference + UI.
 * Skips re-encode when the name already ends with `_h264.mp4` (inference export).
 */
export async function ensureGpuH264File(file: File, apiBase: string): Promise<File> {
  if (looksLikeH264Filename(file.name)) return file;

  const directOk = await probeVideoFilePlayability(file);
  if (directOk) return file;

  const { blob, filename } = await fetchGpuH264Video(file, apiBase);
  return new File([blob], filename, { type: 'video/mp4' });
}

/** @deprecated Use ensureGpuH264File — kept for compatibility */
export async function fetchBrowserVideoPreview(file: File, apiBase: string): Promise<Blob> {
  const { blob } = await fetchGpuH264Video(file, apiBase);
  return blob;
}

/** Run async work on a list with limited parallelism (avoids flooding the GPU tunnel). */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const i = nextIndex;
      nextIndex += 1;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
