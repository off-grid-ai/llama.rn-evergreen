# llama.rn-evergreen

[![Nightly](https://github.com/off-grid-ai/llama.rn-evergreen/actions/workflows/nightly.yml/badge.svg)](https://github.com/off-grid-ai/llama.rn-evergreen/actions/workflows/nightly.yml)
[![llama.cpp](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Foff-grid-ai%2Fllama.rn-evergreen%2Fmain%2Fpackage.json&query=%24.offgrid.llamaCpp&label=llama.cpp)](https://github.com/ggml-org/llama.cpp/releases)
[![npm](https://img.shields.io/npm/v/@ogai/llama.rn.svg)](https://www.npmjs.com/package/@ogai/llama.rn)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run the newest open models on iPhone and Android, the day llama.cpp supports them.

`@ogai/llama.rn` is a React Native binding for [llama.cpp](https://github.com/ggml-org/llama.cpp) that never falls behind. Every night it moves to the newest llama.cpp release, builds and tests it, and publishes it. Off Grid AI builds its mobile app on it.

## Why it exists

New model architectures land in llama.cpp almost daily. A React Native app only gets them when its binding ships a release. This package closes that gap:

- **Newest llama.cpp, every night.** The nightly syncs to the newest `bNNNNN` release. When llama.cpp adds an architecture (LFM3, for example), the package supports it within a day.
- **Nothing to compile.** Each release ships prebuilt Android libraries and the iOS `rnllama.xcframework`. Install downloads them and verifies their SHA-256.
- **Android engine updates without an app update.** Each release also ships signed engine packs. Your app can download a newer engine, verify it and load it, and fall back to the bundled engine if it fails. iOS cannot load downloaded code, so iOS apps get new engines through app releases.
- **Tested every night.** Each night runs the C++ tests, Jest and the TypeScript build, and builds Android and iOS. A broken step opens a pull request that names it.

## Install

```sh
npm install llama.rn@npm:@ogai/llama.rn
```

Use the same alias with yarn, pnpm or bun (`yarn add llama.rn@npm:@ogai/llama.rn`). The package installs under the name `llama.rn`, so your imports are `from 'llama.rn'`.

**Coming from llama.rn?** Replace that one dependency with the line above. Your code does not change.

React Native's New Architecture is required.

### Native binaries

Install runs `install/download-native-artifacts.js`. It:

- downloads the prebuilt binaries for the installed version from Cloudflare R2 (`https://mobile-runtime.getoffgridai.co/native/`), and from the GitHub Release if R2 fails;
- verifies each archive's SHA-256 before it extracts it;
- keeps verified archives in `~/.cache/ogai-llama.rn/<version>/` (set `LLAMA_RN_ARTIFACT_CACHE` to change it), so a reinstall downloads nothing;
- downloads Android binaries everywhere and iOS binaries on macOS only (set `LLAMA_RN_PLATFORMS=android,ios` to change it).

With Bun, add the package to `trustedDependencies` so install scripts run, or run the downloader yourself before `npx pod-install` or your Android build:

```sh
node ./node_modules/llama.rn/install/download-native-artifacts.js
```

### iOS

Run `npx pod-install`. To build from source instead of using the prebuilt framework, set `RNLLAMA_BUILD_FROM_SOURCE=1` in your Podfile.

### Android

If ProGuard is on, add this to `android/app/proguard-rules.pro`:

```proguard
-keep class com.rnllama.** { *; }
```

To build from source instead of using the prebuilt libraries, set `rnllamaBuildFromSource=true` in `android/gradle.properties`.

GPU (OpenCL) and NPU (Hexagon) setup is in the [API reference](docs/API.md#features).

### Expo

Add the config plugin under the name `llama.rn`:

```js
plugins: [
  ['llama.rn', { enableEntitlements: true, entitlementsProfile: 'production', forceCxx20: true, enableOpenCL: true }],
]
```

The values shown are the defaults. You also need `expo-build-properties`.

## Quick start

```js
import { initLlama } from 'llama.rn'

const context = await initLlama({
  model: 'file:///path/to/model.gguf',
  n_ctx: 4096,
  n_gpu_layers: 99, // offload to Metal on iOS
})

const result = await context.completion(
  { messages: [{ role: 'user', content: 'Hello!' }], n_predict: 256 },
  (data) => console.log(data.token), // streamed tokens
)
console.log(result.text)

await context.release()
```

Vision and audio models, tool calling, grammars, embeddings, rerank, parallel decoding, speculative decoding and text-to-speech are in the [API reference](docs/API.md).

## Versions

Versions are `<llama.rn base>-<llama.cpp tag>`, for example `0.13.0-b12032` is built on llama.cpp `b12032`. A `.N` suffix is a rebuild on the same llama.cpp tag. `latest` on npm is always the newest nightly that passed every test.

## Android engine packs

An engine pack is the full set of `librnllama*.so` files for one Android ABI. It has every CPU variant, and on arm64-v8a it also has the Hexagon libraries under `htp/`. A pack fits only an app built on the same React Native version and the same package bridge, so the manifest records both.

**Where to get them.**

- `https://mobile-runtime.getoffgridai.co/android/manifest.json` and `manifest.json.sig` describe the newest release.
- `https://mobile-runtime.getoffgridai.co/android/<version>/` holds one release's packs and manifest. These files never change.
- Each GitHub Release carries the same files and `engine-signing-public-key.pem`.

**manifest.json** (schema 1):

```json
{
  "schema": 1,
  "package": "@ogai/llama.rn",
  "version": "0.13.0-b12032",
  "llamaCpp": "b12032",
  "llamaBuild": 12032,
  "bridge": "<sha256 hex>",
  "reactNative": "0.83.1",
  "createdAt": "2026-11-01T00:00:00.000Z",
  "packs": [
    {
      "abi": "arm64-v8a",
      "url": "https://mobile-runtime.getoffgridai.co/android/0.13.0-b12032/engine-pack-arm64-v8a.zip",
      "sha256": "<sha256 hex of the zip>",
      "size": 12345678,
      "files": [
        { "path": "librnllama_v8_2_dotprod_i8mm.so", "sha256": "<hex>", "size": 123 },
        { "path": "librnllama_jni_v8_2_dotprod_i8mm.so", "sha256": "<hex>", "size": 123 },
        { "path": "htp/libggml-htp-v73.so", "sha256": "<hex>", "size": 123 }
      ]
    }
  ]
}
```

- `manifest.json.sig` is a base64 Ed25519 signature over the exact bytes of `manifest.json`.
- The public key (Ed25519, raw 32 bytes, base64) is `c4nGAstb9RSHmeFnP8n+4kEoR85a2V01N34jQKzl/iQ=`. The package also ships it as `install/engine-signing-public-key.pem`.
- `bridge` is a hash of the Java and JS sources an APK bakes in. Your installed package has its own value in `package.json` as `offgrid.engineBridge`.
- `reactNative` is the exact React Native version the packs were built against.

**Accept a pack only when** all of these hold:

1. The signature verifies with the pinned key.
2. `package`, `bridge` and `reactNative` match your app exactly.
3. `version` is newer than the engine your app runs.
4. The zip's SHA-256 matches.
5. After extraction to a staging directory, there are no extra files, no missing files and no `..` paths, and every file's SHA-256 matches `files`.

Then move the directory into app-private storage in one atomic step.

**Load it** (Java, `com.rnllama.RNLlama`):

```java
// In Application.onCreate, before React Native starts. Pass null for the bundled engine.
RNLlama.setEnginePackDir(new File(getFilesDir(), "llama-engines/0.13.0-b12032/arm64-v8a"));

// After llama.rn initialises:
RNLlama.getNativeLibrarySource(); // "pack", "bundled", or null if not loaded yet
RNLlama.getEnginePackError();     // null, or why the pack was not used
```

The loader picks the CPU variant as usual and loads it from the pack. If any pack library fails to load, it records the error and loads the bundled engine for this launch. Your app should then delete that pack.

## Contributing

Open issues and pull requests on [off-grid-ai/llama.rn-evergreen](https://github.com/off-grid-ai/llama.rn-evergreen). Fixes that are not specific to this fork also go upstream to llama.rn. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Credits and license

Built on [llama.rn](https://github.com/mybigday/llama.rn) by BRICKS (Jhen-Jie Hong and contributors) and on [llama.cpp](https://github.com/ggml-org/llama.cpp) by ggml-org. Both are MIT licensed.

MIT. [LICENSE](LICENSE) keeps llama.rn's notice, and [NOTICE](NOTICE) lists the licences of the vendored code.
