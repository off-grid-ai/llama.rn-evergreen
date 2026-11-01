const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  bridgeHash,
  pack,
  buildManifest,
  sign,
  verify,
} = require('../../scripts/engine-pack')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pack-test-'))
}

function writeLibs(dir, names) {
  fs.mkdirSync(dir, { recursive: true })
  names.forEach((name) => fs.writeFileSync(path.join(dir, name), `bytes of ${name}`))
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

describe('engine pack', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' })

  function makePacks() {
    const root = tempDir()
    const libDir = path.join(root, 'lib')
    const htpDir = path.join(root, 'htp')
    const outDir = path.join(root, 'dist')
    fs.mkdirSync(outDir)
    writeLibs(libDir, [
      'librnllama.so',
      'librnllama_jni.so',
      'librnllama_v8.so',
      'librnllama_jni_v8.so',
      'libc++_shared.so',
    ])
    writeLibs(htpDir, ['libggml-htp-v73.so'])
    return { root, libDir, htpDir, outDir }
  }

  it('packs only the librnllama set, plus HTP libs under htp/', () => {
    const { libDir, htpDir, outDir } = makePacks()

    const entry = pack('arm64-v8a', libDir, htpDir, outDir)

    expect(entry.files.map((f) => f.path)).toEqual([
      'librnllama.so',
      'librnllama_jni.so',
      'librnllama_jni_v8.so',
      'librnllama_v8.so',
      'htp/libggml-htp-v73.so',
    ])
    entry.files.forEach((file) => {
      const source = file.path.startsWith('htp/')
        ? path.join(htpDir, path.basename(file.path))
        : path.join(libDir, file.path)
      expect(file.sha256).toBe(sha256(fs.readFileSync(source)))
    })
    const zip = fs.readFileSync(path.join(outDir, 'engine-pack-arm64-v8a.zip'))
    expect(entry.sha256).toBe(sha256(zip))
    expect(entry.size).toBe(zip.length)
  })

  it('refuses a lib dir without the generic core and wrapper', () => {
    const { root, outDir } = makePacks()
    const partial = path.join(root, 'partial')
    writeLibs(partial, ['librnllama_v8.so', 'librnllama_jni_v8.so'])

    expect(() => pack('arm64-v8a', partial, undefined, outDir)).toThrow(
      /lacks librnllama.so/,
    )
  })

  it('lists every pack with its release URL in a manifest the public key verifies', () => {
    const { libDir, htpDir, outDir } = makePacks()
    pack('arm64-v8a', libDir, htpDir, outDir)
    pack('x86_64', libDir, undefined, outDir)

    const manifest = buildManifest(outDir, {
      version: '0.13.0-b12032',
      llamaCpp: 'b12032',
      reactNative: '0.83.1',
      baseUrl: 'https://example.test/v0.13.0-b12032',
      bridge: 'a'.repeat(64),
      createdAt: '2026-11-01T00:00:00.000Z',
    })

    expect(manifest).toMatchObject({
      schema: 1,
      package: '@offgrid/llama.rn',
      version: '0.13.0-b12032',
      llamaBuild: 12032,
      reactNative: '0.83.1',
    })
    expect(manifest.packs.map((p) => [p.abi, p.url])).toEqual([
      ['arm64-v8a', 'https://example.test/v0.13.0-b12032/engine-pack-arm64-v8a.zip'],
      ['x86_64', 'https://example.test/v0.13.0-b12032/engine-pack-x86_64.zip'],
    ])

    const bytes = Buffer.from(JSON.stringify(manifest, null, 2))
    const signature = sign(bytes, privatePem)
    expect(verify(bytes, signature, publicPem)).toBe(true)
  })

  it('rejects a manifest changed after signing', () => {
    const bytes = Buffer.from('{"version":"0.13.0-b12032"}')
    const signature = sign(bytes, privatePem)

    const tampered = Buffer.from('{"version":"0.13.0-b99999"}')
    expect(verify(tampered, signature, publicPem)).toBe(false)
  })

  it('ties the bridge hash to the Java and JS contract only', () => {
    const root = tempDir()
    const javaFile = path.join(root, 'android/src/main/java/com/rnllama/RNLlama.java')
    fs.mkdirSync(path.dirname(javaFile), { recursive: true })
    fs.writeFileSync(javaFile, 'class RNLlama {}')
    fs.mkdirSync(path.join(root, 'src/__tests__'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src/index.ts'), 'export {}')
    fs.writeFileSync(path.join(root, 'src/version.ts'), 'export const v = "b1"')
    const before = bridgeHash(root)

    fs.writeFileSync(path.join(root, 'src/version.ts'), 'export const v = "b2"')
    fs.writeFileSync(path.join(root, 'src/__tests__/a.test.ts'), 'test')
    expect(bridgeHash(root)).toBe(before)

    fs.writeFileSync(javaFile, 'class RNLlama { native void x(); }')
    expect(bridgeHash(root)).not.toBe(before)
  })
})
