export async function encryptDocxBytes(bytes, password) {
  if (typeof password !== 'string' || password.length < 4 || password.length > 255) {
    throw new Error('비밀번호는 4~255자로 입력해주세요.');
  }
  // ECMA-376 Agile encryption: a real Office encrypted package, not ZIP
  // password protection or the editable documentProtection flag.
  const officeCrypto = await import('officecrypto-tool');
  const { Buffer } = await import('buffer');
  const api = officeCrypto.default || officeCrypto;
  return new Uint8Array(api.encrypt(Buffer.from(bytes), { password }));
}

export async function isEncryptedDocx(file) {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => header[index] === value);
}

export async function unlockDocxForViewing(file, password) {
  try {
    const officeCrypto = await import('officecrypto-tool');
    const { Buffer } = await import('buffer');
    const api = officeCrypto.default || officeCrypto;
    const bytes = await api.decrypt(Buffer.from(await file.arrayBuffer()), { password });
    const unlocked = new File([new Uint8Array(bytes)], file.name, {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    unlocked.docPilotWasEncrypted = true;
    return unlocked;
  } catch {
    throw new Error('DOCX를 열지 못했습니다. 비밀번호와 파일을 확인해주세요.');
  }
}
