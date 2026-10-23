import { createHash, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

const release = '3.24.3';
const branch = 'v3.24';
const origin = 'https://dl-cdn.alpinelinux.org';
const pins = {
  aarch64: {
    rootfs: '4d3f80afaebd447c5591a63a73bde380a149fe8b2d85488cafabb2ff97551f50',
    checksum: 'dc1475e1ddf2e97780e323cd06c6602dd9161a32445f8aaee21b7eb6268ee89d',
  },
  x86_64: {
    rootfs: 'f8e1cafba9b1b283b5d30d06f9885c8d2bc161ffe9083ade8e2e157813a53407',
    checksum: 'fa8fcc5b69dadc006d9cbd6a72422a0bde7a35f69836e7b7b77a0c08f31953f8',
  },
};
const maxArchiveBytes = 256 * 1024 * 1024;
const maxAssetBytes = 128 * 1024 * 1024;
const maxKernelBytes = 64 * 1024 * 1024;
const maxFiles = 30000;
const maxPackages = 64;
const sha256Pattern = /^[a-f0-9]{64}$/;
const packageNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9+_.-]{0,99}$/;
const packageVersionPattern = /^[a-zA-Z0-9][a-zA-Z0-9.+_~-]{0,99}$/;
const apkChecksumPattern = /^Q1[A-Za-z0-9+/]{27}=$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const trustNote = 'The Alpine minirootfs and published checksum are pinned by SHA256. APKINDEX and APK signatures are verified using keys from that pinned rootfs. Source and output SHA256 hashes are recorded for subsequent cache validation.';

export function guestArch(hostArch = process.arch) {
  if (hostArch === 'arm64') return 'aarch64';
  if (hostArch === 'x64') return 'x86_64';
  throw new Error(`Unsupported host architecture: ${hostArch}`);
}

function checkArch(arch) {
  if (!Object.hasOwn(pins, arch)) throw new Error('Guest architecture must be aarch64 or x86_64.');
  return arch;
}

export function defaultGuestDirectory(arch = guestArch()) {
  return join(homedir(), '.cache', 'testbench', 'guests', release, checkArch(arch));
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function guestPath(value, allowRoot = false) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/.test(value) || Buffer.byteLength(value) > 4095 || Buffer.from(value).toString() !== value) {
    throw new Error('Invalid guest-relative archive path.');
  }
  const parts = value.split('/');
  if (parts.includes('..')) throw new Error(`Archive path traversal: ${value}`);
  const path = parts.filter(part => part && part !== '.').join('/');
  if ((!path && !allowRoot) || path === 'TRAILER!!!') throw new Error('Invalid archive path.');
  return path;
}

function symlinkData(data) {
  if (!data.length || data.length > 4095 || data.includes(0)) throw new Error('Invalid guest symlink target.');
  decoder.decode(data);
  return data;
}

