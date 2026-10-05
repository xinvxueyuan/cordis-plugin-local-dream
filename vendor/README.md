# Vendored Android platform-tools

This directory contains a copy of Google's official **Android SDK platform-tools**
(the `adb` host binary for each supported desktop platform, plus the two Windows
helper DLLs and the upstream `NOTICE.txt`), so the plugin can talk to a
USB-connected Android device even on machines that have **no Android SDK
installed**.

Nothing here is built or patched: the files are extracted verbatim from the
official archives by `scripts/vendor-platform-tools.mjs`.

## Contents

| Path | Platform | Notes |
| --- | --- | --- |
| `platform-tools/win32-x64/adb.exe` | Windows x64 | requires both DLLs in the same directory |
| `platform-tools/win32-x64/AdbWinApi.dll` | Windows x64 | Windows USB API shim |
| `platform-tools/win32-x64/AdbWinUsbApi.dll` | Windows x64 | Windows USB driver shim |
| `platform-tools/win32-x64/NOTICE.txt` | Windows x64 | upstream attribution |
| `platform-tools/linux-x64/adb` | Linux x64 | mode `0755` |
| `platform-tools/linux-x64/NOTICE.txt` | Linux x64 | upstream attribution |
| `platform-tools/darwin/adb` | macOS (x86_64 + arm64) | universal binary, mode `0755` |
| `platform-tools/darwin/NOTICE.txt` | macOS | upstream attribution |
| `platform-tools/version.json` | — | provenance: sources, timestamp, version, SHA-256 per file |

`adb.exe` will not start unless `AdbWinApi.dll` and `AdbWinUsbApi.dll` sit next
to it, which is why all three live in `win32-x64/`. The macOS `adb` is a single
universal binary, so one `darwin/` directory serves both Intel and Apple
Silicon.

## Upstream sources

Downloaded from the official Google Android repository (no mirror, no CDN
rewrite):

- https://dl.google.com/android/repository/platform-tools-latest-windows.zip
- https://dl.google.com/android/repository/platform-tools-latest-linux.zip
- https://dl.google.com/android/repository/platform-tools-latest-darwin.zip

## Resolved version

```
Android Debug Bridge version 1.0.41
Version 37.0.1-15733141
```

See `platform-tools/version.json` for the exact per-file SHA-256 digests and the
retrieval timestamp.

## Refreshing

```sh
node scripts/vendor-platform-tools.mjs --force
```

The script is dependency-free Node ESM (Node >= 20) and contains its own minimal
ZIP reader, so it works on Windows, macOS and Linux without `unzip`, `tar` or
`Expand-Archive`. Without `--force` it skips files that are already present;
`--platform win32-x64|linux-x64|darwin|all` limits the run (default `all`).
Extraction verifies each entry's CRC-32 before writing, and every written file
is hashed into `version.json`.

## Which adb the plugin actually uses

This copy is a **fallback only**. The plugin resolves `adb` in this order:

1. the explicit `adbPath` configuration option,
2. `$ANDROID_HOME/platform-tools/adb[.exe]`,
3. `$ANDROID_SDK_ROOT/platform-tools/adb[.exe]`,
4. `adb` on `PATH`,
5. this vendored copy.

A system adb always wins when one is found, so a developer with a full Android
SDK keeps using their own (and its matching adb server). The vendored binaries
exist for the USB transport path on machines where steps 1–4 find nothing.

## Attribution and licence

These binaries are unmodified files from Google's **Android SDK platform-tools**
distribution. They are redistributed here under the terms that apply to that
distribution; the upstream `NOTICE.txt` shipped inside each archive is vendored
alongside the binary it belongs to (`win32-x64/NOTICE.txt`,
`linux-x64/NOTICE.txt`, `darwin/NOTICE.txt`). Android, adb and platform-tools
are trademarks of Google LLC; this project is not affiliated with or endorsed by
Google.

## Packaging note

`vendor/` must be shipped with the published package (add it to
`package.json#files`) — the fallback is useless if the directory is left out of
the tarball.

## Size

Total size of `vendor/` (including this file and `version.json`):
**41,429,314 bytes ≈ 39.51 MiB**.
