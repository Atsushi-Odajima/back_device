// 写真の選択・変換・送信状態（仕様10）。
// ブラウザでデコードできた画像を JPEG（長辺1920px以下・2MiB以下）に変換する。
// canvas で描き直すため、位置情報等の EXIF は引き継がない。
import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import { PHOTO_MAX_EDGE, PHOTO_MAX_STORED_BYTES, PHOTO_UNSUPPORTED_MESSAGE, PHOTOS_PER_TARGET, acceptInputFile, fitWithin } from '../domain/photo';
import { sha256Hex } from '../domain/sha256';
import { uuid } from '../domain/ids';
import { decodeB64 } from '../domain/base64';
import { SAMPLE_PHOTO_A, SAMPLE_PHOTO_B } from '../data/demo/samplePhotos';
import { Button, Status } from './ui';
import { PhotoIcon } from './Icons';

export const APP_MODE = (import.meta.env.VITE_APP_MODE ?? 'demo') as 'demo' | 'pilot';

export interface LocalPhoto {
  localId: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  sha256: string;
  previewUrl: string;
  /** 送信状態。ready になるまで「保存済み」と表示しない。 */
  state: 'unsent' | 'sending' | 'ready' | 'failed';
  attachmentId: string | null;
  /** createAttachment の operation_id（再送でも変えない） */
  opId: string;
  error: string | null;
}

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* 下の方法で再試行 */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error(PHOTO_UNSUPPORTED_MESSAGE);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function convertToJpeg(blob: Blob): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const src = await decode(blob);
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height;
  if (!sw || !sh) throw new Error(PHOTO_UNSUPPORTED_MESSAGE);
  const { width, height } = fitWithin(sw, sh, PHOTO_MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('この端末では画像を変換できません');
  ctx.drawImage(src, 0, 0, width, height);
  if ('close' in src) src.close();
  for (const quality of [0.85, 0.75, 0.6, 0.45]) {
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!out) break;
    if (out.size <= PHOTO_MAX_STORED_BYTES) return { bytes: new Uint8Array(await out.arrayBuffer()), width, height };
  }
  throw new Error('写真を2MiB以下に縮小できませんでした。別の写真を選んでください');
}

export async function makeLocalPhoto(blob: Blob): Promise<LocalPhoto> {
  const { bytes, width, height } = await convertToJpeg(blob);
  return {
    localId: uuid(),
    bytes,
    width,
    height,
    sha256: sha256Hex(bytes),
    previewUrl: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })),
    state: 'unsent',
    attachmentId: null,
    opId: uuid(),
    error: null,
  };
}

export function revokePhotos(list: LocalPhoto[]) {
  for (const p of list) URL.revokeObjectURL(p.previewUrl);
}

