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
  THUMB_STORYBOARD,
  countStoryboardThumbs,
  storyboardTilesPerSheet,
  storyboardSheetIndexForThumb,
  storyboardSheetName,
  buildStoryboardVttBody,
  storyboardSpriteGlob,
  buildFieldAnalysisArgs,
  fieldAnalysisSeekMode,
  isTelecineRatio,
  isUsableIdetStats,
  isUsableTelecineFrameCounts,
  telecineMajorityDecision,
  mergeIdetWindowStats,
  mapPool,
  FIELD_PROBE_CONCURRENCY,
  uniquePartZipIndex,
  assertUnderZipCap,
  batchFilesBySize,
  maxZipBytes,
  zipPayloadBudget,
  configureStorage,
  gitlabLinkToApiUrl,
  packVttIntoSizedFiles,
  parseVttCueBlocks,
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
// Thumbnail storyboard (5s / 320 / 10×10 / WebP)
// ---------------------------------------------------------------------------

run('THUMB_STORYBOARD constants: 1s interval, 480px tiles, 10x10, webp q85', () => {
  assertEqual(THUMB_STORYBOARD.intervalSec, 1, 'intervalSec');
  assertEqual(THUMB_STORYBOARD.tileWidth, 480, 'tileWidth');
  assertEqual(THUMB_STORYBOARD.cols, 10, 'cols');
  assertEqual(THUMB_STORYBOARD.rows, 10, 'rows');
  assertEqual(THUMB_STORYBOARD.extension, 'webp', 'extension');
  assertEqual(THUMB_STORYBOARD.webpQuality, 85, 'webpQuality');
});

run('countStoryboardThumbs: ceil(duration/interval) @ 1s', () => {
  assertEqual(countStoryboardThumbs(1494.016, 1), 1495, '1494.016s / 1s');
  assertEqual(countStoryboardThumbs(1500, 1), 1500, 'exact 25 min');
  assertEqual(countStoryboardThumbs(0, 1), 0, 'zero duration');
});

run('storyboard sheet naming and index (10x10 = 100 tiles/sheet)', () => {
  assertEqual(storyboardTilesPerSheet(10, 10), 100, 'tiles per sheet');
  assertEqual(storyboardSheetIndexForThumb(0), 0, 'first thumb sheet 0');
  assertEqual(storyboardSheetIndexForThumb(99), 0, '99 still sheet 0');
  assertEqual(storyboardSheetIndexForThumb(100), 1, '100 starts sheet 1');
  assertEqual(storyboardSheetName(0, 'webp'), 'thumb_sprite_001.webp', 'sheet 0 name');
  assertEqual(storyboardSheetName(2, 'webp'), 'thumb_sprite_003.webp', 'sheet 2 name');
  assertTrue(storyboardSpriteGlob('webp').test('thumb_sprite_001.webp'), 'glob matches webp');
  assertFalse(storyboardSpriteGlob('webp').test('thumb_sprite_001.jpg'), 'glob rejects jpg');
});

run('buildStoryboardVttBody: cues use 1s steps and .webp #xywh URLs', () => {
  const body = buildStoryboardVttBody(3, 320, 180, {
    intervalSec: 1,
    cols: 10,
    rows: 10,
    extension: 'webp',
  });
  // 3s / 1s → 3 thumbs
  assertTrue(body.includes('00:00:00.000 --> 00:00:01.000'), 'first cue');
  assertTrue(body.includes('thumbnails/thumb_sprite_001.webp#xywh=0,0,320,180'), 'first tile webp');
  assertTrue(body.includes('thumbnails/thumb_sprite_001.webp#xywh=320,0,320,180'), 'second col');
  assertFalse(body.includes('.jpg'), 'no jpeg references');
  assertEqual(countStoryboardThumbs(3, 1), 3, 'three thumbs for 3s');
});