export function makeCpio(entries) {
  if (!Array.isArray(entries) || entries.length > maxFiles) throw new Error('Too many cpio entries.');
  const files = new Map();
  let bytes = 0;
  for (const entry of entries) {
    const path = guestPath(entry.path);
    if (files.has(path)) throw new Error(`Duplicate cpio path: ${path}`);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o177777) throw new Error(`Invalid cpio mode: ${path}`);
    const type = entry.mode & 0o170000;
    if (![0o100000, 0o040000, 0o120000].includes(type)) throw new Error(`Unsupported cpio file type: ${path}`);
    if (typeof entry.data !== 'string' && !Buffer.isBuffer(entry.data)) throw new Error(`Invalid cpio data: ${path}`);
    const size = Buffer.byteLength(entry.data);
    bytes += size;
    if (size > maxAssetBytes || bytes > maxArchiveBytes) throw new Error('Cpio input exceeds size limits.');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    if (type === 0o040000 && data.length) throw new Error(`Directory has data: ${path}`);
    if (type === 0o120000) symlinkData(data);
    files.set(path, { path, mode: type | (entry.mode & 0o1777), data });
  }
  for (const path of [...files.keys()]) {
    let parent = path;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      const entry = files.get(parent);
      if (entry && (entry.mode & 0o170000) !== 0o040000) throw new Error(`Archive parent is not a directory: ${parent}`);
      if (!entry) {
        if (files.size >= maxFiles) throw new Error('Too many cpio entries after parent creation.');
        files.set(parent, { path: parent, mode: 0o040755, data: Buffer.alloc(0) });
      }
    }
  }
  if (files.size > maxFiles) throw new Error('Too many cpio entries after parent creation.');
  const parts = [];
  let length = 0;
  function append(path, data, mode, inode) {
    const name = Buffer.from(`${path}\0`);
    const fields = [inode, mode, 0, 0, (mode & 0o170000) === 0o040000 ? 2 : 1, 0, data.length, 0, 0, 0, 0, name.length, 0];
    const header = Buffer.from(`070701${fields.map(value => value.toString(16).padStart(8, '0')).join('')}`);
    const namePad = Buffer.alloc((4 - ((header.length + name.length) % 4)) % 4);
    const dataPad = Buffer.alloc((4 - (data.length % 4)) % 4);
    length += header.length + name.length + namePad.length + data.length + dataPad.length;
    if (length > maxArchiveBytes) throw new Error('Cpio exceeds 256 MiB.');
    parts.push(header, name, namePad, data, dataPad);
  }
  let inode = 1;
  const ordered = [...files.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const entry of ordered) append(entry.path, entry.data, entry.mode, inode++);
  append('TRAILER!!!', Buffer.alloc(0), 0, 0);
  const padding = Buffer.alloc((512 - (length % 512)) % 512);
  if (length + padding.length > maxArchiveBytes) throw new Error('Cpio exceeds 256 MiB.');
  parts.push(padding);
  return Buffer.concat(parts, length + padding.length);
}

function gzipMembers(buffer, limit = maxAssetBytes) {
  const members = [];
  let offset = 0;
  let total = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (members.length === 4 || offset + 18 > buffer.length || buffer.readUInt16LE(offset) !== 0x8b1f || buffer[offset + 2] !== 8 || (buffer[offset + 3] & 0xe0)) throw new Error('Unsupported or invalid gzip archive.');
    const flags = buffer[offset + 3];
    offset += 10;
    if (flags & 4) {
      if (offset + 2 > buffer.length) throw new Error('Truncated gzip header.');
      offset += 2 + buffer.readUInt16LE(offset);
    }
    for (const flag of [8, 16]) {
      if (flags & flag) {
        const end = buffer.indexOf(0, offset);
        if (end < 0 || end - start > 65536) throw new Error('Invalid gzip header string.');
        offset = end + 1;
      }
    }
    if (flags & 2) offset += 2;
    if (offset - start > 65536 || offset + 8 >= buffer.length || total >= limit) throw new Error('Invalid or oversized gzip member.');
    const inflated = inflateRawSync(buffer.subarray(offset), { info: true, maxOutputLength: limit - total });
    const end = offset + inflated.engine.bytesWritten + 8;
    if (end > buffer.length) throw new Error('Truncated gzip trailer.');
    const compressed = buffer.subarray(start, end);
    const data = gunzipSync(compressed, { maxOutputLength: limit - total });
    total += data.length;
    members.push({ compressed, data });
    offset = end;
  }
  if (!members.length) throw new Error('Empty gzip archive.');
  return members;
}

function tarText(buffer) {
  const end = buffer.indexOf(0);
  return decoder.decode(end < 0 ? buffer : buffer.subarray(0, end));
}

function tarNumber(buffer) {
  const text = tarText(buffer).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Unsupported tar numeric field.');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error('Oversized tar numeric field.');
  return value;
}

