/**
 * Client-side YOLO ball-tracking post-processing for the annotator.
 * Removes static/frozen boxes, trajectory outliers, and leg/head false positives.
 */

export type BallBox = [number, number, number, number];

export type BallPrediction = {
  frame: number;
  box?: number[] | BallBox;
  conf?: number;
  source?: string;
  /** Set on detections removed by a post-process filter (for overlay highlighting). */
  rejectReason?: string;
};

export type BallPostprocessConfig = {
  staticMinFrames: number;
  staticEpsPx: number;
  /** Short frozen bursts (e.g. 4 frames on a leg) — lower than staticMinFrames. */
  staticBurstMinFrames: number;
  historyWindow: number;
  outlierJumpPx: number;
  outlierReturnPx: number;
  outlierLookahead: number;
  /** Max frames in a wrong cluster sandwiched between two good tracks. */
  maxSpikeClusterFrames: number;
  minAnchorFrames: number;
  spikeIsolationPx: number;
  anchorContinuePx: number;
  /** Min max(prev,next) jump to flag a 1-frame spike. */
  neighborSpikeMaxPx: number;
  /** Min sum of in+out jumps (catches spikes where one side is ~100px). */
  neighborSpikeSumPx: number;
  /** Max gap between prev and next when the middle frame is a spike. */
  neighborContinuePx: number;
  /** Look ahead up to N frames for next detection (handles missed frames). */
  neighborSpikeMaxGap: number;
  /** Extra bridge allowance per missing frame between prev and next. */
  neighborContinuePerGapPx: number;
  /** Shorter static burst in top-of-frame zone, only if isolated from track. */
  topCornerStaticMinFrames: number;
  topCornerYFrac: number;
  /** Skip static-burst removal when prev/next frames continue the same track. */
  staticTrackContinuePx: number;
  /** Skip top static removal when a neighbor continues the same track. */
  topTrackContinuePx: number;
  /** Min prior removals at same spot before auto-banning for rest of rally. */
  banMinOccurrences: number;
  /** Match radius (px) when comparing to remembered bad coordinates. */
  banMatchPx: number;
  /**
   * Short detection clusters (no ball in video) with no nearby continuing track.
   * Catches lone false positives like a single phantom box on an empty frame.
   */
  maxOrphanFrames: number;
  /** Look this many frames away for a supporting track segment. */
  orphanSearchGap: number;
  /** Max center distance to treat a nearby segment as the same track. */
  orphanContinuePx: number;
  maxAreaRatio: number;
  minAreaRatio: number;
  maxAspectRatio: number;
  minAspectRatio: number;
  legZoneYFrac: number;
  legAreaRatio: number;
  frameWidth: number;
  frameHeight: number;
};

export const DEFAULT_BALL_POSTPROCESS_CONFIG: BallPostprocessConfig = {
  staticMinFrames: 6,
  staticEpsPx: 8,
  staticBurstMinFrames: 3,
  historyWindow: 5,
  outlierJumpPx: 180,
  outlierReturnPx: 90,
  outlierLookahead: 2,
  maxSpikeClusterFrames: 8,
  minAnchorFrames: 3,
  spikeIsolationPx: 120,
  anchorContinuePx: 100,
  neighborSpikeMaxPx: 95,
  neighborSpikeSumPx: 200,
  neighborContinuePx: 90,
  neighborSpikeMaxGap: 5,
  neighborContinuePerGapPx: 35,
  topCornerStaticMinFrames: 2,
  topCornerYFrac: 0.12,
  staticTrackContinuePx: 35,
  topTrackContinuePx: 35,
  banMinOccurrences: 2,
  banMatchPx: 18,
  maxOrphanFrames: 2,
  orphanSearchGap: 12,
  orphanContinuePx: 80,
  maxAreaRatio: 2.8,
  minAreaRatio: 0.15,
  maxAspectRatio: 2.2,
  minAspectRatio: 0.45,
  legZoneYFrac: 0.72,
  legAreaRatio: 1.6,
  frameWidth: 1280,
  frameHeight: 720,
};

type InternalFrame = {
  frame: number;
  box: BallBox | null;
  conf: number;
  source: string;
  rejected: boolean;
  rejectReason: string;
};

