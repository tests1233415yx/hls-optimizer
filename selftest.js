// Plain Node.js self-test for the pure-logic helper functions in optimize.js.
// No external test framework (none is used in this repo) — just hand-written
// assertions. Run with: node selftest.js
'use strict';

const {
  buildSpreadOffsets,
  getSourceBitDepth,
  parseIdetStats,
  isConfidentlyInterlacedFromIdet,
  isConfidentlyProgressiveFromIdet,
  isTelecineLikeIdet,
  parityFromIdet,
  fpsToRateString,
  isHdrSource,
  normalizeFieldStrategy,
  normalizeFieldParity,
  generateKeyframeTimeline,
  shouldComputeSegmentTimeline,
} = require('./optimize.js');

let passed = 0;
let failed = 0;
const failures = [];

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, label) {
  assertEqual(!!value, true, label);
}

function assertFalse(value, label) {
  assertEqual(!!value, false, label);
}

function run(label, fn) {
  try {
    fn();
  } catch (e) {
    failed++;
    failures.push(`${label}: threw ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// buildSpreadOffsets
// ---------------------------------------------------------------------------

run('buildSpreadOffsets: span <= sampleSeconds returns [0]', () => {
  assertEqual(buildSpreadOffsets(10, 10, 5, 12), [0], 'span==sampleSeconds');
  assertEqual(buildSpreadOffsets(5, 10, 5, 12), [0], 'span<sampleSeconds');
  assertEqual(buildSpreadOffsets(0, 10, 5, 12), [0], 'span==0');
});

run('buildSpreadOffsets: short span clamps to minWindows', () => {
  // approx = round(30/60) = 1, clamped up to min(5)
  const offsets = buildSpreadOffsets(30, 10, 5, 12);
  assertEqual(offsets, [0, 5, 10, 15, 20], 'span=30 sampleSeconds=10 min=5 max=12');
});

run('buildSpreadOffsets: long span clamps to maxWindows and starts at 0, sorted, unique', () => {
  const offsets = buildSpreadOffsets(720, 10, 5, 12);
  assertEqual(offsets[0], 0, 'first offset is always 0');
  assertEqual(offsets.length, 12, 'clamped to maxWindows=12');
  const sorted = [...offsets].sort((a, b) => a - b);
  assertEqual(offsets, sorted, 'offsets are sorted ascending');
  assertEqual(new Set(offsets).size, offsets.length, 'offsets are unique');
  assertTrue(offsets[offsets.length - 1] <= 720 - 10, 'last offset stays within usable span');
});

run('buildSpreadOffsets: mid span picks numWindows proportional to span/60', () => {
  // approx = round(300/60) = 5 -> within [5,12] -> numWindows = 5
  const offsets = buildSpreadOffsets(300, 10, 5, 12);
  assertEqual(offsets.length, 5, 'span=300 -> 5 windows');
  assertEqual(offsets[0], 0, 'first offset is 0');
});

// ---------------------------------------------------------------------------
// getSourceBitDepth
// ---------------------------------------------------------------------------

run('getSourceBitDepth: yuv420p (no trailing digit suffix) defaults to 8', () => {
  assertEqual(getSourceBitDepth({ pix_fmt: 'yuv420p' }), 8, 'yuv420p');
});

run('getSourceBitDepth: yuv420p10le -> 10', () => {
  assertEqual(getSourceBitDepth({ pix_fmt: 'yuv420p10le' }), 10, 'yuv420p10le');
});

run('getSourceBitDepth: yuv420p12le -> 12', () => {
  assertEqual(getSourceBitDepth({ pix_fmt: 'yuv420p12le' }), 12, 'yuv420p12le');
});

run('getSourceBitDepth: missing pix_fmt falls back to bits_per_raw_sample', () => {
  assertEqual(getSourceBitDepth({ bits_per_raw_sample: '10' }), 10, 'bits_per_raw_sample=10, no pix_fmt');
});

run('getSourceBitDepth: no stream at all defaults to 8', () => {
  assertEqual(getSourceBitDepth(null), 8, 'null videoStream');
  assertEqual(getSourceBitDepth(undefined), 8, 'undefined videoStream');
});

// ---------------------------------------------------------------------------
// parseIdetStats
// ---------------------------------------------------------------------------

const sampleIdetStderr = `
[Parsed_idet_0 @ 0x55f1a2] Repeated Fields: Neither: 400 Top: 12 Bottom: 8
[Parsed_idet_0 @ 0x55f1a2] Single frame detection: TFF: 100 BFF: 10 Progressive: 250 Undetermined: 75
[Parsed_idet_0 @ 0x55f1a2] Multi frame detection: TFF: 120 BFF: 5 Progressive: 300 Undetermined: 10
frame=  435 fps= 60 q=-0.0 Lsize=N/A time=00:00:14.50 bitrate=N/A speed=29.1x
`;

run('parseIdetStats: prefers multi-frame stats when determined', () => {
  const stats = parseIdetStats(sampleIdetStderr);
  assertEqual(stats, { tff: 120, bff: 5, progressive: 300, undetermined: 10 }, 'multi-frame stats picked');
});

run('parseIdetStats: falls back to single-frame stats when no multi-frame line present', () => {
  const singleOnly = `
[Parsed_idet_0 @ 0x1] Single frame detection: TFF: 20 BFF: 3 Progressive: 40 Undetermined: 5
`;
  const stats = parseIdetStats(singleOnly);
  assertEqual(stats, { tff: 20, bff: 3, progressive: 40, undetermined: 5 }, 'single-frame fallback');
});

run('parseIdetStats: returns null-ish (no stats) when stderr has nothing matching', () => {
  const stats = parseIdetStats('no idet output here');
  assertFalse(!!stats, 'no stats found');
});

// ---------------------------------------------------------------------------
// isConfidentlyInterlacedFromIdet / isConfidentlyProgressiveFromIdet / isTelecineLikeIdet
// ---------------------------------------------------------------------------

const interlacedLike = { tff: 100, bff: 20, progressive: 10, undetermined: 5 };
const progressiveLike = { tff: 5, bff: 3, progressive: 200, undetermined: 2 };
const telecineLike = { tff: 30, bff: 10, progressive: 60, undetermined: 0 };
const inconclusive = { tff: 2, bff: 1, progressive: 3, undetermined: 50 };

run('isConfidentlyInterlacedFromIdet: interlaced-like stats -> true, others -> false', () => {
  assertTrue(isConfidentlyInterlacedFromIdet(interlacedLike), 'interlaced-like');
  assertFalse(isConfidentlyInterlacedFromIdet(progressiveLike), 'progressive-like');
  assertFalse(isConfidentlyInterlacedFromIdet(telecineLike), 'telecine-like');
  assertFalse(isConfidentlyInterlacedFromIdet(inconclusive), 'inconclusive');
  assertFalse(isConfidentlyInterlacedFromIdet(null), 'null stats');
});

run('isConfidentlyProgressiveFromIdet: progressive-like stats -> true, others -> false', () => {
  assertFalse(isConfidentlyProgressiveFromIdet(interlacedLike), 'interlaced-like');
  assertTrue(isConfidentlyProgressiveFromIdet(progressiveLike), 'progressive-like');
  assertFalse(isConfidentlyProgressiveFromIdet(telecineLike), 'telecine-like');
  assertFalse(isConfidentlyProgressiveFromIdet(inconclusive), 'inconclusive');
});

run('isTelecineLikeIdet: telecine-like stats -> true, others -> false', () => {
  assertFalse(isTelecineLikeIdet(interlacedLike), 'interlaced-like');
  assertFalse(isTelecineLikeIdet(progressiveLike), 'progressive-like');
  assertTrue(isTelecineLikeIdet(telecineLike), 'telecine-like');
  assertFalse(isTelecineLikeIdet(inconclusive), 'inconclusive');
});

// ---------------------------------------------------------------------------
// parityFromIdet
// ---------------------------------------------------------------------------

run('parityFromIdet: tff-heavy -> tff, bff-heavy -> bff, balanced -> auto', () => {
  assertEqual(parityFromIdet({ tff: 100, bff: 20, progressive: 10, undetermined: 0 }), 'tff', 'tff-heavy');
  assertEqual(parityFromIdet({ tff: 5, bff: 50, progressive: 10, undetermined: 0 }), 'bff', 'bff-heavy');
  assertEqual(parityFromIdet({ tff: 10, bff: 9, progressive: 10, undetermined: 0 }), 'auto', 'balanced');
  assertEqual(parityFromIdet(null), 'auto', 'null stats');
});

// ---------------------------------------------------------------------------
// fpsToRateString
// ---------------------------------------------------------------------------

run('fpsToRateString: known cadences map to clean rate strings', () => {
  assertEqual(fpsToRateString(23.976), '24000/1001', '23.976 fps');
  // Note: 24 falls within the 23.976 check's tolerance (0.12) and is matched by that
  // branch first, since it is checked before the exact-24 branch — this reflects the
  // function's actual (pre-existing) behavior, not an assumption.
  assertEqual(fpsToRateString(24), '24000/1001', '24 fps (matched by 23.976 tolerance band first)');
  assertEqual(fpsToRateString(25), '25', '25 fps');
  assertEqual(fpsToRateString(29.97), '30000/1001', '29.97 fps');
  assertEqual(fpsToRateString(30), '30000/1001', '30 fps (matched by 29.97 tolerance band first)');
  assertEqual(fpsToRateString(50), '50', '50 fps');
  assertEqual(fpsToRateString(59.94), '60000/1001', '59.94 fps');
  assertEqual(fpsToRateString(60), '60000/1001', '60 fps (matched by 59.94 tolerance band first)');
});

run('fpsToRateString: odd/missing fps handled', () => {
  assertEqual(fpsToRateString(21), '21', 'unrecognized 21 fps falls through to rounded string');
  assertEqual(fpsToRateString(0), null, 'zero fps -> null');
  assertEqual(fpsToRateString(null), null, 'null fps -> null');
  assertEqual(fpsToRateString(NaN), null, 'NaN fps -> null');
});

// ---------------------------------------------------------------------------
// isHdrSource
// ---------------------------------------------------------------------------

run('isHdrSource: PQ stream is HDR, SDR bt709 stream is not', () => {
  const pqStream = { color_transfer: 'smpte2084', color_primaries: 'bt2020' };
  const sdrStream = { color_transfer: 'bt709', color_primaries: 'bt709' };
  assertTrue(isHdrSource(pqStream), 'PQ/bt2020 stream is HDR');
  assertFalse(isHdrSource(sdrStream), 'bt709 SDR stream is not HDR');
  assertFalse(isHdrSource(null), 'null stream is not HDR');
  assertFalse(isHdrSource({}), 'empty stream is not HDR');
});

// ---------------------------------------------------------------------------
// normalizeFieldStrategy / normalizeFieldParity
// ---------------------------------------------------------------------------

run('normalizeFieldStrategy: aliases and defaults', () => {
  assertEqual(normalizeFieldStrategy(undefined), 'auto', 'undefined -> auto');
  assertEqual(normalizeFieldStrategy(''), 'auto', 'empty string -> auto');
  assertEqual(normalizeFieldStrategy('BWDIF'), 'hybrid', 'BWDIF alias -> hybrid');
  assertEqual(normalizeFieldStrategy('ivtc'), 'telecine', 'ivtc alias -> telecine');
  assertEqual(normalizeFieldStrategy('telecine'), 'telecine', 'passthrough valid value');
  assertEqual(normalizeFieldStrategy('bogus'), 'auto', 'unknown value -> auto');
});

run('normalizeFieldParity: valid values pass through, others default to auto', () => {
  assertEqual(normalizeFieldParity('TFF'), 'tff', 'TFF -> tff');
  assertEqual(normalizeFieldParity('bff'), 'bff', 'bff passthrough');
  assertEqual(normalizeFieldParity(undefined), 'auto', 'undefined -> auto');
  assertEqual(normalizeFieldParity('xyz'), 'auto', 'unknown -> auto');
});

// ---------------------------------------------------------------------------
// generateKeyframeTimeline / shouldComputeSegmentTimeline
// ---------------------------------------------------------------------------

run('shouldComputeSegmentTimeline: audio jobs included; original/subs/thumbs skipped', () => {
  // Standalone audio must recompute the same grid as video (never same runner).
  assertTrue(shouldComputeSegmentTimeline('compressed', {}), 'compressed video job');
  assertTrue(
    shouldComputeSegmentTimeline('compressed', { isSubtitlesJob: false, isThumbnailsJob: false }),
    'compressed audio job (same gate)',
  );
  assertFalse(shouldComputeSegmentTimeline('original', {}), 'original remux skips grid');
  assertFalse(
    shouldComputeSegmentTimeline('compressed', { isSubtitlesJob: true }),
    'subtitles job skips grid',
  );
  assertFalse(
    shouldComputeSegmentTimeline('compressed', { isThumbnailsJob: true }),
    'thumbnails job skips grid',
  );
});

run('generateKeyframeTimeline: uses scene cuts inside the 3-9s window, else targetSec', () => {
  // Scene at 4.5s is in [3,9] from 0 -> take it; next forced at 4.5+6=10.5; no cut in window.
  const cuts = [1.0, 4.5, 20.0];
  const times = generateKeyframeTimeline(cuts, 30, 6, 3, 9);
  assertEqual(times[0], 4.5, 'first cut picks scene at 4.5');
  assertEqual(times[1], 10.5, 'second is targetSec after last (no scene in window)');
  // Same inputs always yield the same grid (video job and audio job must agree).
  assertEqual(
    generateKeyframeTimeline(cuts, 30, 6, 3, 9),
    times,
    'deterministic for A/V separate runners',
  );
});

run('generateKeyframeTimeline: empty scene list falls back to regular targetSec steps', () => {
  const times = generateKeyframeTimeline([], 20, 6, 3, 9);
  assertEqual(times, [6, 12, 18], 'flat 6s grid when no scene cuts');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (failed === 0) {
  console.log(`PASS: all ${passed} assertions passed.`);
} else {
  console.log(`FAIL: ${failed} of ${passed + failed} assertions failed.`);
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
}

if (failed > 0) {
  process.exit(1);
}