function paxFields(data) {
  if (data.length > 65536) throw new Error('PAX header exceeds 64 KiB.');
  const fields = new Map();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    const digits = data.subarray(offset, space < 0 ? offset : space).toString('ascii');
    if (!/^[1-9][0-9]{0,5}$/.test(digits)) throw new Error('Invalid PAX record length.');
    const length = Number(digits);
    const end = offset + length;
    if (end > data.length || end <= space + 2 || data[end - 1] !== 10) throw new Error('Truncated PAX record.');
    const record = decoder.decode(data.subarray(space + 1, end - 1));
    const equals = record.indexOf('=');
    if (equals < 1 || record.includes('\0')) throw new Error('Invalid PAX field.');
    const key = record.slice(0, equals);
    if (key.includes('sparse') || fields.has(key)) throw new Error('Unsupported or duplicate PAX field.');
    fields.set(key, record.slice(equals + 1));
    offset = end;
  }
  return fields;
}

function readTar(buffer) {
  if (buffer.length > maxArchiveBytes || buffer.length % 512) throw new Error('Invalid tar size.');
  const files = new Map();
  let offset = 0;
  let headers = 0;
  let pax = new Map();
  while (offset < buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) {
      if (!buffer.subarray(offset).every(value => value === 0)) throw new Error('Nonzero data after tar trailer.');
      break;
    }
    if (++headers > maxFiles * 2) throw new Error('Too many tar headers.');
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (checksum !== tarNumber(header.subarray(148, 156))) throw new Error('Tar header checksum mismatch.');
    if (!['ustar\0', 'ustar '].includes(header.subarray(257, 263).toString('ascii'))) throw new Error('Unsupported tar format.');
    const prefix = tarText(header.subarray(345, 500));
    const rawPath = `${prefix ? `${prefix}/` : ''}${tarText(header.subarray(0, 100))}`;
    guestPath(rawPath, true);
    const type = header[156];
    let size = tarNumber(header.subarray(124, 136));
    if (type !== 120 && pax.has('size')) {
      if (!/^[0-9]{1,10}$/.test(pax.get('size'))) throw new Error('Invalid PAX file size.');
      size = Number(pax.get('size'));
    }
    const end = offset + 512 + Math.ceil(size / 512) * 512;
    if (size > maxAssetBytes || end > buffer.length) throw new Error('Truncated or oversized tar entry.');
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    offset = end;
    if (type === 120) {
      if (pax.size) throw new Error('Stacked PAX headers are unsupported.');
      pax = paxFields(data);
      continue;
    }
    const path = guestPath(pax.get('path') ?? rawPath, true);
    const link = pax.get('linkpath') ?? tarText(header.subarray(157, 257));
    pax = new Map();
    const mode = tarNumber(header.subarray(100, 108)) & 0o1777;
    if (!path) {
      if (type !== 53 || size) throw new Error('Invalid tar root directory.');
      continue;
    }
    if (files.has(path)) throw new Error(`Duplicate tar path: ${path}`);
    if (files.size >= maxFiles) throw new Error('Too many tar entries.');
    if (type === 0 || type === 48) files.set(path, { path, mode: 0o100000 | mode, data });
    else if (type === 53 && !size) files.set(path, { path, mode: 0o040000 | mode, data });
    else if (type === 50 && !size) files.set(path, { path, mode: 0o120000 | mode, data: symlinkData(Buffer.from(link)) });
    else if (type === 49 && !size) files.set(path, { path, mode: 0o100000 | mode, link: guestPath(link) });
    else throw new Error(`Unsupported tar entry type: ${path}`);
  }
  if (pax.size) throw new Error('PAX header has no following entry.');
  function materialize(entry, seen = new Set()) {
    if (!entry.link) return entry;
    if (seen.has(entry.path) || seen.size >= 64) throw new Error('Cyclic or excessive tar hardlinks.');
    seen.add(entry.path);
    const target = files.get(entry.link);
    if (!target || (target.mode & 0o170000) !== 0o100000) throw new Error(`Invalid tar hardlink: ${entry.path}`);
    const resolved = materialize(target, seen);
    entry.data = resolved.data;
    entry.mode = resolved.mode;
    delete entry.link;
    return entry;
  }
  let bytes = 0;
  for (const entry of files.values()) {
    bytes += materialize(entry).data.length;
    if (bytes > maxArchiveBytes) throw new Error('Expanded tar files exceed 256 MiB.');
  }
  return files;
}

