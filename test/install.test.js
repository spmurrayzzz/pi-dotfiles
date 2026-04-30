const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
const sourceRoot = path.join(repo, ".pi");
const install = path.join(repo, "scripts", "install.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-dotfiles-"));
}

function runInstall(piHome) {
  return execFileSync(install, [piHome], {
    cwd: repo,
    encoding: "utf8",
  });
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

function repoFiles() {
  return files(sourceRoot).map((file) => path.relative(sourceRoot, file));
}

test("installs every file in .pi", () => {
  const piHome = tempDir();
  try {
    runInstall(piHome);

    for (const rel of repoFiles()) {
      assert.equal(fs.existsSync(path.join(piHome, rel)), true, rel);
    }
  } finally {
    fs.rmSync(piHome, { recursive: true, force: true });
  }
});

test("backs up changed existing files", () => {
  const piHome = tempDir();
  const rel = repoFiles()[0];
  const target = path.join(piHome, rel);
  const local = rel.endsWith(".json") ? "{}\n" : "local\n";
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, local);

    runInstall(piHome);

    const backups = path.join(piHome, ".install-backups");
    const stamps = fs.readdirSync(backups);
    assert.equal(stamps.length, 1);
    assert.equal(
      fs.readFileSync(path.join(backups, stamps[0], rel), "utf8"),
      local,
    );
  } finally {
    fs.rmSync(piHome, { recursive: true, force: true });
  }
});

test("does not create backups when target is unchanged", () => {
  const piHome = tempDir();
  try {
    runInstall(piHome);
    runInstall(piHome);

    assert.equal(
      fs.existsSync(path.join(piHome, ".install-backups")),
      false,
    );
  } finally {
    fs.rmSync(piHome, { recursive: true, force: true });
  }
});
