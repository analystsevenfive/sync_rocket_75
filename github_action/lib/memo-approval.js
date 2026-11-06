const path = require('path');
const sharp = require('sharp');

const STICKER_PATH = path.join(__dirname, '..', 'assets', 'approval-sticker.png');
const AVATAR_PATH = path.join(__dirname, '..', 'assets', 'approver-avatar.png');
const AVATAR_TEMPLATE_WIDTH = 28;
const TEMPLATE_WIDTH = 32;
const WIDTH_FRACTIONS = [];
for (let f = 0.1; f <= 0.75; f *= 1.14) WIDTH_FRACTIONS.push(f);
const MIN_VISIBLE = 0.6;
const STRIDE = 2;
// PDF จริง 12 ใบ: มีสติกเกอร์ได้ 0.70-0.94 ส่วนรูปที่ไม่มีได้ไม่เกิน 0.52
const MATCH_THRESHOLD = 0.6;
// รูปโปรไฟล์ผู้อนุมัติได้ 0.92-0.98 ส่วนคนอื่นที่ใช้สติกเกอร์เดียวกันได้ 0.58
const AVATAR_THRESHOLD = 0.8;

function extractJpegs(pdf) {
  const text = pdf.toString('latin1');
  const jpegs = [];
  for (const match of text.matchAll(/\/Filter\s*\/DCTDecode[\s\S]{0,120}?\/Length\s+(\d+)[\s\S]{0,40}?stream\r?\n/g)) {
    const start = match.index + match[0].length;
    jpegs.push(pdf.subarray(start, start + Number(match[1])));
  }
  return jpegs;
}

const templates = new Map();
function loadTemplate(file, templateWidth) {
  if (!templates.has(file)) templates.set(file, (async () => {
    const { data, info } = await sharp(file).resize({ width: templateWidth })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const points = [];
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (data[i + 3] >= 200) points.push([x, y, data[i], data[i + 1], data[i + 2]]);
    }
    return { width: info.width, height: info.height, points };
  })());
  return templates.get(file);
}

function scoreAt(pixels, width, height, template, ox, oy) {
  let n = 0, sa = 0, sb = 0, sc = 0, ta = 0, tb = 0, tc = 0;
  const { points } = template;
  const used = [];
  for (let k = 0; k < points.length; k++) {
    const p = points[k], x = ox + p[0], y = oy + p[1];
    if (y >= height || x >= width) continue;
    const i = (y * width + x) * 3;
    used.push(k, pixels[i], pixels[i + 1], pixels[i + 2]);
    sa += pixels[i]; sb += pixels[i + 1]; sc += pixels[i + 2];
    ta += p[2]; tb += p[3]; tc += p[4];
    n++;
  }
  if (n < points.length * MIN_VISIBLE) return -1;
  sa /= n; sb /= n; sc /= n; ta /= n; tb /= n; tc /= n;
  let dot = 0, ss = 0, tt = 0;
  for (let u = 0; u < used.length; u += 4) {
    const p = points[used[u]];
    const a = used[u + 1] - sa, b = used[u + 2] - sb, c = used[u + 3] - sc;
    const d = p[2] - ta, e = p[3] - tb, f = p[4] - tc;
    dot += a * d + b * e + c * f; ss += a * a + b * b + c * c; tt += d * d + e * e + f * f;
  }
  return ss && tt ? dot / Math.sqrt(ss * tt) : -1;
}

async function findSticker(jpeg) {
  const template = await loadTemplate(STICKER_PATH, TEMPLATE_WIDTH);
  const image = sharp(jpeg);
  const { channels } = await image.stats();
  if (channels.every(channel => channel.stdev < 1)) return { score: -1 }; // หน้าพื้นหลังเปล่าของฟอร์ม
  const { width: sourceWidth } = await image.metadata();
  let best = { score: -1 };
  for (const fraction of WIDTH_FRACTIONS) {
    const { data, info } = await image.clone().resize({ width: Math.round(TEMPLATE_WIDTH / fraction) })
      .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const maxY = info.height - Math.ceil(template.height * MIN_VISIBLE);
    const maxX = info.width - template.width;
    for (let y = 0; y <= maxY; y += STRIDE) for (let x = 0; x <= maxX; x += STRIDE) {
      const score = scoreAt(data, info.width, info.height, template, x, y);
      if (score <= best.score) continue;
      const scale = sourceWidth / info.width;
      best = { score, left: x * scale, top: y * scale, width: template.width * scale, height: template.height * scale };
    }
  }
  return best;
}

// รูปโปรไฟล์อยู่ด้านซ้ายบนของสติกเกอร์เสมอ และขนาดแปรตามสติกเกอร์ จึงค้นแค่บริเวณนั้น
async function matchAvatar(jpeg, sticker) {
  const template = await loadTemplate(AVATAR_PATH, AVATAR_TEMPLATE_WIDTH);
  const { width: sourceWidth, height: sourceHeight } = await sharp(jpeg).metadata();
  const left = Math.max(0, Math.round(sticker.left - 0.5 * sticker.width));
  const top = Math.max(0, Math.round(sticker.top - 0.4 * sticker.width));
  const right = Math.min(sourceWidth, Math.round(sticker.left + 0.2 * sticker.width));
  const bottom = Math.min(sourceHeight, Math.round(sticker.top + 0.35 * sticker.width));
  let best = -1;
  for (let diameter = 0.1; diameter <= 0.26; diameter *= 1.08) {
    const factor = AVATAR_TEMPLATE_WIDTH / (diameter * sticker.width);
    const { data, info } = await sharp(jpeg).extract({ left, top, width: right - left, height: bottom - top })
      .resize({ width: Math.round((right - left) * factor) }).removeAlpha().toColourspace('srgb')
      .raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y + template.height <= info.height; y++) for (let x = 0; x + template.width <= info.width; x++) {
      best = Math.max(best, scoreAt(data, info.width, info.height, template, x, y));
    }
  }
  return best;
}

async function checkApproval(pdf) {
  let stickerFound = false;
  for (const jpeg of extractJpegs(pdf)) {
    const sticker = await findSticker(jpeg);
    if (sticker.score < MATCH_THRESHOLD) continue;
    if (await matchAvatar(jpeg, sticker) >= AVATAR_THRESHOLD) return 'approved';
    stickerFound = true;
  }
  return stickerFound ? 'other-sender' : 'no-sticker';
}

module.exports = { extractJpegs, checkApproval };
