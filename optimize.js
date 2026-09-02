const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { Readable } = require('stream');

function execAsync(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, ...options });
    
    let stdoutData = '';
    let stderrData = '';
    
    if (options.stdio !== 'inherit') {
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdoutData += data.toString();
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderrData += data.toString();
        });
      }
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdoutData);
      } else {
        const error = new Error(`Command failed with exit code ${code}: ${cmd}`);
        error.status = code;
        error.stdout = stdoutData;
        error.stderr = stderrData;
        reject(error);
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

function getStreamTag(stream, tagName) {
  if (!stream || !stream.tags) return undefined;
  const targetLower = tagName.toLowerCase();
  for (const key of Object.keys(stream.tags)) {
    if (key.toLowerCase() === targetLower) {
      return stream.tags[key];
    }
  }
  return undefined;
}

function parseFrameRate(rFrameRate) {
  if (!rFrameRate) return 30;
  const parts = rFrameRate.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den > 0) return num / den;
  }
  const val = parseFloat(rFrameRate);
  return isNaN(val) ? 30 : val;
}

function getAV1ParamsForLabel(label) {
  const normLabel = (label || '').toLowerCase();
  const defaultPreset = process.env.HLS_AV1_PRESET || '8';
  const defaultCrf = process.env.HLS_AV1_CRF || '30';

  let preset = defaultPreset;
  let crf = defaultCrf;

  if (normLabel.includes('2160p')) {
    preset = process.env.HLS_AV1_PRESET_2160P || '6';
    crf = process.env.HLS_AV1_CRF_2160P || '32';
  } else if (normLabel.includes('1440p')) {
    preset = process.env.HLS_AV1_PRESET_1440P || '7';
    crf = process.env.HLS_AV1_CRF_1440P || '31';
  } else if (normLabel.includes('1080p')) {
    preset = process.env.HLS_AV1_PRESET_1080P || '8';
    crf = process.env.HLS_AV1_CRF_1080P || '30';
  } else if (normLabel.includes('720p')) {
    preset = process.env.HLS_AV1_PRESET_720P || '9';
    crf = process.env.HLS_AV1_CRF_720P || '29';
  } else if (normLabel.includes('480p')) {
    preset = process.env.HLS_AV1_PRESET_480P || '10';
    crf = process.env.HLS_AV1_CRF_480P || '28';
  } else if (normLabel.includes('360p')) {
    preset = process.env.HLS_AV1_PRESET_360P || '10';
    crf = process.env.HLS_AV1_CRF_360P || '27';
  }

  return { preset, crf };
}

// Cache holds the in-flight/resolved Promise (not the boolean) so concurrent callers
// awaiting the same check share one ffmpeg spawn instead of racing duplicate ones.
let _svtAv1SupportPromise = null;
function checkSvtAv1() {
  if (!_svtAv1SupportPromise) {
    _svtAv1SupportPromise = (async () => {
      try {
        const out = await execAsync('ffmpeg -encoders 2>&1');
        return /svtav1/i.test(out);
      } catch (e) {
        const combined = `${e.stdout || ''}${e.stderr || ''}`;
        return /svtav1/i.test(combined);
      }
    })();
  }
  return _svtAv1SupportPromise;
}

// Source bit depth from ffprobe: pix_fmt name is authoritative (yuv420p10le etc.),
// bits_per_raw_sample is the fallback some containers/codecs only expose that way.
function getSourceBitDepth(videoStream) {
  if (!videoStream) return 8;
  const pixFmt = String(videoStream.pix_fmt || '').toLowerCase();
  const pixFmtMatch = pixFmt.match(/(\d+)(le|be)?$/);
  if (pixFmtMatch) {
    const depth = parseInt(pixFmtMatch[1], 10);
    if (!isNaN(depth) && depth >= 8) return depth;
  }
  const raw = parseInt(videoStream.bits_per_raw_sample, 10);
  if (!isNaN(raw) && raw >= 8) return raw;
  return 8;
}

let _x264TenBitSupportPromise = null;
// Most distro/official ffmpeg builds link libx264 compiled 8-bit-only (High profile caps
// at yuv420p). 10-bit needs a High10-capable libx264, which not every build ships — check
// the actual encoder's supported pixel formats rather than assuming.
function checkX264TenBitSupport() {
  if (!_x264TenBitSupportPromise) {
    _x264TenBitSupportPromise = (async () => {
      try {
        const out = await execAsync('ffmpeg -h encoder=libx264 2>&1');
        return /yuv420p10le/i.test(out);
      } catch (e) {
        const combined = `${e.stdout || ''}${e.stderr || ''}`;
        return /yuv420p10le/i.test(combined);
      }
    })();
  }
  return _x264TenBitSupportPromise;
}

let _av1TenBitSupportPromise = null;
function checkAv1TenBitSupport() {
  if (!_av1TenBitSupportPromise) {
    _av1TenBitSupportPromise = (async () => {
      try {
        const out = await execAsync('ffmpeg -h encoder=libsvtav1 2>&1');
        return /yuv420p10le/i.test(out);
      } catch (e) {
        const combined = `${e.stdout || ''}${e.stderr || ''}`;
        return /yuv420p10le/i.test(combined);
      }
    })();
  }
  return _av1TenBitSupportPromise;
}

// Known SDR transfer characteristics (ffprobe color_transfer names) — anything else
// paired with bt2020 primaries is treated as HDR-ish to be safe.
const SDR_TRANSFERS = new Set([
  'bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'linear', 'gamma22', 'gamma28',
  'iec61966-2-1', 'iec61966-2-4', 'bt1361e', 'log100', 'log316', 'unknown', '',
  'bt2020-10', 'bt2020-12',
]);

// HDR detection: PQ (smpte2084) and HLG (arib-std-b67) are the two HDR transfer functions
// ffmpeg/ffprobe report. Also treat bt2020 primaries with a non-SDR transfer as HDR since
// some sources omit/misreport the transfer tag but still carry wide-gamut HDR data.
// Defaults to false (SDR) whenever fields are missing/unrecognized — never throws.
function isHdrSource(videoStream) {
  if (!videoStream || typeof videoStream !== 'object') return false;
  try {
    const transfer = String(videoStream.color_transfer || '').toLowerCase();
    const primaries = String(videoStream.color_primaries || '').toLowerCase();
    if (transfer === 'smpte2084' || transfer === 'arib-std-b67') return true;
    if (primaries === 'bt2020' && transfer !== '' && !SDR_TRANSFERS.has(transfer)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// HDR (PQ/HLG, bt2020) -> SDR (bt709) tonemap filter chain using zscale/tonemap (libzimg).
// linear-light tonemap (hable, mild desat) then convert primaries/matrix/transfer to bt709.
// Requires ffmpeg built with --enable-libzscale (and zimg); not all builds have it, hence
// checkZscaleSupport() below gates whether this is ever applied.
// wantsHighBitDepth: keep the post-tonemap pixel format at 10-bit for high-bit-depth
// sources so the subsequent -pix_fmt yuv420p10le encode path isn't fed data that was
// already truncated to 8-bit here (that would silently discard the whole point of a
// 10-bit encode). Falls back to 8-bit yuv420p otherwise.
function buildTonemapFilter(wantsHighBitDepth) {
  const outFmt = wantsHighBitDepth ? 'yuv420p10le' : 'yuv420p';
  return `zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=transfer=bt709:matrix=bt709:primaries=bt709,format=${outFmt}`;
}

let _zscaleSupportPromise = null;
// Same capability-check pattern as checkX264TenBitSupport/checkAv1TenBitSupport: probe the
// actual ffmpeg build rather than assuming, since zscale/tonemap need libzimg compiled in.
// NOTE: `ffmpeg -h filter=zscale` always echoes the queried name back (e.g. "Unknown filter
// 'zscale'.") even when the filter doesn't exist, so testing the output for the substring
// "zscale" is a no-op that always resolves true. List the actually-registered filters instead
// and match zscale as a distinct token.
function checkZscaleSupport() {
  if (!_zscaleSupportPromise) {
    _zscaleSupportPromise = (async () => {
      try {
        const out = await execAsync('ffmpeg -filters 2>&1');
        return /(^|\s)zscale(\s|$)/im.test(out);
      } catch (e) {
        const combined = `${e.stdout || ''}${e.stderr || ''}`;
        return /(^|\s)zscale(\s|$)/im.test(combined);
      }
    })();
  }
  return _zscaleSupportPromise;
}

function adjustVideoParams(label, codec, origBitrateKbps, origHeight, duration, basePreset, baseCrf) {
  let targetHeight = 1080;
  const labelMatch = (label || '').match(/(\d+)p/);
  if (labelMatch) {
    targetHeight = parseInt(labelMatch[1], 10);
  }

  let proportionalOrigBitrate = origBitrateKbps;
  if (origHeight && origHeight > 0 && origBitrateKbps) {
    proportionalOrigBitrate = origBitrateKbps * Math.pow(targetHeight / origHeight, 1.5);
  }

  let finalCrf = parseInt(baseCrf, 10);
  if (isNaN(finalCrf)) {
    finalCrf = codec === 'av1' ? 30 : 20;
  }

  // Determine standard expectation thresholds for resolution (H264 vs AV1)
  let standardBitrate = 4000;
  if (codec === 'h264') {
    if (targetHeight <= 360) standardBitrate = 700;
    else if (targetHeight <= 480) standardBitrate = 1200;
    else if (targetHeight <= 720) standardBitrate = 2200;
    else if (targetHeight <= 1080) standardBitrate = 4000;
    else if (targetHeight <= 1440) standardBitrate = 8000;
    else standardBitrate = 16000;
  } else if (codec === 'av1') {
    if (targetHeight <= 360) standardBitrate = 400;
    else if (targetHeight <= 480) standardBitrate = 700;
    else if (targetHeight <= 720) standardBitrate = 1300;
    else if (targetHeight <= 1080) standardBitrate = 2400;
    else if (targetHeight <= 1440) standardBitrate = 4800;
    else standardBitrate = 10000;
  }

  // If proportional original bitrate is lower than standard, increase CRF (less quality, lower filesize)
  if (proportionalOrigBitrate && proportionalOrigBitrate < standardBitrate) {
    const deficitRatio = proportionalOrigBitrate / standardBitrate;
    const maxIncrease = codec === 'av1' ? 12 : 8;
    const crfIncrease = Math.round(maxIncrease * (1 - deficitRatio));
    finalCrf += crfIncrease;
    
    const maxCrfLimit = codec === 'av1'
      ? parseInt(process.env.HLS_AV1_MAX_CRF_LIMIT || '40', 10)
      : parseInt(process.env.HLS_H264_MAX_CRF_LIMIT || '30', 10);
    if (finalCrf > maxCrfLimit) finalCrf = maxCrfLimit;
  }

  // Apply strict bitrate cap to guarantee output is smaller than original
  let maxrate = null;
  let bufsize = null;
  if (proportionalOrigBitrate) {
    const cappedBitrate = Math.max(codec === 'av1' ? 200 : 350, Math.round(proportionalOrigBitrate * 0.90));
    maxrate = `${cappedBitrate}k`;
    bufsize = `${cappedBitrate * 2}k`;
  }

  // Preset adjustment based on target resolution height and final CRF
  let finalPreset = basePreset;
  if (codec === 'av1') {
    // SVT-AV1 presets: 0 (slowest) to 13 (fastest)
    const minLimit = parseInt(process.env.HLS_AV1_SLOWEST_PRESET_LIMIT || '6', 10);
    const maxLimit = parseInt(process.env.HLS_AV1_FASTEST_PRESET_LIMIT || '8', 10);

    let minPreset = 6;
    if (targetHeight >= 2160) minPreset = 8;
    else if (targetHeight >= 1080) minPreset = 8;
    else if (targetHeight >= 720) minPreset = 7;
    
    // Ensure resolution-based minPreset is adjusted to fit the limits
    minPreset = Math.max(minLimit, Math.min(minPreset, maxLimit));

    let presetNum = parseInt(basePreset, 10);
    if (isNaN(presetNum)) {
      presetNum = minPreset;
    } else {
      presetNum = Math.max(presetNum, minPreset);
    }

    // Pair lower (slower) preset numbers with higher CRF to maintain detail on compressed streams,
    // and higher (faster) preset numbers with lower CRF where bits are plentiful.
    if (finalCrf >= 35) {
      presetNum = Math.max(minLimit, presetNum - 2);
    } else if (finalCrf >= 31) {
      presetNum = Math.max(minLimit, presetNum - 1);
    } else if (finalCrf <= 26) {
      presetNum = Math.min(maxLimit, presetNum + 1);
    }
    
    // Finally clamp to ensure presetNum is strictly within limits
    presetNum = Math.max(minLimit, Math.min(presetNum, maxLimit));
    finalPreset = String(presetNum);
  } else if (codec === 'h264') {
    // x264 presets: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
    const presetsList = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
    
    const fastestLimit = process.env.HLS_H264_FASTEST_PRESET_LIMIT || 'ultrafast';
    const slowestLimit = process.env.HLS_H264_SLOWEST_PRESET_LIMIT || 'veryslow';
    
    let fastestIdx = presetsList.indexOf(fastestLimit);
    if (fastestIdx === -1) fastestIdx = 0;
    
    let slowestIdx = presetsList.indexOf(slowestLimit);
    if (slowestIdx === -1) slowestIdx = 8;
    
    if (fastestIdx > slowestIdx) {
      const temp = fastestIdx;
      fastestIdx = slowestIdx;
      slowestIdx = temp;
    }

    let idx = presetsList.indexOf(basePreset);
    if (idx === -1) idx = 2; // default veryfast
    
    let maxAllowedIdx = 8;
    if (targetHeight >= 2160) maxAllowedIdx = 2; // veryfast
    else if (targetHeight >= 1080) maxAllowedIdx = 3; // faster
    else if (targetHeight >= 720) maxAllowedIdx = 4; // fast
    
    // Scale safety cap according to configured limits
    maxAllowedIdx = Math.max(fastestIdx, Math.min(maxAllowedIdx, slowestIdx));

    // Initially clamp within safety limits
    idx = Math.max(fastestIdx, Math.min(idx, maxAllowedIdx));

    // Adjust based on CRF
    if (finalCrf >= 26) {
      idx = Math.min(maxAllowedIdx, idx + 1); // make it slower to maintain details (higher index is slower)
    } else if (finalCrf <= 18) {
      idx = Math.max(fastestIdx, idx - 1); // make it faster
    }
    
    idx = Math.max(fastestIdx, Math.min(idx, slowestIdx));
    finalPreset = presetsList[idx];
  }

  // Apply CRF limit boundaries
  if (codec === 'av1') {
    const minCrf = parseInt(process.env.HLS_AV1_MIN_CRF_LIMIT || '20', 10);
    const maxCrf = parseInt(process.env.HLS_AV1_MAX_CRF_LIMIT || '40', 10);
    finalCrf = Math.max(minCrf, Math.min(finalCrf, maxCrf));
  } else {
    const minCrf = parseInt(process.env.HLS_H264_MIN_CRF_LIMIT || '15', 10);
    const maxCrf = parseInt(process.env.HLS_H264_MAX_CRF_LIMIT || '30', 10);
    finalCrf = Math.max(minCrf, Math.min(finalCrf, maxCrf));
  }

  return { crf: String(finalCrf), preset: finalPreset, maxrate, bufsize };
}


// Config and constants
// ponytail: fixed path collided across concurrent matrix jobs on the same self-hosted VPS
// (shared /tmp/hls-worker/cache/part_0 -> ENOENT races). RUNNER_TEMP is job-scoped and unique.
// HLS_WORK_DIR lets the workflow point this at a specific real-disk path instead of
// wherever RUNNER_TEMP/tmp happens to be mounted (e.g. if /tmp is tmpfs, downloaded
// source chunks and HLS output would silently be eating into RAM instead of disk).
// It isn't job-scoped by itself, so a pid suffix keeps concurrent jobs from colliding.
const WORK_DIR = process.env.HLS_WORK_DIR
  ? path.join(process.env.HLS_WORK_DIR, `hls-worker-${process.pid}`)
  : (process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'hls-worker')
      : `/tmp/hls-worker-${process.pid}`);
const INPUT_FILE = path.join(WORK_DIR, 'input.txt');
const OUTPUT_DIR = path.join(WORK_DIR, 'hls-output');
/**
 * Storage backend this job reads from and writes to.
 *
 * The VPS sends non-secret coordinates in client_payload.data.storage; tokens
 * come from this repo's own secrets, never from the payload (a dispatch payload
 * is visible in the Actions run).
 *
 * Defaults to GitHub so a payload from an older VPS - which has no storage
 * block - behaves exactly as before.
 */
const STORAGE = {
  kind: 'github',
  /** 1 GiB on GitHub; GitLab caps release assets at ~95 MiB. */
  maxAssetBytes: 1024 * 1024 * 1024,
  owner: null,
  repo: null,
  apiBase: null,
  projectId: null,
  token: null,
};

function configureStorage(cfg, githubToken) {
  if (cfg && cfg.kind === 'gitlab') {
    STORAGE.kind = 'gitlab';
    STORAGE.apiBase = cfg.api_base || cfg.apiBase;
    STORAGE.projectId = String(cfg.project_id || cfg.projectId);
    STORAGE.token = process.env.GITLAB_TOKEN;
    if (!STORAGE.token) {
      throw new Error(
        'Job targets GitLab but GITLAB_TOKEN is not set. Add it as a repository secret and pass it through in the workflow.',
      );
    }
  } else {
    STORAGE.kind = 'github';
    STORAGE.token = githubToken;
    if (cfg) {
      STORAGE.owner = cfg.owner || null;
      STORAGE.repo = cfg.repo || null;
    }
  }
  // Always assign: STORAGE is module-global, so a conditional update would let
  // a previous job's cap leak into this one.
  const declared = cfg ? Number(cfg.max_asset_bytes ?? cfg.maxAssetBytes) : NaN;
  STORAGE.maxAssetBytes = Number.isFinite(declared) && declared > 0
    ? declared
    : STORAGE.kind === 'gitlab'
      ? 99614720 // GitLab default, mirrors the VPS registry
      : 1024 * 1024 * 1024; // GitHub default
  console.log(
    `[Storage] backend=${STORAGE.kind} maxAssetBytes=${STORAGE.maxAssetBytes} (${(STORAGE.maxAssetBytes / 1024 / 1024).toFixed(0)} MiB zip cap)`,
  );
}

/**
 * Hard cap for every zip upload, taken from the backend's own asset limit
 * rather than assumed. Sized wrong, a GitLab job builds 1 GiB zips that the
 * API refuses outright.
 */
function maxZipBytes() {
  return STORAGE.maxAssetBytes;
}

/** Leave headroom for zip local headers / EOCD so stored payload stays under the cap. */
function zipPayloadBudget() {
  return maxZipBytes() - 512 * 1024;
}

/**
 * Zip index unique across multi-part jobs for a single (zipType, streamIndex).
 * DB uniqueness is (variant_id, zip_type, stream_index, zip_index); chunk
 * counters alone collide across parts and overwrite earlier zip rows → 404.
 * Capacity: 100 zip batches per part (100GB raw at MAX_ZIP_BYTES) is plenty.
 */
function uniquePartZipIndex(partIndex, chunkIndex) {
  const p = Math.max(1, parseInt(partIndex, 10) || 1);
  const c = Math.max(0, parseInt(chunkIndex, 10) || 0);
  return (p - 1) * 100 + c;
}

function formatMiB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * Fail closed if a payload exceeds the shared 1 GiB zip/asset cap.
 * Used for raw single files (subs) and finished zip archives (all types).
 */
function assertUnderZipCap(bytes, label) {
  const n = Number(bytes) || 0;
  if (n > maxZipBytes()) {
    throw new Error(
      `${label}: ${formatMiB(n)} MiB exceeds ${(maxZipBytes() / 1024 / 1024).toFixed(0)} MiB zip cap`,
    );
  }
}

/**
 * Group { fullPath, size, ... } entries into batches each totaling ≤ maxBytes.
 * A single entry larger than maxBytes becomes its own batch (caller must
 * assertUnderZipCap that entry — cannot split format-blind).
 */
function batchFilesBySize(files, maxBytes = maxZipBytes()) {
  const batches = [];
  let pending = [];
  let pendingSize = 0;
  for (const f of files) {
    const size = Number(f.size) || 0;
    if (pending.length > 0 && pendingSize + size > maxBytes) {
      batches.push(pending);
      pending = [];
      pendingSize = 0;
    }
    pending.push(f);
    pendingSize += size;
  }
  if (pending.length > 0) batches.push(pending);
  return batches;
}

/**
 * zip -0 -j the given absolute paths, enforce cap, upload, delete zip.
 * Returns { assetId, url, zipSize }.
 */
async function zipStoreUploadAndCleanup({
  filePaths,
  zipName,
  zipPath,
  listFilePath,
  uploadFn,
}) {
  if (!filePaths || filePaths.length === 0) {
    throw new Error(`zipStoreUploadAndCleanup: no files for ${zipName}`);
  }
  await fs.promises.writeFile(listFilePath, filePaths.join('\n'), 'utf8');
  try {
    execSync(`zip -0 -j "${zipPath}" -@ < "${listFilePath}"`, { stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(listFilePath); } catch (e) {}
  }
  const zipSize = (await fs.promises.stat(zipPath)).size;
  try {
    assertUnderZipCap(zipSize, `ZIP ${zipName}`);
    console.log(`Uploading ${zipName} (${formatMiB(zipSize)} MiB)...`);
    const uploadRes = await uploadFn(zipName, zipPath, 'application/zip');
    return {
      assetId: uploadRes.id,
      url: uploadRes.browser_download_url,
      zipSize,
    };
  } finally {
    try { fs.unlinkSync(zipPath); } catch (e) {}
  }
}

/** Parse WebVTT into cue blocks (raw text between timing lines). */
function parseVttCueBlocks(vttContent) {
  const lines = String(vttContent || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const cues = [];
  let i = 0;
  // skip header until blank after WEBVTT
  while (i < lines.length && !lines[i].includes("-->")) {
    i++;
  }
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const blockStart = i;
    // optional id line
    if (!lines[i].includes("-->") && i + 1 < lines.length && lines[i + 1].includes("-->")) {
      i++;
    }
    if (i >= lines.length || !lines[i].includes("-->")) {
      i++;
      continue;
    }
    const timing = lines[i];
    i++;
    while (i < lines.length && lines[i].trim() !== "") i++;
    const block = lines.slice(blockStart, i).join("\n");
    const arrow = timing.indexOf("-->");
    const start = parseTimestamp(timing.slice(0, arrow).trim());
    const end = parseTimestamp(timing.slice(arrow + 3).trim().split(/\s/)[0]);
    const bytes = Buffer.byteLength(block, "utf8");
    cues.push({ block, start, end, bytes });
  }
  return cues;
}

/**
 * Split a large WebVTT into multiple files each ≤ maxBytes (cue-aligned).
 * Absolute cue times kept so each file is a valid timeline slice for HLS.
 * Returns { files: [{name,fullPath,size}], playlistText }.
 */
function packVttIntoSizedFiles(vttContent, subIndex, outputDir, maxBytes = zipPayloadBudget()) {
  const cues = parseVttCueBlocks(vttContent);
  if (cues.length === 0) {
    const name = `subtitle_${subIndex}_00000.vtt`;
    const fullPath = path.join(outputDir, name);
    const body = ensureVttTimestampMap(vttContent || "WEBVTT\n\n");
    fs.writeFileSync(fullPath, body, "utf8");
    const size = fs.statSync(fullPath).size;
    const duration = 1;
    return {
      files: [{ name, fullPath, size }],
      playlistText: buildSingleSegmentVttPlaylist(duration, name),
    };
  }

  const header = "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n";
  const headerBytes = Buffer.byteLength(header, "utf8");
  const parts = [];
  let current = [];
  let currentBytes = headerBytes;
  let partStart = cues[0].start;
  let partEnd = cues[0].end;

  const flush = () => {
    if (current.length === 0) return;
    const idx = parts.length;
    const name = `subtitle_${subIndex}_${String(idx).padStart(5, "0")}.vtt`;
    const fullPath = path.join(outputDir, name);
    const body = header + current.map((c) => c.block).join("\n\n") + "\n";
    fs.writeFileSync(fullPath, body, "utf8");
    const size = fs.statSync(fullPath).size;
    parts.push({
      name,
      fullPath,
      size,
      duration: Math.max(0.001, partEnd - partStart),
    });
    current = [];
    currentBytes = headerBytes;
  };

  for (const cue of cues) {
    const add = cue.bytes + 2; // blank line between cues
    // Single cue larger than budget: still its own file (assert later).
    if (current.length > 0 && currentBytes + add > maxBytes) {
      flush();
      partStart = cue.start;
      partEnd = cue.end;
    }
    if (current.length === 0) {
      partStart = cue.start;
      partEnd = cue.end;
    } else {
      partEnd = Math.max(partEnd, cue.end);
    }
    current.push(cue);
    currentBytes += add;
  }
  flush();

  let playlistText =
    `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...parts.map((p) => p.duration), 1))}\n` +
    `#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n`;
  for (const p of parts) {
    playlistText += `#EXTINF:${p.duration.toFixed(6)},\n${p.name}\n`;
  }
  playlistText += "#EXT-X-ENDLIST\n";

  return {
    files: parts.map(({ name, fullPath, size }) => ({ name, fullPath, size })),
    playlistText,
  };
}

/**
 * Split a binary file into ≤ maxBytes parts: baseName.part0000, .part0001, ...
 */
async function splitBinaryIntoParts(srcPath, destDir, baseName, maxBytes = zipPayloadBudget()) {
  const stat = await fs.promises.stat(srcPath);
  const total = stat.size;
  if (total <= maxBytes) {
    return [{ name: baseName, fullPath: srcPath, size: total, partIndex: 0, isOriginal: true }];
  }
  const fd = await fs.promises.open(srcPath, "r");
  const parts = [];
  try {
    let offset = 0;
    let partIndex = 0;
    while (offset < total) {
      const len = Math.min(maxBytes, total - offset);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, offset);
      const name = `${baseName}.part${String(partIndex).padStart(4, "0")}`;
      const fullPath = path.join(destDir, name);
      await fs.promises.writeFile(fullPath, buf);
      parts.push({ name, fullPath, size: len, partIndex, isOriginal: false });
      offset += len;
      partIndex++;
    }
  } finally {
    await fd.close();
  }
  return parts;
}

/**
 * Zip+upload subtitle payload files under MAX_ZIP_BYTES (multi-zip when needed).
 * Returns array of completedSubtitleZips entries.
 */
async function uploadSubtitlePayloadZips({
  streamIdx,
  files,
  workDir,
  uploadFn,
}) {
  for (const f of files) {
    assertUnderZipCap(f.size, `subtitle #${streamIdx} file ${f.name}`);
  }
  const batches = batchFilesBySize(files, zipPayloadBudget());
  const out = [];
  for (let zipIndex = 0; zipIndex < batches.length; zipIndex++) {
    const batch = batches[zipIndex];
    const zipName =
      zipIndex === 0
        ? `subtitle_${streamIdx}.zip`
        : `subtitle_${streamIdx}_${String(zipIndex).padStart(3, "0")}.zip`;
    const zipPath = path.join(workDir, zipName);
    const listFilePath = path.join(workDir, `${zipName}.list.txt`);
    console.log(
      `Packaging subtitle ZIP ${zipName} (${batch.length} file(s), stream #${streamIdx})...`,
    );
    const uploaded = await zipStoreUploadAndCleanup({
      filePaths: batch.map((f) => f.fullPath),
      zipName,
      zipPath,
      listFilePath,
      uploadFn,
    });
    out.push({
      zipType: "subtitle",
      streamIndex: streamIdx,
      zipIndex,
      assetId: uploaded.assetId,
      url: uploaded.url,
      zipSize: uploaded.zipSize,
    });
  }
  return out;
}

let globalProxyServer = null;

// Standard API Request helper
function apiRequestRaw(urlStr, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'User-Agent': 'github-storage-worker/1.0.0',
        ...headers,
      },
    };
    if (body) {
      if (Buffer.isBuffer(body)) {
        options.headers['Content-Length'] = body.length.toString();
      } else {
        const bodyStr = typeof body === 'object' ? JSON.stringify(body) : String(body);
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
        if (!options.headers['Content-Type']) {
          options.headers['Content-Type'] = 'application/json';
        }
        body = Buffer.from(bodyStr, 'utf8');
      }
    }
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, headers: res.headers, body: buffer });
        } else {
          const err = new Error(`Request to ${urlStr} failed with status ${res.statusCode}: ${buffer.toString('utf8')}`);
          err.headers = res.headers;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// GitHub's primary rate limit resets on a fixed hourly window (X-RateLimit-Reset, epoch
// seconds). Once a shared token is exhausted (e.g. several self-hosted runner agents on the
// same VPS all pulling video byte-ranges through the authenticated api.github.com asset
// endpoint), short fixed retry delays just re-hit the still-exhausted limit and burn through
// the attempt budget in seconds instead of actually recovering. When the response tells us
// remaining=0, wait until the window resets (capped so a single retry loop can't stall a job
// forever) instead of the normal linear backoff.
function computeBackoffMs(headers, fallbackMs) {
  const remaining = headers && headers['x-ratelimit-remaining'];
  const reset = headers && headers['x-ratelimit-reset'];
  if (remaining === '0' && reset) {
    const waitMs = (parseInt(reset, 10) * 1000) - Date.now() + 1000 + Math.random() * 2000;
    if (waitMs > fallbackMs) {
      // ponytail: 90s cap was shorter than typical time-to-reset, so the retry loop gave up
      // before the window actually reset (observed: reset 78-800s out, job died at attempt 5).
      // Cap raised well past worst observed case; still bounded so a stuck job can't hang forever.
      return Math.min(waitMs, 20 * 60 * 1000);
    }
  }
  return fallbackMs;
}

async function apiRequest(urlStr, method = 'GET', headers = {}, body = null, maxAttempts = 5) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await apiRequestRaw(urlStr, method, headers, body);
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw err;
      }
      
      const isGet = method.toUpperCase() === 'GET';
      const isTransient = 
        err.message.includes('status 429') ||
        err.message.includes('status 403') ||
        err.message.includes('status 5') || // 5xx server errors
        (isGet && err.message.includes('status 404')) || // replication delay on GETs
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ENOTFOUND' ||
        err.message.includes('socket hang up') ||
        err.message.includes('network');

      if (!isTransient) {
        throw err;
      }

      const backoffMs = computeBackoffMs(err.headers, attempt * 1000 + Math.random() * 500);
      console.warn(`API request to ${urlStr} failed on attempt ${attempt}: ${err.message}. Retrying in ${Math.round(backoffMs)}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

// Redirect-following downloader that handles private GitHub Release assets with retries and content-length checks
function downloadAsset(urlStr, token, destPath, maxRetries = 3) {
  let attempt = 0;

  function tryDownload() {
    attempt++;
    return new Promise((resolve, reject) => {
      let file = null;
      let activeRequest = null;
      let downloadedBytes = 0;
      let isRejected = false;

      function cleanupAndReject(err) {
        if (isRejected) return;
        isRejected = true;
        
        if (activeRequest) {
          activeRequests.delete(activeRequest);
          try { activeRequest.destroy(); } catch (e) {}
        }
        if (file) {
          file.close(() => {
            fs.unlink(destPath, () => {});
          });
        } else {
          fs.unlink(destPath, () => {});
        }
        reject(err);
      }

      function get(url) {
        const parsed = new URL(url);
        const headers = buildDownloadHeaders(parsed, token);
        
        file = fs.createWriteStream(destPath);
        file.on('error', (err) => {
          cleanupAndReject(err);
        });

        const req = https.get({
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          headers,
          timeout: 60000 // 60 seconds inactivity timeout
        }, (res) => {
          res.on('error', (err) => {
            cleanupAndReject(err);
          });

          if (res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 307 || res.statusCode === 308) {
            const loc = res.headers.location;
            res.resume(); // consume response body
            activeRequests.delete(req);
            file.close(() => {
              if (!loc) {
                cleanupAndReject(new Error('Redirected but found no Location header'));
                return;
              }
              get(loc); // follow redirect
            });
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            const err = new Error(`Failed to download asset, HTTP status: ${res.statusCode}`);
            err.headers = res.headers;
            if (res.statusCode === 403 || res.statusCode === 401) {
              cdnUrlCache.delete(urlStr);
            }
            cleanupAndReject(err);
            return;
          }

          const totalBytes = parseInt(res.headers['content-length'] || '0', 10);

          res.on('data', (chunk) => {
            downloadedBytes += chunk.length;
          });

          res.pipe(file);

          file.on('finish', () => {
            file.close(() => {
              activeRequests.delete(req);
              if (totalBytes > 0 && downloadedBytes !== totalBytes) {
                cleanupAndReject(new Error(`Incomplete download: expected ${totalBytes} bytes, got ${downloadedBytes} bytes`));
              } else {
                resolve();
              }
            });
          });
        });

        activeRequest = req;
        activeRequests.add(req);

        req.on('timeout', () => {
          cleanupAndReject(new Error('Download connection timed out after 60 seconds of inactivity'));
        });

        req.on('error', (err) => {
          cleanupAndReject(err);
        });
      }

      // Prefer cached CDN URL so full-file downloads also skip api.github.com after first resolve.
      resolveAssetCdnUrl(urlStr, token)
        .then((cdnUrl) => {
          if (isRejected) return;
          get(cdnUrl);
        })
        .catch((err) => cleanupAndReject(err));
    });
  }

  return new Promise((resolve, reject) => {
    function execute() {
      if (isGlobalAborted) {
        reject(new Error('Download aborted due to process cleanup'));
        return;
      }
      tryDownload()
        .then(resolve)
        .catch((err) => {
          if (isGlobalAborted || err.message === 'aborted') {
            reject(err);
            return;
          }
          console.warn(`[DownloadAsset] Attempt ${attempt} failed: ${err.message}`);
          if (attempt < maxRetries) {
            const delay = computeBackoffMs(err.headers, attempt * 2000);
            console.log(`[DownloadAsset] Retrying in ${delay}ms...`);
            setTimeout(execute, delay);
          } else {
            reject(err);
          }
        });
    }
    execute();
  });
}

// Upload a single file as a release asset (with retries on transient connection issues)
/**
 * Upload one asset. `releaseId` is required on GitLab, which has no upload_url
 * and addresses the release by a tag derived from that id.
 *
 * Returns GitHub's response shape ({ id, browser_download_url, ... }) on both
 * backends, so callers stay unchanged.
 */
async function uploadAssetFile(uploadUrl, assetName, filePath, contentType, token, releaseId) {
  if (STORAGE.kind === 'gitlab') {
    return uploadAssetFileGitlab(releaseId, assetName, filePath, contentType);
  }
  const stat = await fs.promises.stat(filePath);
  const baseUploadUrl = uploadUrl.split('{')[0];
  const uploadEndpoint = `${baseUploadUrl}?name=${encodeURIComponent(assetName)}`;
  const url = new URL(uploadEndpoint);
  
  // Parse owner, repo, and release ID from upload URL for potential deletion on retry
  let apiOwner = '';
  let apiRepo = '';
  let apiReleaseId = '';
  const match = baseUploadUrl.match(/\/repos\/([^\/]+)\/([^\/]+)\/releases\/(\d+)\/assets/);
  if (match) {
    apiOwner = match[1];
    apiRepo = match[2];
    apiReleaseId = match[3];
  }

  const maxAttempts = 3;
  let attempt = 0;

  while (true) {
    attempt++;
    console.log(`[Upload] Uploading ${assetName} (Attempt ${attempt}/${maxAttempts})...`);
    try {
      const timeoutMs = Math.max(
        15 * 60 * 1000, // 15 minutes minimum
        2 * 60 * 1000 * Math.ceil(stat.size / (100 * 1024 * 1024)) // 2 minutes per 100MB
      );
      const uploadResult = await new Promise((resolve, reject) => {
        const options = {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'github-storage-worker/1.0.0',
            'Content-Type': contentType,
            'Content-Length': stat.size.toString(),
            'Accept': 'application/vnd.github+json',
          },
          timeout: timeoutMs,
        };
        
        const absoluteTimer = setTimeout(() => {
          req.destroy();
          reject(new Error(`Upload nach ${timeoutMs / 60000} Minuten absolutem Timeout abgebrochen.`));
        }, timeoutMs);

        const req = https.request(options, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            clearTimeout(absoluteTimer);
            const buffer = Buffer.concat(chunks);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(buffer.toString('utf8')));
            } else {
              const err = new Error(`Status ${res.statusCode}: ${buffer.toString('utf8')}`);
              err.headers = res.headers;
              reject(err);
            }
          });
        });
        
        req.on('error', (err) => {
          clearTimeout(absoluteTimer);
          reject(err);
        });
        req.on('timeout', () => {
          clearTimeout(absoluteTimer);
          req.destroy(new Error('Upload request timed out'));
        });
        
        req.on('socket', (socket) => {
          const startPiping = () => {
            const fileStream = fs.createReadStream(filePath);
            fileStream.pipe(req);
            fileStream.on('error', (err) => {
              clearTimeout(absoluteTimer);
              req.destroy();
              reject(err);
            });
          };

          if (socket.connecting) {
            const connectEvent = url.protocol === 'https:' ? 'secureConnect' : 'connect';
            socket.once(connectEvent, startPiping);
          } else {
            startPiping();
          }
        });
      });
      console.log(`[Upload] Successfully uploaded ${assetName} on attempt ${attempt}`);
      return uploadResult;
    } catch (err) {
      console.warn(`Attempt ${attempt} to upload ${assetName} failed: ${err.message}`);
      if (attempt >= maxAttempts) {
        throw err;
      }

      // Check if duplicate asset needs to be deleted before retry (especially on 422 already_exists)
      if (apiOwner && apiRepo && apiReleaseId) {
        console.log(`Checking for existing asset ${assetName} to clean up...`);
        try {
          const listUrl = `https://api.github.com/repos/${apiOwner}/${apiRepo}/releases/${apiReleaseId}/assets`;
          const res = await apiRequest(listUrl, 'GET', {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'github-storage-worker/1.0.0',
          });
          const assets = JSON.parse(res.body.toString('utf8'));
          if (Array.isArray(assets)) {
            const existingAsset = assets.find(a => a.name === assetName);
            if (existingAsset) {
              console.log(`Found existing asset ${assetName} (ID: ${existingAsset.id}). Deleting to allow clean retry...`);
              const deleteUrl = `https://api.github.com/repos/${apiOwner}/${apiRepo}/releases/assets/${existingAsset.id}`;
              await apiRequest(deleteUrl, 'DELETE', {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'github-storage-worker/1.0.0',
              });
              console.log(`Successfully deleted duplicate asset ${assetName}`);
            }
          }
        } catch (cleanErr) {
          console.warn(`Warning: Failed to delete duplicate asset before retry: ${cleanErr.message}`);
        }
      }

      const backoffMs = computeBackoffMs(err.headers, attempt * 2000);
      console.log(`Retrying in ${backoffMs}ms...`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

// Build a minimal single-segment HLS media playlist wrapping one whole-file WebVTT
// subtitle track. hls.js requires TYPE=SUBTITLES EXT-X-MEDIA URIs to point at a Media
// Playlist (m3u8), not a raw .vtt file, so every subtitle track still needs one of these
// even though the underlying WebVTT itself is no longer chunked into segments.
function buildSingleSegmentVttPlaylist(durationSeconds, segmentName) {
  const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : 36000;
  const targetDuration = Math.max(1, Math.ceil(duration));
  return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:${duration.toFixed(6)},\n${segmentName}\n#EXT-X-ENDLIST\n`;
}

// Native HLS players (iOS/Safari AVFoundation) require every WebVTT segment referenced
// from a TYPE=SUBTITLES media playlist to declare X-TIMESTAMP-MAP, mapping the VTT-local
// cue clock onto the MPEGTS media timeline. hls.js tolerates its absence (it parses cues
// itself and assumes a zero offset), which is why this only broke native/iOS playback.
function ensureVttTimestampMap(vttContent) {
  if (vttContent.includes("X-TIMESTAMP-MAP")) return vttContent;
  const lines = vttContent.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => line.trim().startsWith("WEBVTT"));
  if (headerIdx === -1) return vttContent;
  lines.splice(headerIdx + 1, 0, "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0");
  return lines.join("\n");
}

