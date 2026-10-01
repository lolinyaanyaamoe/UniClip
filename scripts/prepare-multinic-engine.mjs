import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(process.argv[2]);
const commit = '5b7d59c0073f45413bd608f1c08f71a72c4968da';
const version = '1.1.0-rc.20-multinic.1';
const moduleRoot = resolve(root, 'modules/uc-engine');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const platform of ['android', 'ios']) {
  if (readFileSync(resolve(artifacts, platform, 'source-commit.txt'), 'utf8').trim() !== commit) {
    throw new Error(`Unexpected ${platform} Engine commit`);
  }
  if (readFileSync(resolve(artifacts, platform, 'build-profile.txt'), 'utf8').trim() !== 'release') {
    throw new Error(`Expected Release Engine for ${platform}`);
  }
}
const maven = `android/release-maven/app/uniclipboard/uniclipboard-engine/${version}`;
const files = {
  'UniClipboardEngine.aar': ['android/UniClipboardEngine.aar', `${maven}/uniclipboard-engine-${version}.aar`],
  'UniClipboardEngine.pom': ['android/UniClipboardEngine.pom', `${maven}/uniclipboard-engine-${version}.pom`],
  'runtime-dependencies.txt': ['android/runtime-dependencies.txt', 'android/release-metadata/runtime-dependencies.txt'],
  'uc_engine_uniffi.kt': ['android/uc_engine_uniffi.kt', 'android/release-metadata/uc_engine_uniffi.kt'],
  'uc_engine_uniffi.swift': ['ios/uc_engine_uniffi.swift', 'ios/Bindings/uc_engine_uniffi.swift'],
};
const hashes = {};
for (const [name, [source, destination]] of Object.entries(files)) {
  const target = resolve(moduleRoot, destination);
  mkdirSync(resolve(target, '..'), { recursive: true });
  copyFileSync(resolve(artifacts, source), target);
  if (name.endsWith('.pom')) {
    const pom = readFileSync(target, 'utf8');
    if (!/<version>[^<]+<\/version>/.test(pom)) throw new Error('Missing Maven version');
    writeFileSync(target, pom.replace(/<version>[^<]+<\/version>/, `<version>${version}</version>`));
  }
  hashes[name] = hash(readFileSync(target));
}
execFileSync('unzip', ['-q', resolve(artifacts, 'ios/UniClipboardEngine.xcframework.zip'), '-d', resolve(moduleRoot, 'ios')]);
writeFileSync(resolve(moduleRoot, 'core-source.json'), JSON.stringify({
  schemaVersion: 1,
  repository: 'lolinyaanyaamoe/Engine',
  version: `v${version}`,
  sourceCommit: commit,
  artifactSource: 'local-build',
  sourceStateSha256: hash(''),
  artifacts: hashes,
}, null, 2) + '\n');
const packagePath = resolve(moduleRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
packageJson.version = version;
writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
for (const flag of ['--record-prepared', '--prepared']) {
  execFileSync(process.execPath, [resolve(root, 'scripts/verify-unified-engine-core.mjs'), flag], { stdio: 'inherit' });
}
