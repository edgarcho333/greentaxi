"""Use the cloud's existing proxy and trust certificate without exposing credentials."""
import os
import pathlib
import shutil
import subprocess
import urllib.parse

base = pathlib.Path(os.environ.get("GREENTAXI_TOOL_ROOT", "/workspace/.greentaxi-tools"))
proxy = urllib.parse.urlsplit(os.environ.get("HTTPS_PROXY", ""))
if proxy.username or proxy.password:
    raise SystemExit("Use the platform's supported proxy route; credentials will not be copied into Gradle configuration.")

properties = []
if proxy.hostname:
    for scheme in ("http", "https"):
        properties.extend([
            f"systemProp.{scheme}.proxyHost={proxy.hostname}",
            f"systemProp.{scheme}.proxyPort={proxy.port or 80}",
        ])
    properties.append("systemProp.http.nonProxyHosts=localhost|127.*|[::1]")

certificate = os.environ.get("CODEX_PROXY_CERT")
if certificate and pathlib.Path(certificate).is_file():
    truststore = base / "java-cacerts"
    java = pathlib.Path(shutil.which("java") or "").resolve()
    original = java.parent.parent / "lib/security/cacerts"
    if not original.is_file():
        raise SystemExit("Installed Java truststore not found.")
    if not truststore.exists():
        shutil.copyfile(original, truststore)
    probe = subprocess.run([
        "keytool", "-list", "-alias", "greentaxi-cloud-egress",
        "-keystore", str(truststore), "-storepass", "changeit",
    ], capture_output=True)
    if probe.returncode:
        result = subprocess.run([
            "keytool", "-importcert", "-noprompt", "-alias", "greentaxi-cloud-egress",
            "-file", certificate, "-keystore", str(truststore), "-storepass", "changeit",
        ], capture_output=True)
        if result.returncode:
            raise SystemExit("Could not install the platform trust certificate in the local Java truststore.")
    properties.append(f"systemProp.javax.net.ssl.trustStore={truststore}")

target = base / "gradle-user/gradle.properties"
target.parent.mkdir(parents=True, exist_ok=True)
existing = target.read_text() if target.exists() else ""
begin, end = "# GreenTaxi cloud networking BEGIN", "# GreenTaxi cloud networking END"
if begin in existing and end in existing:
    existing = existing[:existing.index(begin)] + existing[existing.index(end) + len(end):]
target.write_text(existing.rstrip() + "\n" + begin + "\n" + "\n".join(properties) + "\n" + end + "\n")
print("Gradle networking configured with TLS verification enabled.")
