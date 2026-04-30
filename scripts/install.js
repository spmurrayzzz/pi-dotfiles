#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const srcRoot = path.join(repo, ".pi");
const dstRoot = path.resolve(process.argv[2] || process.env.PI_HOME ||
  path.join(process.env.HOME, ".pi"));
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const backupRoot = path.join(dstRoot, ".install-backups", stamp);
const jsonFiles = new Set([
  "agent/settings.json",
  "agent/models.json",
  "agent/voice.json",
]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function merge(a, b) {
  if (a && b && typeof a === "object" && typeof b === "object" &&
      !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) {
      out[key] = key in out ? merge(out[key], value) : value;
    }
    return out;
  }
  return b;
}

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function backup(dst) {
  const rel = path.relative(dstRoot, dst);
  const target = path.join(backupRoot, rel);
  mkdir(path.dirname(target));
  fs.copyFileSync(dst, target);
}

function write(dst, content) {
  if (fs.existsSync(dst) && fs.readFileSync(dst).equals(Buffer.from(content))) {
    return;
  }
  if (fs.existsSync(dst)) backup(dst);
  mkdir(path.dirname(dst));
  fs.writeFileSync(dst, content);
}

for (const src of walk(srcRoot)) {
  const rel = path.relative(srcRoot, src);
  const dst = path.join(dstRoot, rel);
  if (jsonFiles.has(rel)) {
    const incoming = JSON.parse(fs.readFileSync(src, "utf8"));
    const current = fs.existsSync(dst)
      ? JSON.parse(fs.readFileSync(dst, "utf8"))
      : {};
    write(dst, JSON.stringify(merge(current, incoming), null, 2) + "\n");
  } else {
    write(dst, fs.readFileSync(src));
  }
}

console.log(fs.existsSync(backupRoot)
  ? "Installed with backups in " + backupRoot
  : "Installed " + srcRoot + " into " + dstRoot);