// Rewrite HLS manifest references to target the VPS virtual endpoints
function rewriteVariantPlaylist({ playlistText, fileId, label }) {
  if (!playlistText) return null;
  const base = `/api/files/${encodeURIComponent(fileId)}/hls/${encodeURIComponent(label)}`;

  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      line = line.trim();
      if (!line) return line;
      if (line.startsWith('#EXT-X-MAP:')) {
        return line.replace(/URI="([^"]+)"/, (_m, uri) => {
          // Already absolute (partial rewrite / re-entry) — keep leaf name only.
          let name = uri;
          if (uri.includes('/segment/')) {
            name = decodeURIComponent(uri.split('/segment/').pop().split('?')[0]);
          } else if (uri.includes('/')) {
            name = decodeURIComponent(uri.split('/').pop().split('?')[0]);
          }
          const newUri = `${base}/segment/${encodeURIComponent(name)}`;
          return `URI="${newUri}"`;
        });
      }
      if (line.startsWith('#')) return line;
      let name = line;
      if (line.includes('/segment/')) {
        name = decodeURIComponent(line.split('/segment/').pop().split('?')[0]);
      } else if (line.includes('/')) {
        name = decodeURIComponent(line.split('/').pop().split('?')[0]);
      }
      return `${base}/segment/${encodeURIComponent(name)}`;
    })
    .join('\n');
}

/**
 * Label used in absolute media playlist segment URLs. Master points audio/subs at the
 * highest video variant; prefer the tallest video resolution so early (partial)
 * callbacks match what the player will request.
 */
function resolveManifestRewriteLabel(rawResolutions, codecs, jobLabel) {
  const nonVideo = new Set(['metadata', 'audio', 'subtitles', 'thumbnails']);
  const videoRes = (rawResolutions || []).filter((r) => r && !nonVideo.has(r.label));
  let best = videoRes[0] || (rawResolutions && rawResolutions[0]) || { label: jobLabel || '1080p' };
  for (const r of videoRes) {
    if ((r.targetHeight || 0) > (best.targetHeight || 0)) best = r;
  }
  const codecList = Array.isArray(codecs) && codecs.length ? codecs : ['h264'];
  const useCodecSuffix = codecList.length > 1;
  const primaryCodec = codecList[0] || 'h264';
  if (jobLabel && !nonVideo.has(jobLabel)) {
    return useCodecSuffix ? `${jobLabel}_${primaryCodec}` : jobLabel;
  }
  const baseLabel = best.label || '1080p';
  return useCodecSuffix ? `${baseLabel}_${primaryCodec}` : baseLabel;
}

/* ==========================================================================
 * GitLab storage adapter
 *
 * GitLab's release model differs from GitHub's in three ways that matter here,
 * and all three must match what the VPS (backend/src/services/gitlab.ts)
 * expects - otherwise the server cannot read back what this worker writes:
 *
 *  1. Releases have no numeric id. The VPS mints one itself and derives the tag
 *     as `release-${id}`, so the same derivation is used here.
 *  2. Assets are release *links*, not first-class assets. Uploading is two
 *     steps: multipart POST to /uploads, then attach the returned path as a
 *     link on the release.
 *  3. The link stores a *web* URL, which 403s for PRIVATE-TOKEN. Server-side
 *     reads use an API URL derived from the upload path instead, so that is
 *     what gets reported back as the asset url.
 * ========================================================================== */

/** Same derivation as the VPS: a release is addressed by this tag. */
function gitlabReleaseTag(releaseId) {
  return `release-${releaseId}`;
}

let lastMintedMs = 0;
let mintedSeq = 0;

/**
 * Same shape as the VPS's generateReleaseId(): Date.now()*1000 + sequence.
 *
 * A per-millisecond counter rather than a random draw, for the same reason the
 * VPS uses one - release rotation can mint several ids inside one millisecond,
 * and two colliding ids would make the second create fail as "already taken".
 * Unlike the VPS this never adopts a colliding release: it throws, so a
 * collision costs a job rather than silently sharing storage between files.
 */
function gitlabMintReleaseId() {
  const now = Date.now();
  if (now > lastMintedMs) {
    lastMintedMs = now;
    mintedSeq = 0;
  } else {
    mintedSeq++;
    if (mintedSeq > 999) {
      lastMintedMs += 1;
      mintedSeq = 0;
    }
  }
  return lastMintedMs * 1000 + mintedSeq;
}

function gitlabHeaders(extra = {}) {
  return { 'PRIVATE-TOKEN': STORAGE.token, ...extra };
}

function gitlabProjectUrl(suffix) {
  return `${STORAGE.apiBase}/projects/${encodeURIComponent(STORAGE.projectId)}${suffix}`;
}

/**
 * API-form download URL for an upload path, matching the VPS's
 * toApiUploadDownloadUrl: the web form of the path rejects PRIVATE-TOKEN.
 */
function gitlabApiUploadUrl(fullPath) {
  const m = String(fullPath).match(/\/uploads\/([0-9a-f]{32})\/(.+)$/i);
  if (!m) return `${STORAGE.apiBase.replace(/\/api\/v4$/, '')}${fullPath}`;
  return gitlabProjectUrl(`/uploads/${m[1]}/${encodeURIComponent(m[2])}`);
}

/**
 * Rewrite a release link's URL into the API upload form.
 *
 * A release link stores the *web* URL (that is what shows in the GitLab UI),
 * and the web path answers 403 to a PRIVATE-TOKEN request - so probing or
 * downloading it directly reports no size and no bytes. Reads must go through
 * /api/v4/projects/:id/uploads/:secret/:filename instead. Same rule as the
 * VPS's toApiUploadDownloadUrl; the secret+filename form is used because the
 * upload-id form needs Maintainer rights while this one works for Guest+.
 */
function gitlabLinkToApiUrl(linkUrl) {
  if (!linkUrl) return linkUrl;
  // Already an API upload URL - leave it alone.
  if (/\/api\/v4\/projects\/[^/]+\/uploads\/(\d+|[a-f0-9]{32}\/)/i.test(linkUrl)) {
    return linkUrl;
  }
  try {
    const u = linkUrl.startsWith('http')
      ? new URL(linkUrl)
      : new URL(linkUrl, STORAGE.apiBase.replace(/\/api\/v4$/, ''));
    const m = u.pathname.match(/\/uploads\/([a-f0-9]{32})\/([^/]+)$/i);
    if (m) {
      return gitlabProjectUrl(
        `/uploads/${m[1]}/${encodeURIComponent(decodeURIComponent(m[2]))}`,
      );
    }
  } catch (_) {
    // fall through
  }
  return linkUrl;
}

/**
 * Two-step GitLab upload: multipart POST the file to the project, then attach
 * the returned path to the release as a link.
 *
 * A name already taken is cleared first, so a retry cannot end up with two
 * links of the same name pointing at different uploads - the server picks
 * assets by name and would then read whichever came back first.
 */
async function uploadAssetFileGitlab(releaseId, assetName, filePath, contentType) {
  if (!releaseId) {
    throw new Error(`uploadAssetFileGitlab: missing releaseId for ${assetName}`);
  }
  const stat = await fs.promises.stat(filePath);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `[Upload] Uploading ${assetName} to GitLab (${formatMiB(stat.size)} MiB, attempt ${attempt}/${maxAttempts})...`,
    );
    try {
      const uploaded = await gitlabPostUpload(filePath, assetName, contentType, stat.size);
      const fullPath = uploaded.full_path || uploaded.url;
      if (!fullPath) {
        throw new Error('GitLab upload response missing full_path');
      }

      // Replace any link left by a previous attempt before creating this one.
      try {
        const existing = await gitlabListReleaseLinks(releaseId);
        const dup = existing.find((l) => l && l.name === assetName);
        if (dup) {
          await apiRequest(
            gitlabProjectUrl(
              `/releases/${encodeURIComponent(gitlabReleaseTag(releaseId))}/assets/links/${dup.id}`,
            ),
            'DELETE',
            gitlabHeaders(),
          );
        }
      } catch (e) {
        console.warn(`[Upload] Could not check existing links for ${assetName}: ${e.message}`);
      }

      const apiUrl = gitlabApiUploadUrl(fullPath);
      const linkRes = await apiRequest(
        gitlabProjectUrl(
          `/releases/${encodeURIComponent(gitlabReleaseTag(releaseId))}/assets/links`,
        ),
        'POST',
        gitlabHeaders({ 'Content-Type': 'application/json' }),
        { name: assetName, url: apiUrl, link_type: 'other' },
      );
      const link = JSON.parse(linkRes.body.toString('utf8'));

      // GitHub-shaped so callers need no branch. The API url is reported (not
      // the web one) because that is what reads back with PRIVATE-TOKEN.
      return {
        id: link.id,
        name: assetName,
        size: stat.size,
        browser_download_url: apiUrl,
        url: apiUrl,
        state: 'uploaded',
      };
    } catch (err) {
      console.warn(`[Upload] GitLab upload of ${assetName} failed: ${err.message}`);
      if (attempt >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Multipart POST of one file to /projects/:id/uploads. */
function gitlabPostUpload(filePath, assetName, contentType, contentLength) {
  return new Promise((resolve, reject) => {
    const boundary = `----VaultWorker${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const safeName = String(assetName).replace(/["\r\n]/g, '_');
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`,
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const target = new URL(gitlabProjectUrl('/uploads'));

    let settled = false;
    const settle = (fn) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const req = https.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: {
          'PRIVATE-TOKEN': STORAGE.token,
          'User-Agent': 'github-storage-worker/1.0.0',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(preamble.length + contentLength + epilogue.length),
        },
        timeout: 30 * 60 * 1000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              settle(() => resolve(JSON.parse(body)));
            } catch (e) {
              settle(() => reject(new Error(`GitLab upload: bad JSON (${body.slice(0, 200)})`)));
            }
          } else {
            settle(() =>
              reject(new Error(`GitLab upload failed status=${res.statusCode} body=${body.slice(0, 300)}`)),
            );
          }
        });
      },
    );

    req.on('error', (err) => settle(() => reject(err)));
    req.on('timeout', () => {
      req.destroy(new Error('GitLab upload timed out'));
    });

    req.write(preamble);
    const rs = fs.createReadStream(filePath);
    rs.on('error', (err) => {
      req.destroy(err);
      settle(() => reject(err));
    });
    rs.on('end', () => {
      req.write(epilogue);
      req.end();
    });
    rs.pipe(req, { end: false });
  });
}

