import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '../public/fonts');

const downloads = [
  {
    name: 'NotoSansKR-Regular.ttf',
    url: 'https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf'
  },
  {
    name: 'NanumGothic-Regular.ttf',
    url: 'https://github.com/google/fonts/raw/main/ofl/nanumgothic/NanumGothic-Regular.ttf'
  },
  {
    name: 'NanumMyeongjo-Regular.ttf',
    url: 'https://github.com/google/fonts/raw/main/ofl/nanummyeongjo/NanumMyeongjo-Regular.ttf'
  },
  {
    name: 'OFL-NotoSansKR.txt',
    url: 'https://github.com/notofonts/noto-cjk/raw/main/LICENSE'
  },
  {
    name: 'OFL-Nanum.txt',
    url: 'https://github.com/google/fonts/raw/main/ofl/nanumgothic/OFL.txt'
  }
];

await mkdir(outputDir, { recursive: true });

for (const item of downloads) {
  try {
    const response = await fetch(item.url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const outputPath = resolve(outputDir, item.name);

    await writeFile(outputPath, bytes);
    console.log(`[download-fonts] saved ${item.name}`);
  } catch (error) {
    console.warn('[download-fonts] failed:', {
      name: item.name,
      url: item.url,
      error
    });
  }
}

console.log('[download-fonts] done');