const boxCenter = (box: BallBox): [number, number] => {
  const [x1, y1, x2, y2] = box;
  return [(x1 + x2) / 2, (y1 + y2) / 2];
};

const boxSize = (box: BallBox): [number, number, number] => {
  const [x1, y1, x2, y2] = box;
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  return [w, h, w * h];
};

const dist = (a: [number, number], b: [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const medianPoint = (points: [number, number][]): [number, number] | null => {
  if (!points.length) return null;
  return [median(points.map((p) => p[0])), median(points.map((p) => p[1]))];
};

const isDetected = (f: InternalFrame) => f.box !== null && !f.rejected;

const recentCenters = (frames: InternalFrame[], idx: number, window: number) => {
  const pts: [number, number][] = [];
  for (let j = idx - 1; j >= 0; j--) {
    if (isDetected(frames[j]) && frames[j].box) {
      pts.unshift(boxCenter(frames[j].box!));
      if (pts.length >= window) break;
    }
  }
  return pts;
};

const forwardCenters = (frames: InternalFrame[], idx: number, lookahead: number) => {
  const pts: [number, number][] = [];
  for (let j = idx + 1; j < frames.length; j++) {
    if (isDetected(frames[j]) && frames[j].box) {
      pts.push(boxCenter(frames[j].box!));
      if (pts.length >= lookahead) break;
    }
  }
  return pts;
};

const recentAreas = (frames: InternalFrame[], idx: number, window: number) => {
  const areas: number[] = [];
  for (let j = idx - 1; j >= 0; j--) {
    if (isDetected(frames[j]) && frames[j].box) {
      areas.push(boxSize(frames[j].box!)[2]);
      if (areas.length >= window) break;
    }
  }
  return areas;
};

const isContinuingTrackRun = (
  frames: InternalFrame[],
  runStart: number,
  runEnd: number,
  continuePx: number,
): boolean => {
  const byFrame = new Map<number, number>();
  frames.forEach((f, i) => byFrame.set(f.frame, i));

  const centerAt = (frameNum: number): [number, number] | null => {
    const idx = byFrame.get(frameNum);
    if (idx === undefined) return null;
    const f = frames[idx];
    if (!f.box) return null;
    return boxCenter(f.box);
  };

  const startCenter = boxCenter(frames[runStart].box!);
  const endCenter = boxCenter(frames[runEnd - 1].box!);
  const before = centerAt(frames[runStart].frame - 1);
  const after = centerAt(frames[runEnd - 1].frame + 1);

  const continuesBefore = before !== null && dist(before, startCenter) <= continuePx;
  const continuesAfter = after !== null && dist(after, endCenter) <= continuePx;
  // Opening/closing segments: one neighbor continuing is enough (rally 36 frames 0–42).
  return continuesBefore || continuesAfter;
};

const filterStaticFrozen = (
  frames: InternalFrame[],
  cfg: BallPostprocessConfig,
  minFrames: number,
  yMax?: number,
): number => {
  let removed = 0;
  let runStart = 0;
  while (runStart < frames.length) {
    if (!isDetected(frames[runStart]) || !frames[runStart].box) {
      runStart++;
      continue;
    }
    const anchor = boxCenter(frames[runStart].box!);
    const [, anchorY] = anchor;
    if (yMax !== undefined && anchorY > yMax) {
      runStart++;
      continue;
    }
    let runEnd = runStart + 1;
    while (runEnd < frames.length) {
      const f = frames[runEnd];
      if (!isDetected(f) || !f.box) break;
      if (dist(boxCenter(f.box), anchor) > cfg.staticEpsPx) break;
      runEnd++;
    }
    if (runEnd - runStart >= minFrames) {
      const skipContinuing = yMax === undefined
        && isContinuingTrackRun(frames, runStart, runEnd, cfg.staticTrackContinuePx);

      if (!skipContinuing) {
        for (let k = runStart; k < runEnd; k++) {
          if (!frames[k].rejected) {
            frames[k].rejected = true;
            frames[k].rejectReason =
              yMax !== undefined
                ? 'top_corner_static'
                : minFrames <= cfg.staticBurstMinFrames
                  ? 'static_burst'
                  : 'static_frozen';
            removed++;
          }
        }
      }
    }
    runStart = runEnd > runStart ? runEnd : runStart + 1;
  }
  return removed;
};

/**
 * Remove a single wrong frame when prev and next agree (track continues across it).
 * Handles gaps: rally 36 frame 744 OK, 745 wrong, 746-747 missing, 748 OK.
 */
const filterNeighborSpikeFrames = (frames: InternalFrame[], cfg: BallPostprocessConfig): number => {
  const byFrame = new Map<number, number>();
  frames.forEach((f, i) => byFrame.set(f.frame, i));

  const findNextDetectedIdx = (frameNum: number): { idx: number; gap: number } | null => {
    for (let gap = 1; gap <= cfg.neighborSpikeMaxGap; gap++) {
      const idx = byFrame.get(frameNum + gap);
      if (idx === undefined) continue;
      const next = frames[idx];
      if (isDetected(next) && next.box) return { idx, gap };
    }
    return null;
  };

  let removed = 0;
  for (const f of frames) {
    if (!isDetected(f) || !f.box || f.rejected) continue;

    const prevIdx = byFrame.get(f.frame - 1);
    if (prevIdx === undefined) continue;

    const prev = frames[prevIdx];
    if (!isDetected(prev) || !prev.box) continue;

    const nextHit = findNextDetectedIdx(f.frame);
    if (!nextHit) continue;

    const next = frames[nextHit.idx];
    if (!isDetected(next) || !next.box) continue;
    const pc = boxCenter(prev.box);
    const cc = boxCenter(f.box);
    const nc = boxCenter(next.box);
    const jumpIn = dist(pc, cc);
    const jumpOut = dist(cc, nc);
    const bridge = dist(pc, nc);
    const maxJump = Math.max(jumpIn, jumpOut);
    const sumJump = jumpIn + jumpOut;
    const bridgeMax = cfg.neighborContinuePx + (nextHit.gap - 1) * cfg.neighborContinuePerGapPx;

    if (
      bridge <= bridgeMax
      && maxJump >= cfg.neighborSpikeMaxPx
      && sumJump >= cfg.neighborSpikeSumPx
    ) {
      f.rejected = true;
      f.rejectReason = nextHit.gap > 1 ? 'gap_spike' : 'neighbor_spike';
      removed++;
    }
  }
  return removed;
};

const segmentMedianCenter = (frames: InternalFrame[], indices: number[]): [number, number] | null => {
  const pts = indices
    .map((i) => frames[i].box)
    .filter((b): b is BallBox => b !== null)
    .map(boxCenter);
  return medianPoint(pts);
};

/**
 * Remove short frozen bursts in the top band only when they are isolated
 * from the surrounding track (not slow motion along the top edge).
 */
const filterIsolatedTopStaticRuns = (frames: InternalFrame[], cfg: BallPostprocessConfig): number => {
  const yMax = (cfg.frameHeight || 720) * cfg.topCornerYFrac;
  const byFrame = new Map<number, number>();
  frames.forEach((f, i) => byFrame.set(f.frame, i));

  const neighborCenter = (frameNum: number): [number, number] | null => {
    const idx = byFrame.get(frameNum);
    if (idx === undefined) return null;
    const f = frames[idx];
    if (!isDetected(f) || !f.box) return null;
    return boxCenter(f.box);
  };

  let removed = 0;
  let runStart = 0;
  while (runStart < frames.length) {
    if (!isDetected(frames[runStart]) || !frames[runStart].box) {
      runStart++;
      continue;
    }
    const anchor = boxCenter(frames[runStart].box!);
    if (anchor[1] > yMax) {
      runStart++;
      continue;
    }

    let runEnd = runStart + 1;
    while (runEnd < frames.length) {
      const f = frames[runEnd];
      if (!isDetected(f) || !f.box) break;
      if (dist(boxCenter(f.box), anchor) > cfg.staticEpsPx) break;
      runEnd++;
    }

    if (runEnd - runStart >= cfg.topCornerStaticMinFrames) {
      const runIndices = Array.from({ length: runEnd - runStart }, (_, k) => runStart + k);
      const runMed = segmentMedianCenter(frames, runIndices);
      const before = neighborCenter(frames[runStart].frame - 1);
      const after = neighborCenter(frames[runEnd - 1].frame + 1);
      const continuesBefore = before !== null && runMed !== null && dist(runMed, before) <= cfg.topTrackContinuePx;
      const continuesAfter = after !== null && runMed !== null && dist(runMed, after) <= cfg.topTrackContinuePx;

      if (!continuesBefore && !continuesAfter) {
        for (let k = runStart; k < runEnd; k++) {
          if (!frames[k].rejected) {
            frames[k].rejected = true;
            frames[k].rejectReason = 'top_corner_static';
            removed++;
          }
        }
      }
    }

    runStart = runEnd > runStart ? runEnd : runStart + 1;
  }
  return removed;
};

type TrackSegment = {
  frameStart: number;
  frameEnd: number;
  indices: number[];
};

const buildConsecutiveSegments = (frames: InternalFrame[]): TrackSegment[] => {
  const detected = frames
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => isDetected(f) && f.box);
  const segments: TrackSegment[] = [];
  let cur: { f: InternalFrame; i: number }[] = [];
  for (const item of detected) {
    if (!cur.length || item.f.frame === cur[cur.length - 1].f.frame + 1) {
      cur.push(item);
    } else {
      if (cur.length) {
        segments.push({
          frameStart: cur[0].f.frame,
          frameEnd: cur[cur.length - 1].f.frame,
          indices: cur.map((c) => c.i),
        });
      }
      cur = [item];
    }
  }
  if (cur.length) {
    segments.push({
      frameStart: cur[0].f.frame,
      frameEnd: cur[cur.length - 1].f.frame,
      indices: cur.map((c) => c.i),
    });
  }
  return segments;
};

/**
 * Remove short lone clusters with no supporting track nearby.
 * Example: frame 85 has a box but no ball, and surrounding frames are empty /
 * far away — previous filters need neighbors or a long static run, so this
 * catches the "no ball but box" case.
 */
const filterIsolatedOrphanClusters = (frames: InternalFrame[], cfg: BallPostprocessConfig): number => {
  const segments = buildConsecutiveSegments(frames);
  let removed = 0;

  for (let s = 0; s < segments.length; s++) {
    const cur = segments[s];
    if (cur.indices.length > cfg.maxOrphanFrames) continue;

    const curMed = segmentMedianCenter(frames, cur.indices);
    if (!curMed) continue;

    let continuesPrev = false;
    let continuesNext = false;

    for (let p = s - 1; p >= 0; p--) {
      const prev = segments[p];
      const gap = cur.frameStart - prev.frameEnd;
      if (gap > cfg.orphanSearchGap) break;
      const prevMed = segmentMedianCenter(frames, prev.indices);
      if (prevMed && dist(curMed, prevMed) <= cfg.orphanContinuePx) {
        continuesPrev = true;
        break;
      }
    }

    for (let n = s + 1; n < segments.length; n++) {
      const next = segments[n];
      const gap = next.frameStart - cur.frameEnd;
      if (gap > cfg.orphanSearchGap) break;
      const nextMed = segmentMedianCenter(frames, next.indices);
      if (nextMed && dist(curMed, nextMed) <= cfg.orphanContinuePx) {
        continuesNext = true;
        break;
      }
    }

    if (continuesPrev || continuesNext) continue;

    for (const idx of cur.indices) {
      if (!frames[idx].rejected) {
        frames[idx].rejected = true;
        frames[idx].rejectReason = 'isolated_orphan';
        removed++;
      }
    }
  }
  return removed;
};

/**
 * Remove short wrong clusters sandwiched between two agreeing tracks.
 * Rally 36 example: frames 283-285 OK, 286-289 frozen wrong corner, 290+ OK again.
 */
const filterSandwichedSpikeClusters = (frames: InternalFrame[], cfg: BallPostprocessConfig): number => {
  const segments = buildConsecutiveSegments(frames);
  let removed = 0;

  for (let s = 1; s < segments.length - 1; s++) {
    const prev = segments[s - 1];
    const cur = segments[s];
    const next = segments[s + 1];

    const curLen = cur.indices.length;
    if (curLen > cfg.maxSpikeClusterFrames) continue;
    if (prev.indices.length < cfg.minAnchorFrames || next.indices.length < cfg.minAnchorFrames) continue;

    const prevMed = segmentMedianCenter(frames, prev.indices);
    const curMed = segmentMedianCenter(frames, cur.indices);
    const nextMed = segmentMedianCenter(frames, next.indices);
    if (!prevMed || !curMed || !nextMed) continue;

    // Real ball track continues across the sandwich (A and C agree).
    if (dist(prevMed, nextMed) > cfg.anchorContinuePx) continue;

    // Spike cluster is isolated from both neighbors (not a real move).
    if (dist(curMed, prevMed) < cfg.spikeIsolationPx) continue;
    if (dist(curMed, nextMed) < cfg.spikeIsolationPx) continue;

    for (const idx of cur.indices) {
      if (!frames[idx].rejected) {
        frames[idx].rejected = true;
        frames[idx].rejectReason = 'sandwiched_spike';
        removed++;
      }
    }
  }
  return removed;
};

const filterBodyPartHeuristics = (frames: InternalFrame[], cfg: BallPostprocessConfig): number => {
  let removed = 0;
  const fh = cfg.frameHeight || 720;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!isDetected(f) || !f.box || f.rejected) continue;

    const [w, h, area] = boxSize(f.box);
    const aspect = w / h;
    const [, cy] = boxCenter(f.box);
    const refAreas = recentAreas(frames, i, cfg.historyWindow);
    const refArea = refAreas.length ? median(refAreas) : area;

    if (aspect > cfg.maxAspectRatio || aspect < cfg.minAspectRatio) {
      f.rejected = true;
      f.rejectReason = 'bad_aspect';
      removed++;
      continue;
    }
    if (area > refArea * cfg.maxAreaRatio) {
      f.rejected = true;
      f.rejectReason = 'too_large';
      removed++;
      continue;
    }
    if (refAreas.length && area < refArea * cfg.minAreaRatio) {
      f.rejected = true;
      f.rejectReason = 'too_small';
      removed++;
      continue;
    }
    if (cy >= fh * cfg.legZoneYFrac && area >= refArea * cfg.legAreaRatio) {
      f.rejected = true;
      f.rejectReason = 'leg_zone';
      removed++;
    }
  }
  return removed;
};

