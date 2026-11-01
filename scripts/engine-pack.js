#!/usr/bin/env node
// Android engine packs: the librnllama*.so set of one ABI, zipped, listed with
// sha256 in manifest.json and signed with ed25519. The app verifies the
// manifest and files, then points RNLlama.setEnginePackDir() at them.
// Format: README.md, "Android engine packs".
//
//   engine-pack.js bridge
//   engine-pack.js pack <abi> <libDir> [htpDir] --out <dir>
//   engine-pack.js manifest --out <dir> --version <v> --llama-cpp <bNNNNN> --react-native <v> --base-url <url>
//   engine-pack.js sign <manifest>               (ENGINE_SIGNING_PRIVATE_KEY: base64 PKCS#8 DER)
//   engine-pack.js verify <manifest> <publicKeyPem>
//   engine-pack.js upload <dir> <prefix> <version> (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const packageRoot = path.resolve(__dirname, '..')
const SCHEMA = 1
const PACKAGE_NAME = '@offgrid/llama.rn'

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function listFiles(dir, filter) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return listFiles(full, filter)
      return filter(full) ? [full] : []
    })
}

// The contract the APK bakes in: Java JNI declarations and the JS API that
// calls the JSI functions. A pack is only safe under an app built from the
// same contract.
function bridgeHash(root = packageRoot) {
  const files = [
    ...listFiles(path.join(root, 'android/src/main/java'), (f) =>
      f.endsWith('.java'),
    ),
    ...listFiles(
      path.join(root, 'src'),
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !f.includes(`${path.sep}__tests__${path.sep}`) &&
        path.basename(f) !== 'version.ts',
    ),
  ]
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .sort()

  const hash = crypto.createHash('sha256')
  files.forEach((rel) => {
    hash.update(`${rel}\0`)
    hash.update(fs.readFileSync(path.join(root, rel)))
    hash.update('\0')
  })
  return hash.digest('hex')
}

function describeFile(root, rel) {
  const data = fs.readFileSync(path.join(root, rel))
  return { path: rel, sha256: sha256(data), size: data.length }
}

