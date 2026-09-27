import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, '..');
const releaseDir = path.join(frontendDir, 'release');
const unpackedDir = path.join(releaseDir, 'win-unpacked');
const outputZip = path.join(releaseDir, 'DocPilot-win-unpacked.zip');

if (!existsSync(unpackedDir)) {
  console.error(`win-unpacked 폴더를 찾을 수 없습니다: ${unpackedDir}`);
  process.exit(1);
}

try {
  // Run from release so the archive contains a portable win-unpacked folder.
  execFileSync('zip', ['-r', '-FS', outputZip, 'win-unpacked'], {
    cwd: releaseDir,
    stdio: 'inherit'
  });
  console.log(`Created ${outputZip}`);
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('zip 명령을 찾을 수 없습니다. Codespaces/Linux에 zip 패키지를 설치해주세요.');
  } else {
    console.error(`win-unpacked ZIP 생성에 실패했습니다: ${error.message}`);
  }
  process.exit(error.status || 1);
}