const filterTrajectoryOutliers = (frames: InternalFrame[], cfg: BallPostprocessConfig): number => {
  let removed = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!isDetected(f) || !f.box || f.rejected) continue;

    const history = recentCenters(frames, i, cfg.historyWindow);
    if (history.length < Math.max(3, cfg.historyWindow - 1)) continue;

    const med = medianPoint(history);
    if (!med) continue;

    const jump = dist(boxCenter(f.box), med);
    if (jump < cfg.outlierJumpPx) continue;

    const before = history[history.length - 1];
    const afterPts = forwardCenters(frames, i, cfg.outlierLookahead);
    const returnsAfter = afterPts.length > 0
      && afterPts.every((p) => dist(p, med) <= cfg.outlierReturnPx);
    const returnsBefore = dist(before, med) <= cfg.outlierReturnPx;

    if (returnsBefore && returnsAfter) {
      f.rejected = true;
      f.rejectReason = 'trajectory_outlier';
      removed++;
    }
  }
  return removed;
};

type BanCluster = {
  center: [number, number];
  count: number;
};

/** Cluster centers from already-rejected boxes (rally-local false-positive memory). */
const buildBanClusters = (frames: InternalFrame[], clusterPx: number): BanCluster[] => {
  const clusters: BanCluster[] = [];
  for (const f of frames) {
    if (!f.rejected || !f.box) continue;
    const c = boxCenter(f.box);
    const existing = clusters.find((cl) => dist(cl.center, c) <= clusterPx);
    if (existing) {
      existing.count += 1;
      existing.center = [
        (existing.center[0] * (existing.count - 1) + c[0]) / existing.count,
        (existing.center[1] * (existing.count - 1) + c[1]) / existing.count,
      ];
    } else {
      clusters.push({ center: c, count: 1 });
    }
  }
  return clusters;
};

