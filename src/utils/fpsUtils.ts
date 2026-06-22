import * as MP4Box from 'mp4box';

export const detectVideoFps = (file: File): Promise<number | null> => {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val: number | null) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };

    // Safety timeout: if we can't parse the FPS within 2000ms, just fallback to default
    setTimeout(() => {
      safeResolve(null);
    }, 2000);

    const mp4boxfile = MP4Box.createFile();
    
    mp4boxfile.onReady = (info: any) => {
      const videoTrack = info.videoTracks[0];
      if (videoTrack && videoTrack.nb_samples && videoTrack.duration && videoTrack.timescale) {
        let fps = videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale);
        // Round to 2 decimal places to handle common floating point representations (e.g. 29.97002997 -> 29.97)
        fps = Math.round(fps * 100) / 100;
        safeResolve(fps);
      } else {
        safeResolve(null);
      }
    };

    mp4boxfile.onError = (e: any) => {
      console.error("MP4Box Error:", e);
      safeResolve(null);
    };

    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        const buffer = e.target.result as ArrayBuffer;
        (buffer as any).fileStart = 0;
        mp4boxfile.appendBuffer(buffer as any);
        mp4boxfile.flush();
      } else {
        safeResolve(null);
      }
    };
    
    // For short rally clips (typically <20MB), we can safely read the entire file
    // to guarantee we find the moov atom even if it's at the end of the file.
    reader.readAsArrayBuffer(file);
  });
};