/**
 * One release's assets, in GitHub's asset shape on both backends.
 *
 * GitLab reports assets as release *links* with no size field, so size is left
 * at 0 and discovered by the range reader (which learns it from Content-Range
 * anyway). Normalising here keeps part filtering, range downloads and CDN
 * prewarm backend-agnostic.
 */
async function fetchReleaseInfo(owner, repo, releaseId, token) {
  if (STORAGE.kind === 'gitlab') {
    const links = await gitlabListReleaseLinks(releaseId);
    // Sizes are probed rather than read from the API: GitLab's links endpoint
    // reports none, and the source proxy sums them into totalSize before
    // serving any range. Leaving them at 0 makes it answer
    // `Content-Range: bytes 0--1/0` and hand ffprobe an empty body.
    const assets = await Promise.all(
      links.map(async (l) => {
        // The link's own url is the web form, which 403s for PRIVATE-TOKEN;
        // every read has to use the API upload path.
        const url = gitlabLinkToApiUrl(l.url || l.direct_asset_url);
        return {
          id: l.id,
          name: l.name,
          url,
          browser_download_url: url,
          size: await gitlabProbeAssetSize(url),
        };
      }),
    );
    const unsized = assets.filter((a) => !a.size);
    if (unsized.length > 0) {
      // Include the probed URL: the failure mode here is almost always the
      // wrong URL form (web path instead of the API upload path), and the name
      // alone does not show that.
      throw new Error(
        `Could not determine the size of ${unsized.length} GitLab asset(s) on release ${releaseId}. ` +
          `Continuing would serve a truncated source to ffmpeg. Probed: ` +
          unsized.map((a) => `${a.name} -> ${a.url}`).join(' | '),
      );
    }
    return { upload_url: null, assets };
  }
  const res = await apiRequest(
    `https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}`,
    'GET',
    {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    },
  );
  return JSON.parse(res.body.toString('utf8'));
}

/**
 * Byte size of one GitLab asset.
 *
 * GitLab's release-links API does not report sizes, and the worker needs them
 * up front: the source proxy sums them into totalSize and serves ranges
 * against it, so a missing size makes it answer `Content-Range: bytes 0--1/0`
 * and hand ffprobe an empty body ("moov atom not found"). Mirrors the VPS's
 * probeAssetSize: HEAD first, then a one-byte range for servers that refuse
 * HEAD.
 */
async function gitlabProbeAssetSize(url, depth = 0) {
  const followed = async (err) => {
    // apiRequestRaw rejects on 3xx and does not follow redirects; GitLab can
    // redirect an upload path, so take one hop rather than reporting size 0.
    const loc = err && err.headers && err.headers.location;
    if (!loc || depth >= 3) return 0;
    return gitlabProbeAssetSize(new URL(loc, url).toString(), depth + 1);
  };

  try {
    const head = await apiRequestRaw(url, 'HEAD', gitlabHeaders());
    const cl = head.headers && head.headers['content-length'];
    if (cl) {
      const n = parseInt(cl, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (err) {
    const viaRedirect = await followed(err);
    if (viaRedirect > 0) return viaRedirect;
  }

  try {
    const res = await apiRequestRaw(
      url,
      'GET',
      gitlabHeaders({ Range: 'bytes=0-0', 'Accept-Encoding': 'identity' }),
    );
    const cr = res.headers && res.headers['content-range'];
    if (cr) {
      const m = String(cr).match(/\/(\d+)\s*$/);
      if (m) return parseInt(m[1], 10);
    }
    const cl = res.headers && res.headers['content-length'];
    if (cl) {
      const n = parseInt(cl, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (err) {
    const viaRedirect = await followed(err);
    if (viaRedirect > 0) return viaRedirect;
  }
  return 0;
}

async function gitlabListReleaseLinks(releaseId) {
  const url = gitlabProjectUrl(
    `/releases/${encodeURIComponent(gitlabReleaseTag(releaseId))}/assets/links`,
  );
  const res = await apiRequest(url, 'GET', gitlabHeaders());
  const links = JSON.parse(res.body.toString('utf8'));
  return Array.isArray(links) ? links : [];
}

async function createNewRelease(owner, repo, fileId, label, partIndex, token) {
  const releaseName = `[HLS] File ${fileId} - ${label} (Part ${partIndex})`;

  if (STORAGE.kind === 'gitlab') {
    // The id is minted here and the tag derived from it, exactly as the VPS
    // does - a GitLab release has no numeric id of its own, and the server
    // finds this release again by that derived tag.
    const releaseId = gitlabMintReleaseId();
    await apiRequest(
      gitlabProjectUrl('/releases'),
      'POST',
      gitlabHeaders({ 'Content-Type': 'application/json' }),
      {
        tag_name: gitlabReleaseTag(releaseId),
        ref: 'main',
        name: releaseName,
        description: `Rotated HLS release for file ID: ${fileId}\nVariant: ${label}\nPart: ${partIndex}`,
      },
    );
    // GitLab has no upload_url; uploads go to the project and are then linked,
    // so the release id is all the upload path needs.
    return { releaseId, uploadUrl: null };
  }

  const tagName = `hls-${fileId}-${label}-part${partIndex}-${Date.now()}`;
  const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases`;

  const res = await apiRequest(releaseUrl, 'POST', {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
  }, {
    tag_name: tagName,
    name: releaseName,
    body: `Rotated HLS release for file ID: ${fileId}\nVariant: ${label}\nPart: ${partIndex}`,
    draft: false,
    prerelease: true,
  });
  
  const data = JSON.parse(res.body.toString('utf8'));
  return {
    releaseId: data.id,
    uploadUrl: data.upload_url,
  };
}

async function getReleaseAssetsCount(owner, repo, releaseId, token) {
  if (STORAGE.kind === 'gitlab') {
    return (await gitlabListReleaseLinks(releaseId)).length;
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}`;
  const res = await apiRequest(url, 'GET', {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'github-storage-worker/1.0.0',
  });
  const data = JSON.parse(res.body.toString('utf8'));
  return Array.isArray(data.assets) ? data.assets.length : 0;
}

function parseTimestamp(ts) {
  if (!ts) return 0;
  const cleanTs = ts.trim().replace(',', '.');
  const parts = cleanTs.split(':');
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10);
    const seconds = parseFloat(parts[1]);
    return (isNaN(minutes) ? 0 : minutes * 60) + (isNaN(seconds) ? 0 : seconds);
  } else if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    return (isNaN(hours) ? 0 : hours * 3600) + (isNaN(minutes) ? 0 : minutes * 60) + (isNaN(seconds) ? 0 : seconds);
  }
  const val = parseFloat(cleanTs);
  return isNaN(val) ? 0 : val;
}

function formatTimestamp(seconds) {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds - hrs * 3600) / 60);
  const secs = seconds - hrs * 3600 - mins * 60;
  
  const hrsStr = String(hrs).padStart(2, '0');
  const minsStr = String(mins).padStart(2, '0');
  const secsStr = secs.toFixed(3).padStart(6, '0');
  
  return `${hrsStr}:${minsStr}:${secsStr}`;
}

function parseSegmentDurations(playlistText) {
  const durations = [];
  const lines = playlistText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const commaIdx = line.indexOf(',');
      const durStr = commaIdx !== -1 
        ? line.substring(8, commaIdx).trim() 
        : line.substring(8).trim();
      const dur = parseFloat(durStr);
      if (!isNaN(dur)) {
        durations.push(dur);
      }
    }
  }
  return durations;
}

async function segmentVtt(vttContent, segmentDurations, videoDuration, outputDir, subIndex, startSegmentNumber) {
  const lines = vttContent.split(/\r?\n/);
  const cues = [];
  let i = 0;
  
  while (i < lines.length && lines[i].trim() !== '') {
    i++;
  }
  
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    
    let id = undefined;
    if (!lines[i].includes('-->')) {
      id = lines[i].trim();
      i++;
    }
    
    if (i < lines.length && lines[i].includes('-->')) {
      const tsLine = lines[i].trim();
      const parts = tsLine.split('-->');
      const startStr = parts[0].trim();
      const rest = parts[1].trim();
      
      const spaceIdx = rest.indexOf(' ');
      let endStr = rest;
      let settings = '';
      if (spaceIdx !== -1) {
        endStr = rest.substring(0, spaceIdx).trim();
        settings = rest.substring(spaceIdx).trim();
      }
      
      const start = parseTimestamp(startStr);
      const end = parseTimestamp(endStr);
      
      i++;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i++;
      }
      
      const cleanedText = textLines.join('\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\{[^}]*\}/g, '');
      
      if (start < end) {
        cues.push({
          id,
          start,
          end,
          settings,
          text: cleanedText
        });
      }
    } else {
      i++;
    }
  }
  
  if (segmentDurations.length === 0) {
    const fallbackTime = 6;
    const totalDuration = videoDuration || (cues.length > 0 ? Math.max(...cues.map(c => c.end)) : 0);
    const fallbackNum = Math.ceil(totalDuration / fallbackTime);
    for (let segIdx = 0; segIdx < fallbackNum; segIdx++) {
      segmentDurations.push(segIdx === fallbackNum - 1 ? (totalDuration - segIdx * fallbackTime) : fallbackTime);
    }
  }
  
  const numSegments = segmentDurations.length;
  const segStarts = [];
  const segEnds = [];
  let accumTime = 0;
  for (let segIdx = 0; segIdx < numSegments; segIdx++) {
    segStarts.push(accumTime);
    accumTime += segmentDurations[segIdx];
    segEnds.push(accumTime);
  }
  
  const segmentFiles = [];
  const maxTargetDuration = numSegments > 0 ? Math.max(...segmentDurations) : 6;
  
  for (let segIdx = 0; segIdx < numSegments; segIdx++) {
    const segStart = segStarts[segIdx];
    const segEnd = segEnds[segIdx];
    const segmentTime = segmentDurations[segIdx];
    const mpegts = Math.round(segStart * 90000);
    
    let segmentContent = `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${mpegts}\n\n` +
      `STYLE\n` +
      `::cue {\n` +
      `  background: transparent;\n` +
      `  text-shadow: 0 0 2px black, 0 0 2px black, 0 0 2px black, 0 0 2px black;\n` +
      `}\n\n`;
    
    for (const cue of cues) {
      if (cue.start < segEnd && cue.end > segStart) {
        const relStart = Math.max(0, cue.start - segStart);
        const relEnd = Math.min(segmentTime, cue.end - segStart);
        if (relStart < relEnd) {
          if (cue.id) {
            segmentContent += `${cue.id}\n`;
          }
          segmentContent += `${formatTimestamp(relStart)} --> ${formatTimestamp(relEnd)}${cue.settings ? ' ' + cue.settings : ''}\n`;
          segmentContent += `${cue.text}\n\n`;
        }
      }
    }
    
    const finalSegIdx = startSegmentNumber !== undefined ? (startSegmentNumber + segIdx) : segIdx;
    const fileName = `subtitle_${subIndex}_${String(finalSegIdx).padStart(5, '0')}.vtt`;
    const filePath = path.join(outputDir, fileName);
    await fs.promises.writeFile(filePath, segmentContent, 'utf8');
    segmentFiles.push(fileName);
  }
  
  const mediaSeq = startSegmentNumber !== undefined ? startSegmentNumber : 0;
  let playlistText = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${Math.ceil(maxTargetDuration)}\n#EXT-X-MEDIA-SEQUENCE:${mediaSeq}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n`;
  for (let segIdx = 0; segIdx < numSegments; segIdx++) {
    const duration = segmentDurations[segIdx];
    const finalSegIdx = startSegmentNumber !== undefined ? (startSegmentNumber + segIdx) : segIdx;
    playlistText += `#EXTINF:${duration.toFixed(6)},\nsubtitle_${subIndex}_${String(finalSegIdx).padStart(5, '0')}.vtt\n`;
  }
  playlistText += '#EXT-X-ENDLIST\n';
  
  return playlistText;
}

function buildDownloadHeaders(parsed, token) {
  const headers = {
    'User-Agent': 'github-storage-worker/1.0.0',
  };
  // ONLY send Authorization & Accept on github.com / api.github.com.
  // CDN/S3 signed URLs reject Auth headers mixed with query signatures.
  if (parsed.hostname === 'api.github.com' || parsed.hostname.endsWith('.github.com') || parsed.hostname === 'github.com') {
    headers['Authorization'] = `Bearer ${token}`;
    headers['Accept'] = 'application/octet-stream';
  } else if (isGitlabApiHost(parsed.hostname)) {
    // GitLab serves upload paths straight from the API host - no signed CDN
    // redirect - so the range GET itself carries the token.
    headers['PRIVATE-TOKEN'] = STORAGE.token;
  }
  return headers;
}

/** True when this host is the GitLab instance this job is configured against. */
function isGitlabApiHost(hostname) {
  if (STORAGE.kind !== 'gitlab' || !STORAGE.apiBase) return false;
  try {
    return new URL(STORAGE.apiBase).hostname === hostname;
  } catch (_) {
    return false;
  }
}

// --- CDN URL cache ----------------------------------------------------------
// Sparse range downloads used to hit api.github.com on EVERY range (auth + 302
// + rate-limit counters). With field-detect windows and ffmpeg seeks that is
// hundreds of API calls per job, which starves the shared token and can stall
// a 20MB part for minutes waiting on X-RateLimit-Reset. Resolve the signed CDN
// Location once per asset (like backend getResolvedAssetUrl) and reuse it for
// all subsequent Range GETs until it expires.
const CDN_URL_CACHE_TTL_MS = 12 * 60 * 1000;
const cdnUrlCache = new Map(); // assetApiUrl -> { url, expiresAt }
const pendingCdnResolutions = new Map(); // assetApiUrl -> Promise<string>

function getS3UrlExpirationMs(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const amzDate = parsed.searchParams.get('X-Amz-Date');
    const amzExpires = parsed.searchParams.get('X-Amz-Expires');
    if (amzDate && amzExpires) {
      const year = parseInt(amzDate.substring(0, 4), 10);
      const month = parseInt(amzDate.substring(4, 6), 10) - 1;
      const day = parseInt(amzDate.substring(6, 8), 10);
      const hour = parseInt(amzDate.substring(9, 11), 10);
      const minute = parseInt(amzDate.substring(11, 13), 10);
      const second = parseInt(amzDate.substring(13, 15), 10);
      return Date.UTC(year, month, day, hour, minute, second) + parseInt(amzExpires, 10) * 1000;
    }
    const exp = parsed.searchParams.get('expires');
    if (exp) {
      const n = parseInt(exp, 10);
      if (Number.isFinite(n)) return n * 1000;
    }
  } catch (_) {}
  return null;
}

function isGithubAssetApiHost(hostname) {
  return hostname === 'api.github.com' || hostname === 'github.com' || hostname.endsWith('.github.com');
}

/**
 * Resolve a GitHub release-asset API URL to a direct CDN/S3 URL and cache it.
 * Non-GitHub URLs are returned as-is. Concurrent resolvers for the same URL share one request.
 */
function resolveAssetCdnUrl(assetUrl, token) {
  if (!assetUrl) return Promise.reject(new Error('resolveAssetCdnUrl: empty url'));

  let parsed;
  try {
    parsed = new URL(assetUrl);
  } catch (e) {
    return Promise.reject(e);
  }

  // Already a CDN/S3 URL (or anything outside github.com) — no resolution needed.
  if (!isGithubAssetApiHost(parsed.hostname)) {
    return Promise.resolve(assetUrl);
  }

  const cached = cdnUrlCache.get(assetUrl);
  // 30s safety buffer so we never hand out a URL that expires mid-transfer.
  if (cached && cached.expiresAt > Date.now() + 30000) {
    return Promise.resolve(cached.url);
  }

  const pending = pendingCdnResolutions.get(assetUrl);
  if (pending) return pending;

  const promise = new Promise((resolve, reject) => {
    const headers = buildDownloadHeaders(parsed, token);
    const req = https.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
      timeout: 30000,
    }, (res) => {
      const loc = res.headers.location;
      // Drain/abort body; we only care about the redirect Location.
      res.resume();

      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        if (!loc) {
          reject(new Error(`CDN resolve redirect missing Location (status ${res.statusCode})`));
          return;
        }
        const s3Exp = getS3UrlExpirationMs(loc);
        const expiresAt = s3Exp ? s3Exp - 30000 : Date.now() + CDN_URL_CACHE_TTL_MS;
        cdnUrlCache.set(assetUrl, { url: loc, expiresAt });
        console.error(`[CDN Cache] RESOLVED asset URL (cached until ${new Date(expiresAt).toISOString()})`);
        resolve(loc);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        const err = new Error(`CDN resolve failed: status ${res.statusCode}`);
        err.headers = res.headers;
        // Drop any stale cache entry so the next attempt re-resolves.
        cdnUrlCache.delete(assetUrl);
        reject(err);
        return;
      }

      // Unexpected non-redirect success: fall back to the original URL.
      resolve(assetUrl);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('CDN resolve timed out'));
    });
    req.on('error', reject);
  }).finally(() => {
    pendingCdnResolutions.delete(assetUrl);
  });

  pendingCdnResolutions.set(assetUrl, promise);
  return promise;
}

function attemptRangeDownload(url, destPath, token, start, end) {
  return new Promise((resolve, reject) => {
    let fd = null;
    let activeRequest = null;
    let isRejected = false;
    let writePos = start;
    let pendingWrites = 0;
    let streamEnded = false;

    function cleanupAndReject(err) {
      if (isRejected) return;
      isRejected = true;
      if (activeRequest) {
        activeRequests.delete(activeRequest);
        try { activeRequest.destroy(); } catch (e) {}
      }
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (e) {}
        fd = null;
      }
      reject(err);
    }

    function handleResponse(req, res) {
      res.on('error', (err) => cleanupAndReject(err));

      if (res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        res.resume();
        activeRequests.delete(req);
        if (!loc) {
          cleanupAndReject(new Error('Redirect location missing'));
          return;
        }
        // Cache unexpected mid-download redirects so the next range skips the hop.
        if (isGithubAssetApiHost(new URL(url).hostname)) {
          const s3Exp = getS3UrlExpirationMs(loc);
          cdnUrlCache.set(url, {
            url: loc,
            expiresAt: s3Exp ? s3Exp - 30000 : Date.now() + CDN_URL_CACHE_TTL_MS,
          });
        }
        startDownload(loc);
        return;
      }

      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        const err = new Error(`Failed range download: status ${res.statusCode}`);
        err.headers = res.headers;
        // 403 on a signed CDN URL usually means expiry — drop cache so retry re-resolves.
        if (res.statusCode === 403 || res.statusCode === 401) {
          cdnUrlCache.delete(url);
        }
        cleanupAndReject(err);
        return;
      }

      // If the server doesn't honor Range and sends the full body (200), skip to the
      // requested offset ourselves so we still only persist the requested span.
      let skipBytes = res.statusCode === 200 ? start : 0;

      res.on('data', (chunk) => {
        if (isRejected) return;
        if (skipBytes > 0) {
          if (chunk.length <= skipBytes) {
            skipBytes -= chunk.length;
            return;
          }
          chunk = chunk.subarray(skipBytes);
          skipBytes = 0;
        }
        if (writePos > end) return;
        if (writePos + chunk.length - 1 > end) {
          chunk = chunk.subarray(0, end - writePos + 1);
        }
        res.pause();
        pendingWrites++;
        fs.write(fd, chunk, 0, chunk.length, writePos, (err, written) => {
          pendingWrites--;
          if (err) {
            cleanupAndReject(err);
            return;
          }
          writePos += written;
          if (!isRejected) res.resume();
          // 'end' can fire while this write was still in flight (pause() only
          // suppresses further 'data' emission, it doesn't delay 'end' once the
          // stream has drained its buffer) — finish up here if that happened.
          if (streamEnded && pendingWrites === 0) finish();
        });
      });

      function finish() {
        if (isRejected) return;
        activeRequests.delete(req);
        if (fd !== null) {
          try { fs.closeSync(fd); } catch (e) {}
          fd = null;
        }
        if (writePos - start !== (end - start + 1)) {
          cleanupAndReject(new Error(`Incomplete range download: expected ${end - start + 1} bytes, got ${writePos - start} bytes`));
          return;
        }
        resolve();
      }

      res.on('end', () => {
        if (isRejected) return;
        streamEnded = true;
        // Wait for any writes still in flight; finish() will be invoked by the
        // last one's callback instead of here (see comment above).
        if (pendingWrites > 0) return;
        finish();
      });
    }

    function startDownload(currentUrl) {
      const parsed = new URL(currentUrl);
      const headers = buildDownloadHeaders(parsed, token);
      headers['Range'] = `bytes=${start}-${end}`;

      const req = https.get({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers,
        timeout: 60000
      }, (res) => handleResponse(req, res));

      activeRequest = req;
      activeRequests.add(req);

      req.on('timeout', () => {
        cleanupAndReject(new Error('Range download connection timed out after 60 seconds of inactivity'));
      });

      req.on('error', (err) => {
        cleanupAndReject(err);
      });
    }

    try {
      // Open the sparse cache file once; redirects must not re-open (fd leak).
      fd = fs.openSync(destPath, 'r+');
    } catch (e) {
      cleanupAndReject(e);
      return;
    }

    // Resolve api.github.com → CDN once, then Range-GET the signed URL directly.
    resolveAssetCdnUrl(url, token)
      .then((cdnUrl) => {
        if (isRejected) return;
        startDownload(cdnUrl);
      })
      .catch((err) => cleanupAndReject(err));
  });
}

// Large single-range requests (whole video parts can be 500MB+) are more prone to
// mid-transfer connection resets on GitHub's CDN than smaller ones. Splitting into
// sub-ranges bounds how much a single connection has to deliver reliably, and lets
// a reset only cost a retry of its own sub-range instead of the whole part.
const MAX_SUBRANGE_BYTES = 64 * 1024 * 1024;

function downloadSingleRange(url, destPath, token, start, end, maxRetries) {
  let attempt = 0;

  return new Promise((resolve, reject) => {
    function execute() {
      if (isGlobalAborted) {
        reject(new Error('Download aborted due to process cleanup'));
        return;
      }
      attempt++;
      attemptRangeDownload(url, destPath, token, start, end)
        .then(resolve)
        .catch((err) => {
          if (isGlobalAborted || err.message === 'aborted') {
            reject(err);
            return;
          }
          console.warn(`[Range Download] Attempt ${attempt} failed (bytes ${start}-${end}): ${err.message}`);
          if (attempt < maxRetries) {
            const delay = computeBackoffMs(err.headers, attempt * 2000);
            console.log(`[Range Download] Retrying in ${delay}ms...`);
            setTimeout(execute, delay);
          } else {
            reject(err);
          }
        });
    }
    execute();
  });
}

async function downloadRange(url, destPath, token, start, end, maxRetries = 3) {
  if (end - start + 1 <= MAX_SUBRANGE_BYTES) {
    return downloadSingleRange(url, destPath, token, start, end, maxRetries);
  }

  for (let subStart = start; subStart <= end; subStart += MAX_SUBRANGE_BYTES) {
    const subEnd = Math.min(subStart + MAX_SUBRANGE_BYTES - 1, end);
    await downloadSingleRange(url, destPath, token, subStart, subEnd, maxRetries);
  }
}

// Merge a new [start, end] interval into a sorted list of non-overlapping, coalesced intervals.
function mergeRange(intervals, start, end) {
  const next = intervals.concat([[start, end]]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of next) {
    if (merged.length && iv[0] <= merged[merged.length - 1][1] + 1) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
    } else {
      merged.push(iv.slice());
    }
  }
  return merged;
}

// Return the sub-ranges of [start, end] not yet covered by `intervals`.
function findMissingRanges(intervals, start, end) {
  const missing = [];
  let cur = start;
  for (const [s, e] of intervals) {
    if (e < cur) continue;
    if (s > end) break;
    if (s > cur) missing.push([cur, Math.min(s - 1, end)]);
    cur = Math.max(cur, e + 1);
    if (cur > end) break;
  }
  if (cur <= end) missing.push([cur, end]);
  return missing;
}

let isGlobalAborted = false;
const activeDownloads = new Map();
const activeRequests = new Set();

function abortAllDownloads() {
  isGlobalAborted = true;
  if (activeRequests.size === 0) return;
  console.log(`[Proxy] Aborting all ${activeRequests.size} active downloads...`);
  for (const req of activeRequests) {
    try {
      req.destroy();
    } catch (e) {}
  }
  activeRequests.clear();
}
const cacheDir = path.join(WORK_DIR, 'cache');
const activeReads = new Map();
const chunkAccessOrder = [];
let MAX_CACHED_CHUNKS = parseInt(process.env.MAX_CACHED_CHUNKS || '4', 10);
// Byte ranges already fetched per part index, e.g. { 3: [[0, 4095], [1048576, 2097151]] }.
const partRanges = new Map();
// Serializes range fetches per part so overlapping requests don't race on the same sparse file.
const partQueue = new Map();

function recordAccess(assetIdx) {
  const idx = chunkAccessOrder.indexOf(assetIdx);
  if (idx !== -1) {
    chunkAccessOrder.splice(idx, 1);
  }
  chunkAccessOrder.push(assetIdx);
}