/**
 * Remove detections that land on coordinates already flagged earlier in this rally.
 * Catches lone reappearances (e.g. frame 779 at phantom 505,28).
 */
const filterBanlistMemory = (
  frames: InternalFrame[],
  cfg: BallPostprocessConfig,
): { removed: number; bannedClusters: number } => {
  const clusters = buildBanClusters(frames, cfg.banMatchPx);
  const banned = clusters.filter((c) => c.count >= cfg.banMinOccurrences);
  let removed = 0;

  for (const f of frames) {
    if (!isDetected(f) || !f.box || f.rejected) continue;
    const cc = boxCenter(f.box);
    const hit = banned.find((b) => dist(cc, b.center) <= cfg.banMatchPx);
    if (hit) {
      f.rejected = true;
      f.rejectReason = 'banlist_memory';
      removed++;
    }
  }
  return { removed, bannedClusters: banned.length };
};

export type BallPostprocessStats = {
  input_detections: number;
  neighbor_spike: number;
  static_burst: number;
  top_corner_static: number;
  static_frozen: number;
  isolated_orphan: number;
  sandwiched_spike: number;
  body_part: number;
  trajectory_outlier: number;
  banlist_memory: number;
  banned_clusters: number;
  output_detections: number;
  total_removed: number;
};

