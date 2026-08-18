import { ValidationError } from '@/domain/errors';

/**
 * Deciding whether an uploaded file is really an image, from its own bytes.
 *
 * This is the first untrusted binary the application accepts, and the usual
 * mistakes all apply here:
 *
 *  - The browser's `Content-Type` and filename are supplied by whoever is
 *    uploading. Neither is evidence of anything, so neither is consulted; the
 *    format is read from the file's magic bytes.
 *  - SVG is deliberately NOT accepted. It is not an image but a document that
 *    can carry script, and an SVG served from the shop's own origin would run
 *    with the viewer's session — on the machine of whoever opens a receipt.
 *  - Dimensions are read as well as byte length. A small compressed file can
 *    decompress into something enormous, and a browser asked to paint it is
 *    the thing that falls over.
 */

export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** Comfortably more than a logo needs, far less than a problem. */
export const MAX_IMAGE_BYTES = 1_000_000;
export const MAX_IMAGE_DIMENSION = 4000;

export interface InspectedImage {
  mime: AllowedImageType;
  width: number;
  height: number;
  bytes: number;
}

const startsWith = (data: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((byte, index) => data[offset + index] === byte);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG: the IHDR chunk sits immediately after the signature. */
function readPngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // 8 signature + 4 length + 4 'IHDR' = 16.
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * JPEG: walk the marker segments to the frame header, which is the only place
 * the dimensions are recorded. There is no fixed offset to read.
 */
function readJpegSize(data: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 2; // past 0xFFD8

  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1] as number;

    // Start-of-frame markers carry the size. C4, C8 and CC look like frame
    // markers but are tables, not frames.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }

    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

/** WebP: RIFF container, then one of three chunk layouts. */
function readWebpSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 30) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunk = String.fromCharCode(...data.slice(12, 16));

  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, then a start code, then 14-bit dimensions.
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14 bits each, packed across four bytes after the signature.
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit values, minus one, little-endian.
    const width = (data[24] as number) | ((data[25] as number) << 8) | ((data[26] as number) << 16);
    const height = (data[27] as number) | ((data[28] as number) << 8) | ((data[29] as number) << 16);
    return { width: width + 1, height: height + 1 };
  }
  return null;
}

/**
 * Confirms the bytes are an image of an accepted kind and returns what it is.
 * Throws a ValidationError a shop owner can act on, never a bare failure.
 */
export function inspectImage(data: Uint8Array): InspectedImage {
  if (data.length === 0) {
    throw new ValidationError('That file is empty.');
  }
  if (data.length > MAX_IMAGE_BYTES) {
    const mb = (data.length / 1_000_000).toFixed(1);
    throw new ValidationError(
      `That image is ${mb} MB. Please use one under ${MAX_IMAGE_BYTES / 1_000_000} MB.`,
    );
  }

  let mime: AllowedImageType | null = null;
  let size: { width: number; height: number } | null = null;

  if (startsWith(data, PNG_SIGNATURE)) {
    mime = 'image/png';
    size = readPngSize(data);
  } else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    mime = 'image/jpeg';
    size = readJpegSize(data);
  } else if (
    startsWith(data, [0x52, 0x49, 0x46, 0x46]) && // 'RIFF'
    startsWith(data, [0x57, 0x45, 0x42, 0x50], 8) // 'WEBP'
  ) {
    mime = 'image/webp';
    size = readWebpSize(data);
  }

  if (mime === null) {
    // Name the likely culprit rather than saying "invalid file".
    const looksLikeSvg = /^\s*(<\?xml|<svg)/i.test(
      new TextDecoder().decode(data.slice(0, 200)),
    );
    throw new ValidationError(
      looksLikeSvg
        ? 'SVG images are not accepted, because they can carry hidden instructions that run in the browser. Please use a PNG, JPEG or WebP.'
        : 'That does not look like a PNG, JPEG or WebP image.',
    );
  }

  if (size === null || size.width <= 0 || size.height <= 0) {
    throw new ValidationError('That image appears to be damaged — its size could not be read.');
  }

  if (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION) {
    throw new ValidationError(
      `That image is ${size.width}x${size.height} pixels. Please use one no larger than ${MAX_IMAGE_DIMENSION} pixels on a side.`,
    );
  }

  return { mime, width: size.width, height: size.height, bytes: data.length };
}
