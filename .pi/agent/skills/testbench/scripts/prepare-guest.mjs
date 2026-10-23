import { prepareGuest } from './guest-image.mjs';

try {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--arch', '--directory'].includes(flag)) throw new Error('Usage: node scripts/prepare-guest.mjs [--arch aarch64|x86_64] [--directory path]');
    const key = flag.slice(2);
    const value = args[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error(`Missing or duplicate ${flag} value.`);
    options[key] = value;
  }
  console.log('Preparing a checksum-pinned Alpine rootfs with verified APKINDEX and package signatures.');
  const guest = await prepareGuest(options);
  console.log(`Alpine ${guest.manifest.distro.version}, ${guest.manifest.arch}`);
  console.log(guest.manifest.trust.note);
  const index = guest.manifest.sources.find(source => source.url.endsWith('/APKINDEX.tar.gz'));
  console.log(`Pinned APKINDEX SHA256: ${index.sha256}`);
  console.log(`Packages: ${guest.manifest.packages.map(pkg => `${pkg.name}=${pkg.version}${pkg.role === 'kernel-only' ? ' (kernel only)' : ''}`).join(', ')}`);
  for (const [name, path] of [['kernel.bin', guest.kernelPath], ['base.cpio.gz', guest.initrdPath]]) {
    console.log(`${path}: ${guest.sizes[name]} bytes, SHA256 ${guest.manifest.files[name]}`);
  }
  console.log(`Manifest: ${guest.manifestPath}`);
} catch (error) {
  console.error(`Guest preparation failed: ${error.message}`);
  process.exitCode = 1;
}
