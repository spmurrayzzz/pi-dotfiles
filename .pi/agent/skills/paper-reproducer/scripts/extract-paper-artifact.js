#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function usage() {
  return [
    "Usage: extract-paper-artifact <path-or-url> [--out file]",
    "                              [--max-chars n]",
    "",
    "Converts local or remote PDF, HTML, Markdown, or text artifacts into",
    "plain text suitable for model input.",
    "",
    "PDF extraction requires pdftotext, pypdf, or PyPDF2. Use",
    "--max-chars 0 to disable truncation. Default: 200000.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { input: null, out: null, maxChars: 200000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--out") {
      args.out = argv[++i];
    } else if (arg === "--max-chars") {
      args.maxChars = Number(argv[++i]);
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.maxChars) || args.maxChars < 0) {
    throw new Error("--max-chars must be a non-negative number");
  }
  return args;
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function looksPdf(name, contentType, buffer) {
  const fileName = name.split("?")[0].toLowerCase();
  return fileName.endsWith(".pdf") ||
    /application\/pdf/i.test(contentType || "") ||
    buffer.subarray(0, 4).toString() === "%PDF";
}

function looksHtml(name, contentType, buffer) {
  const fileName = name.split("?")[0].toLowerCase();
  const head = buffer.subarray(0, 512).toString("utf8").toLowerCase();
  return /text\/html/i.test(contentType || "") ||
    fileName.endsWith(".html") ||
    fileName.endsWith(".htm") ||
    head.includes("<html") ||
    head.includes("<!doctype html");
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1].toLowerCase() === "x";
      const num = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : match;
    }
    return named[entity.toLowerCase()] || match;
  });
}

function htmlToText(html) {
  const dropTags = "script|style|noscript|svg|canvas";
  const blockTags = "article|div|h[1-6]|li|ol|p|section|table|tr|ul";
  const dropPattern = new RegExp(
    `<\\s*(${dropTags})[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`,
    "gi"
  );
  const blockPattern = new RegExp(
    `<\\s*\\/\\s*(${blockTags})\\s*>`,
    "gi"
  );
  return decodeEntities(html)
    .replace(dropPattern, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(blockPattern, "\n")
    .replace(/<[^>]+>/g, " ");
}

function normalize(text) {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPdf(file) {
  const poppler = spawnSync("pdftotext", ["-layout", file, "-"], {
    encoding: "utf8",
    maxBuffer: 200 * 1024 * 1024,
  });
  if (poppler.status === 0 && poppler.stdout.trim()) {
    return poppler.stdout;
  }

  const py = [
    "import sys",
    "try:",
    "    from pypdf import PdfReader",
    "except Exception:",
    "    from PyPDF2 import PdfReader",
    "reader = PdfReader(sys.argv[1])",
    "for i, page in enumerate(reader.pages):",
    "    print(f'\\n\\n--- page {i + 1} ---\\n')",
    "    print(page.extract_text() or '')",
  ].join("\n");

  for (const cmd of ["python3", "python"]) {
    const result = spawnSync(cmd, ["-c", py, file], {
      encoding: "utf8",
      maxBuffer: 200 * 1024 * 1024,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout;
    }
  }

  throw new Error(
    "Could not extract PDF text. Install pdftotext, pypdf, or PyPDF2."
  );
}

function truncate(text, maxChars) {
  if (maxChars === 0 || text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) +
    `\n\n[truncated at ${maxChars} chars; rerun with --max-chars 0]`;
}

async function loadArtifact(input) {
  if (isUrl(input)) {
    const response = await fetch(input, {
      headers: { "user-agent": "pi-paper-reproducer/1.0" },
    });
    if (!response.ok) {
      const status = `${response.status} ${response.statusText}`;
      throw new Error(`Fetch failed: ${status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    return { source: response.url, contentType, buffer };
  }

  const file = path.resolve(input);
  return {
    source: file,
    contentType: "",
    buffer: fs.readFileSync(file),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  const artifact = await loadArtifact(args.input);
  let type = "text";
  let text;

  if (looksPdf(artifact.source, artifact.contentType, artifact.buffer)) {
    type = "pdf";
    const tmp = path.join(os.tmpdir(), `paper-artifact-${process.pid}.pdf`);
    fs.writeFileSync(tmp, artifact.buffer);
    try {
      text = extractPdf(tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } else if (
    looksHtml(artifact.source, artifact.contentType, artifact.buffer)
  ) {
    type = "html";
    text = htmlToText(artifact.buffer.toString("utf8"));
  } else {
    text = artifact.buffer.toString("utf8");
  }

  const body = truncate(normalize(text), args.maxChars);
  const output = [
    `Source: ${artifact.source}`,
    `Type: ${type}`,
    "",
    body,
    "",
  ].join("\n");

  if (args.out) {
    fs.writeFileSync(args.out, output);
  } else {
    process.stdout.write(output);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
