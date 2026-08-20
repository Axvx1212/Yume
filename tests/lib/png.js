// Minimal PNG decoder (zlib + struct only) so tests can assert on real pixels.
//
// This exists because two bugs were invisible to every DOM assertion and only
// showed up in rendered output: a dead band at the bottom of the screen, and a
// 1px seam drawn through webtoon artwork. Both were found by decoding a
// screenshot and reading rows, and neither is catchable by eye at device scale.

import zlib from 'node:zlib';
import fs from 'node:fs';

/** Decode a PNG to {width, height, channels, data} with 8-bit samples. */
export function decodePNG(path) {
  const file = fs.readFileSync(path);
  let pos = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];

  while (pos < file.length) {
    const len = file.readUInt32BE(pos);
    const tag = file.toString('ascii', pos + 4, pos + 8);
    const chunk = file.subarray(pos + 8, pos + 8 + len);
    if (tag === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (tag === 'IDAT') idat.push(chunk);
    else if (tag === 'IEND') break;
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[p]; p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 255; break;
        case 2: line[i] = (line[i] + b) & 255; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          line[i] = (line[i] + pr) & 255;
          break;
        }
        default: break;      // 0 = none
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }

  return { width, height, channels, data: out };
}

/** Average colour of one row, sampled across its width. */
export function rowColour(img, y, step = 4) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let x = 0; x < img.width; x += step) {
    const i = (y * img.width + x) * img.channels;
    r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n += 1;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Last row containing lit UI pixels. Used to prove the shell reaches the
 * bottom of the screen: compare against height and the 34px home-indicator
 * inset. Anything beyond that is dead space.
 */
export function lastContentRow(img, threshold = 100) {
  for (let y = img.height - 1; y > img.height / 2; y--) {
    let lit = 0;
    for (let x = 0; x < img.width; x += 3) {
      const i = (y * img.width + x) * img.channels;
      if (img.data[i] > threshold && img.data[i + 1] > threshold && img.data[i + 2] > threshold) {
        lit += 1;
        if (lit > 4) return y;
      }
    }
  }
  return null;
}

/** Darkest row within a band — a seam shows up as a dip against white pages. */
export function darkestRowIn(img, fromY, toY) {
  let darkest = null;
  for (let y = Math.max(0, fromY); y <= Math.min(img.height - 1, toY); y++) {
    const c = rowColour(img, y);
    const sum = c[0] + c[1] + c[2];
    if (!darkest || sum < darkest.sum) darkest = { y, colour: c, sum };
  }
  return darkest;
}