export const predictionsToInternalFrames = (predictions: BallPrediction[]): InternalFrame[] => {
  const byFrame = new Map<number, InternalFrame>();
  for (const item of predictions) {
    const frame = Number(item.frame);
    if (Number.isNaN(frame)) continue;
    const raw = item.box;
    if (!raw || raw.length < 4) {
      byFrame.set(frame, { frame, box: null, conf: 0, source: '', rejected: false, rejectReason: '' });
      continue;
    }
    byFrame.set(frame, {
      frame,
      box: [Number(raw[0]), Number(raw[1]), Number(raw[2]), Number(raw[3])],
      conf: Number(item.conf) || 0,
      source: item.source || 'yolo',
      rejected: false,
      rejectReason: '',
    });
  }
  return [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
};

export const applyBallPostprocess = (
  predictions: BallPrediction[],
  cfg: Partial<BallPostprocessConfig> = {},
): { predictions: BallPrediction[]; rejected: BallPrediction[]; stats: BallPostprocessStats } => {
  const fullCfg = { ...DEFAULT_BALL_POSTPROCESS_CONFIG, ...cfg };
  const frames = predictionsToInternalFrames(predictions);

  const stats: BallPostprocessStats = {
    input_detections: frames.filter((f) => f.box !== null).length,
    neighbor_spike: 0,
    static_burst: 0,
    top_corner_static: 0,
    static_frozen: 0,
    isolated_orphan: 0,
    sandwiched_spike: 0,
    body_part: 0,
    trajectory_outlier: 0,
    banlist_memory: 0,
    banned_clusters: 0,
    output_detections: 0,
    total_removed: 0,
  };

  stats.neighbor_spike = filterNeighborSpikeFrames(frames, fullCfg);
  stats.static_burst = filterStaticFrozen(frames, fullCfg, fullCfg.staticBurstMinFrames);
  stats.top_corner_static = filterIsolatedTopStaticRuns(frames, fullCfg);
  stats.static_frozen = filterStaticFrozen(frames, fullCfg, fullCfg.staticMinFrames);
  stats.isolated_orphan = filterIsolatedOrphanClusters(frames, fullCfg);
  stats.sandwiched_spike = filterSandwichedSpikeClusters(frames, fullCfg);
  stats.body_part = filterBodyPartHeuristics(frames, fullCfg);
  stats.trajectory_outlier = filterTrajectoryOutliers(frames, fullCfg);

  const banResult = filterBanlistMemory(frames, fullCfg);
  stats.banlist_memory = banResult.removed;
  stats.banned_clusters = banResult.bannedClusters;
  stats.output_detections = frames.filter((f) => isDetected(f)).length;
  stats.total_removed = stats.input_detections - stats.output_detections;

  const filtered: BallPrediction[] = [];
  const rejected: BallPrediction[] = [];
  for (const f of frames) {
    if (!f.box) continue;
    const [x1, y1, x2, y2] = f.box;
    const roundedBox: BallBox = [
      Math.round(x1 * 100) / 100,
      Math.round(y1 * 100) / 100,
      Math.round(x2 * 100) / 100,
      Math.round(y2 * 100) / 100,
    ];
    const entry: BallPrediction = {
      frame: f.frame,
      box: roundedBox,
      conf: Math.round(f.conf * 10000) / 10000,
      source: f.source || 'yolo',
    };
    if (isDetected(f)) {
      filtered.push(entry);
    } else if (f.rejected) {
      rejected.push({ ...entry, rejectReason: f.rejectReason || 'removed' });
    }
  }
  return { predictions: filtered, rejected, stats };
};
