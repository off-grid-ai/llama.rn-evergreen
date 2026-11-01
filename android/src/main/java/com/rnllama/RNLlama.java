package com.rnllama;

import android.os.Build;
import android.util.Log;

import com.facebook.react.bridge.ReactApplicationContext;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.InputStream;
import java.io.IOException;
import java.util.Locale;
import java.util.regex.Pattern;

public class RNLlama {
  public static final String NAME = "RNLlama";
  private static final String TAG = "RNLlama";
  private static boolean libsLoaded = false;

  // Engine pack: an app-private dir holding a verified, newer librnllama*.so set
  // (core + JNI wrapper per variant, optional htp/). The app verifies and sets it
  // before React Native starts; when unusable, the bundled libraries load.
  private static File enginePackDir = null;
  private static boolean useEnginePack = false;
  private static String nativeLibrarySource = null;
  private static String enginePackError = null;

  // HTP (Hexagon Tensor Processor) constants
  private static final int HTP_DIR_MODE = 0755;  // rwx for owner, rx for group/others
  private static final int HTP_FILE_MODE = 0755;
  private static final String HTP_DIR_NAME = "rnllama-htp";
  private static final String[] HTP_LIBS = {
    "libggml-htp-v73.so",
    "libggml-htp-v75.so",
    "libggml-htp-v79.so",
    "libggml-htp-v81.so",
    "libggml-htp-v85.so"
  };
  private static final Pattern QUALCOMM_HINT_PATTERN =
    Pattern.compile("(adreno|qcom|qualcomm|snapdragon)", Pattern.CASE_INSENSITIVE);
  private static final Pattern KNOWN_HEXAGON_SOC_PATTERN =
    Pattern.compile("\\b(SM8450|SM8550|SM8635|SM8650|SM8750|SM8845|SM8850)\\b");
  private static final Pattern SNAPDRAGON_8_SERIES_SOC_PATTERN = Pattern.compile("\\bSM8\\d{3}\\b");
  private static final Pattern SNAPDRAGON_8_SERIES_NAME_PATTERN =
    Pattern.compile("SNAPDRAGON\\s*8");
  private static final Pattern HEXAGON_CODENAME_PATTERN =
    Pattern.compile("(taro|kalama|pineapple|sun|lanai)");

  private final ReactApplicationContext reactContext;

  public RNLlama(ReactApplicationContext reactContext) {
    this.reactContext = reactContext;
  }

  /** Set before the first llama.rn install; null means bundled libraries. */
  public static synchronized void setEnginePackDir(File dir) {
    if (libsLoaded) {
      Log.w(TAG, "setEnginePackDir called after native libraries loaded; ignored");
      return;
    }
    enginePackDir = dir;
  }

  /** "pack", "bundled", or null before the native libraries load. */
  public static synchronized String getNativeLibrarySource() {
    return nativeLibrarySource;
  }

  /** Why the engine pack was not used, or null. */
  public static synchronized String getEnginePackError() {
    return enginePackError;
  }

  private static File enginePackFile(String libraryName) {
    return new File(enginePackDir, "lib" + libraryName + ".so");
  }

  // The JNI wrapper links its core by soname: rnllama_jni_<v> -> rnllama_<v>.
  private static String coreLibraryName(String jniLibraryName) {
    return jniLibraryName.replaceFirst("^rnllama_jni", "rnllama");
  }

  private static File enginePackHtpDir() {
    if (!useEnginePack) return null;
    File htpDir = new File(enginePackDir, "htp");
    for (String libName : HTP_LIBS) {
      if (!new File(htpDir, libName).isFile()) return null;
    }
    return htpDir;
  }

  // HTP library extraction and setup
  private static boolean prepareHtpDirectory(File dir, String label) {
    if (dir == null) {
      return false;
    }
    try {
      if (dir.exists()) {
        if (!dir.isDirectory()) {
          Log.w(NAME, label + " exists but is not a directory: " + dir.getAbsolutePath());
          return false;
        }
      } else {
        if (!dir.mkdirs()) {
          Log.w(NAME, "Unable to create " + label + " at " + dir.getAbsolutePath());
          return false;
        }
        File sanity = File.createTempFile("htp", ".tmp", dir);
        sanity.delete();
      }
    } catch (Exception e) {
      Log.w(NAME, "Unable to prepare " + label + " at " + dir.getAbsolutePath(), e);
      return false;
    }

    dir.setReadable(true, false);
    dir.setExecutable(true, false);
    dir.setWritable(true, true);

    try {
      android.system.Os.chmod(dir.getAbsolutePath(), HTP_DIR_MODE);
    } catch (Exception e) {
      Log.w(NAME, "Failed to chmod HTP directory " + dir.getAbsolutePath(), e);
    }

    return true;
  }

