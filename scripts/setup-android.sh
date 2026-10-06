#!/usr/bin/env bash
set -eu

# Official HTTPS repositories and their checksums remain enabled.
GREENTAXI_TOOL_ROOT=${GREENTAXI_TOOL_ROOT:-/workspace/.greentaxi-tools}
export ANDROID_HOME="$GREENTAXI_TOOL_ROOT/android-sdk"
export ANDROID_USER_HOME="$GREENTAXI_TOOL_ROOT/android-user"
export GRADLE_USER_HOME="$GREENTAXI_TOOL_ROOT/gradle-user"
mkdir -p "$GREENTAXI_TOOL_ROOT/downloads" "$ANDROID_HOME" "$ANDROID_USER_HOME" "$GRADLE_USER_HOME"
if [ ! -x "$GREENTAXI_TOOL_ROOT/jdk21/bin/jlink" ]; then
  curl --fail --location --silent --show-error 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz' --output "$GREENTAXI_TOOL_ROOT/downloads/jdk21.tar.gz"
  curl --fail --location --silent --show-error 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz.sha256.txt' --output "$GREENTAXI_TOOL_ROOT/downloads/jdk21.sha256"
  python3 - "$GREENTAXI_TOOL_ROOT/downloads" <<'PY'
import hashlib, pathlib, re, sys
base = pathlib.Path(sys.argv[1])
expected = (base / 'jdk21.sha256').read_text().split()[0]
if not re.fullmatch(r'[0-9a-f]{64}', expected):
    raise SystemExit('Invalid official JDK checksum')
actual = hashlib.file_digest((base / 'jdk21.tar.gz').open('rb'), 'sha256').hexdigest()
if actual != expected:
    raise SystemExit('JDK SHA256 verification failed')
print('JDK SHA256 verified')
PY
  mkdir -p "$GREENTAXI_TOOL_ROOT/jdk21"
  tar -xzf "$GREENTAXI_TOOL_ROOT/downloads/jdk21.tar.gz" --strip-components=1 -C "$GREENTAXI_TOOL_ROOT/jdk21"
fi
export JAVA_HOME="$GREENTAXI_TOOL_ROOT/jdk21"
export PATH="$JAVA_HOME/bin:$PATH"
python3 "$(dirname "$0")/configure-gradle-network.py"
if [ -f "$GREENTAXI_TOOL_ROOT/java-cacerts" ]; then
  export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djavax.net.ssl.trustStore=$GREENTAXI_TOOL_ROOT/java-cacerts"
fi
GREENTAXI_SDK_PROXY_ARGS=()
if [ -n "${HTTPS_PROXY:-}" ]; then
  read -r GREENTAXI_PROXY_HOST GREENTAXI_PROXY_PORT < <(python3 - <<'PY'
import os, urllib.parse
proxy = urllib.parse.urlsplit(os.environ['HTTPS_PROXY'])
if proxy.hostname:
    print(proxy.hostname, proxy.port or 80)
PY
  )
  GREENTAXI_SDK_PROXY_ARGS=(--proxy=http "--proxy_host=$GREENTAXI_PROXY_HOST" "--proxy_port=$GREENTAXI_PROXY_PORT")
fi

if [ ! -x "$ANDROID_HOME/cmdline-tools/19.0/bin/sdkmanager" ]; then
  curl --fail --location --silent --show-error https://dl.google.com/android/repository/repository2-3.xml --output "$GREENTAXI_TOOL_ROOT/downloads/repository.xml"
  python3 - "$GREENTAXI_TOOL_ROOT/downloads" <<'PY'
import pathlib, sys, xml.etree.ElementTree as E
base = pathlib.Path(sys.argv[1])
root = E.parse(base / 'repository.xml').getroot()
for package in root:
    if package.attrib.get('path') != 'cmdline-tools;19.0':
        continue
    for archive in package.iter():
        if not archive.tag.endswith('archive'):
            continue
        if not any(item.tag.endswith('host-os') and item.text == 'linux' for item in archive):
            continue
        values = {item.tag.rsplit('}', 1)[-1]: item.text for item in archive.iter()}
        if not values.get('url') or not values.get('checksum'):
            raise SystemExit('Official Android metadata is incomplete')
        (base / 'cmdline.url').write_text('https://dl.google.com/android/repository/' + values['url'])
        (base / 'cmdline.sha1').write_text(values['checksum'] + '  ' + str(base / 'cmdline.zip') + '\n')
        break
    else:
        continue
    break
else:
    raise SystemExit('Pinned Android command-line tools absent from official metadata')
PY
  curl --fail --location --silent --show-error "$(cat "$GREENTAXI_TOOL_ROOT/downloads/cmdline.url")" --output "$GREENTAXI_TOOL_ROOT/downloads/cmdline.zip"
  sha1sum --check "$GREENTAXI_TOOL_ROOT/downloads/cmdline.sha1"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  unzip -oq "$GREENTAXI_TOOL_ROOT/downloads/cmdline.zip" -d "$GREENTAXI_TOOL_ROOT/downloads/cmdline-extracted"
  mv "$GREENTAXI_TOOL_ROOT/downloads/cmdline-extracted/cmdline-tools" "$ANDROID_HOME/cmdline-tools/19.0"
fi

if [ ! -x "$GREENTAXI_TOOL_ROOT/gradle-8.9/bin/gradle" ]; then
  curl --fail --location --silent --show-error https://services.gradle.org/distributions/gradle-8.9-bin.zip.sha256 --output "$GREENTAXI_TOOL_ROOT/downloads/gradle.sha256"
  curl --fail --location --silent --show-error https://services.gradle.org/distributions/gradle-8.9-bin.zip --output "$GREENTAXI_TOOL_ROOT/downloads/gradle.zip"
  python3 - "$GREENTAXI_TOOL_ROOT/downloads" <<'PY'
import hashlib, pathlib, re, sys
base = pathlib.Path(sys.argv[1])
expected = (base / 'gradle.sha256').read_text().strip()
if not re.fullmatch(r'[0-9a-f]{64}', expected):
    raise SystemExit('Invalid official Gradle checksum')
actual = hashlib.file_digest((base / 'gradle.zip').open('rb'), 'sha256').hexdigest()
if actual != expected:
    raise SystemExit('Gradle SHA256 verification failed')
print('Gradle SHA256 verified')
PY
  unzip -q "$GREENTAXI_TOOL_ROOT/downloads/gradle.zip" -d "$GREENTAXI_TOOL_ROOT"
fi

if [ ! -f "$ANDROID_HOME/platforms/android-35/android.jar" ] || [ ! -x "$ANDROID_HOME/build-tools/35.0.0/aapt2" ] || [ ! -x "$ANDROID_HOME/platform-tools/adb" ]; then
  yes 2>/dev/null | "$ANDROID_HOME/cmdline-tools/19.0/bin/sdkmanager" --sdk_root="$ANDROID_HOME" "${GREENTAXI_SDK_PROXY_ARGS[@]}" --licenses >/dev/null
  "$ANDROID_HOME/cmdline-tools/19.0/bin/sdkmanager" --sdk_root="$ANDROID_HOME" "${GREENTAXI_SDK_PROXY_ARGS[@]}" 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
fi
printf 'Android SDK: %s\nGradle: %s\n' "$ANDROID_HOME" "$GREENTAXI_TOOL_ROOT/gradle-8.9/bin/gradle"
