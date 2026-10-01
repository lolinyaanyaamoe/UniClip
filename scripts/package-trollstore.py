#!/usr/bin/env python3
"""Add release entitlements to an unsigned production IPA for TrollStore.

Uses only macOS ad-hoc signing (no Apple account, certificate or profile).
TrollStore preserves these entitlements when applying its installation signature.
Usage: python3 scripts/package-trollstore.py unsigned.ipa trollstore.ipa
"""

import hashlib
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import zipfile


BUNDLE_ID = "app.uniclipboard.UniClipboard"
APP_GROUPS = [f"group.{BUNDLE_ID}", "group.app.uniclipboard.ios"]
TEAM = "TROLLTROLL"  # TrollStore's placeholder, not an Apple developer identity.


def run(*args):
    return subprocess.run(args, check=True, capture_output=True).stdout


def text_sections(data):
    """Compare compiled code/data, excluding headers changed by codesign."""
    if data[:4] != b"\xcf\xfa\xed\xfe":
        raise ValueError("Expected thin 64-bit Mach-O")
    if struct.unpack_from("<I", data, 4)[0] != 0x100000C:
        raise ValueError("Expected arm64 device binary")
    offset = 32
    sections = {}
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        command, size = struct.unpack_from("<II", data, offset)
        if command == 0x19:  # LC_SEGMENT_64
            for index in range(struct.unpack_from("<I", data, offset + 64)[0]):
                section = offset + 72 + index * 80
                name, segment, _, length, file_offset = struct.unpack_from("<16s16sQQI", data, section)
                if segment.rstrip(b"\0") == b"__TEXT":
                    sections[name.rstrip(b"\0").decode()] = hashlib.sha256(
                        data[file_offset:file_offset + length]
                    ).hexdigest()
        offset += size
    if "__text" not in sections:
        raise ValueError("Missing compiled code section")
    return sections


def package(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists():
        raise ValueError(f"Refusing to overwrite {destination}")
    with zipfile.ZipFile(source) as archive:
        if archive.testzip() is not None:
            raise ValueError("Input IPA failed ZIP CRC verification")
        for name in archive.namelist():
            if Path(name).is_absolute() or ".." in Path(name).parts:
                raise ValueError("Unsafe ZIP path")
            if "_CodeSignature" in Path(name).parts or name.endswith("embedded.mobileprovision"):
                raise ValueError("Expected an unsigned IPA without provisioning profiles")

    with tempfile.TemporaryDirectory(prefix="uniclip-trollstore-") as temp:
        stage = Path(temp)
        run("/usr/bin/ditto", "-x", "-k", str(source), str(stage))
        app = stage / "Payload/UniClip.app"
        targets = sorted(app.glob("PlugIns/*.appex")) + [app]
        expected_ids = {BUNDLE_ID, f"{BUNDLE_ID}.Share", f"{BUNDLE_ID}.Keyboard"}
        records = []
        for target in targets:
            info = plistlib.loads((target / "Info.plist").read_bytes())
            bundle_id = info["CFBundleIdentifier"]
            if bundle_id not in expected_ids:
                raise ValueError(f"Unexpected bundle: {bundle_id}")
            expected_ids.remove(bundle_id)
            keychain_group = info.get("UCP2PKeychainAccessGroup")
            if keychain_group != f"{BUNDLE_ID}.p2p":
                raise ValueError("Expected the unsigned build's unprefixed P2P keychain group")
            if info.get("UCAppGroupIdentifier", APP_GROUPS[0]) != APP_GROUPS[0]:
                raise ValueError("Unexpected App Group")
            executable = target / info["CFBundleExecutable"]
            entitlements = {
                "application-identifier": f"{TEAM}.{bundle_id}",
                "com.apple.developer.team-identifier": TEAM,
                "com.apple.security.application-groups": APP_GROUPS,
                "keychain-access-groups": [keychain_group],
            }
            if target == app:
                entitlements["com.apple.developer.networking.multicast"] = True
            records.append((target, executable, info, entitlements, text_sections(executable.read_bytes())))
        if expected_ids:
            raise ValueError(f"Missing targets: {expected_ids}")

        # Sign nested frameworks before the extensions and containing application.
        # '-' is ad-hoc signing and does not select a keychain signing identity.
        for framework in sorted(app.rglob("*.framework"), key=lambda p: len(p.parts), reverse=True):
            run("/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(framework))
        report = []
        for target, executable, info, entitlements, original_sections in records:
            entitlements_file = stage / f"{target.name}.entitlements.plist"
            entitlements_file.write_bytes(plistlib.dumps(entitlements))
            run("/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none",
                "--generate-entitlement-der", "--entitlements", str(entitlements_file), str(target))
            embedded = plistlib.loads(run("/usr/bin/codesign", "--display", "--entitlements", "-", "--xml", str(target)))
            if embedded != entitlements:
                raise ValueError(f"Embedded entitlements differ: {target.name}")
            if text_sections(executable.read_bytes()) != original_sections:
                raise ValueError(f"Compiled sections changed: {target.name}")
            report.append({
                "bundleIdentifier": info["CFBundleIdentifier"],
                "version": info["CFBundleShortVersionString"], "build": info["CFBundleVersion"],
                "entitlements": embedded, "compiledTextSectionsUnchanged": True,
            })
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", str(app))
        destination.parent.mkdir(parents=True, exist_ok=True)
        run("/usr/bin/ditto", "-c", "-k", "--keepParent", "--norsrc", str(stage / "Payload"), str(destination))

    with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination) as result:
        if result.testzip() is not None:
            raise ValueError("Output IPA failed ZIP CRC verification")
        # All original resources, including Info.plist and JavaScript, must survive unchanged.
        for name in original.namelist():
            if name.endswith("/"):
                continue
            before, after = original.read(name), result.read(name)
            if before == after:
                continue
            if before[:4] != b"\xcf\xfa\xed\xfe" or text_sections(before) != text_sections(after):
                raise ValueError(f"Unexpected payload change: {name}")
    manifest = {
        "file": destination.name,
        "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "inputSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "signing": "ad-hoc entitlements for TrollStore; no Apple signing identity",
        "zipCRC": "passed", "codeSignatureVerification": "passed",
        "originalResourcesUnchanged": True, "deviceRuntimeTests": "not performed",
        "targets": report,
    }
    destination.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    package(sys.argv[1], sys.argv[2])