// Extra free space kept beyond the cached chunks themselves, so a slow eviction
// or a neighboring process (ffmpeg output, other work dirs) still leaves headroom.
const CACHE_DISK_SAFETY_BYTES = 2 * 1024 * 1024 * 1024;

function getFreeDiskBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch (e) {
    return Infinity; // statfs unsupported/failed: don't block on it
  }
}

function deleteChunk(assetIdx) {
  const oldPath = path.join(cacheDir, `part_${assetIdx}`);
  if (!fs.existsSync(oldPath)) return false;
  console.error(`[Proxy Cache] Deleting old cached chunk ${assetIdx} to free up space`);
  try {
    fs.unlinkSync(oldPath);
    partRanges.delete(assetIdx);
    return true;
  } catch (e) {
    console.warn(`[Proxy Cache] Failed to delete chunk ${assetIdx}:`, e);
    return false;
  }
}

// Evicts cached chunks that aren't currently being downloaded/read. Always
// enforces the MAX_CACHED_CHUNKS count cap; if neededBytes is given, keeps
// evicting (even below the count cap) until there's real free disk space for
// the incoming write, since the count cap alone can't see actual disk pressure
// from other jobs/dirs sharing the same volume.
async function cleanCache(neededBytes = 0) {
  if (!fs.existsSync(cacheDir)) return;

  const files = (await fs.promises.readdir(cacheDir))
    .filter(name => name.startsWith('part_'))
    .map(name => parseInt(name.substring(5), 10))
    .filter(num => !isNaN(num));

  const isEvictable = (assetIdx) =>
    !activeDownloads.has(assetIdx) && !(activeReads.get(assetIdx) > 0);

  files.sort((a, b) => {
    const idxA = chunkAccessOrder.indexOf(a);
    const idxB = chunkAccessOrder.indexOf(b);
    return idxA - idxB;
  });

  let deletedCount = 0;
  const targetDeleteCount = files.length - MAX_CACHED_CHUNKS;
  for (const assetIdx of files) {
    if (deletedCount >= targetDeleteCount) break;
    if (!isEvictable(assetIdx)) continue;
    if (deleteChunk(assetIdx)) deletedCount++;
  }

  if (neededBytes > 0) {
    for (const assetIdx of files) {
      if (getFreeDiskBytes(cacheDir) >= neededBytes + CACHE_DISK_SAFETY_BYTES) break;
      if (!isEvictable(assetIdx)) continue;
      deleteChunk(assetIdx);
    }
  }
}

// Ensures a sparse cache file exists for this part, sized to the full remote part
// (so byte offsets line up), without pre-filling it — actual bytes are only written
// for ranges that get downloaded.
async function ensurePartFile(assetIdx, partSize) {
  await cleanCache(partSize);
  fs.mkdirSync(cacheDir, { recursive: true });
  const destPath = path.join(cacheDir, `part_${assetIdx}`);
  if (!fs.existsSync(destPath)) {
    const free = getFreeDiskBytes(cacheDir);
    if (free < partSize + CACHE_DISK_SAFETY_BYTES) {
      throw new Error(`[Proxy Cache] Not enough disk space for chunk ${assetIdx}: need ${partSize} bytes (+${CACHE_DISK_SAFETY_BYTES} headroom), only ${free} free`);
    }
    const fd = fs.openSync(destPath, 'w');
    fs.ftruncateSync(fd, partSize);
    fs.closeSync(fd);
    partRanges.delete(assetIdx);
  }
  return destPath;
}

// Ensures [start, end] of the given part is present in the local sparse cache file,
// fetching only the byte sub-ranges that aren't cached yet (coalescing adjacent/
// overlapping requests) instead of downloading the whole ~1GB part for a small read.
function getOrDownloadRange(assetIdx, partAssets, token, start, end) {
  recordAccess(assetIdx);
  const partSize = partAssets[assetIdx].size;

  const prevTail = partQueue.get(assetIdx) || Promise.resolve();
  const task = prevTail.then(async () => {
    const destPath = await ensurePartFile(assetIdx, partSize);
    const covered = partRanges.get(assetIdx) || [];
    const missing = findMissingRanges(covered, start, end);

    for (const [mStart, mEnd] of missing) {
      console.error(`[Proxy Cache] Fetching bytes ${mStart}-${mEnd} of chunk ${assetIdx} (${mEnd - mStart + 1} bytes)...`);
      await downloadRange(partAssets[assetIdx].url, destPath, token, mStart, mEnd);
      partRanges.set(assetIdx, mergeRange(partRanges.get(assetIdx) || [], mStart, mEnd));
    }

    return destPath;
  });

  activeDownloads.set(assetIdx, task);
  // Keep the queue alive even if this task fails, so subsequent ranges on this part
  // aren't permanently blocked by one failed fetch; the caller still sees the rejection.
  partQueue.set(assetIdx, task.catch(() => {}));
  // .finally() returns its own derived promise that mirrors task's rejection.
  // task's rejection is already handled by callers (createMergedStream) and by
  // partQueue's .catch() above, but nobody consumes THIS derived promise, so
  // without the trailing catch it becomes a second, independent unhandled
  // rejection that crashes the process even though the "real" one was handled.
  task.finally(() => {
    if (activeDownloads.get(assetIdx) === task) {
      activeDownloads.delete(assetIdx);
      cleanCache().catch(() => {});
    }
  }).catch(() => {});

  return task;
}

function createMergedStream(start, end, partAssets, token) {
  let currentOffset = 0;
  const partsToRead = [];
  
  for (let i = 0; i < partAssets.length; i++) {
    const partSize = partAssets[i].size;
    const partStart = currentOffset;
    const partEnd = currentOffset + partSize - 1;
    
    const overlapStart = Math.max(start, partStart);
    const overlapEnd = Math.min(end, partEnd);
    
    if (overlapStart <= overlapEnd) {
      partsToRead.push({
        idx: i,
        startInPart: overlapStart - partStart,
        endInPart: overlapEnd - partStart
      });
    }
    currentOffset += partSize;
  }
  
  let currentPartIdx = 0;
  let currentFileStream = null;
  let openingPart = false;
  let destroyed = false;

  function processNext() {
    if (destroyed) return;
    
    if (currentFileStream) {
      currentFileStream.resume();
      return;
    }
    
    if (openingPart) {
      return;
    }
    
    if (currentPartIdx >= partsToRead.length) {
      stream.push(null);
      return;
    }
    
    openingPart = true;
    const partInfo = partsToRead[currentPartIdx];
    
    activeReads.set(partInfo.idx, (activeReads.get(partInfo.idx) || 0) + 1);
    let decremented = false;
    const decrementRead = () => {
      if (decremented) return;
      decremented = true;
      const count = activeReads.get(partInfo.idx) || 0;
      if (count <= 1) {
        activeReads.delete(partInfo.idx);
      } else {
        activeReads.set(partInfo.idx, count - 1);
      }
    };

    getOrDownloadRange(partInfo.idx, partAssets, token, partInfo.startInPart, partInfo.endInPart)
      .then((filePath) => {
        if (destroyed) {
          decrementRead();
          return;
        }
        openingPart = false;

        // Pre-fetch the next needed range in background
        if (currentPartIdx + 1 < partsToRead.length) {
          const nextPart = partsToRead[currentPartIdx + 1];
          getOrDownloadRange(nextPart.idx, partAssets, token, nextPart.startInPart, nextPart.endInPart).catch(() => {});
        }
        
        const fsStream = fs.createReadStream(filePath, {
          start: partInfo.startInPart,
          end: partInfo.endInPart
        });
        
        currentFileStream = fsStream;
        
        fsStream.on('data', (chunk) => {
          if (destroyed) {
            fsStream.destroy();
            return;
          }
          if (!stream.push(chunk)) {
            fsStream.pause();
          }
        });
        
        fsStream.on('end', () => {
          decrementRead();
          currentFileStream = null;
          currentPartIdx++;
          processNext();
        });
        
        fsStream.on('error', (err) => {
          decrementRead();
          stream.destroy(err);
        });
        
        fsStream.on('close', () => {
          decrementRead();
        });
      })
      .catch((err) => {
        decrementRead();
        stream.destroy(err);
      });
  }

  const stream = new Readable({
    read(size) {
      processNext();
    },
    destroy(err, callback) {
      destroyed = true;
      if (currentFileStream) {
        currentFileStream.destroy();
      }
      callback(err);
    }
  });

  return stream;
}

