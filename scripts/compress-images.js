// scripts/compress-images.js
// Automatically compresses all JPG and PNG images in /images
// - JPGs  → re-compressed at quality 80 (photos — stays JPG)
// - PNGs  → converted to WebP (massive savings, universally supported)
// - Already-compressed files are skipped (safe to re-run anytime)
// - Originals backed up to /images/originals/ before overwriting

const sharp  = require('sharp');
const fs     = require('fs');
const path   = require('path');

const IMAGES_DIR   = path.join(__dirname, '..', 'images');
const BACKUP_DIR   = path.join(IMAGES_DIR, 'originals');
const JPG_QUALITY  = 80;
const PNG_QUALITY  = 80;
const SKIP_UNDER_BYTES = 150 * 1024;

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function getImageFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath === BACKUP_DIR) continue;
      results = results.concat(getImageFiles(fullPath));
    } else if (/\.(jpe?g|png)$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

async function compress(filePath) {
  const stat     = fs.statSync(filePath);
  const ext      = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);
  const isJpg    = /\.jpe?g$/i.test(ext);
  const isPng    = ext === '.png';

  if (stat.size < SKIP_UNDER_BYTES) {
    console.log(`⏭  Skipped (already small): ${basename} (${kb(stat.size)} KB)`);
    return;
  }

  const backupPath = path.join(BACKUP_DIR, basename);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`💾 Backed up: ${basename}`);
  }

  try {
    if (isJpg) {
      const compressed = await sharp(filePath)
        .jpeg({ quality: JPG_QUALITY, mozjpeg: true })
        .toBuffer();
      if (compressed.length < stat.size) {
        fs.writeFileSync(filePath, compressed);
        console.log(`✅ JPG compressed: ${basename} ${kb(stat.size)} KB → ${kb(compressed.length)} KB (saved ${pct(stat.size, compressed.length)}%)`);
      } else {
        console.log(`⏭  Skipped (already optimal): ${basename}`);
      }
    } else if (isPng) {
      const webpPath = filePath.replace(/\.png$/i, '.webp');
      const compressed = await sharp(filePath)
        .webp({ quality: PNG_QUALITY })
        .toBuffer();
      if (compressed.length < stat.size) {
        fs.writeFileSync(webpPath, compressed);
        fs.unlinkSync(filePath);
        console.log(`✅ PNG→WebP: ${basename} ${kb(stat.size)} KB → ${kb(compressed.length)} KB (saved ${pct(stat.size, compressed.length)}%)`);
      } else {
        console.log(`⏭  Skipped (WebP not smaller): ${basename}`);
      }
    }
  } catch (err) {
    console.error(`❌ Failed: ${basename} — ${err.message}`);
  }
}

function kb(bytes)          { return (bytes / 1024).toFixed(1); }
function pct(before, after) { return (((before - after) / before) * 100).toFixed(0); }

async function main() {
  const files = getImageFiles(IMAGES_DIR);
  if (!files.length) { console.log('No JPG or PNG files found in /images.'); return; }
  console.log(`\n🔍 Found ${files.length} image(s) to process...\n`);
  for (const file of files) await compress(file);
  console.log('\n✨ Done! All images processed.');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
