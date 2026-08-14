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

/**
 * Return a browser-playable H.264 File. Uses original when Chrome can decode it;
 * otherwise transcodes on the GPU server (fast ffmpeg). Same file for inference + UI.
 */
export async function ensureGpuH264File(file: File, apiBase: string): Promise<File> {
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