function verifySignature(members, rootfs) {
  if (members.length < 2) throw new Error('Signed archive has no content segment.');
  for (const entry of readTar(members[0].data).values()) {
    const match = /^\.SIGN\.(RSA|RSA256|RSA512)\.([^/]+)$/.exec(entry.path);
    if (!match || (entry.mode & 0o170000) !== 0o100000) continue;
    const key = rootfs.get(`etc/apk/keys/${match[2]}`);
    if (!key || (key.mode & 0o170000) !== 0o100000 || key.data.length > 16384) continue;
    const algorithm = { RSA: 'RSA-SHA1', RSA256: 'RSA-SHA256', RSA512: 'RSA-SHA512' }[match[1]];
    if (verify(algorithm, members[1].compressed, key.data, entry.data)) return;
  }
  throw new Error('Archive signature does not match a trusted Alpine release key.');
}

function readIndex(buffer, arch, rootfs) {
  const members = gzipMembers(buffer, 16 * 1024 * 1024);
  if (members.length !== 2) throw new Error('Unsupported signed APKINDEX layout.');
  verifySignature(members, rootfs);
  const entries = members.flatMap(member => [...readTar(member.data).values()]);
  const matches = entries.filter(entry => entry.path === 'APKINDEX' && (entry.mode & 0o170000) === 0o100000);
  if (matches.length !== 1) throw new Error('APKINDEX archive must contain one regular index file.');
  const records = decoder.decode(matches[0].data).trimEnd().split(/\n\n+/);
  if (records.length > 20000) throw new Error('Too many APKINDEX packages.');
  const names = new Set();
  return records.map(record => {
    const fields = new Map();
    for (const line of record.split('\n')) {
      if (!/^[a-zA-Z]:/.test(line) || fields.has(line[0])) throw new Error('Invalid APKINDEX field.');
      fields.set(line[0], line.slice(2));
    }
    const pkg = {
      name: fields.get('P'),
      version: fields.get('V'),
      arch: fields.get('A'),
      size: Number(fields.get('S')),
      checksum: fields.get('C'),
      dependencies: (fields.get('D') ?? '').split(' ').filter(Boolean),
      provides: (fields.get('p') ?? '').split(' ').filter(Boolean),
    };
    if (!packageNamePattern.test(pkg.name ?? '') || !packageVersionPattern.test(pkg.version ?? '') || ![arch, 'noarch'].includes(pkg.arch) || !Number.isSafeInteger(pkg.size) || pkg.size < 1 || names.has(pkg.name)) throw new Error(`Invalid or duplicate APKINDEX package: ${pkg.name}`);
    names.add(pkg.name);
    return pkg;
  });
}

function dependency(value) {
  const match = /^([^\s=<>~!]+)(?:=([^\s=<>~!]+))?$/.exec(value);
  if (!match || value.length > 256) throw new Error(`Unsupported dependency in pinned index: ${value}`);
  return { name: match[1], version: match[2] };
}

function guestFile(files, path) {
  let name = guestPath(path);
  for (let depth = 0; depth < 40; depth++) {
    const entry = files.get(name);
    if (!entry) throw new Error(`Missing guest runtime file: ${name}`);
    if ((entry.mode & 0o170000) === 0o100000) return entry;
    if ((entry.mode & 0o170000) !== 0o120000) throw new Error(`Guest runtime path is not a file: ${name}`);
    const target = decoder.decode(entry.data);
    const parts = (target.startsWith('/') ? target : `${name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''}/${target}`).split('/');
    const resolved = [];
    for (const part of parts) {
      if (part === '..') resolved.pop();
      else if (part && part !== '.') resolved.push(part);
    }
    name = guestPath(resolved.join('/'));
  }
  throw new Error('Excessive guest runtime symlinks.');
}

