// 사진 글자 읽기 (PaddleOCR 한국어 모델, 폰 브라우저 안에서 실행 — 사진은 밖으로 나가지 않는다).
// 모델·엔진 파일(약 33MB)은 처음 한 번만 받아 브라우저 Cache Storage에 둔다.

const VENDOR = new URL('./vendor/', import.meta.url);
const CACHE_NAME = 'ledger-ocr-v1';  // 파일을 바꾸면 이름을 올려 옛 캐시를 지운다
const FILES = {
  wasm: 'ort/ort-wasm-simd-threaded.wasm',
  detection: 'models/PP-OCRv5_mobile_det_infer.onnx',
  recognition: 'models/korean_PP-OCRv5_mobile_rec_infer.onnx',
  dictionary: 'models/ppocrv5_korean_dict.txt',
};
const MAX_SIDE = 2400;  // 이보다 큰 사진은 줄여서 읽는다 (캡처는 보통 이보다 작다)

let servicePromise = null;

async function openCache() {
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith('ledger-ocr-') && name !== CACHE_NAME) await caches.delete(name);
    }
    return await caches.open(CACHE_NAME);
  } catch {
    return null;  // 사생활 보호 모드 등에서 캐시를 못 쓰면 매번 받는다
  }
}

async function readWithProgress(res, onBytes) {
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

async function fetchFile(cache, path, onBytes) {
  const url = new URL(path, VENDOR).href;
  const hit = cache && await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OCR 파일을 받지 못했습니다: ${path} (${res.status})`);
  const buffer = await readWithProgress(res, onBytes);
  if (cache) await cache.put(url, new Response(buffer.slice(0))).catch(() => {});
  return buffer;
}

// 첫 사용이면 파일을 받는다. onProgress(받은 MB) — 이미 받아 둔 경우는 호출되지 않는다.
export function prepare(onProgress = () => {}) {
  if (!servicePromise) {
    servicePromise = (async () => {
      const cache = await openCache();
      let received = 0;
      const onBytes = n => { received += n; onProgress(received / 1e6); };
      const [wasm, detection, recognition, dictionary] = await Promise.all(
        [FILES.wasm, FILES.detection, FILES.recognition, FILES.dictionary].map(p => fetchFile(cache, p, onBytes)));
      const ort = await import('onnxruntime-web');
      ort.env.wasm.wasmPaths = new URL('ort/', VENDOR).href;
      ort.env.wasm.wasmBinary = wasm;
      ort.env.wasm.numThreads = 1;
      const { PaddleOcrService } = await import('ppu-paddle-ocr/web');
      const service = new PaddleOcrService({
        model: { detection, recognition, charactersDictionary: dictionary },
        session: { executionProviders: ['wasm'] },
      });
      await service.initialize();
      return service;
    })();
    servicePromise.catch(() => { servicePromise = null; });  // 실패하면 다음에 다시 시도
  }
  return servicePromise;
}

export async function isCached() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hits = await Promise.all(Object.values(FILES).map(p => cache.match(new URL(p, VENDOR).href)));
    return hits.every(Boolean);
  } catch {
    return false;
  }
}

// 사진 파일 → { width, height, lines: [{text, x, y, w, h}] } (서버판 ocr.ps1과 같은 모양)
export async function recognize(file, onProgress) {
  const service = await prepare(onProgress);
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(`${file.name}: 열 수 없는 사진 형식입니다`); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';  // 투명 PNG는 흰 바탕으로
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const result = await service.recognize(canvas, { noCache: true });
  const lines = [];
  for (const group of result.lines) {
    // 같은 높이라도 왼쪽(가게 이름)과 오른쪽(금액)처럼 멀리 떨어진 글자는 다른 줄로 둔다
    let current = null;
    for (const item of [...group].sort((a, b) => a.box.x - b.box.x)) {
      const b = item.box;
      if (current && b.x - (current.x + current.w) < b.height * 1.5) {
        current.text += ' ' + item.text;
        current.w = b.x + b.width - current.x;
        current.h = Math.max(current.h, b.height);
      } else {
        current = { text: item.text, x: b.x, y: b.y, w: b.width, h: b.height };
        lines.push(current);
      }
    }
  }
  return { width: canvas.width, height: canvas.height, lines };
}
