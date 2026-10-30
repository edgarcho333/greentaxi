#!/usr/bin/env python3
"""Build the driver's signed APK and retain its private update identity outside Git."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent.parent
TOOLS = Path(os.environ.get('GREENTAXI_TOOL_ROOT', '/workspace/.greentaxi-tools'))
APPLICATION_ID = 'ge.greentaxi.driver'
ALIAS = 'greentaxi-driver'
DOWNLOADS = REPO / 'public/downloads'
PUBLIC_METADATA = DOWNLOADS / 'driver-release.json'


class BuildError(Exception):
    pass


def captured(command, environ):
    result = subprocess.run(command, env=environ, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Java/provider errors can include environment values: never echo them.
        raise BuildError(f'{Path(command[0]).name} failed (exit {result.returncode}).')
    return result.stdout


def identity(environ):
    private = TOOLS / 'android-signing'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    private.chmod(0o700)
    metadata = private / 'driver.json'
    key = private / 'driver.jks'
    published = json.loads(PUBLIC_METADATA.read_text()) if PUBLIC_METADATA.exists() else None
    if metadata.exists():
        config = json.loads(metadata.read_text())
        if config.get('keystore') != str(key) or not key.is_file() or not config.get('password'):
            raise BuildError('Restore the original private driver keystore and metadata; never generate a replacement for an update.')
    else:
        if published or key.exists():
            raise BuildError('Driver signing metadata is missing. Restore the original identity before building an update.')
        password = secrets.token_hex(32)
        environ['GREENTAXI_DRIVER_KEY_PASSWORD'] = password
        captured([
            str(TOOLS / 'jdk21/bin/keytool'), '-genkeypair', '-noprompt', '-alias', ALIAS,
            '-keystore', str(key), '-storetype', 'JKS', '-storepass:env', 'GREENTAXI_DRIVER_KEY_PASSWORD',
            '-keypass:env', 'GREENTAXI_DRIVER_KEY_PASSWORD', '-keyalg', 'RSA', '-keysize', '3072',
            '-sigalg', 'SHA256withRSA', '-validity', '10000',
            '-dname', 'CN=GreenTaxi Driver, O=GreenTaxi, C=GE',
        ], environ)
        config = {'keystore': str(key), 'password': password}
    environ['GREENTAXI_DRIVER_KEYSTORE'] = str(key)
    environ['GREENTAXI_DRIVER_KEY_PASSWORD'] = config['password']
    certificate = captured([
        str(TOOLS / 'jdk21/bin/keytool'), '-exportcert', '-alias', ALIAS,
        '-keystore', str(key), '-storepass:env', 'GREENTAXI_DRIVER_KEY_PASSWORD',
    ], environ)
    fingerprint = hashlib.sha256(certificate).hexdigest()
    if config.get('certificateSha256') not in (None, fingerprint):
        raise BuildError('The private driver signing certificate does not match its retained identity.')
    if published and published.get('certificateSha256') != fingerprint:
        raise BuildError('The signing certificate differs from the published driver APK. Restore its original private identity.')
    config['certificateSha256'] = fingerprint
    metadata.write_text(json.dumps(config))
    metadata.chmod(0o600)
    key.chmod(0o600)
    return fingerprint


def main():
    os.umask(0o077)
    environ = os.environ.copy()
    environ.update({
        'JAVA_HOME': str(TOOLS / 'jdk21'),
        'ANDROID_HOME': str(TOOLS / 'android-sdk'),
        'ANDROID_USER_HOME': str(TOOLS / 'android-user'),
        'GRADLE_USER_HOME': str(TOOLS / 'gradle-user'),
        'PATH': str(TOOLS / 'jdk21/bin') + os.pathsep + environ.get('PATH', ''),
    })
    truststore = TOOLS / 'java-cacerts'
    if truststore.exists():
        environ['JAVA_TOOL_OPTIONS'] = environ.get('JAVA_TOOL_OPTIONS', '') + f' -Djavax.net.ssl.trustStore={truststore}'
    if not (TOOLS / 'gradle-8.9/bin/gradle').is_file() or not (TOOLS / 'android-sdk/platforms/android-35/android.jar').is_file():
        raise BuildError('Android build tools are missing. Run scripts/setup-android.sh first.')
    fingerprint = identity(environ)
    with tempfile.TemporaryDirectory(prefix='greentaxi-driver-policy-') as output:
        captured([
            str(TOOLS / 'jdk21/bin/javac'), '-d', output,
            str(REPO / 'android/driver/src/main/java/ge/greentaxi/driver/NavigationPolicy.java'),
            str(REPO / 'android/driver/tests/NavigationPolicyTest.java'),
        ], environ)
        captured([str(TOOLS / 'jdk21/bin/java'), '-cp', output, 'ge.greentaxi.driver.NavigationPolicyTest'], environ)
    log = Path('/tmp/greentaxi-driver-apk-gradle.log')
    result = subprocess.run([
        str(TOOLS / 'gradle-8.9/bin/gradle'), '--no-daemon', '-p', str(REPO / 'android'),
        ':driver:assembleRelease', ':driver:lintRelease',
    ], env=environ, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    # A Gradle/Groovy configuration error can echo DSL arguments. Redact the
    # signing password before any build output is written to a log or displayed.
    output = result.stdout.decode(errors='replace').replace(environ['GREENTAXI_DRIVER_KEY_PASSWORD'], '[REDACTED]')
    log.write_text(output)
    if result.returncode:
        raise BuildError(f'Driver release build/lint failed; inspect {log}.')
    apk = REPO / 'android/driver/build/outputs/apk/release/driver-release.apk'
    tools = TOOLS / 'android-sdk/build-tools/35.0.0'
    signatures = captured([str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)], environ).decode()
    actual = re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)', signatures)
    if not actual or actual[1].lower() != fingerprint:
        raise BuildError('APK certificate verification failed.')
    badging = captured([str(tools / 'aapt'), 'dump', 'badging', str(apk)], environ).decode()
    if f"package: name='{APPLICATION_ID}'" not in badging or "versionCode='1'" not in badging or "versionName='1.0.0'" not in badging:
        raise BuildError('The release APK has an unexpected package or version.')
    if "sdkVersion:'26'" not in badging or "targetSdkVersion:'35'" not in badging or 'application-debuggable' in badging:
        raise BuildError('The APK SDK settings or release flags are incorrect.')
    permissions = captured([str(tools / 'aapt'), 'dump', 'permissions', str(apk)], environ).decode()
    requested = set(re.findall(r"uses-permission: name='([^']+)'", permissions))
    if requested != {'android.permission.INTERNET'}:
        raise BuildError('Unexpected driver APK permissions.')
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    destination = DOWNLOADS / 'GreenTaxi-Driver-Android.apk'
    shutil.copyfile(apk, destination)
    destination.chmod(0o644)
    metadata = {
        'applicationId': APPLICATION_ID, 'versionCode': 1, 'versionName': '1.0.0',
        'minSdk': 26, 'targetSdk': 35,
        'downloadPath': '/downloads/GreenTaxi-Driver-Android.apk',
        'websiteUrl': 'https://green-taxi.ge/driver',
        'bytes': destination.stat().st_size,
        'sha256': hashlib.file_digest(destination.open('rb'), 'sha256').hexdigest(),
        'certificateSha256': fingerprint,
    }
    PUBLIC_METADATA.write_text(json.dumps(metadata, indent=2) + '\n')
    PUBLIC_METADATA.chmod(0o644)
    print(json.dumps({**metadata, 'apkPath': str(destination), 'releaseSigned': True, 'debuggable': False, 'navigationPolicyTests': 'passed', 'lint': 'passed', 'permissions': sorted(requested)}))


if __name__ == '__main__':
    try:
        main()
    except (BuildError, OSError, ValueError, KeyError) as error:
        # Only controlled messages are returned; raw keystore/provider exceptions stay private.
        print(str(error) if isinstance(error, BuildError) else 'Driver APK build failed; signing credentials were not logged.')
        raise SystemExit(1)