function resolvePackages(packages, rootfs) {
  const providers = new Map();
  function provide(name, version, pkg) {
    if (!providers.has(name)) providers.set(name, []);
    providers.get(name).push({ version, pkg });
  }
  for (const pkg of packages) {
    provide(pkg.name, pkg.version, pkg);
    for (const value of pkg.provides) {
      const item = dependency(value);
      provide(item.name, item.version, pkg);
    }
  }
  const selected = new Map();
  function visit(value) {
    const item = dependency(value);
    if (item.name.startsWith('/')) {
      if (item.version) throw new Error('Versioned file dependencies are unsupported.');
      guestFile(rootfs, item.name.slice(1));
      return;
    }
    const candidates = (providers.get(item.name) ?? []).filter(candidate => !item.version || candidate.version === item.version);
    candidates.sort((a, b) => Number(selected.has(b.pkg.name)) - Number(selected.has(a.pkg.name)) || Number(b.pkg.name === item.name) - Number(a.pkg.name === item.name) || a.pkg.size - b.pkg.size || (a.pkg.name < b.pkg.name ? -1 : a.pkg.name > b.pkg.name ? 1 : 0));
    const pkg = candidates[0]?.pkg;
    if (!pkg) throw new Error(`Unresolved Alpine dependency: ${value}`);
    if (selected.has(pkg.name)) return;
    if (selected.size >= maxPackages) throw new Error('Too many guest packages.');
    selected.set(pkg.name, pkg);
    for (const child of pkg.dependencies) visit(child);
  }
  visit('nodejs');
  visit('bash');
  if (!(Number(selected.get('nodejs').version.split('.')[0]) >= 22)) throw new Error('Guest Node.js must be version 22 or newer.');
  return [...selected.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function readApk(buffer, pkg, rootfs) {
  if (buffer.length !== pkg.size || !apkChecksumPattern.test(pkg.checksum)) throw new Error(`Invalid APK size or index checksum: ${pkg.name}`);
  const members = gzipMembers(buffer);
  if (members.length !== 3) throw new Error(`Expected a signed-format v2 APK with three gzip members: ${pkg.name}`);
  verifySignature(members, rootfs);
  const signature = readTar(members[0].data);
  if (!signature.size || [...signature.values()].some(entry => !entry.path.startsWith('.SIGN.RSA.') || (entry.mode & 0o170000) !== 0o100000)) throw new Error('Unsupported APK signature container.');
  const checksum = `Q1${createHash('sha1').update(members[1].compressed).digest('base64')}`;
  if (checksum !== pkg.checksum) throw new Error(`APKINDEX control checksum mismatch: ${pkg.name}`);
  const info = readTar(members[1].data).get('.PKGINFO');
  if (!info || (info.mode & 0o170000) !== 0o100000 || info.data.length > 65536) throw new Error('Missing or oversized APK metadata.');
  const fields = new Map();
  for (const line of decoder.decode(info.data).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf(' = ');
    if (equals < 1) throw new Error('Invalid APK metadata field.');
    const key = line.slice(0, equals);
    if (!fields.has(key)) fields.set(key, []);
    fields.get(key).push(line.slice(equals + 3));
  }
  for (const [key, value] of [['pkgname', pkg.name], ['pkgver', pkg.version]]) {
    if (fields.get(key)?.length !== 1 || fields.get(key)[0] !== value) throw new Error(`APK metadata mismatch: ${pkg.name} ${key}`);
  }
  if (fields.get('arch')?.length !== 1 || ![pkg.arch, 'noarch'].includes(fields.get('arch')[0])) throw new Error(`APK metadata mismatch: ${pkg.name} arch`);
  const dataSha256 = sha256(members[2].compressed);
  if (fields.get('datahash')?.length !== 1 || fields.get('datahash')[0] !== dataSha256) throw new Error(`APK payload SHA256 mismatch: ${pkg.name}`);
  if (JSON.stringify([...(fields.get('depend') ?? [])].sort()) !== JSON.stringify([...pkg.dependencies].sort())) throw new Error(`APK dependency metadata mismatch: ${pkg.name}`);
  return { files: readTar(members[2].data), dataSha256 };
}

function urls(arch) {
  const filename = `alpine-minirootfs-${release}-${arch}.tar.gz`;
  const repository = `${origin}/alpine/${branch}/main/${arch}`;
  const rootfs = `${origin}/alpine/${branch}/releases/${arch}/${filename}`;
  return { filename, repository, rootfs, checksum: `${rootfs}.sha256`, index: `${repository}/APKINDEX.tar.gz` };
}

function download(url, limit, budget) {
  return new Promise((resolveDownload, reject) => {
    const timeout = Math.min(90000, (budget.deadline ?? Infinity) - Date.now());
    if (timeout <= 0) return reject(new Error('Guest downloads exceeded the ten-minute time limit.'));
    const request = get(url, { headers: { 'Accept-Encoding': 'identity' } }, response => {
      if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        request.destroy(new Error(`Official HTTPS download failed (${response.statusCode}): ${url}`));
        return;
      }
      if (Number(response.headers['content-length'] ?? 0) > limit) {
        request.destroy(new Error(`Download exceeds size limit: ${url}`));
        return;
      }
      const parts = [];
      let bytes = 0;
      response.on('data', data => {
        bytes += data.length;
        budget.bytes += data.length;
        if (bytes > limit || budget.bytes > 192 * 1024 * 1024) request.destroy(new Error(`Guest download budget exceeded: ${url}`));
        else parts.push(data);
      });
      response.on('error', reject);
      response.on('end', () => resolveDownload(Buffer.concat(parts, bytes)));
    });
    const timer = setTimeout(() => request.destroy(new Error(`Guest download time limit exceeded: ${url}`)), timeout);
    request.setTimeout(15000, () => request.destroy(new Error(`Download idle timeout: ${url}`)));
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
  });
}

function assetPaths(directory) {
  return { directory, kernelPath: join(directory, 'kernel.bin'), initrdPath: join(directory, 'base.cpio.gz'), manifestPath: join(directory, 'manifest.json') };
}

async function readBounded(path, limit) {
  const before = await lstat(path);
  if (!before.isFile() || before.size < 1 || before.size > limit) throw new Error(`Invalid guest asset size or type: ${path}`);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size < 1 || info.size > limit) throw new Error(`Invalid or changed guest asset: ${path}`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) throw new Error(`Guest asset changed during read: ${path}`);
      offset += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, null)).bytesRead) throw new Error(`Guest asset grew during read: ${path}`);
    return buffer;
  } finally {
    await file.close();
  }
}

