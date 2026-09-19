import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, '..');
const projectRoot = path.resolve(frontendDir, '..');
const jreExecutable = path.join(frontendDir, 'runtime', 'jre', 'bin', 'java.exe');
const targetDir = path.join(projectRoot, 'target');

const errors = [];

if (!existsSync(jreExecutable)) {
  errors.push(
    'JRE가 없습니다. Windows portable 빌드를 위해 frontend/runtime/jre/bin/java.exe가 필요합니다.'
  );
}

const backendJars = existsSync(targetDir)
  ? readdirSync(targetDir).filter((name) => name.endsWith('.jar') && !name.startsWith('original-'))
  : [];

if (backendJars.length === 0) {
  errors.push('backend jar가 없습니다. 프로젝트 루트에서 mvn clean package를 먼저 실행하세요.');
}

if (errors.length > 0) {
  console.error('DocPilot portable 빌드 사전 점검 실패:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log('DocPilot portable 빌드 사전 점검 통과');
  console.log(`- backend jar: ${backendJars[0]}`);
  console.log('- Windows x64 JRE: 준비됨');
}