  private static File getPrivateHtpDir(android.content.Context context) {
    try {
      return context.getDir(HTP_DIR_NAME, android.content.Context.MODE_PRIVATE);
    } catch (Exception e) {
      Log.w(NAME, "Unable to access private HTP directory", e);
      return null;
    }
  }

  private static File resolveHtpDirectory(android.content.Context context) {
    File[] candidates = new File[] {
      getPrivateHtpDir(context),
      new File(context.getFilesDir(), HTP_DIR_NAME),
      context.getCodeCacheDir() != null ? new File(context.getCodeCacheDir(), HTP_DIR_NAME) : null,
      context.getCacheDir() != null ? new File(context.getCacheDir(), HTP_DIR_NAME) : null,
      context.getExternalFilesDir(null) != null ? new File(context.getExternalFilesDir(null), HTP_DIR_NAME) : null
    };

    for (File candidate : candidates) {
      if (candidate == null) continue;
      if (prepareHtpDirectory(candidate, "HTP directory candidate")) {
        return candidate;
      }
    }

    Log.w(NAME, "Unable to provision directory for Hexagon libraries; Hexagon backend will be disabled");
    return null;
  }

  private static void setHtpFilePermissions(File file) {
    file.setReadable(true, false);
    file.setExecutable(true, false);
    try {
      android.system.Os.chmod(file.getAbsolutePath(), HTP_FILE_MODE);
    } catch (Exception e) {
      Log.w(NAME, "Failed to chmod HTP library " + file.getAbsolutePath(), e);
    }
  }