function validateImageManifest(manifest, arch) {
  if (!manifest || manifest.version !== 1 || manifest.arch !== arch) throw new Error('Guest manifest version or architecture mismatch.');
  if (!manifest.files || Object.keys(manifest.files).sort().join(',') !== 'base.cpio.gz,kernel.bin' || !Object.values(manifest.files).every(value => typeof value === 'string' && sha256Pattern.test(value))) throw new Error('Invalid guest asset hashes.');
}

function validateManifest(manifest, arch) {
  validateImageManifest(manifest, arch);
  if (manifest.distro?.name !== 'alpine' || manifest.distro.version !== release || manifest.distro.branch !== branch || manifest.trust?.signaturesVerified !== true || manifest.trust.note !== trustNote) throw new Error('Prepared Alpine release or trust metadata mismatch.');
  if (!Array.isArray(manifest.packages) || manifest.packages.length < 3 || manifest.packages.length > maxPackages || !Array.isArray(manifest.sources) || manifest.sources.length !== manifest.packages.length + 3) throw new Error('Invalid guest source or package list.');
  const locations = urls(arch);
  const indexSource = manifest.sources.find(source => source.url === locations.index);
  if (!indexSource || !sha256Pattern.test(indexSource.sha256 ?? '')) throw new Error('Missing authenticated index digest.');
  const expected = new Map([[locations.rootfs, pins[arch].rootfs], [locations.checksum, pins[arch].checksum], [locations.index, indexSource.sha256]]);
  const names = new Set();
  for (const pkg of manifest.packages) {
    if (!pkg || !packageNamePattern.test(pkg.name ?? '') || !packageVersionPattern.test(pkg.version ?? '') || ![arch, 'noarch'].includes(pkg.arch) || !apkChecksumPattern.test(pkg.checksum ?? '') || !sha256Pattern.test(pkg.sha256 ?? '') || !sha256Pattern.test(pkg.dataSha256 ?? '') || !Number.isSafeInteger(pkg.size) || pkg.size < 1 || pkg.size > maxKernelBytes || names.has(pkg.name) || pkg.role !== (pkg.name === 'linux-virt' ? 'kernel-only' : 'rootfs') || !Array.isArray(pkg.dependencies) || pkg.dependencies.length > 128 || pkg.dependencies.some(value => typeof value !== 'string' || value.length > 256)) throw new Error('Invalid cached package metadata.');
    names.add(pkg.name);
    expected.set(`${locations.repository}/${pkg.name}-${pkg.version}.apk`, pkg.sha256);
  }
  if (!['nodejs', 'bash', 'linux-virt'].every(name => names.has(name)) || !(Number(manifest.packages.find(pkg => pkg.name === 'nodejs').version.split('.')[0]) >= 22)) throw new Error('Guest manifest lacks required runtime packages.');
  for (const source of manifest.sources) {
    if (!source || typeof source.url !== 'string' || !expected.has(source.url) || source.sha256 !== expected.get(source.url) || !Number.isSafeInteger(source.size) || source.size < 1 || source.size > maxKernelBytes) throw new Error('Invalid cached source metadata or pin.');
    expected.delete(source.url);
  }
  if (expected.size) throw new Error('Guest manifest is missing source hashes.');
}

