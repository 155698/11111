// Converts a single 256x256 PNG into a valid .ico (PNG-compressed entry).
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const dst = process.argv[3] || src.replace(/\.png$/i, '.ico');

const png = fs.readFileSync(src);

// ICO header: reserved(2) type(2) count(2)
const count = 1;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type: icon
header.writeUInt16LE(count, 4);

// Directory entry (16 bytes each)
const entry = Buffer.alloc(16);
entry[0] = 0;                    // width (0 = 256)
entry[1] = 0;                    // height (0 = 256)
entry[2] = 0;                    // colors
entry[3] = 0;                    // reserved
entry.writeUInt16LE(1, 4);       // planes
entry.writeUInt16LE(32, 6);      // bpp
entry.writeUInt32LE(png.length, 8);  // size (with PNG data offset below)
entry.writeUInt32LE(6 + 16 * count, 12); // offset of image data

fs.writeFileSync(dst, Buffer.concat([header, entry, png]));
console.log('ICO written:', dst, png.length, 'bytes');