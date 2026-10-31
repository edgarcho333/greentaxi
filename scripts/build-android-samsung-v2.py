#!/usr/bin/env python3
"""Build the separately paired Samsung 2 receiver and retain its update identity."""
import hashlib
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess

REPO = Path(__file__).resolve().parent.parent
TOOLS = Path(os.environ.get('GREENTAXI_TOOL_ROOT', '/workspace/.greentaxi-tools')).expanduser().resolve()
APPLICATION_ID = 'ge.greentaxi.calls.samsung.v2'
LABEL = 'Green Taxi Samsung 2'
ALIAS = 'greentaxi-samsung-v2'
VERSION_NAME = '0.3.2'
VERSION_CODE = 9
DOWNLOADS = REPO / 'public/downloads'
PUBLIC_METADATA = DOWNLOADS / 'samsung-v2-release.json'
EXPECTED_PERMISSIONS = {
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.READ_CALL_LOG',
    'android.permission.READ_PHONE_STATE',
    'android.permission.READ_PHONE_NUMBERS',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
    'android.permission.RECEIVE_BOOT_COMPLETED',
}


class BuildError(Exception):
    pass


def captured(command, environ):
    result = subprocess.run(command, env=environ, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Do not expose provider or configuration errors that may echo secrets.
        raise BuildError(f'{Path(command[0]).name} failed (exit {result.returncode}).')
    return result.stdout


def identity(environ):
    if TOOLS.is_relative_to(REPO.resolve()):
        raise BuildError('Private signing material must remain outside the repository and public downloads.')
    private = TOOLS / 'android-signing'
    if private.resolve().is_relative_to(REPO.resolve()) or private.is_symlink():
        raise BuildError('The private signing directory must not point into the repository or through a symbolic link.')
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    private.chmod(0o700)
    metadata = private / 'samsung-v2.json'
    key = private / 'samsung-v2.jks'
    if key.is_symlink() or metadata.is_symlink() or PUBLIC_METADATA.is_symlink():
        raise BuildError('Signing identity files and release metadata must not be symbolic links.')
    published = json.loads(PUBLIC_METADATA.read_text()) if PUBLIC_METADATA.exists() else None
    if published and published.get('applicationId') != APPLICATION_ID:
        raise BuildError('Published Samsung 2 metadata has an unexpected application identity.')
    if metadata.exists():
        config = json.loads(metadata.read_text())
        if config.get('keystore') != str(key) or not key.is_file() or not config.get('password'):
            raise BuildError('Restore the retained Samsung 2 private keystore and metadata before updating it.')
    else:
        # Generation is allowed only for this first, explicitly authorized
        # separate application. Never silently replace a published identity.
        if published or key.exists():
            raise BuildError('Samsung 2 signing metadata is missing. Restore its original identity; no replacement was generated.')
        password = secrets.token_hex(32)
        environ['GREENTAXI_SAMSUNG_V2_KEY_PASSWORD'] = password
        captured([
            str(TOOLS / 'jdk21/bin/keytool'), '-genkeypair', '-noprompt', '-alias', ALIAS,
            '-keystore', str(key), '-storetype', 'JKS', '-storepass:env', 'GREENTAXI_SAMSUNG_V2_KEY_PASSWORD',
            '-keypass:env', 'GREENTAXI_SAMSUNG_V2_KEY_PASSWORD', '-keyalg', 'RSA', '-keysize', '3072',
            '-sigalg', 'SHA256withRSA', '-validity', '10000',
            '-dname', 'CN=GreenTaxi Samsung 2, O=GreenTaxi, C=GE',
        ], environ)
        config = {'keystore': str(key), 'password': password}
    environ['GREENTAXI_SAMSUNG_V2_KEYSTORE'] = str(key)
    environ['GREENTAXI_SAMSUNG_V2_KEY_PASSWORD'] = config['password']
    certificate = captured([
        str(TOOLS / 'jdk21/bin/keytool'), '-exportcert', '-alias', ALIAS,
        '-keystore', str(key), '-storepass:env', 'GREENTAXI_SAMSUNG_V2_KEY_PASSWORD',
    ], environ)
    fingerprint = hashlib.sha256(certificate).hexdigest()
    if config.get('certificateSha256') not in (None, fingerprint):
        raise BuildError('Samsung 2 private signing certificate does not match its retained identity.')
    if published and published.get('certificateSha256') != fingerprint:
        raise BuildError('The certificate differs from the published Samsung 2 APK. Restore its original private identity.')
    config['certificateSha256'] = fingerprint
    metadata.write_text(json.dumps(config))
    metadata.chmod(0o600)
    key.chmod(0o600)
    return fingerprint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
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
    log = Path('/tmp/greentaxi-samsung-v2-gradle.log')
    result = subprocess.run([
        str(TOOLS / 'gradle-8.9/bin/gradle'), '--no-daemon', '-p', str(REPO / 'android'),
        '-PgreenTaxiSamsungV2=true', ':app:assembleRelease', ':app:lintRelease',
    ], env=environ, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = result.stdout.decode(errors='replace').replace(environ['GREENTAXI_SAMSUNG_V2_KEY_PASSWORD'], '[REDACTED]')
    log.write_text(output)
    log.chmod(0o600)
    if result.returncode:
        raise BuildError(f'Samsung 2 release build/lint failed; inspect {log}.')
    apk = REPO / 'android/app/build/outputs/apk/release/app-release.apk'
    tools = TOOLS / 'android-sdk/build-tools/35.0.0'
    signatures = captured([str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)], environ).decode()
    actual = re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)', signatures)
    if not actual or actual[1].lower() != fingerprint:
        raise BuildError('Samsung 2 APK signature verification failed.')
    badging = captured([str(tools / 'aapt'), 'dump', 'badging', str(apk)], environ).decode()
    if (f"package: name='{APPLICATION_ID}'" not in badging or f"versionCode='{VERSION_CODE}'" not in badging
            or f"versionName='{VERSION_NAME}'" not in badging or f"application-label:'{LABEL}'" not in badging):
        raise BuildError('The APK has an unexpected Samsung 2 package, label or version.')
    if "sdkVersion:'26'" not in badging or "targetSdkVersion:'35'" not in badging or 'application-debuggable' in badging:
        raise BuildError('Samsung 2 APK SDK settings or release flags are incorrect.')
    permissions = captured([str(tools / 'aapt'), 'dump', 'permissions', str(apk)], environ).decode()
    requested = set(re.findall(r"uses-permission: name='([^']+)'", permissions))
    if requested != EXPECTED_PERMISSIONS:
        raise BuildError('Unexpected Samsung 2 APK permissions.')
    manifest = captured([str(tools / 'aapt'), 'dump', 'xmltree', str(apk), 'AndroidManifest.xml'], environ).decode()
    for forbidden in ['ge.greentaxi.calls.PhoneActivity', 'ge.greentaxi.calls.CallActivity', 'ge.greentaxi.calls.TaxiInCallService',
                      'android.intent.action.DIAL', 'android.permission.BIND_INCALL_SERVICE', 'android.telecom.IN_CALL_SERVICE_UI']:
        if forbidden in manifest:
            raise BuildError('The ordinary receiver must not register default-phone components.')
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    destination = DOWNLOADS / 'GreenTaxi-Samsung-2.apk'
    if destination.is_symlink() or PUBLIC_METADATA.is_symlink():
        raise BuildError('Samsung 2 public release files must not be symbolic links.')
    shutil.copyfile(apk, destination)
    destination.chmod(0o644)
    metadata = {
        'applicationId': APPLICATION_ID, 'label': LABEL, 'versionCode': VERSION_CODE, 'versionName': VERSION_NAME,
        'minSdk': 26, 'targetSdk': 35, 'liveMonitoringMinSdk': 30,
        'downloadPath': '/downloads/GreenTaxi-Samsung-2.apk', 'websiteUrl': 'https://green-taxi.ge',
        'bytes': destination.stat().st_size,
        'sha256': hashlib.file_digest(destination.open('rb'), 'sha256').hexdigest(),
        'certificateSha256': fingerprint,
    }
    metadata.update({'releaseChannel': 'stable', 'defaultPhoneRoleSupported': False, 'defaultPhoneRoleRequiresUserSelection': False,
                     'updatesApplicationId': APPLICATION_ID, 'supersedesVersionCodes': [5, 6, 7, 8],
                     'incomingCallStages': ['ringing', 'answered', 'completed', 'missed', 'rejected'],
                     'outgoingCallsIncluded': False, 'requiredServerSchema': 19})
    PUBLIC_METADATA.write_text(json.dumps(metadata, indent=2) + '\n')
    PUBLIC_METADATA.chmod(0o644)
    print(json.dumps({**metadata, 'apkPath': str(destination), 'releaseSigned': True, 'debuggable': False,
                      'lint': 'passed', 'permissions': sorted(requested)}))


if __name__ == '__main__':
    try:
        main()
    except (BuildError, OSError, ValueError, KeyError) as error:
        print(str(error) if isinstance(error, BuildError) else 'Samsung 2 APK build failed; signing credentials were not logged.')
        raise SystemExit(1)