function pack(abi, libDir, htpDir, outDir) {
  const staging = fs.mkdtempSync(path.join(outDir, `.stage-${abi}-`))
  try {
    const libs = fs
      .readdirSync(libDir)
      .filter((name) => /^librnllama.*\.so$/.test(name))
      .sort()
    if (!libs.includes('librnllama.so') || !libs.includes('librnllama_jni.so')) {
      throw new Error(`${libDir} lacks librnllama.so or librnllama_jni.so`)
    }
    libs.forEach((name) =>
      fs.copyFileSync(path.join(libDir, name), path.join(staging, name)),
    )

    const htpLibs = htpDir
      ? fs.readdirSync(htpDir).filter((name) => name.endsWith('.so')).sort()
      : []
    if (htpLibs.length > 0) {
      fs.mkdirSync(path.join(staging, 'htp'))
      htpLibs.forEach((name) =>
        fs.copyFileSync(path.join(htpDir, name), path.join(staging, 'htp', name)),
      )
    }

    const files = [...libs, ...htpLibs.map((name) => `htp/${name}`)]
    const zipName = `engine-pack-${abi}.zip`
    const zipPath = path.resolve(outDir, zipName)
    fs.rmSync(zipPath, { force: true })
    // -X: no extra attributes; -D: no directory entries
    execFileSync('zip', ['-q', '-X', '-D', zipPath, ...files], { cwd: staging })

    const zip = fs.readFileSync(zipPath)
    const entry = {
      abi,
      file: zipName,
      sha256: sha256(zip),
      size: zip.length,
      files: files.map((rel) => describeFile(staging, rel)),
    }
    fs.writeFileSync(
      path.join(outDir, `engine-pack-${abi}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
    )
    return entry
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

function buildManifest(outDir, { version, llamaCpp, reactNative, baseUrl, bridge, createdAt }) {
  const packs = fs
    .readdirSync(outDir)
    .filter((name) => /^engine-pack-.+\.json$/.test(name))
    .sort()
    .map((name) => {
      const { file, ...entry } = JSON.parse(
        fs.readFileSync(path.join(outDir, name), 'utf8'),
      )
      return { abi: entry.abi, url: `${baseUrl}/${file}`, ...entry }
    })
  if (packs.length === 0) throw new Error(`No engine packs in ${outDir}`)

  return {
    schema: SCHEMA,
    package: PACKAGE_NAME,
    version,
    llamaCpp,
    llamaBuild: Number(llamaCpp.replace(/^b/, '')),
    bridge,
    reactNative,
    createdAt,
    packs,
  }
}

// Same key format as the desktop engine index: base64 PKCS#8 DER, or PEM.
function privateKeyFrom(value) {
  const text = value.trim()
  if (text.startsWith('-----BEGIN')) return crypto.createPrivateKey(text)
  return crypto.createPrivateKey({
    key: Buffer.from(text, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
}

function sign(manifestBytes, privateKey) {
  return crypto.sign(null, manifestBytes, privateKeyFrom(privateKey)).toString('base64')
}

function verify(manifestBytes, signatureBase64, publicKeyPem) {
  return crypto.verify(
    null,
    manifestBytes,
    publicKeyPem,
    Buffer.from(signatureBase64.trim(), 'base64'),
  )
}

// ---- R2 (S3 API, SigV4), as the desktop engine publisher does -------------
function r2Put(key, body, contentType, cacheControl) {
  const env = (name) => {
    if (!process.env[name]) throw new Error(`${name} is not set`)
    return process.env[name]
  }
  const hmac = (k, data) => crypto.createHmac('sha256', k).update(data).digest()
  const url = new URL(
    `${env('R2_ENDPOINT').replace(/\/$/, '')}/${env('R2_BUCKET')}/${key
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
  )
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = now.slice(0, 8)
  const headers = {
    'cache-control': cacheControl,
    'content-type': contentType,
    host: url.host,
    'x-amz-content-sha256': sha256(body),
    'x-amz-date': now,
  }
  const names = Object.keys(headers).sort()
  const canonical = [
    'PUT',
    url.pathname,
    '',
    ...names.map((name) => `${name}:${headers[name]}`),
    '',
    names.join(';'),
    headers['x-amz-content-sha256'],
  ].join('\n')
  const scope = `${day}/auto/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n')
  const signingKey = ['auto', 's3', 'aws4_request'].reduce(
    (k, part) => hmac(k, part),
    hmac(`AWS4${env('R2_SECRET_ACCESS_KEY')}`, day),
  )
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${env('R2_ACCESS_KEY_ID')}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
  delete headers.host
  return fetch(url, { method: 'PUT', headers, body }).then((response) => {
    if (!response.ok) throw new Error(`R2 PUT ${key}: HTTP ${response.status}`)
    console.log(`uploaded ${key}`)
  })
}

// Packs are immutable under <prefix>/<version>/; the manifest at <prefix>/
// moves last, signature first, so a reader never sees a manifest whose packs
// are missing.
async function upload(dir, prefix, version) {
  const immutable = 'public, max-age=31536000, immutable'
  const zips = fs.readdirSync(dir).filter((n) => n.endsWith('.zip')).sort()
  await zips.reduce(
    (previous, name) =>
      previous.then(() =>
        r2Put(
          `${prefix}/${version}/${name}`,
          fs.readFileSync(path.join(dir, name)),
          'application/zip',
          immutable,
        ),
      ),
    Promise.resolve(),
  )
  const manifest = fs.readFileSync(path.join(dir, 'manifest.json'))
  const signature = fs.readFileSync(path.join(dir, 'manifest.json.sig'))
  await r2Put(`${prefix}/${version}/manifest.json.sig`, signature, 'text/plain', immutable)
  await r2Put(`${prefix}/${version}/manifest.json`, manifest, 'application/json', immutable)
  await r2Put(`${prefix}/manifest.json.sig`, signature, 'text/plain', 'public, max-age=60')
  await r2Put(`${prefix}/manifest.json`, manifest, 'application/json', 'public, max-age=60')
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index === -1 || !args[index + 1]) throw new Error(`Missing ${name}`)
  return args[index + 1]
}

function main(argv) {
  const [command, ...args] = argv
  switch (command) {
    case 'bridge':
      console.log(bridgeHash())
      return
    case 'pack': {
      const positional = args.slice(0, args.indexOf('--out'))
      const [abi, libDir, htpDir] = positional
      const outDir = option(args, '--out')
      fs.mkdirSync(outDir, { recursive: true })
      const entry = pack(abi, libDir, htpDir, outDir)
      console.log(`${entry.file}: ${entry.files.length} files, ${entry.size} bytes`)
      return
    }
    case 'manifest': {
      const outDir = option(args, '--out')
      const manifest = buildManifest(outDir, {
        version: option(args, '--version'),
        llamaCpp: option(args, '--llama-cpp'),
        reactNative: option(args, '--react-native'),
        baseUrl: option(args, '--base-url').replace(/\/$/, ''),
        bridge: bridgeHash(),
        createdAt: new Date().toISOString(),
      })
      fs.writeFileSync(
        path.join(outDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
      console.log(`manifest.json: ${manifest.packs.length} packs`)
      return
    }
    case 'sign': {
      const key = process.env.ENGINE_SIGNING_PRIVATE_KEY
      if (!key) throw new Error('ENGINE_SIGNING_PRIVATE_KEY is not set')
      const manifestPath = args[0]
      fs.writeFileSync(
        `${manifestPath}.sig`,
        `${sign(fs.readFileSync(manifestPath), key)}\n`,
      )
      console.log(`${path.basename(manifestPath)}.sig written`)
      return
    }
    case 'verify': {
      const [manifestPath, publicKeyPath] = args
      const ok = verify(
        fs.readFileSync(manifestPath),
        fs.readFileSync(`${manifestPath}.sig`, 'utf8'),
        fs.readFileSync(publicKeyPath, 'utf8'),
      )
      console.log(ok ? 'signature ok' : 'signature INVALID')
      if (!ok) process.exitCode = 1
      return
    }
    case 'upload':
      return upload(args[0], args[1], args[2])
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

module.exports = { bridgeHash, pack, buildManifest, sign, verify }

if (require.main === module) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .catch((error) => {
      console.error(`engine-pack: ${error.message}`)
      process.exit(1)
    })
}
