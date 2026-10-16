// 写真の制約（仕様10）。サーバー側検査とブラウザ側変換の双方で使う。
export const PHOTO_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const PHOTO_MAX_STORED_BYTES = 2 * 1024 * 1024;
export const PHOTO_MAX_EDGE = 1920;
export const PHOTOS_PER_TARGET = 3;

export const PHOTO_UNSUPPORTED_MESSAGE =
  'この形式は読み込めません。カメラで撮り直すかJPEGで選んでください';

export function isJpegSignature(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** JPEG の SOFn マーカーから寸法を読む。読めなければ null。 */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isJpegSignature(b)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return { width, height };
    }
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/** 入力ファイルの受付判定（ブラウザでデコード前）。SVG/HTML/PDF/動画は拒否。 */
export function acceptInputFile(f: { type: string; size: number; name: string }): string | null {
  if (f.size > PHOTO_MAX_INPUT_BYTES) return '10MiBを超える写真は選べません。カメラの画質を下げるか別の写真を選んでください';
  const t = f.type.toLowerCase();
  const n = f.name.toLowerCase();
  if (t.includes('svg') || t.includes('html') || t.includes('pdf') || t.startsWith('video/') || /\.(svg|html?|pdf|mp4|mov)$/.test(n))
    return PHOTO_UNSUPPORTED_MESSAGE;
  return null;
}

export function fitWithin(w: number, h: number, max = PHOTO_MAX_EDGE): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * s), height: Math.round(h * s) };
}
