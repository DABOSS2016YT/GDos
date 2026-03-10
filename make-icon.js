'use strict';
const fs   = require('fs');
const path = require('path');

const sizes = [16, 24, 32, 48, 64, 128, 256];

async function run() {
  let sharp;
  try { sharp = require('sharp'); } catch(_) {
    console.log('sharp not found — install with: npm install sharp');
    console.log('Then run: node make-icon.js');
    process.exit(0);
  }

  if (!fs.existsSync('icon.png')) {
    console.error('icon.png not found in current directory');
    process.exit(1);
  }

  fs.mkdirSync('build', { recursive: true });

  const buffers = [];
  for (const size of sizes) {
    const buf = await sharp('icon.png').resize(size, size).png().toBuffer();
    buffers.push({ size, buf });
    await sharp('icon.png').resize(size, size).png().toFile(path.join('build', `icon-${size}.png`));
    console.log(`  ✓ ${size}x${size}`);
  }

  buildIco(buffers);
  console.log('✓ icon.ico written');
  console.log('✓ icon.icns — use iconutil on macOS or electron-builder will handle it');
}

function buildIco(images) {
  const count  = images.length;
  const dirSize = 6 + 16 * count;
  let offset    = dirSize;

  const pngBufs = images.map(({ size, buf }) => {
    return { size, buf };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0,     0);
  header.writeUInt16LE(1,     2);
  header.writeUInt16LE(count, 4);

  const dirs = pngBufs.map(({ size, buf }) => {
    const d = Buffer.alloc(16);
    d.writeUInt8(size >= 256 ? 0 : size, 0);
    d.writeUInt8(size >= 256 ? 0 : size, 1);
    d.writeUInt8(0, 2);
    d.writeUInt8(0, 3);
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(buf.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += buf.length;
    return d;
  });

  const out = Buffer.concat([header, ...dirs, ...pngBufs.map(p => p.buf)]);
  fs.writeFileSync('icon.ico', out);
}

run().catch(e => { console.error(e.message); process.exit(1); });