/** 写真を1枚送る（pending 作成 → アップロード → ready）。失敗時は pending のまま再試行できる。 */
export async function sendPhoto(
  repo: ReturnType<typeof useApp>['repo'],
  p: LocalPhoto,
  parent: { issueId: string | null; receiptLineId: string | null },
): Promise<LocalPhoto> {
  try {
    let attachmentId = p.attachmentId;
    if (!attachmentId) {
      const r = await repo.createAttachment(p.opId, {
        ...parent,
        byteSize: p.bytes.length,
        mime: 'image/jpeg',
        imageWidth: p.width,
        imageHeight: p.height,
        sha256: p.sha256,
      });
      attachmentId = r.attachmentId;
    }
    try {
      await repo.uploadAttachment(attachmentId, p.bytes);
    } catch (e) {
      return { ...p, attachmentId, state: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    return { ...p, attachmentId, state: 'ready', error: null };
  } catch (e) {
    return { ...p, state: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

export function photoStateLabel(s: LocalPhoto['state']) {
  switch (s) {
    case 'unsent':
      return <Status tone="neutral">未送信</Status>;
    case 'sending':
      return <Status tone="info">送信中</Status>;
    case 'ready':
      return <Status tone="success">送信済み</Status>;
    case 'failed':
      return <Status tone="error">送信失敗</Status>;
  }
}

/** 写真の追加。Stage A では架空画像のみ受け付け、持込ファイルの入口は理由付きで無効。 */
export function PhotoPicker({
  photos,
  max = PHOTOS_PER_TARGET,
  onAdd,
  onRemove,
  label,
}: {
  photos: LocalPhoto[];
  max?: number;
  onAdd: (p: LocalPhoto) => void;
  onRemove?: (localId: string) => void;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const full = photos.length >= max;
  const add = async (blob: Blob, name: string) => {
    setError(null);
    const reject = acceptInputFile({ type: blob.type, size: blob.size, name });
    if (reject) {
      setError(reject);
      return;
    }
    setBusy(true);
    try {
      onAdd(await makeLocalPhoto(blob));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const sample = (b64: string, n: string) => add(new Blob([new Uint8Array(decodeB64(b64))], { type: 'image/jpeg' }), n);
  const fullReason = full ? `写真は${max}枚までです` : null;

  return (
    <div className="stack-sm">
      <div className="label" style={{ fontWeight: 600 }}>
        {label}（最大{max}枚）
      </div>
      <p className="small muted">縮小画像を保存します。元写真は端末に残してください。位置情報は保存しません。</p>
      {photos.length > 0 && (
        <div className="photos">
          {photos.map((p, i) => (
            <div className="photo" key={p.localId}>
              <img src={p.previewUrl} alt={`${label} ${i + 1}枚目（${p.width}×${p.height}）`} />
              {photoStateLabel(p.state)}
              {onRemove && p.state !== 'ready' && p.state !== 'sending' && (
                <button type="button" className="btn btn-quiet small" onClick={() => onRemove(p.localId)} style={{ minHeight: 48 }}>
                  外す
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {APP_MODE === 'demo' ? (
        <div className="stack-sm">
          <div className="row">
            <Button onClick={() => sample(SAMPLE_PHOTO_A, 'sample-a.jpg')} disabled={busy} disabledReason={fullReason}>
              <PhotoIcon />
              架空写真Aを追加
            </Button>
            {!full && (
              <Button onClick={() => sample(SAMPLE_PHOTO_B, 'sample-b.jpg')} disabled={busy}>
                <PhotoIcon />
                架空写真Bを追加
              </Button>
            )}
            {!full && (
              <Button onClick={() => add(new Blob([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])], { type: 'image/heic' }), 'sample.heic')} disabled={busy}>
                非対応形式を試す
              </Button>
            )}
          </div>
          <Button disabledReason="検証用デモのため、実写真・持込ファイルの取り込みは無効です（Stage Bで有効）">
            <PhotoIcon />
            カメラで撮影・写真を選ぶ
          </Button>
        </div>
      ) : (
        <label className="btn" aria-disabled={full || busy}>
          <PhotoIcon />
          カメラで撮影・写真を選ぶ
          <input
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            disabled={full || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void add(f, f.name);
            }}
          />
        </label>
      )}
      {busy && <p className="small muted" role="status">写真を変換中…</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 送信済み写真の表示。60秒有効の読取を権限再検証後に取得し、オブジェクトURLは破棄する。 */
export function RemotePhoto({ attachmentId, alt }: { attachmentId: string; alt: string }) {
  const { repo } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let u: string | null = null;
    let alive = true;
    repo.getPhoto(attachmentId).then(
      (p) => {
        if (!alive) return;
        u = URL.createObjectURL(new Blob([new Uint8Array(p.bytes)], { type: p.mime }));
        setUrl(u);
      },
      () => alive && setErr(true),
    );
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [repo, attachmentId]);
  if (err) return <div className="ph small" role="img" aria-label={`${alt}（読み込めません）`}>読込失敗</div>;
  if (!url) return <div className="ph" role="img" aria-label={`${alt}（読み込み中）`} />;
  return <img src={url} alt={alt} />;
}
