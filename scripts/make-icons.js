'use strict';

// Regenerates the macOS app icon (.icns) and the in-app header logo from a
// single source image. Run: `node scripts/make-icons.js [sourceImage]`
//
// The source is expected to be the branded badge artwork (swimmer + headphones
// over a wave) on a plain background. We trim the surrounding margin, round the
// corners with transparency, and emit Apple-grid icon sizes.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
// Source art lives in the repo so icons can be regenerated reproducibly.
const SOURCE = process.argv[2] || path.join(BUILD, 'icon-source.png');
const ICONSET = path.join(BUILD, 'icon.iconset');
const ASSETS = path.join(ROOT, 'src', 'renderer', 'assets');

// Rounded-rect alpha mask of side S with corner radius R (Apple squircle ≈ 22.4%).
function roundedMask(side) {
  const r = Math.round(side * 0.224);
  const svg = `<svg width="${side}" height="${side}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${side}" height="${side}" rx="${r}" ry="${r}" fill="#fff"/>
  </svg>`;
  return Buffer.from(svg);
}

// Trim margin -> square -> rounded transparent corners. Returns a PNG buffer
// of the badge at `side` px with no extra padding.
async function roundedBadge(side) {
  const trimmed = await sharp(SOURCE)
    .trim({ background: '#ffffff', threshold: 20 })
    .toBuffer();

  return sharp(trimmed)
    .resize(side, side, { fit: 'cover', position: 'centre' })
    .ensureAlpha()
    .composite([{ input: roundedMask(side), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('Source image not found:', SOURCE);
    process.exit(1);
  }
  fs.mkdirSync(ICONSET, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });

  // 1024 master with standard Mac transparent margin (badge ~83% of canvas).
  const CANVAS = 1024;
  const BADGE = 832;
  const margin = Math.round((CANVAS - BADGE) / 2);
  const badge = await roundedBadge(BADGE);

  const master = await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: badge, top: margin, left: margin }])
    .png()
    .toBuffer();

  // Apple .iconset members.
  const sizes = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, px] of sizes) {
    await sharp(master).resize(px, px).png().toFile(path.join(ICONSET, name));
  }

  // Compile to .icns (also keep a 512 png for the dev dock icon).
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', path.join(BUILD, 'icon.icns')]);
  await sharp(master).resize(512, 512).png().toFile(path.join(BUILD, 'icon.png'));

  // In-app header logo: tight rounded badge, no big margin.
  await sharp(await roundedBadge(256)).toFile(path.join(ASSETS, 'logo.png'));

  console.log('Generated:');
  console.log('  build/icon.icns');
  console.log('  build/icon.png (dev dock icon)');
  console.log('  src/renderer/assets/logo.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
