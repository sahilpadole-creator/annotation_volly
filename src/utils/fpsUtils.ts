import * as MP4Box from 'mp4box';

export const detectVideoFps = (file: File): Promise<number | null> => {
  return new Promise((resolve) => {
    const mp4boxfile = MP4Box.createFile();
    
    mp4boxfile.onReady = (info: any) => {
      const videoTrack = info.videoTracks[0];
      if (videoTrack && videoTrack.nb_samples && videoTrack.duration && videoTrack.timescale) {
        let fps = videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale);
        // Round to 2 decimal places to handle common floating point representations (e.g. 29.97002997 -> 29.97)
        fps = Math.round(fps * 100) / 100;
        resolve(fps);
      } else {
        resolve(null);
      }
    };

    mp4boxfile.onError = (e: any) => {
      console.error("MP4Box Error:", e);
      resolve(null);
    };

    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        const buffer = e.target.result as ArrayBuffer;
        (buffer as any).fileStart = 0;
        mp4boxfile.appendBuffer(buffer as any);
        mp4boxfile.flush();
      } else {
        resolve(null);
      }
    };
    
    // Read up to 50MB which is more than enough for individual rally clips
    // If the moov atom is at the end of a very large file, this might fail,
    // but rallies are short so 50MB usually covers the entire file.
    const slice = file.slice(0, 50 * 1024 * 1024);
    reader.readAsArrayBuffer(slice);
  });
};
