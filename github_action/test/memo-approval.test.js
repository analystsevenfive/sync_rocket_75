const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const sharp = require('sharp');
const { extractJpegs, checkApproval } = require('../lib/memo-approval');

const STICKER = path.join(__dirname, '..', 'assets', 'approval-sticker.png');
const AVATAR = path.join(__dirname, '..', 'assets', 'approver-avatar.png');

function fakePdf(...jpegs) {
  const parts = [Buffer.from('%PDF-1.3\n', 'latin1')];
  for (const jpeg of jpegs) {
    parts.push(Buffer.from(`<</Type /XObject /Subtype /Image /Filter /DCTDecode /Length ${jpeg.length}>>\nstream\n`, 'latin1'),
      jpeg, Buffer.from('\nendstream\n', 'latin1'));
  }
  return Buffer.concat(parts);
}

async function chatImage(background, sticker) {
  const base = sharp({ create: { width: 500, height: 900, channels: 3, background } });
  if (sticker) {
    const input = await sharp(STICKER).resize({ width: sticker.width }).png().toBuffer();
    const avatar = sticker.avatar === false
      ? await sharp({ create: { width: 34, height: 34, channels: 3, background: '#3a7' } }).png().toBuffer()
      : await sharp(AVATAR).resize({ width: 34 }).png().toBuffer();
    base.composite([{ input, left: 100, top: sticker.top }, { input: avatar, left: 50, top: sticker.top - 10 }]);
  }
  return base.jpeg({ quality: 80 }).toBuffer();
}

test('every JPEG stream is pulled out of the PDF intact', async () => {
  const first = await chatImage('#ffffff'), second = await chatImage('#000000');
  const jpegs = extractJpegs(fakePdf(first, second));
  assert.equal(jpegs.length, 2);
  assert.ok(jpegs[0].equals(first) && jpegs[1].equals(second));
});

for (const [name, background] of [['dark', '#23272b'], ['pink', '#fff0f5'], ['blue', '#8fb0dc']]) {
  test(`approval from Virat 75 is found on a ${name} chat background`, async () => {
    const jpeg = await chatImage(background, { width: 200, top: 500 });
    assert.equal(await checkApproval(fakePdf(jpeg)), 'approved');
  });
}

test('approval is found when the bottom is cut off by the screenshot', async () => {
  const jpeg = await chatImage('#fff0f5', { width: 200, top: 750 });
  assert.equal(await checkApproval(fakePdf(jpeg)), 'approved');
});

test('the same sticker from another profile picture is not an approval', async () => {
  const jpeg = await chatImage('#fff0f5', { width: 200, top: 500, avatar: false });
  assert.equal(await checkApproval(fakePdf(jpeg)), 'other-sender');
});

test('blank and sticker-free attachments are not approved', async () => {
  const blank = await chatImage('#ffffff');
  const noise = await sharp({ create: { width: 400, height: 700, channels: 3, background: '#fff', noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg().toBuffer();
  assert.equal(await checkApproval(fakePdf(blank, noise)), 'no-sticker');
  assert.equal(await checkApproval(fakePdf()), 'no-sticker');
});
