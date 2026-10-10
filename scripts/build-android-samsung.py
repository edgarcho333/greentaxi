#!/usr/bin/env python3
"""Build the Samsung bridge with its existing private identity, never a new key."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

CERTIFICATE_SHA256 = '44e8dc7c71ac84523091169d571231b1f5a9a84bf568e63c37c9c6d92ac07846'


def main():
    root = Path(os.environ.get('GREENTAXI_TOOL_ROOT', '/workspace/.greentaxi-tools'))
    metadata = root / 'android-signing/samsung.json'
    if not metadata.is_file():
        raise SystemExit('Restore android-signing/samsung.json and its existing keystore from the private environment snapshot. Do not generate a replacement key.')
    config = json.loads(metadata.read_text())
    if config.get('certificateSha256') != CERTIFICATE_SHA256:
        raise SystemExit('The Samsung signing metadata does not match the published certificate. Restore the original identity.')
    key = Path(config['keystore'])
    if not key.is_file():
        raise SystemExit('The existing Samsung keystore is unavailable. Restore it before building an update.')
    environ = os.environ.copy()
    environ.update({
        'JAVA_HOME': str(root / 'jdk21'),
        'ANDROID_HOME': str(root / 'android-sdk'),
        'ANDROID_USER_HOME': str(root / 'android-user'),
        'GRADLE_USER_HOME': str(root / 'gradle-user'),
        'GREENTAXI_SAMSUNG_KEYSTORE': str(key),
        'GREENTAXI_SAMSUNG_KEY_PASSWORD': config['password'],
    })
    certificate = subprocess.run([
        str(root / 'jdk21/bin/keytool'), '-exportcert', '-alias', 'greentaxi-samsung',
        '-keystore', str(key), '-storepass:env', 'GREENTAXI_SAMSUNG_KEY_PASSWORD',
    ], env=environ, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if certificate.returncode or hashlib.sha256(certificate.stdout).hexdigest() != CERTIFICATE_SHA256:
        raise SystemExit('Samsung signing identity verification failed. No update was built.')
    project = Path(__file__).resolve().parent.parent / 'android'
    subprocess.run([
        str(root / 'gradle-8.9/bin/gradle'), '--no-daemon', '-p', str(project),
        '-PgreenTaxiSamsung=true', ':app:assembleRelease', ':app:lintRelease',
    ], env=environ, check=True)


if __name__ == '__main__':
    main()