run('assertUnderZipCap / batchFilesBySize: cap comes from the backend', () => {
  // No storage block in the payload (an older VPS): must behave exactly as
  // before, GitHub with a 1 GiB cap.
  configureStorage(null, 'gh-token');
  assertEqual(maxZipBytes(), 1024 * 1024 * 1024, 'github 1 GiB cap');
  assertTrue(zipPayloadBudget() < maxZipBytes(), 'payload budget under cap');
  let threw = false;
  try {
    assertUnderZipCap(maxZipBytes() + 1, 'test');
  } catch (e) {
    threw = true;
    assertTrue(/exceeds/.test(e.message), 'error mentions exceeds');
  }
  assertTrue(threw, 'oversize throws');
  assertUnderZipCap(maxZipBytes(), 'at-cap-ok'); // exact cap allowed

  const files = [
    { name: 'a', size: maxZipBytes() - 100 },
    { name: 'b', size: 200 },
    { name: 'c', size: 50 },
  ];
  const batches = batchFilesBySize(files);
  assertEqual(batches.length, 2, 'second file forces new batch');
  assertEqual(batches[0].length, 1, 'first batch one file');
  assertEqual(batches[1].length, 2, 'rest in second batch');
});

run('gitlabLinkToApiUrl: release links must be read through the API path', () => {
  // A release link stores the *web* URL. Requesting it with PRIVATE-TOKEN
  // answers 403, so probing reported size 0 and the source proxy handed ffprobe
  // an empty body ("moov atom not found"). Reads must go through
  // /api/v4/projects/:id/uploads/:secret/:filename.
  process.env.GITLAB_TOKEN = 'glpat-selftest';
  configureStorage(
    { kind: 'gitlab', api_base: 'https://gitlab.com/api/v4', project_id: '85638501' },
    'gh-token',
  );

  const web = 'https://gitlab.com/gldrive/storage/-/project/85638501/uploads/0123456789abcdef0123456789abcdef/movie.mkv.part0000';
  const api = gitlabLinkToApiUrl(web);
  assertTrue(api.includes('/api/v4/projects/85638501/uploads/'), 'rewritten to the API path');
  assertTrue(api.includes('0123456789abcdef0123456789abcdef'), 'keeps the upload secret');
  assertTrue(api.endsWith('movie.mkv.part0000'), 'keeps the filename');

  // Filenames with spaces must survive as a single encoded segment.
  const spaced = gitlabLinkToApiUrl(
    'https://gitlab.com/x/-/uploads/0123456789abcdef0123456789abcdef/2025-12-22%2013-59-47.mp4.part0000',
  );
  assertTrue(spaced.includes('2025-12-22%2013-59-47.mp4.part0000'), 'space stays encoded');

  // Already-API urls are left alone (idempotent).
  assertEqual(gitlabLinkToApiUrl(api), api, 'idempotent on an API url');

  // Anything unrecognised is returned untouched rather than mangled.
  assertEqual(gitlabLinkToApiUrl('https://example.com/x'), 'https://example.com/x', 'unknown url untouched');

  delete process.env.GITLAB_TOKEN;
  configureStorage(null, 'gh-token');
});

run('zip cap follows a GitLab job instead of staying at 1 GiB', () => {
  // GitLab caps a release asset at ~95 MiB. Batching at GitHub's 1 GiB would
  // build zips the API refuses outright, so the cap has to come from the job.
  process.env.GITLAB_TOKEN = 'glpat-selftest';
  configureStorage(
    {
      kind: 'gitlab',
      api_base: 'https://gitlab.com/api/v4',
      project_id: '1',
      max_asset_bytes: 99614720,
    },
    'gh-token',
  );
  assertEqual(maxZipBytes(), 99614720, 'gitlab 95 MiB cap');
  assertTrue(zipPayloadBudget() < 99614720, 'gitlab payload budget under cap');

  // Two payloads that fit one GitHub zip must split for GitLab.
  const files = [
    { name: 'a', size: 90 * 1024 * 1024 },
    { name: 'b', size: 90 * 1024 * 1024 },
  ];
  assertEqual(batchFilesBySize(files).length, 2, 'splits under the smaller cap');

  let oversizeThrew = false;
  try {
    assertUnderZipCap(200 * 1024 * 1024, 'gitlab-oversize');
  } catch (e) {
    oversizeThrew = true;
  }
  assertTrue(oversizeThrew, '200 MiB rejected on gitlab');

  // A GitLab job without the secret must fail loudly rather than silently
  // falling back to the GitHub token and writing to the wrong place.
  delete process.env.GITLAB_TOKEN;
  let missingThrew = false;
  try {
    configureStorage({ kind: 'gitlab', api_base: 'x', project_id: '1' }, 'gh');
  } catch (e) {
    missingThrew = true;
    assertTrue(/GITLAB_TOKEN/.test(e.message), 'names the missing secret');
  }
  assertTrue(missingThrew, 'missing GITLAB_TOKEN throws');

  // STORAGE is module-global: reconfiguring back to GitHub must restore the
  // GitHub cap, not leave the previous job's smaller one in place.
  configureStorage(null, 'gh-token');
  assertEqual(maxZipBytes(), 1024 * 1024 * 1024, 'cap resets with the backend');
});

