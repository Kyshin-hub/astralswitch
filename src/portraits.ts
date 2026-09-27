// Détourage automatique des portraits sans transparence (jpg…) :
// on efface le fond blanc connecté aux bords (remplissage par diffusion),
// ce qui préserve les reflets blancs à l'intérieur de l'image.

const cache = new Map<string, Promise<string>>();

const HARD = 238; // au-dessus : fond → transparent
const SOFT = 205; // entre SOFT et HARD : bord adouci

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Recadre en carré sur le contenu visible (les emblèmes ont souvent beaucoup de marge). */
function trimToContent(canvas: HTMLCanvasElement, px: Uint8ClampedArray): string {
  const { width: w, height: h } = canvas;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return canvas.toDataURL("image/png");
  const side = Math.ceil(Math.max(x1 - x0, y1 - y0) * 1.06) + 2;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const out = document.createElement("canvas");
  out.width = out.height = Math.min(side, 256);
  out.getContext("2d")!.drawImage(canvas, cx - side / 2, cy - side / 2, side, side, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

async function cutout(src: string, removeWhite: boolean): Promise<string> {
  const img = await load(src);
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const light = (i: number) => Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);

  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (!seen[i] && light(i) >= SOFT) { seen[i] = 1; stack.push(i); } };
  if (removeWhite) {
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  }

  while (stack.length) {
    const i = stack.pop()!;
    const l = light(i);
    // Blanc franc : transparent. Zone de transition : alpha progressif.
    px[i * 4 + 3] = l >= HARD ? 0 : Math.round((255 * (HARD - l)) / (HARD - SOFT));
    if (l < HARD) continue; // on ne se propage qu'à travers le vrai fond
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  ctx.putImageData(data, 0, 0);
  return trimToContent(canvas, px);
}

const EXTENSIONS = ["png", "webp", "jpg", "jpeg"];
const resolved = new Map<string, Promise<string | null>>();

async function resolve(key: string): Promise<string | null> {
  for (const ext of EXTENSIONS) {
    const src = `/classes/${key}.${ext}`;
    try {
      // PNG/WebP : transparence déjà présente, on recadre seulement
      let p = cache.get(src);
      if (!p) { p = cutout(src, ext !== "png" && ext !== "webp"); cache.set(src, p); }
      return await p;
    } catch {
      // fichier absent : extension suivante
    }
  }
  return null;
}

/** URL du portrait d'une classe (détouré si besoin, mis en cache), ou null s'il n'y en a pas. */
export function portraitFor(key: string): Promise<string | null> {
  let p = resolved.get(key);
  if (!p) { p = resolve(key); resolved.set(key, p); }
  return p;
}
