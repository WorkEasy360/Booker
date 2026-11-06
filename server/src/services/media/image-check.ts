// What an uploaded image really is, read from its bytes (the file name and the browser's content type are ignored).
// Only PNG, JPEG and WebP are accepted: no SVG (it can carry scripts), no GIF, no HEIC. Dimensions come from the file
// header so oversized images (decompression bombs) are refused without decoding them.

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export const EXTENSIONS: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export interface ImageInfo { type: ImageType; width: number; height: number }

export type ImageProblem = { error: string; code: 'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'UNREADABLE' | 'TOO_MANY_PIXELS' };

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_DIMENSION = 4096;

function pngSize(b: Buffer): { width: number; height: number } | null {
  // Signature, then the IHDR chunk: length (4), "IHDR" (4), width (4), height (4).
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }                       // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // Start-of-frame markers carry the size (C0–CF except C4 DHT, C8 JPG, CC DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;            // end of image or start of scan before a frame
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

/** The image's real type and size, or why it is refused. */
export function inspectImage(bytes: Buffer, maxBytes = MAX_UPLOAD_BYTES): ImageInfo | ImageProblem {
  if (!bytes.length) return { error: 'The file is empty.', code: 'EMPTY' };
  if (bytes.length > maxBytes) return { error: `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, code: 'TOO_LARGE' };
  let type: ImageType | null = null;
  let size: { width: number; height: number } | null = null;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    type = 'image/png'; size = pngSize(bytes);
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    type = 'image/jpeg'; size = jpegSize(bytes);
  } else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    type = 'image/webp'; size = webpSize(bytes);
  }
  if (!type) return { error: 'Upload a PNG, JPEG or WebP image.', code: 'UNSUPPORTED_TYPE' };
  if (!size || size.width < 1 || size.height < 1) return { error: 'The image could not be read. Save it again as PNG or JPEG and retry.', code: 'UNREADABLE' };
  if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
    return { error: `The image is larger than ${MAX_DIMENSION} × ${MAX_DIMENSION} pixels.`, code: 'TOO_MANY_PIXELS' };
  }
  return { type, ...size };
}