export async function loadGuest({ arch = guestArch(), directory = defaultGuestDirectory(arch) } = {}) {
  checkArch(arch);
  directory = resolve(directory);
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error('Guest cache must be a directory, not a symlink.');
  const paths = assetPaths(directory);
  const manifest = JSON.parse(decoder.decode(await readBounded(paths.manifestPath, 256 * 1024)));
  validateImageManifest(manifest, arch);
  const kernel = await readBounded(paths.kernelPath, maxKernelBytes);
  const initrd = await readBounded(paths.initrdPath, maxAssetBytes);
  if (sha256(kernel) !== manifest.files['kernel.bin'] || sha256(initrd) !== manifest.files['base.cpio.gz']) throw new Error('Guest asset SHA256 mismatch. Refusing cache reuse.');
  return { directory, manifest, kernel, initrd };
}

export async function prepareGuest({ arch = guestArch(), directory = defaultGuestDirectory(arch) } = {}) {
  checkArch(arch);
  directory = resolve(directory);
  let exists = true;
  try {
    await lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  if (exists) {
    const cached = await loadGuest({ arch, directory });
    validateManifest(cached.manifest, arch);
    return { ...assetPaths(directory), manifest: cached.manifest, sizes: { 'kernel.bin': cached.kernel.length, 'base.cpio.gz': cached.initrd.length } };
  }
  const locations = urls(arch);
  const sources = [];
  const budget = { bytes: 0, deadline: Date.now() + 600000 };
  async function source(url, limit, expected) {
    const data = await download(url, limit, budget);
    const hash = sha256(data);
    if (expected && hash !== expected) throw new Error(`Pinned source SHA256 mismatch: ${url}. Refusing changed upstream metadata; pins require an explicit update.`);
    sources.push({ url, sha256: hash, size: data.length });
    return data;
  }
  const checksum = await source(locations.checksum, 4096, pins[arch].checksum);
  if (decoder.decode(checksum).trim() !== `${pins[arch].rootfs}  ${locations.filename}`) throw new Error('Published release checksum does not match the release pin.');
  const rootMembers = gzipMembers(await source(locations.rootfs, 8 * 1024 * 1024, pins[arch].rootfs), 32 * 1024 * 1024);
  if (rootMembers.length !== 1) throw new Error('Unexpected minirootfs gzip layout.');
  const rootfs = readTar(rootMembers[0].data);
  if (decoder.decode(guestFile(rootfs, 'etc/alpine-release').data).trim() !== release) throw new Error('Minirootfs release mismatch.');
  const trustedRoot = new Map(rootfs);
  const index = readIndex(await source(locations.index, 4 * 1024 * 1024), arch, trustedRoot);
  const selected = resolvePackages(index, rootfs);
  const linux = index.find(pkg => pkg.name === 'linux-virt');
  if (!linux) throw new Error('Pinned index has no linux-virt package.');
  const packages = [];
  const owners = new Map();
  let rootBytes = [...rootfs.values()].reduce((sum, entry) => sum + entry.data.length, 0);
  let kernel;
  for (const pkg of [...selected, linux]) {
    if (pkg.size > maxKernelBytes) throw new Error(`Package download exceeds 64 MiB: ${pkg.name}`);
    const data = await source(`${locations.repository}/${pkg.name}-${pkg.version}.apk`, pkg.size);
    const unpacked = readApk(data, pkg, trustedRoot);
    packages.push({ ...pkg, role: pkg === linux ? 'kernel-only' : 'rootfs', sha256: sha256(data), dataSha256: unpacked.dataSha256 });
    if (pkg === linux) {
      const entry = unpacked.files.get('boot/vmlinuz-virt');
      if (!entry || (entry.mode & 0o170000) !== 0o100000 || !entry.data.length || entry.data.length > maxKernelBytes) throw new Error('linux-virt APK has no bounded regular boot/vmlinuz-virt.');
      kernel = Buffer.from(entry.data);
      continue;
    }
    for (const [path, entry] of unpacked.files) {
      const previous = rootfs.get(path);
      if (previous && (previous.mode & 0o170000) === 0o040000 && (entry.mode & 0o170000) === 0o040000) continue;
      if (owners.has(path) && (previous.mode !== entry.mode || !previous.data.equals(entry.data))) throw new Error(`Conflicting package file: ${path}`);
      rootBytes += entry.data.length - (previous?.data.length ?? 0);
      if (rootBytes > maxArchiveBytes || (!previous && rootfs.size >= maxFiles)) throw new Error('Guest rootfs exceeds size or file limits.');
      rootfs.set(path, entry);
      owners.set(path, pkg.name);
    }
    if (rootfs.size > maxFiles) throw new Error('Guest rootfs has too many files.');
  }
  for (const path of ['usr/bin/node', 'bin/bash', 'bin/sh', `lib/ld-musl-${arch}.so.1`]) guestFile(rootfs, path);
  const initrd = gzipSync(makeCpio([...rootfs.values()]), { level: 9, mtime: 0 });
  initrd.writeUInt32LE(0, 4);
  initrd[9] = 255;
  if (initrd.length > maxAssetBytes) throw new Error('Guest initramfs exceeds 128 MiB.');
  const manifest = {
    version: 1,
    arch,
    distro: { name: 'alpine', version: release, branch },
    trust: { signaturesVerified: true, note: trustNote },
    sources,
    packages,
    files: { 'kernel.bin': sha256(kernel), 'base.cpio.gz': sha256(initrd) },
  };
  validateManifest(manifest, arch);
  const paths = assetPaths(directory);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await writeFile(paths.kernelPath, kernel, { flag: 'wx', mode: 0o600 });
  await writeFile(paths.initrdPath, initrd, { flag: 'wx', mode: 0o600 });
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { ...paths, manifest, sizes: { 'kernel.bin': kernel.length, 'base.cpio.gz': initrd.length } };
}
