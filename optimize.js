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

function checkSvtAv1() {
  try {
    execSync('ffmpeg -encoders | grep -i svtav1', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
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
const MAX_ZIP_BYTES = 1024 * 1024 * 1024; // 1GB limit for zipped segments
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
          reject(new Error(`Request to ${urlStr} failed with status ${res.statusCode}: ${buffer.toString('utf8')}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
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

      const backoffMs = attempt * 1000 + Math.random() * 500;
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
      let totalBytes = 0;
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
        const headers = {
          'User-Agent': 'github-storage-worker/1.0.0',
        };
        // ONLY send Authorization & Accept headers if we are targeting GitHub endpoints.
        // S3/CDN endpoints will reject requests that mix signature query parameters with Auth headers.
        if (parsed.hostname.endsWith('github.com')) {
          headers['Authorization'] = `Bearer ${token}`;
          headers['Accept'] = 'application/octet-stream';
        }
        
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

          if (res.statusCode === 302 || res.statusCode === 301) {
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
            cleanupAndReject(new Error(`Failed to download asset, HTTP status: ${res.statusCode}`));
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
      get(urlStr);
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
            const delay = attempt * 2000;
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
async function uploadAssetFile(uploadUrl, assetName, filePath, contentType, token) {
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
              reject(new Error(`Status ${res.statusCode}: ${buffer.toString('utf8')}`));
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

      const backoffMs = attempt * 2000;
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
          const newUri = `${base}/segment/${encodeURIComponent(uri)}`;
          return `URI="${newUri}"`;
        });
      }
      if (line.startsWith('#')) return line;
      return `${base}/segment/${encodeURIComponent(line)}`;
    })
    .join('\n');
}

async function createNewRelease(owner, repo, fileId, label, partIndex, token) {
  const tagName = `hls-${fileId}-${label}-part${partIndex}-${Date.now()}`;
  const releaseName = `[HLS] File ${fileId} - ${label} (Part ${partIndex})`;
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
  if (parsed.hostname.endsWith('github.com')) {
    headers['Authorization'] = `Bearer ${token}`;
    headers['Accept'] = 'application/octet-stream';
  }
  return headers;
}

function attemptRangeDownload(url, destPath, token, start, end) {
  return new Promise((resolve, reject) => {
    let fd = null;
    let activeRequest = null;
    let isRejected = false;
    let writePos = start;

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

      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location;
        res.resume();
        activeRequests.delete(req);
        if (!loc) {
          cleanupAndReject(new Error('Redirect location missing'));
          return;
        }
        startDownload(loc);
        return;
      }

      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        cleanupAndReject(new Error(`Failed range download: status ${res.statusCode}`));
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
        fs.write(fd, chunk, 0, chunk.length, writePos, (err, written) => {
          if (err) {
            cleanupAndReject(err);
            return;
          }
          writePos += written;
          if (!isRejected) res.resume();
        });
      });

      res.on('end', () => {
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
      });
    }

    function startDownload(currentUrl) {
      const parsed = new URL(currentUrl);
      const headers = buildDownloadHeaders(parsed, token);
      headers['Range'] = `bytes=${start}-${end}`;

      try {
        fd = fs.openSync(destPath, 'r+');
      } catch (e) {
        cleanupAndReject(e);
        return;
      }

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

    startDownload(url);
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
            const delay = attempt * 2000;
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
let MAX_CACHED_CHUNKS = 12;
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

function cleanCache() {
  if (!fs.existsSync(cacheDir)) return;
  (async () => {
    const files = (await fs.promises.readdir(cacheDir))
      .filter(name => name.startsWith('part_') && !name.endsWith('.tmp'))
      .map(name => parseInt(name.substring(5), 10))
      .filter(num => !isNaN(num));

    if (files.length <= MAX_CACHED_CHUNKS) return;

    files.sort((a, b) => {
      const idxA = chunkAccessOrder.indexOf(a);
      const idxB = chunkAccessOrder.indexOf(b);
      return idxA - idxB;
    });

    let deletedCount = 0;
    const targetDeleteCount = files.length - MAX_CACHED_CHUNKS;

    for (const assetIdx of files) {
      if (deletedCount >= targetDeleteCount) break;
      if (activeDownloads.has(assetIdx)) continue;
      if (activeReads.has(assetIdx) && activeReads.get(assetIdx) > 0) continue;

      const oldPath = path.join(cacheDir, `part_${assetIdx}`);
      if (fs.existsSync(oldPath)) {
        console.error(`[Proxy Cache] Deleting old cached chunk ${assetIdx} to free up space`);
        try {
          fs.unlinkSync(oldPath);
          partRanges.delete(assetIdx);
          deletedCount++;
        } catch (e) {
          console.warn(`[Proxy Cache] Failed to delete chunk ${assetIdx}:`, e);
        }
      }
    }
  })();
}

// Ensures a sparse cache file exists for this part, sized to the full remote part
// (so byte offsets line up), without pre-filling it — actual bytes are only written
// for ranges that get downloaded.
function ensurePartFile(assetIdx, partSize) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const destPath = path.join(cacheDir, `part_${assetIdx}`);
  if (!fs.existsSync(destPath)) {
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
  const destPath = ensurePartFile(assetIdx, partSize);

  const prevTail = partQueue.get(assetIdx) || Promise.resolve();
  const task = prevTail.then(async () => {
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
  task.finally(() => {
    if (activeDownloads.get(assetIdx) === task) {
      activeDownloads.delete(assetIdx);
      cleanCache();
    }
  });

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
    
    getOrDownloadRange(partInfo.idx, partAssets, token, partInfo.startInPart, partInfo.endInPart)
      .then((filePath) => {
        if (destroyed) return;
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
    MAX_CACHED_CHUNKS = Math.max(12, Math.min(partAssets.length, 30));
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

function detectSceneCuts(inputSource, startTime, endTime) {
  return new Promise((resolve) => {
    const args = ['-nostdin'];
    if (startTime > 0) {
      args.push('-ss', startTime.toFixed(3));
    }
    args.push(
      '-analyzeduration', '100M',
      '-probesize', '100M',
      '-protocol_whitelist', 'file,http,tcp,https,tls',
      '-i', inputSource,
    );
    // Output -t rather than input -to; see the video job for why. The scene-cut timestamps
    // this returns must stay on the same part-relative clock as the encode's -force_key_frames.
    if (endTime !== null) {
      args.push('-t', Math.max(0, endTime - startTime).toFixed(3));
    }
    args.push(
      '-an',
      '-vf', "scale=-2:240,select='gt(scene,0.4)',showinfo",
      '-f', 'null',
      '-'
    );

    console.log(`Running scene-cut detection: ffmpeg ${args.join(' ')}`);
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      const timestamps = [];
      const lines = stderr.split(/\r?\n/);
      const regex = /Parsed_showinfo_.*pts_time:([0-9.]+)/;
      for (const line of lines) {
        const match = regex.exec(line);
        if (match) {
          const t = parseFloat(match[1]);
          if (!isNaN(t)) {
            timestamps.push(t);
          }
        }
      }
      console.log(`Detected ${timestamps.length} scene cuts.`);
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

  const activePart = process.env.ACTIVE_PART ? JSON.parse(process.env.ACTIVE_PART) : null;

  const startTime = activePart && activePart.start_time !== undefined 
    ? parseFloat(activePart.start_time) 
    : (data.start_time !== undefined ? parseFloat(data.start_time) : 0);
  const endTime = activePart && activePart.end_time !== undefined 
    ? (activePart.end_time !== null ? parseFloat(activePart.end_time) : null) 
    : (data.end_time !== undefined && data.end_time !== null ? parseFloat(data.end_time) : null);
  const startSegmentIndex = activePart && activePart.start_segment_index !== undefined 
    ? parseInt(activePart.start_segment_index, 10) 
    : (data.start_segment_index !== undefined ? parseInt(data.start_segment_index, 10) : 0);
  const partIndex = activePart && activePart.part_index !== undefined 
    ? parseInt(activePart.part_index, 10) 
    : (data.part_index !== undefined ? parseInt(data.part_index, 10) : 1);
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
  const isMetadataJob = isAudioJob; // Keep isMetadataJob for backward compatibility

  const extract_subtitles = isSubtitlesJob || (!hasSubtitlesRunner && (hasMetadataRunner ? isAudioJob : true) && 
    (activePart && activePart.extract_subtitles !== undefined 
      ? !!activePart.extract_subtitles 
      : ((vps && vps.extract_subtitles !== undefined) ? !!vps.extract_subtitles : true)));

  const extract_audio = !isSubtitlesJob && (hasMetadataRunner ? isAudioJob : true) && 
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
  const sourceReleaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/${sourceReleaseId}`;
  console.log(`Fetching source release info...`);
  const sourceReleaseRes = await apiRequest(sourceReleaseUrl, 'GET', {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
  });
  const sourceReleaseInfo = JSON.parse(sourceReleaseRes.body.toString('utf8'));

  // 2b. Fetch Target Release info for uploads
  const targetReleaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/${release_id}`;
  console.log(`Fetching target release info...`);
  const targetReleaseRes = await apiRequest(targetReleaseUrl, 'GET', {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
  });
  const targetReleaseInfo = JSON.parse(targetReleaseRes.body.toString('utf8'));
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
    
    const res = await uploadAssetFile(currentUploadUrl, assetName, filePath, contentType, token);
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

  // 3. Start local HTTP proxy with caching
  console.log(`Starting local caching HTTP proxy server for ${partAssets.length} remote chunks...`);
  const proxyInfo = await startCachingProxy(partAssets, token);
  globalProxyServer = proxyInfo.server;
  const proxyPort = proxyInfo.port;
  console.log(`Local caching HTTP proxy server listening on port ${proxyPort}`);

  const inputSource = `http://127.0.0.1:${proxyPort}/video.mp4`;

  // 5. Probe video stream properties
  console.log('Probing video stream properties...');
  const probeCmd = `ffprobe -v error -analyzeduration 100M -probesize 100M -show_entries "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,channels,r_frame_rate,bit_rate:stream_tags" -of json -protocol_whitelist file,http,tcp,https,tls "${inputSource}"`;
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
        const hasTags = !!((lang && lang !== 'und' && lang !== 'undetermined') || getStreamTag(s, 'title') || getStreamTag(s, 'name'));
        let isForced = !!(s.disposition && s.disposition.forced === 1);
        let isDefault = !!(s.disposition && s.disposition.default === 1 && hasTags);
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
            const zipName = `subtitle_${streamIdx}.zip`;
            const zipPath = path.join(WORK_DIR, zipName);
            console.log(`Packaging bitmap subtitle ZIP ${zipName}...`);
            const listFilePath = path.join(WORK_DIR, `${zipName}.list.txt`);
            fs.writeFileSync(listFilePath, subExtPath, 'utf8');

            try {
              execSync(`zip -0 -j "${zipPath}" -@ < "${listFilePath}"`, { stdio: 'ignore' });

              const zipSize = (await fs.promises.stat(zipPath)).size;
              console.log(`Uploading bitmap subtitle ZIP ${zipName} (${(zipSize / 1024).toFixed(1)} KB)...`);
              const uploadRes = await uploadAssetWithRotation(zipName, zipPath, 'application/zip');

              completedSubtitleZips.push({
                zipType: 'subtitle',
                streamIndex: streamIdx,
                zipIndex: 0,
                assetId: uploadRes.id,
                url: uploadRes.browser_download_url,
                zipSize
              });

              fs.unlinkSync(zipPath);
            } catch (zipErr) {
              console.warn(`Warning: Failed to zip/upload bitmap subtitle stream #${streamIdx}: ${zipErr.message}`);
            } finally {
              try { fs.unlinkSync(listFilePath); } catch (e) {}
              try { fs.unlinkSync(subExtPath); } catch (e) {}
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
            fs.writeFileSync(fullVttPath, patchedVtt, 'utf8');
            const rawSize = (await fs.promises.stat(fullVttPath)).size;
            console.log(`Subtitle stream #${sub.index} converted to single VTT (${(rawSize / 1024).toFixed(1)} KB)`);

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
              playlistText: buildSingleSegmentVttPlaylist(videoDurationVal, `subtitle_${sub.index}.vtt`)
            });

            // Zip and Upload this stream's single VTT file immediately
            const streamIdx = sub.index;
            const zipName = `subtitle_${streamIdx}.zip`;
            const zipPath = path.join(WORK_DIR, zipName);
            console.log(`Packaging subtitle ZIP ${zipName}...`);
            const listFilePath = path.join(WORK_DIR, `${zipName}.list.txt`);
            fs.writeFileSync(listFilePath, fullVttPath, 'utf8');
            try {
              execSync(`zip -0 -j "${zipPath}" -@ < "${listFilePath}"`, { stdio: 'ignore' });

              const zipSize = (await fs.promises.stat(zipPath)).size;
              console.log(`Uploading subtitle ZIP ${zipName} (${(zipSize / 1024).toFixed(1)} KB)...`);
              const uploadRes = await uploadAssetWithRotation(zipName, zipPath, 'application/zip');

              completedSubtitleZips.push({
                zipType: 'subtitle',
                streamIndex: streamIdx,
                zipIndex: 0,
                assetId: uploadRes.id,
                url: uploadRes.browser_download_url,
                zipSize
              });

              fs.unlinkSync(zipPath);
            } catch (zipErr) {
              console.warn(`Warning: Failed to zip/upload subtitle stream #${streamIdx}: ${zipErr.message}`);
            } finally {
              try { fs.unlinkSync(listFilePath); } catch (e) {}
              try { fs.unlinkSync(fullVttPath); } catch (e) {}
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
        '-b:a', `${targetAudioBitrate}k`,
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_playlist_type', 'vod',
        '-hls_segment_type', 'fmp4',
        '-hls_segment_filename', `"${audSegmentPattern}"`,
        '-hls_fmp4_init_filename', `"${audInitName}"`,
        '-hls_flags', 'independent_segments',
        '-start_number', startSegmentIndex.toString()
      );
      // Audio beyond 7.1 (e.g. Atmos 7.1.2 / 7.1.4 with up to 12 channels) produces
      // channel_configuration >= 12 which ISO 14496-3:2009 Table 1.19 leaves undefined;
      // browsers reject it with CHUNK_DEMUXER_ERROR_APPEND_FAILED. Downmix to stereo.
      if (aud.channels > 8) {
        audFfmpegArgs.push('-ac', '2');
      }
      audFfmpegArgs.push(`"${audPlaylistPath}"`);
      const audFfmpegCmd = audFfmpegArgs.flat().join(' ');
      console.log(`Executing Audio FFmpeg command: ${audFfmpegCmd}`);
      
      try {
        await execAsync(audFfmpegCmd, { stdio: 'inherit' });
        const rawAudPlaylist = fs.readFileSync(audPlaylistPath, 'utf8');
        audioPlaylists.push({
          streamIndex: aud.index,
          language: aud.language,
          title: aud.title,
          playlistText: rawAudPlaylist
        });
      } catch (err) {
        console.warn(`Warning: Failed to convert audio stream #${aud.index}. Skipping.`);
      }
    }
  }

  // Zip audio files separately, one zip per audio stream (mirrors subtitle per-stream
  // zipping), chunked so no single zip exceeds MAX_ZIP_BYTES (runs on metadata/audio
  // runner or primary runner VM).
  const audioSegRegex = /^audio_(\d+)_(\d{5})\.m4s$/;
  const audioInitRegex = /^audio_(\d+)_part\d{4}_init\.mp4$/;
  const audioFilesByStream = new Map();
  for (const name of await fs.promises.readdir(OUTPUT_DIR)) {
    const segMatch = name.match(audioSegRegex);
    const initMatch = name.match(audioInitRegex);
    if (!segMatch && !initMatch) continue;
    const streamIdx = parseInt((segMatch || initMatch)[1], 10);
    const segmentIndex = segMatch ? parseInt(segMatch[2], 10) : null;
    const fullPath = path.join(OUTPUT_DIR, name);
    const size = (await fs.promises.stat(fullPath)).size;
    if (!audioFilesByStream.has(streamIdx)) audioFilesByStream.set(streamIdx, []);
    audioFilesByStream.get(streamIdx).push({ name, fullPath, size, segmentIndex });
  }

  for (const [streamIdx, files] of audioFilesByStream) {
    files.sort((a, b) => {
      const isInitA = a.name.includes('init');
      const isInitB = b.name.includes('init');
      if (isInitA && !isInitB) return -1;
      if (!isInitA && isInitB) return 1;
      return (a.segmentIndex ?? -1) - (b.segmentIndex ?? -1);
    });

    let pendingFiles = [];
    let pendingSize = 0;
    let segmentStart = null;
    let segmentEnd = null;
    let chunkIdx = 0;

    const flush = async () => {
      if (pendingFiles.length === 0) return;
      const zipName = `audio-${streamIdx}-part${partIndex.toString().padStart(4, '0')}-${chunkIdx.toString().padStart(4, '0')}.zip`;
      const zipPath = path.join(WORK_DIR, zipName);
      console.log(`Packaging audio ZIP ${zipName} with ${pendingFiles.length} files...`);
      const listFilePath = path.join(WORK_DIR, `${zipName}.list.txt`);
      fs.writeFileSync(listFilePath, pendingFiles.map(f => f.fullPath).join('\n'), 'utf8');
      try {
        execSync(`zip -0 -j "${zipPath}" -@ < "${listFilePath}"`, { stdio: 'ignore' });
      } finally {
        try { fs.unlinkSync(listFilePath); } catch (e) {}
      }

      const zipSize = (await fs.promises.stat(zipPath)).size;
      console.log(`Uploading audio ZIP ${zipName} (${(zipSize / 1024 / 1024).toFixed(2)} MB)...`);
      const uploadRes = await uploadAssetWithRotation(zipName, zipPath, 'application/zip');

      completedSubtitleZips.push({
        zipType: 'audio',
        streamIndex: streamIdx,
        zipIndex: chunkIdx,
        assetId: uploadRes.id,
        url: uploadRes.browser_download_url,
        zipSize,
        segmentStart,
        segmentEnd
      });

      fs.unlinkSync(zipPath);
      for (const f of pendingFiles) {
        try { fs.unlinkSync(f.fullPath); } catch (e) {}
      }
      pendingFiles = [];
      pendingSize = 0;
      segmentStart = null;
      segmentEnd = null;
      chunkIdx++;
    };

    for (const f of files) {
      if (pendingSize + f.size > MAX_ZIP_BYTES && pendingFiles.length > 0) {
        await flush();
      }
      pendingFiles.push(f);
      pendingSize += f.size;
      if (f.segmentIndex !== null) {
        if (segmentStart === null || f.segmentIndex < segmentStart) segmentStart = f.segmentIndex;
        if (segmentEnd === null || f.segmentIndex > segmentEnd) segmentEnd = f.segmentIndex;
      }
    }
    await flush();
  }



  let forcedKeyframeString = null;
  if (kind !== 'original' && !isAudioJob && !isSubtitlesJob) {
    console.log('Pre-analysis: Detecting scene cuts for aligned keyframe placement...');
    try {
      const chunkDuration = (endTime !== null ? endTime : duration) - startTime;
      const sceneCuts = await detectSceneCuts(inputSource, startTime, endTime);
      const forcedTimestamps = generateKeyframeTimeline(sceneCuts, chunkDuration, 6, 3, 9);
      if (forcedTimestamps.length > 0) {
        forcedKeyframeString = forcedTimestamps.map(t => t.toFixed(3)).join(',');
        console.log(`Generated timeline with ${forcedTimestamps.length} keyframe alignment points: ${forcedKeyframeString}`);
      } else {
        console.log('No keyframe alignment points generated, falling back to default keyframes.');
      }
    } catch (e) {
      console.warn('Pre-analysis failed:', e);
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
      const svtav1Available = checkSvtAv1();
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

      if (codec === 'h264') {
        ffmpegArgs.push(
          '-c:v', 'libx264',
          '-preset', dynamicParams.preset,
          '-crf', dynamicParams.crf
        );
        const activeMaxrate = dynamicParams.maxrate || hls_maxrate;
        const activeBufsize = dynamicParams.bufsize || hls_bufsize;
        if (activeMaxrate) ffmpegArgs.push('-maxrate', activeMaxrate);
        if (activeBufsize) ffmpegArgs.push('-bufsize', activeBufsize);
        if (hls_profile) ffmpegArgs.push('-profile:v', hls_profile);
        if (hls_level) ffmpegArgs.push('-level', hls_level);
        ffmpegArgs.push(
          '-pix_fmt', 'yuv420p',
          '-vf', `"bwdif,scale='trunc(oh*a/2)*2':'trunc(min(${tHeight},ih)/2)*2'"`,
          '-force_key_frames', forcedKeyframeString ? `"${forcedKeyframeString}"` : '"expr:gte(t,n_forced*6)"',
          '-sc_threshold', '0',
          '-flags', '+cgop'
        );
      } else if (codec === 'av1') {
        let fps = 30; // default fallback
        try {
          if (videoStream && videoStream.r_frame_rate) {
            fps = parseFrameRate(videoStream.r_frame_rate);
          }
        } catch (e) {
          console.warn('Failed parsing r_frame_rate:', e);
        }
        const gop = Math.round(fps * 6);

        ffmpegArgs.push(
          '-c:v', 'libsvtav1',
          '-preset', dynamicParams.preset,
          '-crf', dynamicParams.crf,
          '-svtav1-params', forcedKeyframeString ? 'tune=0:scd=0' : 'tune=0',
          '-pix_fmt', 'yuv420p',
          '-g', String(gop)
        );
        if (dynamicParams.maxrate) {
          ffmpegArgs.push('-maxrate', dynamicParams.maxrate);
        }
        if (dynamicParams.bufsize) {
          ffmpegArgs.push('-bufsize', dynamicParams.bufsize);
        }
        ffmpegArgs.push(
          '-vf', `"bwdif,scale='trunc(oh*a/2)*2':'trunc(min(${tHeight},ih)/2)*2'"`
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
    await execAsync(ffmpegCmd, { stdio: 'inherit' });

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
    let currentZipSize = 0;
    let currentZipIndex = 0;
    let pendingFiles = [];
    let segmentStart = null;
    let segmentEnd = null;

    async function uploadZipBatch() {
      if (pendingFiles.length === 0) return;
      
      const uniqueZipIndex = (partIndex - 1) * 100 + currentZipIndex;
      const zipName = useCodecSuffix 
        ? `segments-${label}-${codec}-part${partIndex.toString().padStart(4, '0')}-${currentZipIndex.toString().padStart(4, '0')}.zip`
        : `segments-${label}-part${partIndex.toString().padStart(4, '0')}-${currentZipIndex.toString().padStart(4, '0')}.zip`;
      const zipPath = path.join(WORK_DIR, zipName);
      
      console.log(`Packaging ZIP ${zipName} with ${pendingFiles.length} segments...`);
      const listFilePath = path.join(WORK_DIR, `${zipName}.list.txt`);
      const fileContents = pendingFiles.map(f => f.fullPath).join('\n');
      fs.writeFileSync(listFilePath, fileContents, 'utf8');
      try {
        execSync(`zip -0 -j "${zipPath}" -@ < "${listFilePath}"`, { stdio: 'ignore' });
      } finally {
        try { fs.unlinkSync(listFilePath); } catch (e) {}
      }
      
      const zipSize = (await fs.promises.stat(zipPath)).size;
      console.log(`Uploading ${zipName} (${(zipSize / 1024 / 1024).toFixed(1)} MB)...`);
      const uploadRes = await uploadAssetWithRotation(zipName, zipPath, 'application/zip');
      
      completedZipsForCodec.push({
        zipIndex: uniqueZipIndex,
        assetId: uploadRes.id,
        url: uploadRes.browser_download_url,
        zipSize,
        segmentStart,
        segmentEnd
      });
      
      fs.unlinkSync(zipPath);
      for (const f of pendingFiles) {
        const name = f.name;
        const isAudioOrSub = name.startsWith('audio_') || name.startsWith('subtitle_');
        if (!isAudioOrSub) {
          try { fs.unlinkSync(f.fullPath); } catch (e) {}
        }
      }
      
      currentZipIndex++;
      currentZipSize = 0;
      pendingFiles = [];
      segmentStart = null;
      segmentEnd = null;
    }

    for (const file of filesToZip) {
      if (file.segmentIndex !== null) {
        if (segmentStart === null || file.segmentIndex < segmentStart) segmentStart = file.segmentIndex;
        if (segmentEnd === null || file.segmentIndex > segmentEnd) segmentEnd = file.segmentIndex;
      }
      
      pendingFiles.push(file);
      currentZipSize += file.size;
      
      if (currentZipSize >= MAX_ZIP_BYTES) {
        await uploadZipBatch();
      }
    }
    await uploadZipBatch();

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

  if (!isMetadataJob && !isSubtitlesJob) {
    for (const codec of resolvedCodecs) {
      try {
        const result = await processCodecJob(codec);
        if (result) {
          codecResults.push(result);
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
      if (isAudioJobLocal || isSubtitlesJobLocal) {
        const primaryVideoRes = rawResolutions.find(r => r.label !== 'metadata' && r.label !== 'audio' && r.label !== 'subtitles') || rawResolutions[0];
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

    let defaultAudioIndex = null;
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

main().catch(err => {
  console.error('Unhandled Fatal Error outside main try-catch:', err);
  process.exit(1);
});