function startCachingProxy(partAssets, token) {
  return new Promise((resolve, reject) => {
    const totalSize = partAssets.reduce((acc, a) => acc + a.size, 0);
    const envMax = process.env.MAX_CACHED_CHUNKS ? parseInt(process.env.MAX_CACHED_CHUNKS, 10) : 4;
    const defaultCap = isNaN(envMax) ? 4 : envMax;
    MAX_CACHED_CHUNKS = Math.max(1, Math.min(partAssets.length, defaultCap));
    console.log(`[Proxy] Dynamically set MAX_CACHED_CHUNKS to ${MAX_CACHED_CHUNKS} for ${partAssets.length} remote chunks.`);

    const server = http.createServer((req, res) => {
      console.error(`[Proxy] Incoming request: ${req.method} ${req.url} (Range: ${req.headers['range'] || 'none'})`);
      
      if (req.url !== '/video.mp4') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      
      let start = 0;
      let end = totalSize - 1;
      let statusCode = 200;
      const rangeHeader = req.headers['range'];
      
      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        start = parseInt(parts[0], 10);
        end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        statusCode = 206;
      }
      
      res.writeHead(statusCode, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': (end - start) + 1,
        'Content-Type': 'video/mp4'
      });
      
      // destroy(err) below re-emits 'error' on res itself; without a listener
      // here that's a second unhandled 'error' event that crashes the process
      // even though the mergedStream error right below is already handled.
      res.on('error', () => {});

      const mergedStream = createMergedStream(start, end, partAssets, token);
      // pipe() doesn't forward source 'error' events to the destination, so
      // without this listener a download failure here is an unhandled
      // 'error' event on mergedStream and crashes the whole worker process.
      mergedStream.on('error', (err) => {
        console.error(`[Proxy] Merged stream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502);
        }
        res.destroy(err);
      });
      mergedStream.pipe(res);

      req.on('close', () => {
        mergedStream.destroy();
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, server });
    });

    server.on('error', reject);
  });
}

// ============================================================================
// Field-type detection + deinterlace / IVTC (ffmpeg-max for GHA)
// ----------------------------------------------------------------------------
// progressive     → no field filter
// soft_telecine   → pin film CFR (repeat_pict progressive 29.97 container)
// telecine        → fieldmatch + residual yadif + decimate + film CFR
// interlaced      → bwdif bob (send_field, deint=all) + double-rate CFR
// hybrid          → bwdif send_frame deint=all (woven combing / unknown)
//
// field_order=progressive never trusted alone.
// Override: vps.field_strategy / HLS_FIELD_STRATEGY =
//   auto|off|progressive|soft_telecine|telecine|interlaced|hybrid
// ============================================================================

const FIELD_STRATEGY_VALUES = new Set([
  'auto', 'off', 'progressive', 'soft_telecine', 'telecine', 'interlaced', 'hybrid',
]);

function normalizeFieldStrategy(value) {
  if (value === undefined || value === null || value === '') return 'auto';
  const s = String(value).toLowerCase().trim();
  if (s === 'none' || s === 'skip') return 'off';
  if (s === 'bwdif') return 'hybrid';
  if (s === 'ivtc' || s === 'detelecine') return 'telecine';
  if (s === 'bob' || s === 'deinterlace') return 'interlaced';
  return FIELD_STRATEGY_VALUES.has(s) ? s : 'auto';
}

function normalizeFieldParity(value) {
  if (!value) return 'auto';
  const p = String(value).toLowerCase().trim();
  if (p === 'tff' || p === 'bff' || p === 'auto') return p;
  return 'auto';
}

function fieldOrderParity(fieldOrder) {
  if (!fieldOrder) return null;
  const fo = String(fieldOrder).toLowerCase().trim();
  if (fo === 'tt' || fo === 'tb') return 'tff';
  if (fo === 'bb' || fo === 'bt') return 'bff';
  return null;
}

function fieldOrderIsInterlaced(fieldOrder) {
  return fieldOrderParity(fieldOrder) !== null;
}

function idetStatsDetermined(stats) {
  if (!stats) return 0;
  return stats.tff + stats.bff + stats.progressive;
}

function parseIdetStats(stderr) {
  const multiRe =
    /Multi[- ]frame detection:\s*TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)\s*Undetermined:\s*(\d+)/gi;
  let best = null;
  let m;
  while ((m = multiRe.exec(stderr)) !== null) {
    const stats = {
      tff: parseInt(m[1], 10),
      bff: parseInt(m[2], 10),
      progressive: parseInt(m[3], 10),
      undetermined: parseInt(m[4], 10),
    };
    if (!best || idetStatsDetermined(stats) >= idetStatsDetermined(best)) best = stats;
  }
  if (best && idetStatsDetermined(best) > 0) return best;

  const singleRe =
    /Single[- ]frame detection:\s*TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)\s*Undetermined:\s*(\d+)/gi;
  let singleBest = null;
  while ((m = singleRe.exec(stderr)) !== null) {
    const stats = {
      tff: parseInt(m[1], 10),
      bff: parseInt(m[2], 10),
      progressive: parseInt(m[3], 10),
      undetermined: parseInt(m[4], 10),
    };
    if (!singleBest || idetStatsDetermined(stats) >= idetStatsDetermined(singleBest)) {
      singleBest = stats;
    }
  }
  return singleBest || best;
}

function parityFromIdet(stats) {
  if (!stats) return 'auto';
  if (stats.tff > stats.bff * 1.5 && stats.tff >= 8) return 'tff';
  if (stats.bff > stats.tff * 1.5 && stats.bff >= 8) return 'bff';
  return 'auto';
}

function isConfidentlyProgressiveFromIdet(stats) {
  if (!stats) return false;
  const interlaced = stats.tff + stats.bff;
  const progressive = stats.progressive;
  const determined = interlaced + progressive;
  if (determined < 12) return false;
  return progressive >= interlaced * 2 && progressive / determined >= 0.75;
}

function isConfidentlyInterlacedFromIdet(stats) {
  if (!stats) return false;
  const interlaced = stats.tff + stats.bff;
  const progressive = stats.progressive;
  const determined = interlaced + progressive;
  if (determined < 12) return false;
  return interlaced >= progressive * 2 && interlaced / determined >= 0.6;
}

function isTelecineLikeIdet(stats) {
  if (!stats) return false;
  const interlaced = stats.tff + stats.bff;
  const progressive = stats.progressive;
  const determined = interlaced + progressive;
  if (determined < 20) return false;
  const progRatio = progressive / determined;
  const intRatio = interlaced / determined;
  return progRatio >= 0.45 && progRatio <= 0.9 && intRatio >= 0.1 && intRatio <= 0.5;
}

function fpsNear(fps, target, tol = 0.08) {
  return !!fps && isFinite(fps) && Math.abs(fps - target) <= tol;
}

function isFilmFps(fps) {
  return fpsNear(fps, 23.976, 0.12) || fpsNear(fps, 24, 0.12);
}

function isNtsc30Family(fps) {
  return fpsNear(fps, 29.97, 0.15) || fpsNear(fps, 30, 0.15);
}

function isNtsc60Family(fps) {
  return fpsNear(fps, 59.94, 0.2) || fpsNear(fps, 60, 0.2);
}

function isPal25Family(fps) {
  return fpsNear(fps, 25, 0.15);
}

function isPal50Family(fps) {
  return fpsNear(fps, 50, 0.2);
}

/** Map numeric fps to a clean ffmpeg rate string. */
function fpsToRateString(fps) {
  if (!fps || !isFinite(fps)) return null;
  if (fpsNear(fps, 23.976, 0.12)) return '24000/1001';
  if (fpsNear(fps, 24, 0.08)) return '24';
  if (fpsNear(fps, 25, 0.08)) return '25';
  if (fpsNear(fps, 29.97, 0.12)) return '30000/1001';
  if (fpsNear(fps, 30, 0.08)) return '30';
  if (fpsNear(fps, 50, 0.12)) return '50';
  if (fpsNear(fps, 59.94, 0.2)) return '60000/1001';
  if (fpsNear(fps, 60, 0.12)) return '60';
  // Keep modest precision for odd rates (cinema 21.0 etc. rare in this pipeline).
  return (Math.round(fps * 1000) / 1000).toString();
}

function bobOutRate(sourceFps) {
  if (isPal25Family(sourceFps) || isPal50Family(sourceFps)) return '50';
  if (isNtsc30Family(sourceFps) || isNtsc60Family(sourceFps)) return '60000/1001';
  if (sourceFps && isFinite(sourceFps)) return fpsToRateString(sourceFps * 2);
  return '60000/1001';
}

function parseLastFrameCount(stderr) {
  let last = null;
  const re = /frame=\s*(\d+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) last = parseInt(m[1], 10);
  return last;
}

function runFfmpegStderr(args) {
  return new Promise((resolve) => {
    console.log(`ffmpeg ${args.join(' ')}`);
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stderr }));
    child.on('error', (err) => {
      console.warn('ffmpeg spawn error:', err.message || err);
      resolve({ code: -1, stderr, error: err });
    });
  });
}

/** Bound concurrent async work while preserving result order (full-span probes). */
async function mapPool(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(concurrency || 1, list.length || 1));
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await mapper(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

// Hard 3:2 pulldown typically lands ~0.8; band absorbs short-window noise.
function isTelecineRatio(ratio) {
  return typeof ratio === 'number' && isFinite(ratio) && ratio >= 0.72 && ratio <= 0.88;
}

function isUsableIdetStats(stats) {
  if (!stats) return false;
  return idetStatsDetermined(stats) + (stats.undetermined || 0) > 0;
}

function isUsableTelecineFrameCounts(rawFrames, ivtcFrames) {
  return !!(rawFrames && ivtcFrames && rawFrames >= 40);
}

/**
 * Majority of conclusive telecine windows (ratio != null).
 * Single conclusive window: that window decides. Empty → false.
 */
function telecineMajorityDecision(results) {
  const list = Array.isArray(results) ? results : [];
  const conclusive = list.filter((r) => r && r.ratio !== null && r.ratio !== undefined);
  if (conclusive.length === 0) return false;
  const yes = conclusive.filter((r) => r.ok).length;
  if (conclusive.length === 1) return yes === 1;
  return yes >= Math.ceil(conclusive.length / 2);
}

function mergeIdetWindowStats(statsList) {
  const merged = { tff: 0, bff: 0, progressive: 0, undetermined: 0 };
  let windows = 0;
  let progHits = 0;
  let interHits = 0;
  let teleHits = 0;
  for (const stats of statsList || []) {
    if (!isUsableIdetStats(stats)) continue;
    windows += 1;
    merged.tff += stats.tff;
    merged.bff += stats.bff;
    merged.progressive += stats.progressive;
    merged.undetermined += stats.undetermined;
    if (isConfidentlyInterlacedFromIdet(stats)) interHits += 1;
    else if (isTelecineLikeIdet(stats)) teleHits += 1;
    else if (isConfidentlyProgressiveFromIdet(stats)) progHits += 1;
  }
  return { merged, windows, progHits, interHits, teleHits, any: windows > 0 };
}

/**
 * Build ffmpeg args for a short field-analysis sample.
 * seekPlacement:
 *   - 'input'  → -ss before -i (fast container seek; can be empty on some range proxies)
 *   - 'output' → -ss after -i  (accurate; historically reliable with the local cache proxy)
 */
function buildFieldAnalysisArgs(inputSource, seekSeconds, sampleSeconds, vf, seekPlacement = 'output') {
  const args = [
    '-nostdin', '-hide_banner',
    '-analyzeduration', '100M', '-probesize', '100M',
    '-protocol_whitelist', 'file,http,tcp,https,tls',
  ];
  const seek = seekSeconds > 0 ? seekSeconds : 0;
  if (seekPlacement === 'input' && seek > 0) {
    args.push('-ss', seek.toFixed(3));
  }
  args.push('-i', inputSource);
  if (seekPlacement !== 'input' && seek > 0) {
    args.push('-ss', seek.toFixed(3));
  }
  args.push('-t', String(sampleSeconds), '-an', '-sn', '-dn', '-map', '0:v:0');
  if (vf) args.push('-vf', vf);
  args.push('-f', 'null', '-');
  return args;
}

/** Index of -ss relative to -i in analysis args (-1 if none). Pure helper for selftests. */
function fieldAnalysisSeekMode(args) {
  const list = Array.isArray(args) ? args : [];
  const iIdx = list.indexOf('-i');
  const ssIdx = list.indexOf('-ss');
  if (ssIdx < 0 || iIdx < 0) return 'none';
  return ssIdx < iIdx ? 'input' : 'output';
}

async function runIdetSampleOnce(inputSource, seekSeconds, sampleSeconds, seekPlacement) {
  const { code, stderr } = await runFfmpegStderr(
    buildFieldAnalysisArgs(inputSource, seekSeconds, sampleSeconds, 'idet', seekPlacement),
  );
  const stats = parseIdetStats(stderr);
  if (stats) {
    console.log(
      `idet @${seekSeconds.toFixed(1)}s [${seekPlacement}]: TFF=${stats.tff} BFF=${stats.bff} Progressive=${stats.progressive} Undetermined=${stats.undetermined} (exit=${code})`,
    );
  } else {
    console.warn(`idet @${seekSeconds.toFixed(1)}s [${seekPlacement}]: no stats (exit=${code})`);
    const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    if (tail) console.warn(`idet stderr tail:\n${tail}`);
  }
  return stats;
}

/**
 * Prefer fast input -ss for mid/late windows; if the sample is empty/unusable
 * (known range-proxy footgun), fall back to accurate post-input -ss for that window.
 */
async function runIdetSample(inputSource, seekSeconds, sampleSeconds) {
  if (seekSeconds > 0) {
    const fast = await runIdetSampleOnce(inputSource, seekSeconds, sampleSeconds, 'input');
    if (isUsableIdetStats(fast)) return fast;
    console.warn(
      `idet @${seekSeconds.toFixed(1)}s: input -ss unusable, falling back to output -ss`,
    );
  }
  return runIdetSampleOnce(inputSource, seekSeconds, sampleSeconds, 'output');
}

// Spread N sample windows across [0, span] (relative to startTime), always including 0
// (logo/OP frame) plus evenly-paced points through the rest of the episode/chunk — so a
// cadence break mid-episode (scene change, OP/ED, effects shot) isn't missed just because
// it falls outside a few fixed near-start offsets.
function buildSpreadOffsets(span, sampleSeconds, minWindows, maxWindows) {
  if (!span || span <= sampleSeconds) return [0];
  const approx = Math.round(span / 60);
  const numWindows = Math.max(minWindows, Math.min(maxWindows, approx));
  const usableSpan = Math.max(0, span - sampleSeconds);
  const offsets = [0];
  for (let i = 1; i < numWindows; i++) {
    offsets.push(Math.round((i * usableSpan) / (numWindows - 1)));
  }
  return [...new Set(offsets)].sort((a, b) => a - b);
}

// How many independent field windows to run at once (CPU/network bound on GHA).
const FIELD_PROBE_CONCURRENCY = 3;

async function sampleInterlaceWithIdet(inputSource, startTime, sampleSeconds = 10, endTime = null) {
  // Full-span: visit EVERY planned offset (no early-exit). Cadence/combing can change
  // past the open; user preference is whole-part coverage over abort-on-majority.
  // Speed comes from input -ss + bounded concurrency, not from skipping windows.
  const span = endTime !== null ? Math.max(0, endTime - startTime) : null;
  const offsets = span !== null
    ? buildSpreadOffsets(span, sampleSeconds, 5, 12)
    : [0, 12, 45, 120, 240];

  console.log(
    `idet full-span: ${offsets.length} windows (concurrency=${FIELD_PROBE_CONCURRENCY}) offsets=[${offsets.join(',')}]`,
  );

  const perWindow = await mapPool(offsets, FIELD_PROBE_CONCURRENCY, async (rel) => {
    const seek = Math.max(0, startTime + rel);
    const stats = await runIdetSample(inputSource, seek, sampleSeconds);
    return { rel, seek, stats };
  });

  const { merged, windows, progHits, interHits, teleHits, any } = mergeIdetWindowStats(
    perWindow.map((w) => w.stats),
  );

  if (!any) return null;
  console.log(
    `idet aggregated (windows=${windows}/${offsets.length} inter=${interHits} tele=${teleHits} prog=${progHits}): TFF=${merged.tff} BFF=${merged.bff} Progressive=${merged.progressive} Undetermined=${merged.undetermined}`,
  );
  return merged;
}

async function probeTelecineWindowOnce(inputSource, seek, parity, sampleSeconds, seekPlacement) {
  const order = parity === 'bff' ? 'bff' : parity === 'tff' ? 'tff' : 'auto';
  const ivtcVf = `fieldmatch=order=${order}:combmatch=full,decimate=cycle=5`;
  // raw + IVTC are independent — run in parallel for the same seek.
  const [raw, ivtc] = await Promise.all([
    runFfmpegStderr(
      buildFieldAnalysisArgs(inputSource, seek, sampleSeconds, null, seekPlacement),
    ),
    runFfmpegStderr(
      buildFieldAnalysisArgs(inputSource, seek, sampleSeconds, ivtcVf, seekPlacement),
    ),
  ]);
  const rawFrames = parseLastFrameCount(raw.stderr);
  const ivtcFrames = parseLastFrameCount(ivtc.stderr);
  return { rawFrames, ivtcFrames, seekPlacement };
}

/**
 * Confirm hard 3:2 pulldown: IVTC frame count ≈ 0.8 × source over the same wall time.
 * Fast input -ss first; fall back to accurate output -ss if frame counts are unusable.
 */
async function probeTelecineWindow(inputSource, seek, parity, sampleSeconds = 8) {
  let rawFrames = null;
  let ivtcFrames = null;
  let usedPlacement = 'output';

  if (seek > 0) {
    const fast = await probeTelecineWindowOnce(inputSource, seek, parity, sampleSeconds, 'input');
    if (isUsableTelecineFrameCounts(fast.rawFrames, fast.ivtcFrames)) {
      rawFrames = fast.rawFrames;
      ivtcFrames = fast.ivtcFrames;
      usedPlacement = 'input';
    } else {
      console.warn(
        `Telecine @${seek.toFixed(1)}s: input -ss unusable (raw=${fast.rawFrames} ivtc=${fast.ivtcFrames}), falling back to output -ss`,
      );
    }
  }

  if (!isUsableTelecineFrameCounts(rawFrames, ivtcFrames)) {
    const accurate = await probeTelecineWindowOnce(inputSource, seek, parity, sampleSeconds, 'output');
    rawFrames = accurate.rawFrames;
    ivtcFrames = accurate.ivtcFrames;
    usedPlacement = 'output';
  }

  if (!isUsableTelecineFrameCounts(rawFrames, ivtcFrames)) {
    console.log(
      `Telecine probe @${seek.toFixed(1)}s [${usedPlacement}]: raw=${rawFrames} ivtc=${ivtcFrames} → inconclusive`,
    );
    return { ok: false, ratio: null, rawFrames, ivtcFrames, seekPlacement: usedPlacement };
  }
  const ratio = ivtcFrames / rawFrames;
  const isTc = isTelecineRatio(ratio);
  console.log(
    `Telecine probe @${seek.toFixed(1)}s [${usedPlacement}]: raw=${rawFrames} ivtc=${ivtcFrames} ratio=${ratio.toFixed(3)} → ${isTc ? 'TELECINE' : 'no'}`,
  );
  return { ok: isTc, ratio, rawFrames, ivtcFrames, seekPlacement: usedPlacement };
}

async function probeTelecine(inputSource, startTime, parity, endTime = null) {
  // Full-span: every planned offset is probed (no early-exit). Speed: concurrent
  // windows + input -ss + parallel raw/IVTC pair per window.
  const span = endTime !== null ? Math.max(0, endTime - startTime) : null;
  const seeks = span !== null
    ? buildSpreadOffsets(span, 8, 5, 8).map((rel) => Math.max(0, startTime + rel))
    : [Math.max(0, startTime + 20), Math.max(0, startTime + 90)];

  console.log(
    `telecine full-span: ${seeks.length} windows (concurrency=${FIELD_PROBE_CONCURRENCY}) seeks=[${seeks.map((s) => s.toFixed(0)).join(',')}]`,
  );

  const results = await mapPool(seeks, FIELD_PROBE_CONCURRENCY, async (seek) => {
    const result = await probeTelecineWindow(inputSource, seek, parity, 8);
    return { ...result, seek };
  });

  const conclusive = results.filter((r) => r.ratio !== null);
  const yes = conclusive.filter((r) => r.ok).length;
  const no = conclusive.length - yes;

  // Detect a possible mid-episode cadence break: if both yes and no windows show up in
  // meaningful numbers, a single fieldFilter for the whole file may not be correct
  // everywhere. This is purely diagnostic — the majority-vote return value below is
  // unchanged, and no per-segment strategy switching is attempted here.
  if (conclusive.length >= 4 && yes > 0 && no > 0) {
    const yesFrac = yes / conclusive.length;
    const noFrac = no / conclusive.length;
    if (yesFrac >= 0.2 && noFrac >= 0.2) {
      const detail = conclusive
        .map((r) => `@${r.seek !== undefined ? r.seek.toFixed(1) : '?'}s ratio=${r.ratio.toFixed(3)} → ${r.ok ? 'TELECINE' : 'no'}`)
        .join(', ');
      console.warn(
        `possible mixed/inconsistent telecine cadence - episode may have combing artifacts in some sections; single-pass field strategy may not fully clean the whole file (yes=${yes} no=${no} of ${conclusive.length} conclusive windows): ${detail}`,
      );
    }
  }

  return telecineMajorityDecision(results);
}

function buildBwdifFilter(mode, parity) {
  const p = parity === 'tff' || parity === 'bff' ? parity : 'auto';
  const m = mode === 'send_field' ? 'send_field' : 'send_frame';
  return `bwdif=mode=${m}:parity=${p}:deint=all`;
}

function buildIvtcFilter(parity) {
  const order = parity === 'bff' ? 'bff' : parity === 'tff' ? 'tff' : 'auto';
  const bParity = order === 'auto' ? 'auto' : order;
  return `fieldmatch=order=${order}:combmatch=full,bwdif=mode=send_frame:parity=${bParity}:deint=interlaced,decimate=cycle=5`;
}

function makeFieldPlan(strategy, parity, fieldFilter, outFps, reason) {
  return {
    strategy,
    parity: parity || 'auto',
    fieldFilter: fieldFilter || null,
    outFps: outFps || null,
    reason: reason || strategy,
  };
}

function planFromForcedStrategy(forced, parity, sourceFps) {
  switch (forced) {
    case 'off':
    case 'progressive':
      return makeFieldPlan('progressive', parity, null, null, `forced:${forced}`);
    case 'soft_telecine':
      return makeFieldPlan('soft_telecine', parity, null, '24000/1001', 'forced:soft_telecine');
    case 'telecine':
      return makeFieldPlan('telecine', parity, buildIvtcFilter(parity), '24000/1001', 'forced:telecine');
    case 'interlaced':
      return makeFieldPlan(
        'interlaced',
        parity,
        buildBwdifFilter('send_field', parity),
        bobOutRate(sourceFps),
        'forced:interlaced',
      );
    case 'hybrid':
      return makeFieldPlan(
        'hybrid',
        parity,
        buildBwdifFilter('send_frame', parity),
        fpsToRateString(sourceFps),
        'forced:hybrid',
      );
    default:
      return null;
  }
}

/**
 * @returns {{
 *   strategy: string,
 *   parity: string,
 *   fieldFilter: string|null,
 *   outFps: string|null,
 *   reason: string,
 * }}
 */
async function detectFieldStrategy(inputSource, videoStream, startTime, options = {}) {
  const endTime = options.endTime !== undefined ? options.endTime : null;
  const fieldOrder = videoStream && videoStream.field_order;
  const rFps = videoStream && videoStream.r_frame_rate
    ? parseFrameRate(videoStream.r_frame_rate)
    : null;
  const avgFps = videoStream && videoStream.avg_frame_rate
    ? parseFrameRate(videoStream.avg_frame_rate)
    : null;
  const sourceFps = avgFps || rFps;

  let parity = normalizeFieldParity(options.forceParity);
  if (parity === 'auto') {
    parity = fieldOrderParity(fieldOrder) || 'auto';
  }

  const forced = normalizeFieldStrategy(options.forceStrategy);
  if (forced !== 'auto') {
    const plan = planFromForcedStrategy(forced, parity, sourceFps);
    console.log(`Field strategy FORCED → ${JSON.stringify(plan)}`);
    return plan;
  }

  // 1) Container says true interlaced.
  if (fieldOrderIsInterlaced(fieldOrder)) {
    if (parity === 'auto') parity = fieldOrderParity(fieldOrder) || 'auto';
    const plan = makeFieldPlan(
      'interlaced',
      parity,
      buildBwdifFilter('send_field', parity),
      bobOutRate(sourceFps),
      `field_order=${fieldOrder}`,
    );
    console.log(`Field strategy: ${JSON.stringify(plan)}`);
    return plan;
  }

  // 2) Soft telecine: r≈29.97 container rate, avg≈23.976 film delivery, progressive samples.
  //    Progressive frames with pulldown flags — do NOT hard-IVTC or bwdif.
  const softTelecineMeta =
    isNtsc30Family(rFps) && isFilmFps(avgFps) && Math.abs((rFps || 0) - (avgFps || 0)) > 1.0;

  console.log(
    `Field strategy probe: field_order=${fieldOrder || 'missing'} r=${rFps || '?'} avg=${avgFps || '?'} softMeta=${softTelecineMeta}`,
  );

  const stats = await sampleInterlaceWithIdet(inputSource, startTime, 10, endTime);
  if (stats) {
    const idetParity = parityFromIdet(stats);
    if (parity === 'auto' && idetParity !== 'auto') parity = idetParity;
  }

  // Already bobbed / high-frame progressive (common 4K remasters) → leave alone.
  if (
    (isNtsc60Family(rFps) || isPal50Family(rFps) || isNtsc60Family(avgFps) || isPal50Family(avgFps)) &&
    isConfidentlyProgressiveFromIdet(stats)
  ) {
    const plan = makeFieldPlan('progressive', parity, null, null, 'high-fps progressive (skip)');
    console.log(`Field strategy: ${JSON.stringify(plan)}`);
    return plan;
  }

  if (softTelecineMeta && (isConfidentlyProgressiveFromIdet(stats) || !stats)) {
    const plan = makeFieldPlan(
      'soft_telecine',
      parity,
      null,
      '24000/1001',
      'r≈29.97 avg≈23.976 progressive',
    );
    console.log(`Field strategy: ${JSON.stringify(plan)}`);
    return plan;
  }

  // True film progressive masters (typical clean 4K movies).
  if (isFilmFps(sourceFps) && isConfidentlyProgressiveFromIdet(stats)) {
    const plan = makeFieldPlan('progressive', parity, null, null, 'film progressive');
    console.log(`Field strategy: ${JSON.stringify(plan)}`);
    return plan;
  }

  // PAL 25 progressive.
  if (isPal25Family(sourceFps) && isConfidentlyProgressiveFromIdet(stats)) {
    const plan = makeFieldPlan('progressive', parity, null, null, 'PAL progressive');
    console.log(`Field strategy: ${JSON.stringify(plan)}`);
    return plan;
  }

  // -------------------------------------------------------------------------
  // NTSC ~29.97 (ADN/webrip anime, old TV):
  // Run BEFORE generic interlaced bob. Telecine content often looks "interlaced"
  // to idet (high TFF); IVTC is better for film anime when probe hits. Else bob
  // or hybrid — never progressive-skip on this rate (combing stays).
  // -------------------------------------------------------------------------
  const ntsc30 = isNtsc30Family(rFps) || isNtsc30Family(sourceFps);
  if (ntsc30) {
    let isTc = false;
    try {
      isTc = await probeTelecine(inputSource, startTime, parity, endTime);
    } catch (e) {
      console.warn('Telecine probe failed:', e.message || e);
    }

    if (isTc) {
      const plan = makeFieldPlan(
        'telecine',
        parity,
        buildIvtcFilter(parity),
        '24000/1001',
        'NTSC 29.97 hard 3:2 pulldown',
      );
      console.log(`Field strategy: ${JSON.stringify(plan)}`);
      return plan;
    }

    // Strong field dominance → bob to 60p (cleans combing, smooth motion).
    if (isConfidentlyInterlacedFromIdet(stats)) {
      const plan = makeFieldPlan(
        'interlaced',
        parity,
        buildBwdifFilter('send_field', parity),
        bobOutRate(sourceFps),
        'NTSC 29.97 idet interlaced (telecine probe negative)',
      );
      console.log(`Field strategy: ${JSON.stringify(plan)}`);
      return plan;
    }

    // Progressive-tagged webrip with residual combing (common ADN/old TV):
    // bwdif every frame at source fps — same class of fix as "looks bad without bwdif".
    const plan = makeFieldPlan(
      'hybrid',
      parity,
      buildBwdifFilter('send_frame', parity),
      fpsToRateString(sourceFps) || '30000/1001',
      'NTSC 29.97 progressive-tagged → hybrid bwdif (no skip)',
    );
    console.log(`Field strategy: ${JSON.stringify(plan)}`);
    return plan;
  }

  // Non-NTSC true interlaced (e.g. PAL 25i) → bob.
  if (isConfidentlyInterlacedFromIdet(stats)) {
    const plan = makeFieldPlan(
      'interlaced',
      parity,
      buildBwdifFilter('send_field', parity),
      bobOutRate(sourceFps),
      'idet interlaced',
    );
    console.log(`Field strategy: ${JSON.stringify(plan)}`);
    return plan;
  }

  // Non-NTSC progressive idet can skip.
  if (isConfidentlyProgressiveFromIdet(stats)) {
    const plan = makeFieldPlan('progressive', parity, null, null, 'idet progressive');
    console.log(`Field strategy: ${JSON.stringify(plan)}`);
    return plan;
  }

  // Fail-open hybrid.
  const plan = makeFieldPlan(
    'hybrid',
    parity,
    buildBwdifFilter('send_frame', parity),
    fpsToRateString(sourceFps),
    stats ? 'idet inconclusive' : 'idet empty/fail-open',
  );
  console.log(`Field strategy: ${JSON.stringify(plan)}`);
  return plan;
}

/** field restore → optional CFR pin → optional HDR→SDR tonemap → scale. */
function buildScaleVf(targetHeight, fieldPlan, tonemapFilter) {
  const scale = `scale='trunc(oh*a/2)*2':'trunc(min(${targetHeight},ih)/2)*2'`;
  if (!fieldPlan || typeof fieldPlan !== 'object') {
    return tonemapFilter ? `${tonemapFilter},${scale}` : scale;
  }
  const parts = [];
  if (fieldPlan.fieldFilter) parts.push(fieldPlan.fieldFilter);
  if (fieldPlan.outFps) parts.push(`fps=${fieldPlan.outFps}`);
  // Tonemap runs on native (deinterlaced/IVTC'd) pixel data, before the final scale.
  if (tonemapFilter) parts.push(tonemapFilter);
  parts.push(scale);
  return parts.join(',');
}

function fieldPlanOutputFpsNumber(fieldPlan, fallbackFps) {
  if (fieldPlan && fieldPlan.outFps) {
    const s = String(fieldPlan.outFps);
    if (s.includes('/')) {
      const [a, b] = s.split('/');
      const n = parseFloat(a) / parseFloat(b);
      if (isFinite(n) && n > 0) return n;
    } else {
      const n = parseFloat(s);
      if (isFinite(n) && n > 0) return n;
    }
  }
  return fallbackFps && isFinite(fallbackFps) ? fallbackFps : 30;
}

/**
 * Scene cuts on the SAME field+fps chain as encode so -force_key_frames
 * timestamps match the post-filter clock (critical after IVTC / bob).
 */
function detectSceneCuts(inputSource, startTime, endTime, fieldPlan) {
  return new Promise((resolve) => {
    // Match encode seek style: input -ss before -i so output PTS start near 0 and
    // -force_key_frames times stay part-relative. Field+fps filters still run so cuts
    // land on the post-restore clock (IVTC/bob), not the raw source cadence.
    const args = ['-nostdin', '-hide_banner'];
    if (startTime > 0) args.push('-ss', startTime.toFixed(3));
    args.push(
      '-analyzeduration', '100M', '-probesize', '100M',
      '-protocol_whitelist', 'file,http,tcp,https,tls',
      '-i', inputSource,
    );
    if (endTime !== null) {
      args.push('-t', Math.max(0, endTime - startTime).toFixed(3));
    }

    const vfParts = [];
    if (fieldPlan && fieldPlan.fieldFilter) vfParts.push(fieldPlan.fieldFilter);
    if (fieldPlan && fieldPlan.outFps) vfParts.push(`fps=${fieldPlan.outFps}`);
    vfParts.push('scale=-2:240');
    vfParts.push("select='gt(scene,0.4)'");
    vfParts.push('showinfo');

    args.push('-an', '-sn', '-dn', '-map', '0:v:0', '-vf', vfParts.join(','), '-f', 'null', '-');

    console.log(`Running scene-cut detection (post-field clock): ffmpeg ${args.join(' ')}`);
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', () => {
      const timestamps = [];
      const regex = /Parsed_showinfo_.*pts_time:([0-9.]+)/;
      for (const line of stderr.split(/\r?\n/)) {
        const match = regex.exec(line);
        if (match) {
          let t = parseFloat(match[1]);
          if (isNaN(t)) continue;
          // If PTS stayed on the absolute input timeline, fold back to part-local.
          if (startTime > 0 && t >= startTime - 0.001) t = Math.max(0, t - startTime);
          timestamps.push(t);
        }
      }
      console.log(`Detected ${timestamps.length} scene cuts (post-field).`);
      resolve(timestamps);
    });

    child.on('error', (err) => {
      console.warn('Error during scene-cut detection:', err);
      resolve([]);
    });
  });
}

function generateKeyframeTimeline(sceneCuts, duration, targetSec = 6, minSec = 3, maxSec = 9) {
  const forcedTimestamps = [];
  let lastKeyframe = 0;

  while (lastKeyframe < duration) {
    const naturalCut = sceneCuts.find(t => t >= lastKeyframe + minSec && t <= lastKeyframe + maxSec);

    if (naturalCut !== undefined) {
      forcedTimestamps.push(naturalCut);
      lastKeyframe = naturalCut;
    } else {
      const nextForced = Math.min(duration, lastKeyframe + targetSec);
      if (nextForced >= duration - 0.5) break;
      
      forcedTimestamps.push(nextForced);
      lastKeyframe = nextForced;
    }
  }
  return forcedTimestamps;
}

/**
 * Whether this runner should compute the shared scene-cut segment timeline.
 * Audio is always a separate job from video, but both must recompute the same
 * 3-9s grid so A/V boundaries line up. Original remux / subtitles / thumbnails
 * do not use that grid.
 */
function shouldComputeSegmentTimeline(kind, { isSubtitlesJob = false, isThumbnailsJob = false } = {}) {
  return kind !== 'original' && !isSubtitlesJob && !isThumbnailsJob;
}

// Storyboard scrub previews: 1s tiles @ 480px WebP q85.
// 10×10 = 100 tiles/sheet ≈ 1m40s per sheet; multi-zip under MAX_ZIP_BYTES like video/audio.
const THUMB_STORYBOARD = Object.freeze({
  intervalSec: 1,
  tileWidth: 480,
  cols: 10,
  rows: 10,
  // WebP: simple image2 sequence, decodes everywhere we care about (Safari/iOS/FF/Chrome).
  extension: 'webp',
  webpQuality: 85,
});

function countStoryboardThumbs(durationSec, intervalSec = THUMB_STORYBOARD.intervalSec) {
  if (!(durationSec > 0) || !(intervalSec > 0)) return 0;
  return Math.ceil(durationSec / intervalSec);
}

function storyboardTilesPerSheet(cols = THUMB_STORYBOARD.cols, rows = THUMB_STORYBOARD.rows) {
  return cols * rows;
}

/** 0-based thumb index → 0-based sheet index */
function storyboardSheetIndexForThumb(thumbIndex0, cols = THUMB_STORYBOARD.cols, rows = THUMB_STORYBOARD.rows) {
  const per = storyboardTilesPerSheet(cols, rows);
  if (per <= 0 || thumbIndex0 < 0) return 0;
  return Math.floor(thumbIndex0 / per);
}

/** 0-based sheet index → thumb_sprite_001.webp style name */
function storyboardSheetName(sheetIndex0, extension = THUMB_STORYBOARD.extension) {
  return `thumb_sprite_${String(sheetIndex0 + 1).padStart(3, '0')}.${extension}`;
}

/**
 * Build WebVTT storyboard cues (no WEBVTT header). tileWidth/tileHeight are the
 * per-cell sizes after scale+tile (probed from the first sheet in production).
 */
function buildStoryboardVttBody(durationSec, tileWidth, tileHeight, opts = {}) {
  const intervalSec = opts.intervalSec ?? THUMB_STORYBOARD.intervalSec;
  const cols = opts.cols ?? THUMB_STORYBOARD.cols;
  const rows = opts.rows ?? THUMB_STORYBOARD.rows;
  const extension = opts.extension ?? THUMB_STORYBOARD.extension;
  const totalThumbs = countStoryboardThumbs(durationSec, intervalSec);
  const tilesPerSheet = storyboardTilesPerSheet(cols, rows);
  let vtt = '';
  for (let i = 0; i < totalThumbs; i++) {
    const start = i * intervalSec;
    const end = Math.min(start + intervalSec, durationSec);
    const sheetIdx = storyboardSheetIndexForThumb(i, cols, rows);
    const localIdx = i % tilesPerSheet;
    const col = localIdx % cols;
    const row = Math.floor(localIdx / cols);
    const sheetName = storyboardSheetName(sheetIdx, extension);
    vtt += `${formatTimestamp(start)} --> ${formatTimestamp(end)}\n`;
    vtt += `thumbnails/${sheetName}#xywh=${col * tileWidth},${row * tileHeight},${tileWidth},${tileHeight}\n\n`;
  }
  return vtt;
}

function storyboardSpriteGlob(extension = THUMB_STORYBOARD.extension) {
  // Escape for RegExp; extension is a fixed constant (webp) in production.
  const esc = String(extension).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^thumb_sprite_\\d+\\.${esc}$`);
}

function hasLibwebpEncoder() {
  try {
    const out = execSync('ffmpeg -hide_banner -encoders 2>&1', {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    return /\blibwebp\b/.test(out);
  } catch {
    return false;
  }
}

async function main() {
  isGlobalAborted = false;
  let payloadStr = process.env.EVENT_PAYLOAD;
  if (!payloadStr && process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      if (event.client_payload) {
        payloadStr = JSON.stringify(event.client_payload);
      }
    } catch (e) {
      console.warn('Failed to read EVENT_PAYLOAD from GITHUB_EVENT_PATH:', e.message);
    }
  }
  const token = process.env.PRIVATE_REPO_TOKEN;

  if (!payloadStr) {
    console.error('Error: EVENT_PAYLOAD environment variable is missing and GITHUB_EVENT_PATH could not be read.');
    process.exit(1);
  }
  if (!token) {
    console.error('Error: PRIVATE_REPO_TOKEN environment variable is missing.');
    process.exit(1);
  }

  const payload = JSON.parse(payloadStr);
  const data = payload.data || payload;
  const {
    file_id,
    user_id,
    source_release_id,
    release_id,
    owner,
    repo,
    kind,
    vps,
    vps_callback_url: flat_vps_callback_url,
    vps_callback_token: flat_vps_callback_token
  } = data;

  const vps_callback_url = vps ? vps.callback_url : flat_vps_callback_url;
  const vps_callback_token = vps ? vps.callback_token : flat_vps_callback_token;

  // Which backend this job's releases live on, and the asset cap that sizes
  // every zip. Must run before any storage call or zip batching below.
  configureStorage(data.storage, token);

  let activePart = null;
  try {
    if (process.env.ACTIVE_PART) {
      activePart = JSON.parse(process.env.ACTIVE_PART);
    }
  } catch (e) {}

  const partIndex = activePart && activePart.part_index !== undefined 
    ? parseInt(activePart.part_index, 10) 
    : (data.part_index !== undefined ? parseInt(data.part_index, 10) : 1);

  try {
    const hls_audio_bitrate = (vps && vps.audio_bitrate !== undefined) ? parseInt(vps.audio_bitrate, 10) : 192;
    const subtitle_metadata = vps ? vps.subtitle_metadata : undefined;

    // Propagate HLS limits from vps payload to environment variables for dynamic clamping
    if (vps) {
      if (vps.av1_slowest_preset_limit !== undefined) process.env.HLS_AV1_SLOWEST_PRESET_LIMIT = String(vps.av1_slowest_preset_limit);
      if (vps.av1_fastest_preset_limit !== undefined) process.env.HLS_AV1_FASTEST_PRESET_LIMIT = String(vps.av1_fastest_preset_limit);
      if (vps.h264_slowest_preset_limit !== undefined) process.env.HLS_H264_SLOWEST_PRESET_LIMIT = String(vps.h264_slowest_preset_limit);
      if (vps.h264_fastest_preset_limit !== undefined) process.env.HLS_H264_FASTEST_PRESET_LIMIT = String(vps.h264_fastest_preset_limit);
      if (vps.av1_min_crf_limit !== undefined) process.env.HLS_AV1_MIN_CRF_LIMIT = String(vps.av1_min_crf_limit);
      if (vps.av1_max_crf_limit !== undefined) process.env.HLS_AV1_MAX_CRF_LIMIT = String(vps.av1_max_crf_limit);
      if (vps.h264_min_crf_limit !== undefined) process.env.HLS_H264_MIN_CRF_LIMIT = String(vps.h264_min_crf_limit);
      if (vps.h264_max_crf_limit !== undefined) process.env.HLS_H264_MAX_CRF_LIMIT = String(vps.h264_max_crf_limit);
    }

    const startTime = activePart && activePart.start_time !== undefined 
      ? parseFloat(activePart.start_time) 
      : (data.start_time !== undefined ? parseFloat(data.start_time) : 0);
    const endTime = activePart && activePart.end_time !== undefined 
      ? (activePart.end_time !== null ? parseFloat(activePart.end_time) : null) 
      : (data.end_time !== undefined && data.end_time !== null ? parseFloat(data.end_time) : null);
    const startSegmentIndex = activePart && activePart.start_segment_index !== undefined 
      ? parseInt(activePart.start_segment_index, 10) 
      : (data.start_segment_index !== undefined ? parseInt(data.start_segment_index, 10) : 0);
  // If dedicated metadata runner is configured in rawResolutions, only that runner should extract subtitles and audio.
  // Otherwise (e.g., local execution), the primary resolution runner handles it.
  const rawResolutions = data.resolutions || [
    {
      label: data.label || '1080p',
      targetHeight: data.target_height !== undefined ? parseInt(data.target_height, 10) : null,
      preset: (vps && vps.preset) ? vps.preset : 'veryfast',
      crf: (vps && vps.crf !== undefined) ? String(vps.crf) : '20',
      maxrate: (vps && vps.maxrate) ? String(vps.maxrate) : undefined,
      bufsize: (vps && vps.bufsize) ? String(vps.bufsize) : undefined,
      profile: (vps && vps.profile) ? String(vps.profile) : undefined,
      level: (vps && vps.level) ? String(vps.level) : undefined,
      av1Preset: (vps && vps.av1_preset !== undefined) ? String(vps.av1_preset) : getAV1ParamsForLabel(data.label || '1080p').preset,
      av1Crf: (vps && vps.av1_crf !== undefined) ? String(vps.av1_crf) : getAV1ParamsForLabel(data.label || '1080p').crf
    }
  ];

  const hasMetadataRunner = rawResolutions.some(r => r.label === 'metadata' || r.label === 'audio');
  const hasSubtitlesRunner = rawResolutions.some(r => r.label === 'subtitles');
  const activeLabel = process.env.ACTIVE_RESOLUTION_LABEL || data.label;
  const isAudioJob = activeLabel === 'audio' || activeLabel === 'metadata';
  const isSubtitlesJob = activeLabel === 'subtitles';
  const isThumbnailsJob = activeLabel === 'thumbnails';
  const isMetadataJob = isAudioJob; // Keep isMetadataJob for backward compatibility

  const extract_subtitles = !isThumbnailsJob && (isSubtitlesJob || (!hasSubtitlesRunner && (hasMetadataRunner ? isAudioJob : true) &&
    (activePart && activePart.extract_subtitles !== undefined
      ? !!activePart.extract_subtitles
      : ((vps && vps.extract_subtitles !== undefined) ? !!vps.extract_subtitles : true))));

  const extract_audio = !isSubtitlesJob && !isThumbnailsJob && (hasMetadataRunner ? isAudioJob : true) &&
    (activePart && activePart.extract_audio !== undefined
      ? !!activePart.extract_audio
      : ((vps && vps.extract_audio !== undefined) ? !!vps.extract_audio : true));

  // Resolve Codecs list
  let codecs = ['h264'];
  if (vps && Array.isArray(vps.codecs)) {
    codecs = vps.codecs;
  } else if (process.env.HLS_CODECS) {
    codecs = process.env.HLS_CODECS.split(',').map(c => c.trim()).filter(Boolean);
  }


  const resolutions = process.env.ACTIVE_RESOLUTION_LABEL
    ? rawResolutions.filter(r => r.label === process.env.ACTIVE_RESOLUTION_LABEL)
    : (process.env.ACTIVE_RESOLUTION
        ? [JSON.parse(process.env.ACTIVE_RESOLUTION)]
        : rawResolutions);

  console.log(`Starting HLS Optimization Job for file: ${file_id} (Release: ${release_id}, Kind: ${kind}, Codecs: [${codecs.join(', ')}], Resolutions: [${resolutions.map(r => r.label).join(', ')}], Audio Bitrate: ${hls_audio_bitrate}k, extract_subtitles=${extract_subtitles}, extract_audio=${extract_audio}, startTime=${startTime}, endTime=${endTime}, startSegmentIndex=${startSegmentIndex}, partIndex=${partIndex})`);

  // 1. Prepare directories
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const completedSubtitleZips = [];

  // 2. Fetch Source Release Assets info
  const sourceReleaseId = source_release_id || release_id; // Fallback if source_release_id is not provided
  console.log(`Fetching source and target release info...`);
  const sourceReleaseInfo = await fetchReleaseInfo(owner, repo, sourceReleaseId, token);
  const targetReleaseInfo = await fetchReleaseInfo(owner, repo, release_id, token);
  const uploadUrl = targetReleaseInfo.upload_url;

  // Release rotation variables for handling large numbers of assets (>750)
  let currentReleaseId = release_id;
  let currentUploadUrl = uploadUrl;
  let lastCheckedCount = -1;
  let assetsUploadedSinceCheck = 0;
  const githubReleaseIds = [release_id];

  async function uploadAssetWithRotation(assetName, filePath, contentType) {
    let currentCount = lastCheckedCount;
    if (lastCheckedCount === -1 || assetsUploadedSinceCheck >= 5) {
      try {
        currentCount = await getReleaseAssetsCount(owner, repo, currentReleaseId, token);
        console.log(`[Upload] Fetched assets count for release ${currentReleaseId}: ${currentCount} assets.`);
        lastCheckedCount = currentCount;
        assetsUploadedSinceCheck = 0;
      } catch (e) {
        console.warn(`[Upload] Failed to fetch current assets count: ${e.message}. Using local fallback.`);
        currentCount = lastCheckedCount !== -1 ? lastCheckedCount + assetsUploadedSinceCheck : 0;
      }
    } else {
      currentCount = lastCheckedCount + assetsUploadedSinceCheck;
    }

    if (currentCount >= 750) {
      console.log(`Current release ${currentReleaseId} has reached the asset limit (${currentCount} assets). Creating a new release...`);
      const newReleaseCount = githubReleaseIds.length + 1;
      const newRelease = await createNewRelease(owner, repo, file_id, label, newReleaseCount, token);
      currentReleaseId = newRelease.releaseId;
      currentUploadUrl = newRelease.uploadUrl;
      githubReleaseIds.push(currentReleaseId);
      lastCheckedCount = 0;
      assetsUploadedSinceCheck = 0;
      currentCount = 0;
    }
    
    const res = await uploadAssetFile(
      currentUploadUrl,
      assetName,
      filePath,
      contentType,
      token,
      currentReleaseId,
    );
    assetsUploadedSinceCheck++;
    return res;
  }

  // Filter out and sort the split parts from the source release
  let partAssets = sourceReleaseInfo.assets
    .filter(a => a.name.includes('.part'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (partAssets.length === 0) {
    // Fallback for non-chunked source video uploads (e.g., single mp4/mkv files)
    partAssets = sourceReleaseInfo.assets
      .filter(a => !a.name.endsWith('.zip') && !a.name.endsWith('.m3u8') && !a.name.endsWith('.vtt') && !a.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (partAssets.length === 0) {
    console.error(`Error: No source files found in the source release (${sourceReleaseId}).`);
    process.exit(1);
  }

  // 3. Resolve signed CDN URLs once up front so the first probe/seek doesn't pay
  // api.github.com latency (and so concurrent range fetches share one resolve).
  console.log(`Pre-resolving CDN URLs for ${partAssets.length} source asset(s)...`);
  const prewarmStart = Date.now();
  await Promise.all(
    partAssets.map((a) =>
      resolveAssetCdnUrl(a.url, token).catch((e) => {
        console.warn(`[CDN Cache] Prewarm failed for ${a.name}: ${e.message}`);
      }),
    ),
  );
  console.log(`CDN prewarm done in ${Date.now() - prewarmStart}ms`);

  // 4. Start local HTTP proxy with caching
  console.log(`Starting local caching HTTP proxy server for ${partAssets.length} remote chunks...`);
  const proxyInfo = await startCachingProxy(partAssets, token);
  globalProxyServer = proxyInfo.server;
  const proxyPort = proxyInfo.port;
  console.log(`Local caching HTTP proxy server listening on port ${proxyPort}`);

  const inputSource = `http://127.0.0.1:${proxyPort}/video.mp4`;

  // 5. Probe video stream properties
  console.log('Probing video stream properties...');
  const probeCmd = `ffprobe -v error -analyzeduration 100M -probesize 100M -show_entries "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,channels,r_frame_rate,avg_frame_rate,bit_rate,field_order,pix_fmt,bits_per_raw_sample,profile,color_transfer,color_primaries,color_space,color_range:stream_tags" -of json -protocol_whitelist file,http,tcp,https,tls "${inputSource}"`;
  const probeData = JSON.parse(await execAsync(probeCmd, { maxBuffer: 100 * 1024 * 1024 }));

  const videoStream = probeData.streams.find(s => s.codec_type === 'video');
  if (!videoStream) {
    console.error('Error: No video stream found in the source file.');
    process.exit(1);
  }
  const inferredWidth = videoStream.width || null;
  const inferredHeight = videoStream.height || null;
  const inferredCodec = kind === 'original' ? (videoStream.codec_name || 'copy') : 'h264';

  const format = probeData.format || {};
  const duration = format.duration ? parseFloat(format.duration) : (vps && vps.duration ? parseFloat(vps.duration) : 0);
  const fileSize = format.size ? parseInt(format.size, 10) : 0;

  // Standalone mode: probe once per PART (not per resolution), running in its own matrix
  // cell in parallel with every other part's probe. Result is uploaded as a release asset
  // (field-plan-part{N}.json) so resolution jobs - a separate, later workflow job - can
  // fetch it themselves; see the hard-fail check further down for what happens if missing.
  if (process.env.FIELD_DETECT_ONLY === '1') {
    const forceStrategy = normalizeFieldStrategy((vps && vps.field_strategy) || process.env.HLS_FIELD_STRATEGY || 'auto');
    const forceParity = normalizeFieldParity((vps && vps.field_parity) || process.env.HLS_FIELD_PARITY || 'auto');
    let fieldPlan;
    try {
      fieldPlan = await detectFieldStrategy(inputSource, videoStream, startTime, {
        forceStrategy, forceParity, endTime: endTime !== null ? endTime : duration,
      });
    } catch (e) {
      fieldPlan = makeFieldPlan('hybrid', forceParity === 'auto' ? 'auto' : forceParity,
        buildBwdifFilter('send_frame', forceParity), null, 'detect-error-fail-open');
    }
    let forcedKeyframeString = null;
    try {
      const chunkDuration = (endTime !== null ? endTime : duration) - startTime;
      const sceneCuts = await detectSceneCuts(inputSource, startTime, endTime, fieldPlan);
      const forcedTimestamps = generateKeyframeTimeline(sceneCuts, chunkDuration, 6, 3, 9);
      if (forcedTimestamps.length > 0) forcedKeyframeString = forcedTimestamps.map(t => t.toFixed(3)).join(',');
    } catch (e) {}
    const result = { field_plan: fieldPlan, forced_keyframe_string: forcedKeyframeString };
    fs.writeFileSync(process.env.FIELD_DETECT_OUTPUT_PATH, JSON.stringify(result));
    await uploadAssetWithRotation(`field-plan-part${partIndex}.json`, process.env.FIELD_DETECT_OUTPUT_PATH, 'application/json');
    console.log(`FIELD_DETECT_RESULT=${JSON.stringify(result)}`);
    process.exit(0);
  }

  let origBitrateKbps = vps && vps.source_bitrate_kbps ? parseInt(vps.source_bitrate_kbps, 10) : null;
  if (!origBitrateKbps) {
    if (format.bit_rate) {
      origBitrateKbps = Math.round(parseInt(format.bit_rate, 10) / 1000);
    } else if (duration > 0 && fileSize > 0) {
      origBitrateKbps = Math.round((fileSize * 8) / duration / 1000);
    }
  }
  const origHeight = inferredHeight || (vps && vps.source_height ? parseInt(vps.source_height, 10) : null);



  const audioStream = probeData.streams.find(s => s.codec_type === 'audio');
  const hasAacAudio = audioStream && audioStream.codec_name?.toLowerCase() === 'aac';

  // Find text subtitle streams that FFmpeg can parse to webvtt, plus bitmap streams (.sup / .sub)
  const textSubtitleCodecs = new Set(['ass', 'ssa', 'srt', 'subrip', 'webvtt', 'mov_text', 'text']);
  const bitmapSubtitleCodecs = new Set(['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'vobsub']);
  const subtitleStreams = [];
  const audioStreams = [];

  const ISO_639_2_TO_1 = {
    // A
    aar: 'aa', abk: 'ab', afr: 'af', aka: 'ak', amh: 'am', ara: 'ar', arg: 'an', asm: 'as', ava: 'av', aym: 'ay', aze: 'az',
    // B
    bak: 'ba', bam: 'bm', bel: 'be', ben: 'bn', bod: 'bo', tib: 'bo', bos: 'bs', bre: 'br', bul: 'bg',
    // C
    cat: 'ca', ces: 'cs', cze: 'cs', cha: 'ch', che: 'ce', chu: 'cu', chv: 'cv', cor: 'kw', cos: 'co', cre: 'cr', cym: 'cy', wel: 'cy',
    // D
    dan: 'da', deu: 'de', ger: 'de', div: 'dv', dzo: 'dz',
    // E
    ell: 'el', gre: 'el', eng: 'en', epo: 'eo', est: 'et', eus: 'eu', baq: 'eu', ewe: 'ee',
    // F
    fao: 'fo', fas: 'fa', per: 'fa', fij: 'fj', fin: 'fi', fra: 'fr', fre: 'fr', fry: 'fy', ful: 'ff',
    // G
    gla: 'gd', gle: 'ga', glg: 'gl', glv: 'gv', grn: 'gn', guj: 'gu',
    // H
    hau: 'ha', heb: 'he', her: 'hz', hin: 'hi', hmo: 'ho', hrv: 'hr', hun: 'hu', hye: 'hy', arm: 'hy',
    // I
    iba: 'ib', ibo: 'ig', ido: 'io', iii: 'ii', iku: 'iu', ile: 'ie', ina: 'ia', ind: 'id', ipk: 'ik', isl: 'is', ice: 'is', ita: 'it',
    // J
    jav: 'jv', jpn: 'ja',
    // K
    kal: 'kl', kan: 'kn', kas: 'ks', kat: 'ka', geo: 'ka', kau: 'kr', kaz: 'kk', khm: 'km', kik: 'ki', kin: 'rw', kir: 'ky', kom: 'kv', kon: 'kg', kor: 'ko', kua: 'kj', kur: 'ku',
    // L
    lao: 'lo', lat: 'la', lav: 'lv', lim: 'li', lin: 'ln', lit: 'lt', ltz: 'lb', lub: 'lu', lug: 'lg',
    // M
    mah: 'mh', mal: 'ml', mar: 'mr', mkd: 'mk', mac: 'mk', mlg: 'mg', mlt: 'mt', mon: 'mn', mri: 'mi', mao: 'mi', msa: 'ms', may: 'ms', mya: 'my', bur: 'my',
    // N
    nau: 'na', nav: 'nv', nbl: 'nr', nde: 'nd', ndo: 'ng', nld: 'nl', dut: 'nl', nno: 'nn', nob: 'nb', nor: 'no', nya: 'ny',
    // O
    oci: 'oc', oji: 'oj', ori: 'or', orm: 'om', oss: 'os',
    // P
    pan: 'pa', pli: 'pi', pol: 'pl', por: 'pt', pus: 'ps',
    // Q
    que: 'qu',
    // R
    roh: 'rm', ron: 'ro', rum: 'ro', run: 'rn', rus: 'ru',
    // S
    sag: 'sg', san: 'sa', sin: 'si', slk: 'sk', slo: 'sk', slv: 'sl', sme: 'se', smo: 'sm', sna: 'sn',
    snd: 'sd', som: 'so', sot: 'st', spa: 'es', sqi: 'sq', alb: 'sq', srp: 'sr', ssw: 'ss', sun: 'su',
    swa: 'sw', swe: 'sv',
    // T
    tah: 'ty', tam: 'ta', tat: 'tt', tel: 'te', tgk: 'tg', tgl: 'tl', tha: 'th', tir: 'ti', ton: 'to',
    tsn: 'tn', tso: 'ts', tuk: 'tk', tur: 'tr', twi: 'tw',
    // U
    uig: 'ug', ukr: 'uk', urd: 'ur', uzb: 'uz',
    // V
    ven: 've', vie: 'vi', vol: 'vo',
    // W
    wol: 'wo',
    // X
    xho: 'xh',
    // Y
    yid: 'yi', yor: 'yo',
    // Z
    zha: 'za', zho: 'zh', chi: 'zh', zul: 'zu'
  };

  function getLanguageName(langCode) {
    if (!langCode || langCode === 'und') return undefined;
    const cleanCode = ISO_639_2_TO_1[langCode.toLowerCase().trim()] || langCode.toLowerCase().trim();
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'language' });
      const name = dn.of(cleanCode);
      if (name && name !== cleanCode && name !== 'root') return name;
    } catch (e) {
      // Ignore
    }
    return undefined;
  }

  // Probe audio + subtitle streams for every variant so we know what is present.
  // Audio + subtitle assets are only SEGMENTED + UPLOADED by the 'original' variant
  // (stored once, shared by all variants via the master playlist). Compressed variants
  // only need the metadata so they can flag the default audio in their callback.
  let subTrackCounter = 0;
  probeData.streams.forEach(s => {
    if (s.codec_type === 'subtitle') {
      subTrackCounter++;
      const codec = s.codec_name?.toLowerCase();
      const isText = codec && textSubtitleCodecs.has(codec);
      const isBitmap = codec && bitmapSubtitleCodecs.has(codec);
      if (isText || isBitmap) {
        const format = isText ? 'vtt' : (codec && (codec.includes('dvd') || codec.includes('vob')) ? 'sub' : 'sup');
        const lang = getStreamTag(s, 'language');
        // If subtitle_metadata is provided from the payload (VPS-probed from original file),
        // use it to get the correct title and forced flag. The recombined file may lose subtitle name tags.
        const langName = getLanguageName(lang);
        let rawTitle = getStreamTag(s, 'title') || getStreamTag(s, 'name');

        let title;
        if (rawTitle) {
          title = langName ? `${rawTitle} - [${langName}]` : rawTitle;
        } else {
          title = langName ? `Track ${subTrackCounter} - [${langName}]` : `Track ${subTrackCounter}`;
        }
        let isForced = !!(s.disposition && s.disposition.forced === 1);
        // Honor muxer disposition.default even without language/title tags: many
        // sources mark the sole/default track with only disposition flags.
        let isDefault = !!(s.disposition && s.disposition.default === 1);
        let isHearingImpaired = !!(s.disposition && s.disposition.hearing_impaired === 1);
        if (subtitle_metadata && Array.isArray(subtitle_metadata)) {
          const match = subtitle_metadata.find(m => m.streamIndex === s.index);
          if (match && match.title) {
            let mTitle = match.title;
            if (langName) {
              mTitle = `${mTitle} [${langName}]`;
            }
            title = mTitle;
          }
          if (match && match.isForced !== undefined) {
            isForced = !!match.isForced;
          }
          if (match && match.isDefault !== undefined) {
            isDefault = !!match.isDefault;
          }
          if (match && match.isHearingImpaired !== undefined) {
            isHearingImpaired = !!match.isHearingImpaired;
          }
        }
        subtitleStreams.push({
          index: s.index,
          codec,
          isBitmap,
          format,
          language: lang,
          title,
          isForced,
          isDefault,
          isHearingImpaired,
          disposition: s.disposition || null
        });
      }
    } else if (s.codec_type === 'audio') {
      const lang = getStreamTag(s, 'language');
      const bitRate = s.bit_rate ? parseInt(s.bit_rate, 10) : null;
      audioStreams.push({
        index: s.index,
        codec: s.codec_name?.toLowerCase(),
        language: lang,
        channels: s.channels || 2,
        bitRate: isNaN(bitRate) ? null : bitRate,
        title: getStreamTag(s, 'title') || getStreamTag(s, 'name') || getLanguageName(lang),
        disposition: s.disposition || null
      });
    }
  });

  // Posts a single subtitle or audio stream's status as soon as it finishes, instead of
  // making the VPS wait for every stream in this job (subtitle/audio jobs process all their
  // streams sequentially in one runner) before it learns anything completed - same fix as
  // postEarlyCodecCallback below, applied to the audio/subtitle side of the pipeline.
  async function postPartialStreamCallback({ subtitles, audios }) {
    const body = {
      fileId: file_id,
      userId: user_id,
      label: activeLabel,
      kind,
      renditions: [],
      skippedCodecs: [],
      githubReleaseId: release_id,
      githubReleaseIds,
      subtitles: subtitles || [],
      audios: audios || [],
      token: vps_callback_token,
      partIndex: partIndex,
      completedSubtitleZips,
    };
    try {
      await apiRequest(vps_callback_url, 'POST', { 'Content-Type': 'application/json' }, body);
      console.log(`Early VPS callback sent for ${subtitles ? 'subtitle' : 'audio'} stream`);
    } catch (err) {
      // Non-fatal: the final aggregate callback still reports this stream, so a dropped
      // early ping just means the status stays stale a bit longer.
      console.warn(`Early stream callback failed (will still be reported at the end): ${err.message}`);
    }
  }

  // 6. Segment, Zip, and Upload Subtitles immediately per stream
  const subtitlePlaylists = [];
  if (extract_subtitles && subtitleStreams.length > 0) {
    console.log(`Processing ${subtitleStreams.length} subtitle streams...`);
    for (const sub of subtitleStreams) {
      if (sub.isBitmap) {
        console.log(`Extracting bitmap subtitle stream #${sub.index} (${sub.codec}) as .${sub.format}...`);
        const subExtPath = path.join(OUTPUT_DIR, `subtitle_${sub.index}.${sub.format}`);
        const videoDuration = (probeData.format && probeData.format.duration) ? parseFloat(probeData.format.duration) : null;
        const videoDurationVal = videoDuration || 0;

        const extractCmd = `ffmpeg -y -nostdin -analyzeduration 100M -probesize 100M -protocol_whitelist file,http,tcp,https,tls -i "${inputSource}" ${videoDurationVal ? `-t ${videoDurationVal} ` : ''}-vn -an -map 0:${sub.index} -c:s copy "${subExtPath}"`;
        console.log(`Executing Bitmap Subtitle Extract command: ${extractCmd}`);

        try {
          await execAsync(extractCmd, { stdio: 'inherit' });

          if (fs.existsSync(subExtPath)) {
            const rawSize = (await fs.promises.stat(subExtPath)).size;
            console.log(`Bitmap subtitle stream #${sub.index} extracted (${(rawSize / 1024).toFixed(1)} KB)`);

            subtitlePlaylists.push({
              streamIndex: sub.index,
              language: sub.language,
              title: sub.title,
              isForced: !!sub.isForced,
              isDefault: !!sub.isDefault,
              isHearingImpaired: !!sub.isHearingImpaired,
              isBitmap: true,
              format: sub.format,
              codec: sub.codec,
              disposition: sub.disposition || null,
              playlistText: null
            });

            const streamIdx = sub.index;
            const baseEntry = `subtitle_${streamIdx}.${sub.format}`;
            let partPaths = [];
            try {
              // Split oversize bitmap into .partNNNN files, multi-zip under 1 GiB.
              // Serve concatenates parts when more than one zip/part exists.
              const parts = await splitBinaryIntoParts(
                subExtPath,
                OUTPUT_DIR,
                baseEntry,
                zipPayloadBudget(),
              );
              partPaths = parts.filter((p) => !p.isOriginal).map((p) => p.fullPath);
              if (parts.length > 1) {
                console.log(
                  `Bitmap subtitle #${streamIdx} is ${formatMiB(rawSize)} MiB — split into ${parts.length} part(s)`,
                );
              }
              const uploaded = await uploadSubtitlePayloadZips({
                streamIdx,
                files: parts.map(({ name, fullPath, size }) => ({ name, fullPath, size })),
                workDir: WORK_DIR,
                uploadFn: uploadAssetWithRotation,
              });
              completedSubtitleZips.push(...uploaded);
              await postPartialStreamCallback({ subtitles: [subtitlePlaylists[subtitlePlaylists.length - 1]] });
            } catch (zipErr) {
              console.warn(`Warning: Failed to zip/upload bitmap subtitle stream #${streamIdx}: ${zipErr.message}`);
            } finally {
              try { fs.unlinkSync(subExtPath); } catch (e) {}
              for (const p of partPaths) {
                try { fs.unlinkSync(p); } catch (e) {}
              }
            }
          } else {
            console.warn(`Warning: Extracted bitmap subtitle file not found for stream #${sub.index}`);
          }
        } catch (err) {
          console.warn(`Warning: Failed to extract bitmap subtitle stream #${sub.index}. Skipping.`);
          if (fs.existsSync(subExtPath)) {
            try { fs.unlinkSync(subExtPath); } catch (e) {}
          }
        }
      } else {
        console.log(`Converting subtitle stream #${sub.index} (${sub.codec})...`);
        const fullVttPath = path.join(OUTPUT_DIR, `subtitle_${sub.index}.vtt`);

        const videoDuration = (probeData.format && probeData.format.duration) ? parseFloat(probeData.format.duration) : null;
        const videoDurationVal = videoDuration || 0;

        // Extract subtitle stream to a single VTT file
        const extractCmd = `ffmpeg -y -nostdin -analyzeduration 100M -probesize 100M -protocol_whitelist file,http,tcp,https,tls -i "${inputSource}" ${videoDurationVal ? `-t ${videoDurationVal} ` : ''}-vn -an -map 0:${sub.index} -c:s webvtt "${fullVttPath}"`;
        console.log(`Executing Subtitle Extract command: ${extractCmd}`);

        try {
          await execAsync(extractCmd, { stdio: 'inherit' });

          if (fs.existsSync(fullVttPath)) {
            const patchedVtt = ensureVttTimestampMap(fs.readFileSync(fullVttPath, 'utf8'));
            await fs.promises.writeFile(fullVttPath, patchedVtt, 'utf8');
            const rawSize = (await fs.promises.stat(fullVttPath)).size;
            console.log(`Subtitle stream #${sub.index} converted to VTT (${formatMiB(rawSize)} MiB)`);

            const streamIdx = sub.index;
            const rewriteLabel = resolveManifestRewriteLabel(rawResolutions, codecs, activeLabel);
            let filesToZip;
            let rawSubPlaylist;
            const splitFiles = [];

            if (rawSize <= zipPayloadBudget()) {
              // Small enough: one whole-file VTT + single-segment playlist (fast path).
              const name = `subtitle_${streamIdx}.vtt`;
              filesToZip = [{ name, fullPath: fullVttPath, size: rawSize }];
              rawSubPlaylist = buildSingleSegmentVttPlaylist(videoDurationVal, name);
            } else {
              // Over 1 GiB budget: cue-aligned multi-file VTT + multi-segment playlist,
              // then multi-zip under the same cap as video/audio.
              console.log(
                `Text subtitle #${streamIdx} is ${formatMiB(rawSize)} MiB — splitting under zip cap`,
              );
              const packed = packVttIntoSizedFiles(
                patchedVtt,
                streamIdx,
                OUTPUT_DIR,
                zipPayloadBudget(),
              );
              filesToZip = packed.files;
              rawSubPlaylist = packed.playlistText;
              for (const f of packed.files) splitFiles.push(f.fullPath);
              try { fs.unlinkSync(fullVttPath); } catch (e) {}
            }

            subtitlePlaylists.push({
              streamIndex: sub.index,
              language: sub.language,
              title: sub.title,
              isForced: !!sub.isForced,
              isDefault: !!sub.isDefault,
              isHearingImpaired: !!sub.isHearingImpaired,
              isBitmap: false,
              format: 'vtt',
              codec: sub.codec,
              disposition: sub.disposition || null,
              playlistText: rewriteVariantPlaylist({
                playlistText: rawSubPlaylist,
                fileId: file_id,
                label: rewriteLabel,
              }) || rawSubPlaylist,
            });

            try {
              const uploaded = await uploadSubtitlePayloadZips({
                streamIdx,
                files: filesToZip,
                workDir: WORK_DIR,
                uploadFn: uploadAssetWithRotation,
              });
              completedSubtitleZips.push(...uploaded);
              await postPartialStreamCallback({ subtitles: [subtitlePlaylists[subtitlePlaylists.length - 1]] });
            } catch (zipErr) {
              console.warn(`Warning: Failed to zip/upload subtitle stream #${streamIdx}: ${zipErr.message}`);
            } finally {
              try { fs.unlinkSync(fullVttPath); } catch (e) {}
              for (const p of splitFiles) {
                try { fs.unlinkSync(p); } catch (e) {}
              }
            }
          } else {
            console.warn(`Warning: Extracted VTT file not found for stream #${sub.index}`);
          }
        } catch (err) {
          console.warn(`Warning: Failed to convert subtitle stream #${sub.index}. Skipping.`);
          if (fs.existsSync(fullVttPath)) {
            try { fs.unlinkSync(fullVttPath); } catch (e) {}
          }
        }
      }
    }
  }
 
  // 6b. Generate thumbnail storyboard (sprite sheet + WebVTT). Runs once, Part 1 only
  // (see optimize.yml's matrix-include guard), same one-shot shape as subtitle extraction
  // above: single pass over the whole video regardless of which part triggered the job.
  if (isThumbnailsJob) {
    console.log('Generating thumbnail storyboard sprite sheet...');
    const {
      intervalSec: THUMB_INTERVAL,
      tileWidth: THUMB_TILE_WIDTH,
      cols: THUMB_COLS,
      rows: THUMB_ROWS,
      extension: THUMB_EXT,
      webpQuality,
    } = THUMB_STORYBOARD;
    const videoDurationVal = duration || 0;

    if (videoDurationVal > 0) {
      if (!hasLibwebpEncoder()) {
        throw new Error(
          'Thumbnail storyboard requires ffmpeg libwebp for WebP sprites, but libwebp is not available on this runner',
        );
      }

      // image2 + %03d multi-sheet sequence. One ffmpeg pass.
      const spritePattern = path.join(OUTPUT_DIR, `thumb_sprite_%03d.${THUMB_EXT}`);
      const spriteCmd = [
        'ffmpeg -y -nostdin',
        '-analyzeduration 100M -probesize 100M',
        '-protocol_whitelist file,http,tcp,https,tls',
        `-i "${inputSource}"`,
        `-vf "fps=1/${THUMB_INTERVAL},scale=${THUMB_TILE_WIDTH}:-2,tile=${THUMB_COLS}x${THUMB_ROWS}"`,
        '-f image2',
        '-c:v libwebp',
        `-quality ${webpQuality}`,
        `"${spritePattern}"`,
      ].join(' ');
      console.log(`Executing thumbnail sprite command: ${spriteCmd}`);

      try {
        await execAsync(spriteCmd, { stdio: 'inherit' });

        const spriteRe = storyboardSpriteGlob(THUMB_EXT);
        const spriteFiles = (await fs.promises.readdir(OUTPUT_DIR))
          .filter(name => spriteRe.test(name))
          .sort();

        if (spriteFiles.length > 0) {
          // scale=-2 makes tile height data-dependent (source aspect ratio); probe the
          // actual sheet dimensions rather than assuming a 16:9 source.
          const firstSpritePath = path.join(OUTPUT_DIR, spriteFiles[0]);
          const dimProbe = JSON.parse(await execAsync(
            `ffprobe -v error -show_entries stream=width,height -of json "${firstSpritePath}"`
          ));
          const sheetWidth = dimProbe.streams[0].width;
          const sheetHeight = dimProbe.streams[0].height;
          const tileWidth = Math.round(sheetWidth / THUMB_COLS);
          const tileHeight = Math.round(sheetHeight / THUMB_ROWS);

          // "thumbnails/" prefix (not just the bare filename): @videojs/react resolves
          // this cue reference relative to the <track src> URL (.../hls/thumbnails.vtt),
          // and relative resolution drops the last path segment - so a bare filename
          // would resolve to .../hls/<file>, not .../hls/thumbnails/<file>.
          let vtt = 'WEBVTT\n\n';
          vtt += buildStoryboardVttBody(videoDurationVal, tileWidth, tileHeight, {
            intervalSec: THUMB_INTERVAL,
            cols: THUMB_COLS,
            rows: THUMB_ROWS,
            extension: THUMB_EXT,
          });

          const vttPath = path.join(OUTPUT_DIR, 'thumbnails.vtt');
          await fs.promises.writeFile(vttPath, vtt, 'utf8');

          // Batch sheets under MAX_ZIP_BYTES (same helper as video/audio). VTT only
          // in zip 0; serve uses DB vttText and multi-zip sprite lookup.
          const spriteEntries = [];
          for (const name of spriteFiles) {
            const fullPath = path.join(OUTPUT_DIR, name);
            const size = (await fs.promises.stat(fullPath)).size;
            assertUnderZipCap(size, `thumbnail sheet ${name}`);
            spriteEntries.push({ name, fullPath, size });
          }
          const vttSize = (await fs.promises.stat(vttPath)).size;
          const batches = batchFilesBySize(spriteEntries);
          console.log(
            `Thumbnail storyboard: ${spriteEntries.length} sheet(s) in ${batches.length} zip(s) ` +
            `(cap ${(maxZipBytes() / 1024 / 1024).toFixed(0)} MiB; vtt ${(vttSize / 1024).toFixed(1)} KB)`,
          );

          try {
            for (let zipIndex = 0; zipIndex < batches.length; zipIndex++) {
              const batch = batches[zipIndex];
              const zipName = zipIndex === 0 ? 'thumbnails.zip' : `thumbnails_${String(zipIndex).padStart(3, '0')}.zip`;
              const zipPath = path.join(WORK_DIR, zipName);
              const listFilePath = path.join(WORK_DIR, `${zipName}.list.txt`);
              const filesForZip = zipIndex === 0
                ? [vttPath, ...batch.map(f => f.fullPath)]
                : batch.map(f => f.fullPath);

              try {
                const uploaded = await zipStoreUploadAndCleanup({
                  filePaths: filesForZip,
                  zipName,
                  zipPath,
                  listFilePath,
                  uploadFn: uploadAssetWithRotation,
                });

                completedSubtitleZips.push({
                  zipType: 'thumbnail',
                  streamIndex: 0,
                  zipIndex,
                  assetId: uploaded.assetId,
                  url: uploaded.url,
                  zipSize: uploaded.zipSize,
                  vttText: zipIndex === 0 ? vtt : null,
                });
              } catch (zipErr) {
                console.warn(`Warning: Failed to zip/upload thumbnail ZIP ${zipName}: ${zipErr.message}`);
              }
            }
          } finally {
            try { fs.unlinkSync(vttPath); } catch (e) {}
            for (const f of spriteEntries) {
              try { fs.unlinkSync(f.fullPath); } catch (e) {}
            }
          }
        } else {
          console.warn('Warning: No thumbnail sprite sheets were generated.');
        }
      } catch (err) {
        console.warn(`Warning: Failed to generate thumbnail sprite sheet: ${err.message}`);
      }
    } else {
      console.warn('Warning: Unknown video duration; skipping thumbnail sprite generation.');
    }
  }

  // Computed here, ahead of audio segmenting below, so audio can be cut at the same
  // scene-aligned points as video instead of its own flat interval - see the aligned
  // branch in the audio ffmpeg command for why that matters.
  //
  // Audio is never in the same runner as video. Standalone audio jobs use the same
  // precomputed field plan + scene-cut grid as the video encode jobs so -segment_times
  // matches -force_key_frames. Skipping isAudioJob left audio on flat -hls_time 6.
  let forcedKeyframeString = null;
  // Default hybrid: quality-safe if detection fails open before detectFieldStrategy returns.
  let fieldPlan = makeFieldPlan(
    'hybrid',
    'auto',
    buildBwdifFilter('send_frame', 'auto'),
    null,
    'default-before-detect',
  );

  // Field strategy + scene-cut timeline are part-scoped, not resolution-scoped: a
  // dedicated matrix job computes them ONCE per part (FIELD_DETECT_ONLY above) before
  // this job's workflow stage runs, and uploads the result as a release asset. Fetched
  // here directly (not passed via ACTIVE_PART) so this job's matrix doesn't need to wait
  // on a job that merges per-part data into it. No fallback on purpose: if the asset is
  // missing, that precompute step didn't run or failed, and silently recomputing
  // per-resolution would hide that instead of surfacing it.
  if (shouldComputeSegmentTimeline(kind, { isSubtitlesJob, isThumbnailsJob })) {
    const fieldPlanAssetName = `field-plan-part${partIndex}.json`;
    const fieldPlanAsset = targetReleaseInfo.assets.find(a => a.name === fieldPlanAssetName);
    if (!fieldPlanAsset) {
      console.error(`Error: no precomputed field plan asset "${fieldPlanAssetName}" for part ${partIndex}. The detect job must run before resolution jobs.`);
      process.exit(1);
    }
    const fieldPlanPath = path.join(WORK_DIR, fieldPlanAssetName);
    await downloadAsset(fieldPlanAsset.url, token, fieldPlanPath);
    const result = JSON.parse(fs.readFileSync(fieldPlanPath, 'utf8'));
    fieldPlan = result.field_plan;
    if (result.forced_keyframe_string) forcedKeyframeString = result.forced_keyframe_string;
    console.log(`Using precomputed field plan for part ${partIndex}: ${JSON.stringify(fieldPlan)}`);
  } else {
    fieldPlan = makeFieldPlan('progressive', 'auto', null, null, 'non-encode-job');
  }

  // Computed up front (not just at the final callback) so the early per-stream callback
  // below can report the correct isDefault immediately instead of a transient wrong value
  // that only gets fixed once the job's last stream finishes.
  let defaultAudioIndex = null;
  {
    const defaultAuds = audioStreams.filter(aud => aud.disposition && aud.disposition.default === 1);
    if (defaultAuds.length > 0) {
      if (defaultAuds.length > 1) {
        console.warn(`[HLS] Collision: Multiple audio streams marked default. Selecting lowest stream index.`);
      }
      const sorted = [...defaultAuds].sort((a, b) => a.index - b.index);
      defaultAudioIndex = sorted[0].index;
    } else if (audioStreams.length > 0) {
      const sorted = [...audioStreams].sort((a, b) => a.index - b.index);
      defaultAudioIndex = sorted[0].index;
    }
  }

  // 7. Segment Audio next (always process if present, for all variant kinds)
  const audioPlaylists = [];
  if (extract_audio && audioStreams.length > 0) {
    console.log(`Processing audio tracks (found ${audioStreams.length} total)...`);
    for (const aud of audioStreams) {
      console.log(`Converting audio stream #${aud.index} (${aud.codec})...`);
      const audPlaylistPath = path.join(OUTPUT_DIR, `audio_${aud.index}.m3u8`);
      const audSegmentPattern = path.join(OUTPUT_DIR, `audio_${aud.index}_%05d.m4s`);
      // Per part, for the same reason as the video init segment above.
      const audInitName = `audio_${aud.index}_part${partIndex.toString().padStart(4, '0')}_init.mp4`;
      
      let targetAudioBitrate;
      if (aud.bitRate) {
        const origAudioBitrateKbps = Math.round(aud.bitRate / 1000);
        if (origAudioBitrateKbps <= hls_audio_bitrate) {
          targetAudioBitrate = origAudioBitrateKbps;
        } else {
          targetAudioBitrate = Math.min(origAudioBitrateKbps, 320);
        }
      } else {
        const channels = aud.channels || 2;
        targetAudioBitrate = Math.min(320, Math.max(96, Math.round((channels / 2) * hls_audio_bitrate)));
      }

      // Video cuts segments at scene-aligned, variable-length points (forcedKeyframeString,
      // 3-9s). Flat -hls_time 6 on audio widens the gap-jump window hls.js has to bridge
      // on every seek, since the two tracks' segment boundaries never line up. When we
      // have that timeline, cut audio at the exact same points instead.
      const useAlignedSplits = !!forcedKeyframeString;
      const audSegmentPatternAligned = path.join(OUTPUT_DIR, `audio_${aud.index}_%05d.mp4`);
      const audSegmentListTmpPath = path.join(OUTPUT_DIR, `audio_${aud.index}_list.m3u8.tmp`);

      const audFfmpegArgs = [
        'ffmpeg',
        '-y',
        '-nostdin'
      ];
      if (startTime > 0) {
        audFfmpegArgs.push('-ss', startTime.toFixed(3));
      }
      audFfmpegArgs.push(
        '-analyzeduration', '100M',
        '-probesize', '100M',
        '-protocol_whitelist', 'file,http,tcp,https,tls'
      );
      audFfmpegArgs.push('-i', `"${inputSource}"`);
      // Output -t rather than input -to; see the video job for why.
      if (endTime !== null) {
        audFfmpegArgs.push('-t', Math.max(0, endTime - startTime).toFixed(3));
      }
      audFfmpegArgs.push(
        '-vn',
        '-map', `0:${aud.index}`,
        '-c:a', 'aac',
        '-b:a', `${targetAudioBitrate}k`
      );
      // Audio beyond 7.1 (e.g. Atmos 7.1.2 / 7.1.4 with up to 12 channels) produces
      // channel_configuration >= 12 which ISO 14496-3:2009 Table 1.19 leaves undefined;
      // browsers reject it with CHUNK_DEMUXER_ERROR_APPEND_FAILED. Downmix to stereo.
      if (aud.channels > 8) {
        audFfmpegArgs.push('-ac', '2');
      }

      if (useAlignedSplits) {
        // The generic segment muxer (unlike -f hls) has no notion of a shared fmp4 init
        // segment in its own playlist writer, and it refuses to guess a container for a
        // ".m4s" output pattern even with -segment_format set explicitly - both are
        // worked around below once ffmpeg exits: segments land as .mp4 and get renamed,
        // and EXT-X-MAP is added by hand since ffmpeg never writes one here.
        audFfmpegArgs.push(
          '-f', 'segment',
          '-segment_times', forcedKeyframeString,
          '-segment_format', 'mp4',
          '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
          // Unlike -hls_fmp4_init_filename (resolved against the playlist's directory),
          // the segment muxer opens this path relative to the process CWD - a bare name
          // dropped the init outside OUTPUT_DIR, so it never got zipped and every
          // audio_N_partNNNN_init.mp4 request 404'd. Write it where the packager looks.
          '-segment_header_filename', `"${path.join(OUTPUT_DIR, audInitName)}"`,
          '-reset_timestamps', '0',
          '-segment_list_type', 'hls',
          '-segment_list', `"${audSegmentListTmpPath}"`,
          '-segment_start_number', startSegmentIndex.toString(),
          `"${audSegmentPatternAligned}"`
        );
      } else {
        audFfmpegArgs.push(
          '-f', 'hls',
          '-hls_time', '6',
          '-hls_playlist_type', 'vod',
          '-hls_segment_type', 'fmp4',
          '-hls_segment_filename', `"${audSegmentPattern}"`,
          '-hls_fmp4_init_filename', `"${audInitName}"`,
          '-hls_flags', 'independent_segments',
          '-start_number', startSegmentIndex.toString(),
          `"${audPlaylistPath}"`
        );
      }
      const audFfmpegCmd = audFfmpegArgs.flat().join(' ');
      console.log(`Executing Audio FFmpeg command: ${audFfmpegCmd}`);

      try {
        await execAsync(audFfmpegCmd, { stdio: 'inherit' });

        let rawAudPlaylist;
        if (useAlignedSplits) {
          // ffmpeg computed real, frame-accurate durations for each split point - reuse
          // those verbatim rather than trusting our own requested timestamps, just
          // rename the segment references from .mp4 to the .m4s name the rest of this
          // pipeline (zip packaging, serve-side regexes) already expects.
          const listRaw = fs.readFileSync(audSegmentListTmpPath, 'utf8');
          const segLines = [];
          let maxSeconds = 0;
          const lines = listRaw.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const extinf = /^#EXTINF:\s*([0-9.]+)/.exec(lines[i].trim());
            if (!extinf) continue;
            const seconds = parseFloat(extinf[1]);
            if (Number.isFinite(seconds)) maxSeconds = Math.max(maxSeconds, seconds);
            const mp4Name = (lines[i + 1] || '').trim();
            if (!mp4Name) continue;
            const m4sName = mp4Name.replace(/\.mp4$/, '.m4s');
            fs.renameSync(path.join(OUTPUT_DIR, mp4Name), path.join(OUTPUT_DIR, m4sName));
            segLines.push(`#EXTINF:${seconds.toFixed(6)},`, m4sName);
            i++;
          }
          fs.unlinkSync(audSegmentListTmpPath);

          rawAudPlaylist = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(maxSeconds))}`,
            `#EXT-X-MEDIA-SEQUENCE:${startSegmentIndex}`,
            '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-INDEPENDENT-SEGMENTS',
            `#EXT-X-MAP:URI="${audInitName}"`,
            ...segLines,
            '#EXT-X-ENDLIST',
            '',
          ].join('\n');
        } else {
          rawAudPlaylist = fs.readFileSync(audPlaylistPath, 'utf8');
        }

        audioPlaylists.push({
          streamIndex: aud.index,
          language: aud.language,
          title: aud.title,
          playlistText: rawAudPlaylist
        });

        // Immediately zip, upload, and delete segments for THIS audio track
        // keeping disk storage and RAM low before proceeding to the next track.
        const streamIdx = aud.index;
        const audioSegRegex = new RegExp(`^audio_${streamIdx}_(\\d{5})\\.m4s$`);
        const audioInitRegex = new RegExp(`^audio_${streamIdx}_part\\d{4}_init\\.mp4$`);
        
        const trackFiles = [];
        for (const name of await fs.promises.readdir(OUTPUT_DIR)) {
          const segMatch = name.match(audioSegRegex);
          const initMatch = name.match(audioInitRegex);
          if (!segMatch && !initMatch) continue;
          const segmentIndex = segMatch ? parseInt(segMatch[1], 10) : null;
          const fullPath = path.join(OUTPUT_DIR, name);
          const size = (await fs.promises.stat(fullPath)).size;
          trackFiles.push({ name, fullPath, size, segmentIndex });
        }

        // Without the init in the zip the playlist's EXT-X-MAP is a permanent 404 and the
        // track never plays - fail the job here instead of publishing a broken rendition.
        if (!trackFiles.some(f => audioInitRegex.test(f.name))) {
          throw new Error(`Audio init segment ${audInitName} missing from ${OUTPUT_DIR} after ffmpeg`);
        }

        trackFiles.sort((a, b) => {
          const isInitA = a.name.includes('init');
          const isInitB = b.name.includes('init');
          if (isInitA && !isInitB) return -1;
          if (!isInitA && isInitB) return 1;
          return (a.segmentIndex ?? -1) - (b.segmentIndex ?? -1);
        });

        let chunkIdx = 0;

        // Batch under MAX_ZIP_BYTES; each batch is assert-capped on upload.
        for (const f of trackFiles) {
          assertUnderZipCap(f.size, `audio segment ${f.name}`);
        }
        const audioBatches = batchFilesBySize(trackFiles);
        for (const batch of audioBatches) {
          let batchSegStart = null;
          let batchSegEnd = null;
          for (const f of batch) {
            if (f.segmentIndex !== null) {
              if (batchSegStart === null || f.segmentIndex < batchSegStart) batchSegStart = f.segmentIndex;
              if (batchSegEnd === null || f.segmentIndex > batchSegEnd) batchSegEnd = f.segmentIndex;
            }
          }
          const zipName = `audio-${streamIdx}-part${partIndex.toString().padStart(4, '0')}-${chunkIdx.toString().padStart(4, '0')}.zip`;
          const zipPath = path.join(WORK_DIR, zipName);
          const listFilePath = path.join(WORK_DIR, `${zipName}.list.txt`);
          console.log(`Packaging audio ZIP ${zipName} with ${batch.length} files...`);
          const uploaded = await zipStoreUploadAndCleanup({
            filePaths: batch.map(f => f.fullPath),
            zipName,
            zipPath,
            listFilePath,
            uploadFn: uploadAssetWithRotation,
          });

          completedSubtitleZips.push({
            zipType: 'audio',
            streamIndex: streamIdx,
            zipIndex: uniquePartZipIndex(partIndex, chunkIdx),
            assetId: uploaded.assetId,
            url: uploaded.url,
            zipSize: uploaded.zipSize,
            segmentStart: batchSegStart,
            segmentEnd: batchSegEnd,
          });

          for (const f of batch) {
            try { fs.unlinkSync(f.fullPath); } catch (e) {}
          }
          chunkIdx++;
        }
        // Rewrite BEFORE partial callback. totalParts=1 merge can finalize from this
        // payload alone; bare relative names then resolve next to .../audio/N/ and 404.
        const rewriteLabel = resolveManifestRewriteLabel(rawResolutions, codecs, activeLabel);
        const rewrittenAudForPartial = rewriteVariantPlaylist({
          playlistText: rawAudPlaylist,
          fileId: file_id,
          label: rewriteLabel,
        });
        await postPartialStreamCallback({
          audios: [{
            streamIndex: aud.index,
            language: aud.language,
            title: aud.title,
            isDefault: aud.index === defaultAudioIndex,
            disposition: aud.disposition || null,
            playlistUrl: undefined,
            playlistText: rewrittenAudForPartial || rawAudPlaylist,
          }],
        });
      } catch (err) {
        console.warn(`Warning: Failed to convert audio stream #${aud.index}: ${err.message}. Skipping.`);
      }
    }
  }

  let manifestsUploaded = false;

  const resPromises = resolutions.map(async (currentRes) => {
    const label = currentRes.label;
    const target_height = currentRes.targetHeight;
    const hls_preset = currentRes.preset;
    const hls_crf = String(currentRes.crf);
    const hls_maxrate = currentRes.maxrate;
    const hls_bufsize = currentRes.bufsize;
    const hls_profile = currentRes.profile;
    const hls_level = currentRes.level;
    const hls_av1_preset = currentRes.av1Preset;
    const hls_av1_crf = currentRes.av1Crf;

    const RES_OUTPUT_DIR = path.join(OUTPUT_DIR, label);
    fs.mkdirSync(RES_OUTPUT_DIR, { recursive: true });

    const isAudioJobLocal = (label === 'metadata' || label === 'audio');
    const isSubtitlesJobLocal = (label === 'subtitles');
    const isThumbnailsJobLocal = (label === 'thumbnails');

    console.log(`\n============================================================`);
    console.log(`Processing resolution: ${label} (${target_height || 'source'}p)`);
    console.log(`============================================================\n`);

    const codecResults = [];
    const skippedCodecs = [];

    let resolvedCodecs = [];
    if (kind === 'original') {
      resolvedCodecs = [inferredCodec];
    } else {
      resolvedCodecs = codecs;
    }

    async function processCodecJob(codec) {
    console.log(`Running FFmpeg segmenting on video for codec: ${codec}...`);
    
    if (codec === 'av1') {
      const svtav1Available = await checkSvtAv1();
      if (!svtav1Available) {
        console.log(`AV1 encoder (libsvtav1) not available in this ffmpeg build, skipping AV1 rendition`);
        throw new Error('libsvtav1 encoder not available');
      }
    }

    const useCodecSuffix = resolvedCodecs.length > 1;
    const playlistName = useCodecSuffix ? `variant_${codec}.m3u8` : 'variant.m3u8';
    const segmentPattern = useCodecSuffix ? `seg_${codec}_%05d.m4s` : 'seg%05d.m4s';
    // Each part is an independent ffmpeg run, so each writes its own fMP4 init segment.
    // Naming them all "init.mp4" made every part's init collide on one name, so the
    // merged playlist could only carry one EXT-X-MAP and every part had to be decoded
    // with part 1's track configuration. Name them per part and keep each part's own
    // EXT-X-MAP in the merged playlist instead.
    const partSuffix = `part${partIndex.toString().padStart(4, '0')}`;
    const initName = useCodecSuffix ? `init_${codec}_${partSuffix}.mp4` : `init_${partSuffix}.mp4`;

    const playlistPath = path.join(RES_OUTPUT_DIR, playlistName);
    const segmentPatternPath = path.join(RES_OUTPUT_DIR, segmentPattern);

    const ffmpegArgs = [
      'ffmpeg',
      '-y',
      '-nostdin',
    ];
    if (startTime > 0) {
      ffmpegArgs.push('-ss', startTime.toFixed(3));
    }
    ffmpegArgs.push(
      '-analyzeduration', '100M',
      '-probesize', '100M',
      '-protocol_whitelist', 'file,http,tcp,https,tls'
    );
    ffmpegArgs.push('-i', `"${inputSource}"`);
    // Part length as an OUTPUT -t, not an input -to: input -ss combined with input -to has
    // meant different things across ffmpeg releases (absolute input timestamp vs relative
    // to the seek point), and getting it wrong silently produces parts of the wrong length
    // rather than an error. Output -t is always "stop writing after this much output".
    if (endTime !== null) {
      ffmpegArgs.push('-t', Math.max(0, endTime - startTime).toFixed(3));
    }
    ffmpegArgs.push(
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4',
      '-hls_segment_filename', `"${segmentPatternPath}"`,
      '-hls_fmp4_init_filename', `"${initName}"`,
      '-hls_flags', 'independent_segments',
      '-start_number', startSegmentIndex.toString()
    );
    // 0:v:0, not 0:v: MKV/MP4 containers often carry embedded cover art as a second
    // (attached_pic) video stream, and mapping it makes the HLS muxer reject the job.
    ffmpegArgs.push('-map', '0:v:0');

    let resolvedOutputWidth = inferredWidth;
    let resolvedOutputHeight = inferredHeight;

    if (kind === 'original') {
      ffmpegArgs.push('-c:v', 'copy');
    } else {
      // Compressed variant
      const tHeight = target_height || 1080;
      resolvedOutputHeight = Math.min(tHeight, inferredHeight);
      resolvedOutputWidth = Math.round((resolvedOutputHeight * inferredWidth) / inferredHeight / 2) * 2;

      // Adjust parameters dynamically based on video profiles
      const dynamicParams = adjustVideoParams(
        label,
        codec,
        origBitrateKbps,
        origHeight,
        duration,
        codec === 'av1' ? hls_av1_preset : hls_preset,
        codec === 'av1' ? hls_av1_crf : hls_crf
      );
      console.log(`Dynamic params adjusted for ${codec}: CRF=${dynamicParams.crf}, Preset=${dynamicParams.preset}, Maxrate=${dynamicParams.maxrate || 'N/A'}, Bufsize=${dynamicParams.bufsize || 'N/A'}`);

      const sourceBitDepth = getSourceBitDepth(videoStream);
      const wantsHighBitDepth = sourceBitDepth >= 10;

      let tonemapFilter = null;
      if (isHdrSource(videoStream)) {
        if (await checkZscaleSupport()) {
          tonemapFilter = buildTonemapFilter(wantsHighBitDepth);
          console.log(`HDR source detected (color_transfer=${videoStream && videoStream.color_transfer}, color_primaries=${videoStream && videoStream.color_primaries}) → applying zscale/tonemap HDR→SDR chain`);
        } else {
          console.warn('HDR source detected but ffmpeg lacks zscale/tonemap support - output colors will be wrong, consider a different ffmpeg build');
        }
      }

      const vfChain = buildScaleVf(tHeight, fieldPlan, tonemapFilter);
      console.log(`Video filter chain for ${codec} [${fieldPlan.strategy}]: ${vfChain}`);

      // Signal output color explicitly on every encode. libx264 defaults to writing the
      // source's range (tv); libsvtav1 does NOT propagate it and leaves the AV1 sequence
      // header unspecified, so players assume full range and expand a limited-range (tv)
      // source → lifted blacks / washed-out picture. After a tonemap the pixels are
      // limited-range bt709; otherwise mirror the source (defaulting to bt709 / tv).
      const outColor = tonemapFilter
        ? { primaries: 'bt709', trc: 'bt709', space: 'bt709', range: 'tv' }
        : {
            primaries: videoStream.color_primaries || 'bt709',
            trc: videoStream.color_transfer || 'bt709',
            space: videoStream.color_space || 'bt709',
            range: String(videoStream.color_range || '').toLowerCase() === 'pc' ? 'pc' : 'tv',
          };
      ffmpegArgs.push(
        '-color_primaries', outColor.primaries,
        '-color_trc', outColor.trc,
        '-colorspace', outColor.space,
        '-color_range', outColor.range,
      );

      // Output CFR after field restore so HLS timestamps stay stable (IVTC/bob).
      if (fieldPlan.outFps) {
        ffmpegArgs.push('-r', String(fieldPlan.outFps));
      }

      let sourceFpsNum = 30;
      try {
        if (videoStream && videoStream.avg_frame_rate) {
          sourceFpsNum = parseFrameRate(videoStream.avg_frame_rate);
        } else if (videoStream && videoStream.r_frame_rate) {
          sourceFpsNum = parseFrameRate(videoStream.r_frame_rate);
        }
      } catch (e) {
        console.warn('Failed parsing frame rate:', e);
      }
      const outFpsNum = fieldPlanOutputFpsNumber(fieldPlan, sourceFpsNum);

      if (codec === 'h264') {
        let outputPixFmt = 'yuv420p';
        let outputProfile = hls_profile;
        if (wantsHighBitDepth && await checkX264TenBitSupport()) {
          outputPixFmt = 'yuv420p10le';
          outputProfile = 'high10'; // High/Main profiles cap at 8-bit; 10-bit needs High10.
          console.log(`Source is ${sourceBitDepth}-bit, libx264 supports 10-bit → encoding yuv420p10le/high10`);
        } else if (wantsHighBitDepth) {
          console.log(`Source is ${sourceBitDepth}-bit, but this libx264 build lacks 10-bit support → falling back to 8-bit yuv420p`);
        }

        ffmpegArgs.push(
          '-c:v', 'libx264',
          '-preset', dynamicParams.preset,
          '-crf', dynamicParams.crf
        );
        const activeMaxrate = dynamicParams.maxrate || hls_maxrate;
        const activeBufsize = dynamicParams.bufsize || hls_bufsize;
        if (activeMaxrate) ffmpegArgs.push('-maxrate', activeMaxrate);
        if (activeBufsize) ffmpegArgs.push('-bufsize', activeBufsize);
        if (outputProfile) ffmpegArgs.push('-profile:v', outputProfile);
        if (hls_level) ffmpegArgs.push('-level', hls_level);
        ffmpegArgs.push(
          '-pix_fmt', outputPixFmt,
          '-vf', `"${vfChain}"`,
          '-force_key_frames', forcedKeyframeString ? `"${forcedKeyframeString}"` : '"expr:gte(t,n_forced*6)"',
          '-sc_threshold', '0',
          '-flags', '+cgop'
        );
      } else if (codec === 'av1') {
        const gop = Math.max(1, Math.round(outFpsNum * 6));

        let av1PixFmt = 'yuv420p';
        if (wantsHighBitDepth && await checkAv1TenBitSupport()) {
          av1PixFmt = 'yuv420p10le';
          console.log(`Source is ${sourceBitDepth}-bit, libsvtav1 supports 10-bit → encoding yuv420p10le`);
        } else if (wantsHighBitDepth) {
          console.log(`Source is ${sourceBitDepth}-bit, but this libsvtav1 build lacks 10-bit pixel format → falling back to 8-bit yuv420p`);
        }

        ffmpegArgs.push(
          '-c:v', 'libsvtav1',
          '-preset', dynamicParams.preset,
          '-crf', dynamicParams.crf,
          '-svtav1-params', forcedKeyframeString ? 'tune=0:scd=0' : 'tune=0',
          '-pix_fmt', av1PixFmt,
          '-g', String(gop)
        );
        if (dynamicParams.maxrate) {
          ffmpegArgs.push('-maxrate', dynamicParams.maxrate);
        }
        if (dynamicParams.bufsize) {
          ffmpegArgs.push('-bufsize', dynamicParams.bufsize);
        }
        ffmpegArgs.push(
          '-vf', `"${vfChain}"`
        );
        if (forcedKeyframeString) {
          ffmpegArgs.push('-force_key_frames', `"${forcedKeyframeString}"`);
        }
      } else {
        throw new Error(`Unsupported codec: ${codec}`);
      }
    }

    ffmpegArgs.push(`"${playlistPath}"`);
    const ffmpegCmd = ffmpegArgs.flat().join(' ');
    console.log(`Executing FFmpeg command: ${ffmpegCmd}`);
    // ponytail: encode uses all vCPUs by default and can starve the runner agent's own
    // heartbeat, causing "lost communication with server" on small instances. Lower priority
    // so the runner process still gets scheduled; upgrade to explicit -threads cap if this recurs.
    await execAsync(`nice -n 10 ${ffmpegCmd}`, { stdio: 'inherit' });

    // Group segments and package ZIPs
    console.log(`Grouping segments and packaging ZIPs for ${codec}...`);
    const videoSegRegex = useCodecSuffix ? new RegExp(`^seg_${codec}_(\\d{5})\\.m4s$`) : /^seg(\d{5})\.m4s$/;
    const videoInitRegex = useCodecSuffix
      ? new RegExp(`^init_${codec}_part\\d{4}\\.mp4$`)
      : /^init_part\d{4}\.mp4$/;
    const subtitleSegRegex = /^subtitle_\d+_(\d{5})\.vtt$/;
    const audioSegRegex = /^audio_\d+_(\d{5})\.m4s$/;
    const audioInitRegex = /^audio_\d+_part\d{4}_init\.mp4$/;

    const videoFiles = await Promise.all(
      (await fs.promises.readdir(RES_OUTPUT_DIR))
        .filter(name => videoSegRegex.test(name) || videoInitRegex.test(name))
        .map(async name => {
          const fullPath = path.join(RES_OUTPUT_DIR, name);
          const stat = await fs.promises.stat(fullPath);
          const size = stat.size;
          const segMatch = name.match(videoSegRegex);
          const segmentIndex = segMatch ? parseInt(segMatch[1], 10) : null;
          return { name, fullPath, size, segmentIndex };
        })
    );

    const audioFiles = await Promise.all(
      (await fs.promises.readdir(OUTPUT_DIR))
        .filter(name => audioSegRegex.test(name) || audioInitRegex.test(name))
        .map(async name => {
          const fullPath = path.join(OUTPUT_DIR, name);
          const stat = await fs.promises.stat(fullPath);
          const size = stat.size;
          let segmentIndex = null;
          const audMatch = name.match(audioSegRegex);
          if (audMatch) {
            segmentIndex = parseInt(audMatch[1], 10);
          }
          return { name, fullPath, size, segmentIndex };
        })
    );

    const filesToZip = [...videoFiles, ...audioFiles];

    filesToZip.sort((a, b) => {
      const isInitA = a.name.includes('init');
      const isInitB = b.name.includes('init');
      if (isInitA && !isInitB) return -1;
      if (!isInitA && isInitB) return 1;
      
      const idxA = a.segmentIndex !== null ? a.segmentIndex : -1;
      const idxB = b.segmentIndex !== null ? b.segmentIndex : -1;
      if (idxA !== idxB) {
        return idxA - idxB;
      }
      return a.name.localeCompare(b.name);
    });

    const completedZipsForCodec = [];
    let currentZipIndex = 0;

    // Cap each segment; batch under MAX_ZIP_BYTES; assert zip size on upload.
    for (const file of filesToZip) {
      assertUnderZipCap(file.size, `video segment ${file.name}`);
    }
    const videoBatches = batchFilesBySize(filesToZip);
    for (const batch of videoBatches) {
      let batchSegStart = null;
      let batchSegEnd = null;
      for (const file of batch) {
        if (file.segmentIndex !== null) {
          if (batchSegStart === null || file.segmentIndex < batchSegStart) batchSegStart = file.segmentIndex;
          if (batchSegEnd === null || file.segmentIndex > batchSegEnd) batchSegEnd = file.segmentIndex;
        }
      }
      const uniqueZipIndex = uniquePartZipIndex(partIndex, currentZipIndex);
      const zipName = `segments-${label}-${codec}-part${partIndex.toString().padStart(4, '0')}-${currentZipIndex.toString().padStart(4, '0')}.zip`;
      const zipPath = path.join(WORK_DIR, zipName);
      const listFilePath = path.join(WORK_DIR, `${zipName}.list.txt`);
      console.log(`Packaging ZIP ${zipName} with ${batch.length} segments...`);
      const uploaded = await zipStoreUploadAndCleanup({
        filePaths: batch.map(f => f.fullPath),
        zipName,
        zipPath,
        listFilePath,
        uploadFn: uploadAssetWithRotation,
      });

      completedZipsForCodec.push({
        zipIndex: uniqueZipIndex,
        assetId: uploaded.assetId,
        url: uploaded.url,
        zipSize: uploaded.zipSize,
        segmentStart: batchSegStart,
        segmentEnd: batchSegEnd,
      });

      for (const f of batch) {
        const name = f.name;
        const isAudioOrSub = name.startsWith('audio_') || name.startsWith('subtitle_');
        if (!isAudioOrSub) {
          try { fs.unlinkSync(f.fullPath); } catch (e) {}
        }
      }
      currentZipIndex++;
    }

    // Compute measuredBandwidth
    let measuredBandwidth = 0;
    const durForBandwidth = duration;
    if (durForBandwidth && durForBandwidth > 0) {
      const totalBytes = filesToZip.reduce((acc, f) => acc + f.size, 0);
      measuredBandwidth = Math.round((totalBytes * 8) / durForBandwidth);
    }

    // Rewrite and Upload Manifests
    console.log(`Rewriting manifest for ${codec} to absolute paths...`);
    const mainPlaylistText = fs.readFileSync(playlistPath, 'utf8');
    const dbLabel = useCodecSuffix ? `${label}_${codec}` : label;
    const rewrittenMainPlaylist = rewriteVariantPlaylist({
      playlistText: mainPlaylistText,
      fileId: file_id,
      label: dbLabel
    });

    // Skip uploading individual part playlist to GitHub. Just return the playlistUrl as null or undefined,
    // and provide the rewritten playlist text to be sent in the callbackBody.
    const playlistUrl = null;

    return {
      codec,
      outputWidth: resolvedOutputWidth,
      outputHeight: resolvedOutputHeight,
      measuredBandwidth,
      playlistUrl,
      playlistText: rewrittenMainPlaylist,
      completedZips: completedZipsForCodec
    };
  }

  // Posts a single rendition's status as soon as its codec finishes, instead of making
  // the VPS wait for every codec in this resolution's matrix job (e.g. av1 running long
  // after h264 already finished) before it learns anything completed.
  async function postEarlyCodecCallback(result) {
    const body = {
      fileId: file_id,
      userId: user_id,
      label,
      kind,
      renditions: [{
        codec: result.codec,
        width: result.outputWidth,
        height: result.outputHeight,
        measuredBandwidth: result.measuredBandwidth,
        playlistUrl: result.playlistUrl,
        playlistText: result.playlistText,
        completedZips: result.completedZips,
        disposition: videoStream ? videoStream.disposition : null
      }],
      skippedCodecs: [],
      githubReleaseId: release_id,
      githubReleaseIds,
      subtitles: [],
      audios: [],
      token: vps_callback_token,
      partIndex: partIndex,
    };
    try {
      await apiRequest(vps_callback_url, 'POST', { 'Content-Type': 'application/json' }, body);
      console.log(`Early VPS callback sent for resolution ${label}, codec ${result.codec}`);
    } catch (err) {
      // Non-fatal: the final aggregate callback below still reports this rendition,
      // so a dropped early ping just means the status stays stale a bit longer.
      console.warn(`Early callback for ${label}/${result.codec} failed (will still be reported at the end): ${err.message}`);
    }
  }

  if (!isMetadataJob && !isSubtitlesJob && !isThumbnailsJob) {
    for (const codec of resolvedCodecs) {
      try {
        const result = await processCodecJob(codec);
        if (result) {
          codecResults.push(result);
          await postEarlyCodecCallback(result);
        }
      } catch (err) {
        console.warn(`Warning: Failed to process job for codec ${codec}:`, err);
        skippedCodecs.push({ codec, reason: err.message || 'Unknown error' });
      }
    }

    // Fallback to H.264 if no renditions succeeded
    if (codecResults.length === 0) {
      console.log('No codecs were successfully processed. Attempting H.264 fallback...');
      try {
        const result = await processCodecJob('h264');
        if (result) {
          codecResults.push(result);
          const index = skippedCodecs.findIndex(s => s.codec === 'h264');
          if (index !== -1) {
            skippedCodecs.splice(index, 1);
          }
        }
      } catch (err) {
        console.error('Fatal Error: Fallback to H.264 also failed:', err);
        skippedCodecs.push({ codec: 'h264', reason: err.message || 'Unknown error during fallback' });
      }
    }

    if (codecResults.length === 0) {
      throw new Error(`No codecs could be processed and H.264 fallback failed for resolution ${label}`);
    }
  }

    // 9. Rewrite and Upload subtitle/audio manifests
    const rewrittenSubtitlePlaylists = [];
    const rewrittenAudioPlaylists = [];

    if (!manifestsUploaded) {
      manifestsUploaded = true;
      console.log('Rewriting and uploading subtitle/audio manifests to absolute paths...');
      
      let activeLabel = label;
      if (isAudioJobLocal || isSubtitlesJobLocal || isThumbnailsJobLocal) {
        const primaryVideoRes = rawResolutions.find(r => r.label !== 'metadata' && r.label !== 'audio' && r.label !== 'subtitles' && r.label !== 'thumbnails') || rawResolutions[0];
        const primaryCodec = resolvedCodecs[0] || 'h264';
        const useCodecSuffix = resolvedCodecs.length > 1;
        activeLabel = useCodecSuffix ? `${primaryVideoRes.label}_${primaryCodec}` : primaryVideoRes.label;
      } else {
        const firstSuccess = codecResults[0];
        const useCodecSuffix = resolvedCodecs.length > 1;
        activeLabel = useCodecSuffix ? `${label}_${firstSuccess.codec}` : label;
      }

      for (const subPlaylist of subtitlePlaylists) {
        const rewrittenText = subPlaylist.playlistText ? rewriteVariantPlaylist({
          playlistText: subPlaylist.playlistText,
          fileId: file_id,
          label: activeLabel
        }) : null;
        
        rewrittenSubtitlePlaylists.push({
          streamIndex: subPlaylist.streamIndex,
          language: subPlaylist.language,
          title: subPlaylist.title,
          isForced: !!subPlaylist.isForced,
          isDefault: !!subPlaylist.isDefault,
          isHearingImpaired: !!subPlaylist.isHearingImpaired,
          isBitmap: !!subPlaylist.isBitmap,
          format: subPlaylist.format || 'vtt',
          codec: subPlaylist.codec || null,
          disposition: subPlaylist.disposition || null,
          playlistUrl: null,
          playlistText: rewrittenText
        });
      }

      for (const audPlaylist of audioPlaylists) {
        const rewrittenText = rewriteVariantPlaylist({
          playlistText: audPlaylist.playlistText,
          fileId: file_id,
          label: activeLabel
        });
        
        rewrittenAudioPlaylists.push({
          streamIndex: audPlaylist.streamIndex,
          language: audPlaylist.language,
          title: audPlaylist.title,
          playlistUrl: null,
          playlistText: rewrittenText
        });
      }

      manifestsUploaded = true;
    }

    // 10. Callback to VPS to notify completeness
    console.log(`Sending success callback to VPS for resolution ${label}...`);

    const audiosForCallback = audioStreams.map((aud) => {
      const rawPlaylist = rewrittenAudioPlaylists.find(p => p.streamIndex === aud.index);
      return {
        streamIndex: aud.index,
        language: aud.language,
        title: aud.title,
        isDefault: aud.index === defaultAudioIndex,
        disposition: aud.disposition || null,
        playlistUrl: rawPlaylist ? rawPlaylist.playlistUrl : undefined,
        playlistText: rawPlaylist ? rawPlaylist.playlistText : undefined
      };
    });

    const renditionsForCallback = codecResults.map(r => ({
      codec: r.codec,
      width: r.outputWidth,
      height: r.outputHeight,
      measuredBandwidth: r.measuredBandwidth,
      playlistUrl: r.playlistUrl,
      playlistText: r.playlistText,
      completedZips: r.completedZips,
      disposition: videoStream ? videoStream.disposition : null
    }));

    const callbackBody = {
      fileId: file_id,
      userId: user_id,
      label,
      kind,
      renditions: renditionsForCallback,
      skippedCodecs,
      githubReleaseId: release_id,
      githubReleaseIds,
      subtitles: rewrittenSubtitlePlaylists,
      audios: audiosForCallback,
      token: vps_callback_token,
      partIndex: partIndex,
      completedSubtitleZips
    };

    let delay = 2000;
    let attempt = 1;
    while (true) {
      try {
        await apiRequest(vps_callback_url, 'POST', {
          'Content-Type': 'application/json'
        }, callbackBody);
        console.log(`VPS callback successfully completed for resolution ${label}`);
        break;
      } catch (err) {
        console.warn(`[Callback] Attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
        delay = Math.min(delay * 2, 30000);
      }
    }
  });

  await Promise.all(resPromises);

  abortAllDownloads();

  if (globalProxyServer) {
    console.log('Closing local HTTP proxy server...');
    try {
      globalProxyServer.close();
    } catch (e) {}
  }

    // Cleanup temporary files
    console.log('Cleaning up temporary files...');
    try {
      fs.rmSync(WORK_DIR, { recursive: true, force: true });
    } catch (e) {}

    console.log('HLS Optimization Job successfully completed and logged on VPS!');
  } catch (err) {
    console.error('Fatal Error during HLS Optimization run:', err);

    if (vps_callback_url) {
      const activeLabel = process.env.ACTIVE_RESOLUTION_LABEL || data.label || 'unknown';
      console.log(`Sending failure callback to VPS for resolution ${activeLabel}...`);
      const errorCallbackBody = {
        fileId: file_id,
        userId: user_id,
        label: activeLabel,
        kind,
        token: vps_callback_token,
        partIndex: partIndex,
        error: err.message || String(err)
      };

      let delay = 2000;
      let attempt = 1;
      while (attempt <= 3) {
        try {
          await apiRequest(vps_callback_url, 'POST', {
            'Content-Type': 'application/json'
          }, errorCallbackBody);
          console.log(`VPS failure callback successfully completed`);
          break;
        } catch (callbackErr) {
          console.warn(`[Failure Callback] Attempt ${attempt} failed: ${callbackErr.message}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt++;
          delay = Math.min(delay * 2, 30000);
        }
      }
    }

    abortAllDownloads();

    if (globalProxyServer) {
      console.log('Closing local HTTP proxy server on error...');
      try {
        globalProxyServer.close();
      } catch (e) {}
    }

    // Cleanup temporary files
    console.log('Cleaning up temporary files on error...');
    try {
      fs.rmSync(WORK_DIR, { recursive: true, force: true });
    } catch (e) {}

    process.exit(1);
  }
}

function cleanupWorkDirSync() {
  try {
    if (WORK_DIR && fs.existsSync(WORK_DIR)) {
      fs.rmSync(WORK_DIR, { recursive: true, force: true });
    }
  } catch (e) {}
}

if (require.main === module) {
  process.on('SIGINT', () => { cleanupWorkDirSync(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupWorkDirSync(); process.exit(143); });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    cleanupWorkDirSync();
    process.exit(1);
  });

  main().catch(err => {
    console.error('Unhandled Fatal Error outside main try-catch:', err);
    cleanupWorkDirSync();
    process.exit(1);
  });
} else {
  // Additive, guarded export block for self-test purposes only (selftest.js). Does not
  // change standalone runtime behavior since it's only reached when required as a module.
  module.exports = {
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
    maxZipBytes,
    zipPayloadBudget,
    configureStorage,
    gitlabLinkToApiUrl,
    STORAGE,
    assertUnderZipCap,
    batchFilesBySize,
    packVttIntoSizedFiles,
    parseVttCueBlocks,
  };
}