run('packVttIntoSizedFiles: cue-aligned split under budget', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-pack-'));
  try {
    // Two large cues that force a split when budget is tiny
    const big = 'x'.repeat(80);
    const vtt =
      `WEBVTT\n\n` +
      `00:00:00.000 --> 00:00:01.000\n${big}\n\n` +
      `00:00:01.000 --> 00:00:02.000\n${big}\n\n`;
    const cues = parseVttCueBlocks(vtt);
    assertEqual(cues.length, 2, 'two cues');
    const packed = packVttIntoSizedFiles(vtt, 7, dir, 120);
    assertTrue(packed.files.length >= 2, 'split into multiple files');
    assertTrue(packed.playlistText.includes('subtitle_7_00000.vtt'), 'playlist seg 0');
    assertTrue(packed.playlistText.includes('#EXT-X-ENDLIST'), 'endlist');
    for (const f of packed.files) {
      assertTrue(fs.existsSync(f.fullPath), f.name);
      assertTrue(f.size <= 200, 'each part near budget');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Field / telecine full-span speed helpers (no early-exit; fast seek placement)
// ---------------------------------------------------------------------------

run('buildFieldAnalysisArgs: input vs output -ss placement', () => {
  const outArgs = buildFieldAnalysisArgs('http://x/v.mp4', 270, 10, 'idet', 'output');
  assertEqual(fieldAnalysisSeekMode(outArgs), 'output', 'output seek after -i');
  const inArgs = buildFieldAnalysisArgs('http://x/v.mp4', 270, 10, 'idet', 'input');
  assertEqual(fieldAnalysisSeekMode(inArgs), 'input', 'input seek before -i');
  const zero = buildFieldAnalysisArgs('http://x/v.mp4', 0, 10, 'idet', 'input');
  assertEqual(fieldAnalysisSeekMode(zero), 'none', 'no -ss when seek=0');
  assertTrue(inArgs.includes('idet'), 'vf present');
  assertTrue(FIELD_PROBE_CONCURRENCY >= 2, 'concurrency allows parallel windows');
});

run('isTelecineRatio band and frame-count usability', () => {
  assertTrue(isTelecineRatio(0.8), '0.8 is classic 3:2');
  assertTrue(isTelecineRatio(0.72), 'lower band edge');
  assertTrue(isTelecineRatio(0.88), 'upper band edge');
  assertFalse(isTelecineRatio(0.71), 'below band');
  assertFalse(isTelecineRatio(0.9), 'above band');
  assertFalse(isTelecineRatio(null), 'null');
  assertTrue(isUsableTelecineFrameCounts(100, 80), 'usable pair');
  assertFalse(isUsableTelecineFrameCounts(30, 24), 'raw too small');
  assertFalse(isUsableTelecineFrameCounts(100, 0), 'missing ivtc');
});

run('telecineMajorityDecision: full-span majority, single window, empty', () => {
  assertFalse(telecineMajorityDecision([]), 'empty → false');
  assertTrue(
    telecineMajorityDecision([{ ok: true, ratio: 0.8 }]),
    'single conclusive yes',
  );
  assertFalse(
    telecineMajorityDecision([{ ok: false, ratio: 0.95 }]),
    'single conclusive no',
  );
  assertTrue(
    telecineMajorityDecision([
      { ok: true, ratio: 0.8 },
      { ok: true, ratio: 0.79 },
      { ok: false, ratio: 0.99 },
    ]),
    '2 of 3 yes → majority',
  );
  assertFalse(
    telecineMajorityDecision([
      { ok: true, ratio: 0.8 },
      { ok: false, ratio: 0.99 },
      { ok: false, ratio: 1.0 },
    ]),
    '1 of 3 yes → no majority',
  );
  // Inconclusive (ratio null) windows do not vote.
  assertTrue(
    telecineMajorityDecision([
      { ok: true, ratio: 0.8 },
      { ok: false, ratio: null },
      { ok: true, ratio: 0.81 },
    ]),
    'null ratios ignored; 2/2 yes',
  );
});

run('mergeIdetWindowStats aggregates all windows (full-span, no early abort)', () => {
  const inter = { tff: 100, bff: 0, progressive: 10, undetermined: 0 };
  const prog = { tff: 5, bff: 3, progressive: 200, undetermined: 2 };
  const agg = mergeIdetWindowStats([inter, prog, null, inter]);
  assertEqual(agg.windows, 3, 'three usable windows');
  assertEqual(agg.interHits, 2, 'two interlaced hits counted');
  assertEqual(agg.progHits, 1, 'one progressive hit');
  assertEqual(agg.merged.tff, 205, 'tff summed across full span');
  assertTrue(agg.any, 'any true');
  assertFalse(mergeIdetWindowStats([]).any, 'empty list');
});

run('isUsableIdetStats', () => {
  assertFalse(isUsableIdetStats(null), 'null');
  assertFalse(isUsableIdetStats({ tff: 0, bff: 0, progressive: 0, undetermined: 0 }), 'all zero');
  assertTrue(isUsableIdetStats({ tff: 1, bff: 0, progressive: 0, undetermined: 0 }), 'has tff');
  assertTrue(isUsableIdetStats({ tff: 0, bff: 0, progressive: 0, undetermined: 5 }), 'undet only');
});

run('mapPool preserves order under concurrency=2 (subprocess, real shipped fn)', () => {
  // Selftest harness is sync; drive the real async mapPool in a short-lived Node child.
  const { spawnSync } = require('child_process');
  const script = `
    const { mapPool } = require(${JSON.stringify(require('path').join(__dirname, 'optimize.js'))});
    mapPool([10, 20, 30, 40], 2, async (n, i) => {
      await new Promise((r) => setTimeout(r, 20 - i * 4));
      return n * 2;
    }).then((out) => {
      if (JSON.stringify(out) !== JSON.stringify([20, 40, 60, 80])) {
        console.error('bad order', out);
        process.exit(2);
      }
      process.exit(0);
    }).catch((e) => { console.error(e); process.exit(3); });
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assertEqual(r.status, 0, `mapPool child exit 0 (stderr=${r.stderr || ''})`);
});


// uniquePartZipIndex — multiparts must not collide on DB zip_index
run('uniquePartZipIndex: parts do not share zip indices', () => {
  const part1 = [0, 1, 2].map((c) => uniquePartZipIndex(1, c));
  const part2 = [0, 1, 2].map((c) => uniquePartZipIndex(2, c));
  assertEqual(part1[0], 0, 'part1 chunk0');
  assertEqual(part1[1], 1, 'part1 chunk1');
  assertEqual(part2[0], 100, 'part2 chunk0');
  assertEqual(part2[1], 101, 'part2 chunk1');
  const all = new Set([...part1, ...part2]);
  assertEqual(all.size, 6, 'no collisions across two parts');
  // Old bug: chunkIdx alone would collide
  assertTrue(part1[0] !== part2[0], 'part1[0] !== part2[0]');
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
