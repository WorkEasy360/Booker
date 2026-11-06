// The browser's quick check of a chosen image before uploading it (business logo, staff photo). The server reads the
// file's actual bytes and decides; this only gives an immediate answer. Unit-tested in tests/unit/image-file.test.ts.

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Why a chosen file cannot be uploaded, or null. */
export function imageFileProblem(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return 'Choose a PNG, JPEG or WebP image.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_IMAGE_BYTES) return 'The image must be 2 MB or smaller.';
  return null;
}
