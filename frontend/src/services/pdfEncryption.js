import wasmUrl from 'pdfstudio/qpdf.wasm?url';

let toolkitPromise;

async function getToolkit() {
  toolkitPromise ||= import('pdfstudio').then(({ createPdfToolkit }) => createPdfToolkit({ wasmUrl }));
  return toolkitPromise;
}

export async function isPdfEncrypted(source) {
  return (await getToolkit()).isEncrypted(source);
}

export async function inheritPdfEncryption(sourceBytes, encryptionSource) {
  const toolkit = await getToolkit();
  const original = new Uint8Array(await encryptionSource.arrayBuffer());
  if (!(await toolkit.isEncrypted(original))) throw new Error('암호화된 원본 PDF를 찾을 수 없습니다.');
  let bytes = sourceBytes instanceof Uint8Array ? sourceBytes.slice() : new Uint8Array(sourceBytes).slice();
  if (await toolkit.isEncrypted(bytes)) bytes = await toolkit.unlock(bytes, { password: '' });

  // pdfstudio pins qpdf 0.4.0. Its runner exposes the bundled qpdf CLI, whose
  // copy-encryption option retains both passwords and every permission flag.
  return toolkit.runner.run([bytes, original], ({ dir, inputPaths, exec, fs }) => {
    const outputPath = `${dir}/inherited.pdf`;
    const result = exec([inputPaths[0], `--copy-encryption=${inputPaths[1]}`, outputPath]);
    if (result.exitCode > 1) throw new Error(result.stderr || '원본 PDF의 암호화 설정을 적용하지 못했습니다.');
    return fs.readFile(outputPath);
  });
}

export async function encryptPdfBytes(sourceBytes, password) {
  if (typeof password !== 'string' || password.length < 4) {
    throw new Error('PDF 비밀번호를 4자 이상 입력해주세요.');
  }

  const toolkit = await getToolkit();
  let bytes = sourceBytes instanceof Uint8Array
    ? sourceBytes.slice()
    : new Uint8Array(sourceBytes).slice();
  if (await toolkit.isEncrypted(bytes)) {
    // A source that opens with an empty user password can be re-encrypted with
    // the user's new password. Password-protected inputs are rejected here.
    bytes = await toolkit.unlock(bytes, { password: '' });
  }
  return toolkit.lock(bytes, {
    userPassword: password,
    ownerPassword: password,
    keyLength: 256
  });
}