  private static boolean ensureHtpLibraries(android.content.Context context, File htpDir) {
    for (String libName : HTP_LIBS) {
      File outFile = new File(htpDir, libName);

      try {
        try (InputStream in = context.getAssets().open("ggml-hexagon/" + libName);
             FileOutputStream out = new FileOutputStream(outFile)) {
          byte[] buffer = new byte[8192];
          int read;
          while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
          }
          out.flush();
        }

        setHtpFilePermissions(outFile);
        Log.d(NAME, "Extracted HTP library: " + libName);
      } catch (Exception e) {
        Log.w(NAME, "Failed to extract HTP library " + libName, e);
        return false;
      }
    }
    return true;
  }

  private static void extractHtpLibrariesFromAssets(android.content.Context context) {
    File packHtpDir = enginePackHtpDir();
    File htpDir = packHtpDir != null ? packHtpDir : resolveHtpDirectory(context);
    if (htpDir == null) {
      Log.w(NAME, "Could not resolve HTP directory; Hexagon backend will be disabled");
      return;
    }

    Log.d(NAME, "Using " + htpDir.getAbsolutePath() + " for HTP libraries");

    if (packHtpDir == null && !ensureHtpLibraries(context, htpDir)) {
      Log.w(NAME, "Could not install Hexagon libraries; Hexagon backend will be disabled");
      return;
    }

    try {
      String htpLibPath = htpDir.getAbsolutePath();
      android.system.Os.setenv("ADSP_LIBRARY_PATH", htpLibPath, true);
      android.system.Os.setenv("GGML_HEXAGON_DEVICES", "16", true);
      Log.d(NAME, "Set ADSP_LIBRARY_PATH=" + htpLibPath);
    } catch (Exception e) {
      Log.w(NAME, "Failed to set ADSP_LIBRARY_PATH", e);
    }
  }

  public static synchronized boolean loadNative(ReactApplicationContext context) {
    if (libsLoaded) return true;

    if (Build.SUPPORTED_64_BIT_ABIS.length == 0) {
      Log.w(TAG, "Only 64-bit architectures are supported");
      return false;
    }

    useEnginePack = enginePackDir != null;
    if (useEnginePack && !enginePackFile("rnllama").isFile()) {
      enginePackError = "Engine pack is missing librnllama.so: " + enginePackDir;
      Log.w(TAG, enginePackError);
      useEnginePack = false;
    }

    if (loadNativeLibraries(context)) return true;
    if (!useEnginePack) return false;

    // Best effort: libraries the pack already loaded stay in the process.
    enginePackError = "Engine pack failed to load; using bundled libraries";
    Log.w(TAG, enginePackError);
    useEnginePack = false;
    return loadNativeLibraries(context);
  }

  private static boolean loadNativeLibraries(ReactApplicationContext context) {
    // Extract HTP libraries from assets before loading native library
    try {
      extractHtpLibrariesFromAssets(context);
    } catch (Exception e) {
      Log.w(TAG, "Failed to extract HTP libraries", e);
    }

    String cpuFeatures = getCpuFeatures();
    boolean hasFp16 = cpuFeatures.contains("fp16") || cpuFeatures.contains("fphp");
    boolean hasDotProd = cpuFeatures.contains("dotprod") || cpuFeatures.contains("asimddp");
    boolean hasI8mm = cpuFeatures.contains("i8mm");

    boolean hasAdreno = hasAdrenoGpuHint();
    boolean hasHexagon = isHexagonSupported();

    try {
      boolean jniLoaded = false;
      String loadedLib = "";
      if (isArm64V8a()) {
        if (hasDotProd && hasI8mm && hasHexagon && hasAdreno) {
          if (tryLoadLibrary("rnllama_jni_v8_2_dotprod_i8mm_hexagon_opencl")) {
            jniLoaded = true;
            loadedLib = "rnllama_jni_v8_2_dotprod_i8mm_hexagon_opencl";
          }
        }

        if (!jniLoaded && hasDotProd && hasI8mm) {
          if (tryLoadLibrary("rnllama_jni_v8_2_dotprod_i8mm")) {
            jniLoaded = true;
            loadedLib = "rnllama_jni_v8_2_dotprod_i8mm";
          }
        }

        if (!jniLoaded && hasDotProd) {
          if (tryLoadLibrary("rnllama_jni_v8_2_dotprod")) {
            jniLoaded = true;
            loadedLib = "rnllama_jni_v8_2_dotprod";
          }
        }

        if (!jniLoaded && hasI8mm) {
          if (tryLoadLibrary("rnllama_jni_v8_2_i8mm")) {
            jniLoaded = true;
            loadedLib = "rnllama_jni_v8_2_i8mm";
          }
        }

        if (!jniLoaded && hasFp16) {
          if (tryLoadLibrary("rnllama_jni_v8_2")) {
            jniLoaded = true;
            loadedLib = "rnllama_jni_v8_2";
          }
        }

        if (!jniLoaded) {
          if (tryLoadLibrary("rnllama_jni_v8")) {
            jniLoaded = true;
            loadedLib = "rnllama_jni_v8";
          }
        }
      } else if (isX86_64()) {
        if (tryLoadLibrary("rnllama_jni_x86_64")) {
          jniLoaded = true;
          loadedLib = "rnllama_jni_x86_64";
        }
      } else {
        if (tryLoadLibrary("rnllama_jni")) {
          jniLoaded = true;
          loadedLib = "rnllama_jni";
        }
      }

      if (!jniLoaded) {
        // Fallback to generic JNI
        loadLibrary("rnllama_jni");
        loadedLib = "rnllama_jni";
      }

      loadLibrary("rnllama");
      nativeSetLoadedLibrary(loadedLib);
      libsLoaded = true;
      nativeLibrarySource = useEnginePack ? "pack" : "bundled";
      return true;
    } catch (UnsatisfiedLinkError e) {
      Log.e(TAG, "Failed to load native libraries", e);
      return false;
    }
  }

  private static native void nativeSetLoadedLibrary(String name);

  private static boolean isArm64V8a() {
    for (String abi : Build.SUPPORTED_ABIS) {
      if ("arm64-v8a".equalsIgnoreCase(abi)) return true;
    }
    return false;
  }

  private static boolean isX86_64() {
    for (String abi : Build.SUPPORTED_ABIS) {
      if ("x86_64".equalsIgnoreCase(abi)) return true;
    }
    return false;
  }

  private static String getCpuFeatures() {
    StringBuilder features = new StringBuilder();
    try (BufferedReader br = new BufferedReader(new FileReader("/proc/cpuinfo"))) {
      String line;
      while ((line = br.readLine()) != null) {
        String lower = line.toLowerCase(Locale.ROOT);
        if (lower.startsWith("features") || lower.startsWith("flags")) {
          int idx = lower.indexOf(':');
          if (idx != -1 && idx + 1 < lower.length()) {
            features.append(lower.substring(idx + 1).trim()).append(" ");
          }
        }
      }
    } catch (IOException ignored) {
    }
    return features.toString();
  }

  private static boolean tryLoadLibrary(String libraryName) {
    try {
      loadLibrary(libraryName);
      return true;
    } catch (UnsatisfiedLinkError ignored) {
      return false;
    }
  }

  // From the engine pack, load the core before its JNI wrapper so the wrapper's
  // soname dependency resolves to the pack's core, never the bundled one.
  private static void loadLibrary(String libraryName) {
    if (!useEnginePack) {
      System.loadLibrary(libraryName);
      return;
    }
    File wrapper = enginePackFile(libraryName);
    if (!wrapper.isFile()) {
      throw new UnsatisfiedLinkError("Engine pack has no " + wrapper.getName());
    }
    if (libraryName.startsWith("rnllama_jni")) {
      File core = enginePackFile(coreLibraryName(libraryName));
      if (!core.isFile()) {
        throw new UnsatisfiedLinkError("Engine pack has no " + core.getName());
      }
      System.load(core.getAbsolutePath());
    }
    System.load(wrapper.getAbsolutePath());
  }

  private static String lowerOrEmpty(String value) {
    return value == null ? "" : value.toLowerCase(Locale.ROOT);
  }

  private static String upperOrEmpty(String value) {
    return value == null ? "" : value.toUpperCase(Locale.ROOT);
  }

  private static boolean hasHexagonCodenameHint() {
    String hardwareHints = lowerOrEmpty(Build.HARDWARE) + " " + lowerOrEmpty(Build.BOARD);
    return HEXAGON_CODENAME_PATTERN.matcher(hardwareHints).find();
  }

  private static boolean hasQualcommDeviceHint() {
    if (hasHexagonCodenameHint()) {
      return true;
    }

    StringBuilder hints = new StringBuilder();
    hints
      .append(lowerOrEmpty(Build.HARDWARE)).append(' ')
      .append(lowerOrEmpty(Build.BOARD)).append(' ')
      .append(lowerOrEmpty(Build.MANUFACTURER)).append(' ')
      .append(lowerOrEmpty(Build.BRAND)).append(' ')
      .append(lowerOrEmpty(Build.MODEL));

    if (Build.VERSION.SDK_INT >= 31) {
      hints.append(' ')
        .append(lowerOrEmpty(Build.SOC_MANUFACTURER)).append(' ')
        .append(lowerOrEmpty(Build.SOC_MODEL));
    }

    return QUALCOMM_HINT_PATTERN.matcher(hints.toString()).find();
  }

  private static boolean hasAdrenoGpuHint() {
    if (hasQualcommDeviceHint()) {
      return true;
    }

    if (Build.VERSION.SDK_INT >= 31) {
      String socModel = upperOrEmpty(Build.SOC_MODEL);
      if (!socModel.isEmpty() && SNAPDRAGON_8_SERIES_SOC_PATTERN.matcher(socModel).find()) {
        return true;
      }
    }

    return false;
  }

  private static boolean isHexagonSupported() {
    boolean hasQualcommHint = hasQualcommDeviceHint();

    if (Build.VERSION.SDK_INT >= 31) {
      String socModel = upperOrEmpty(Build.SOC_MODEL);
      if (!socModel.isEmpty()) {
        if (KNOWN_HEXAGON_SOC_PATTERN.matcher(socModel).find()) {
          return true;
        }
        if (hasQualcommHint &&
            (SNAPDRAGON_8_SERIES_SOC_PATTERN.matcher(socModel).find() ||
             SNAPDRAGON_8_SERIES_NAME_PATTERN.matcher(socModel).find())) {
          return true;
        }
      }
    }

    return hasQualcommHint && hasHexagonCodenameHint();
  }
}
