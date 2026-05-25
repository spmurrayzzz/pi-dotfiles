---
name: pmg-config
description: Handles SafeDep PMG configuration, trusted package exceptions, and PMG package install false positives. Use when PMG blocks npm/pnpm/yarn/pip installs, when configuring pmg.yml or config.yml, when adding trusted_packages, or when investigating SafeDep/OSV malware advisories and false positives.
---

# PMG Config

## When PMG blocks a package

1. Identify the dependency path:

```bash
npm ls <package> --all 2>/dev/null || true
```

Use the unwrapped package manager if PMG blocks metadata commands:

```bash
which -a npm
/path/to/real/npm view <package>@<version> dist scripts time --json
```

2. Inspect PMG's report URL and upstream malware data.

For OSV malware IDs:

```bash
python - <<'PY'
import sys, urllib.request
id = sys.argv[1]
print(urllib.request.urlopen(f'https://api.osv.dev/v1/vulns/{id}').read().decode())
PY MAL-YYYY-NNNN
```

Check for mismatches between broad ranges and explicit affected versions.

3. Search for known false positives or corrections:

```bash
gh api 'search/issues?q="<package>"+"<malware-id>"' \
  --jq '.items[] | [.repository_url,.number,.state,.title,.html_url] | @tsv'
```

Also search `ossf/malicious-packages`, package vendor advisories, and SafeDep
or OSV references. Use web search when needed.

4. Only trust a package after confirming the exact version is outside the
published affected versions or the block is a documented false positive.
Prefer version-scoped trust over package-wide trust.

## Trusted packages

PMG trusted packages use package URLs in config YAML:

```yaml
trusted_packages:
  - purl: pkg:npm/@scope/name@1.2.3
    reason: "Documented false positive in MAL-YYYY-NNNN; affected versions are ..."
```

Use package-wide trust only when necessary:

```yaml
trusted_packages:
  - purl: pkg:npm/@scope/name
    reason: "Reason all versions are trusted"
```

## Local PMG config

Do not assume `~/.config/safedep/pmg/config.yml` is active on macOS. Ask PMG or
run setup to locate the actual config directory:

```bash
pmg setup install
pmg config get trusted_packages
```

On macOS, the active config is commonly:

```text
~/Library/Application Support/safedep/pmg/config.yml
```

After editing local config, verify:

```bash
pmg config get trusted_packages
pmg --proxy-mode=false npm install <package>@<version> --dry-run
```

Then run the original install command.

## Repo PMG config for GitHub Actions

Create a repo config file such as `pmg.yml`:

```yaml
trusted_packages:
  - purl: pkg:npm/@scope/name@1.2.3
    reason: "Documented false positive in MAL-YYYY-NNNN; affected versions are ..."
```

Pass it to the SafeDep PMG GitHub Action:

```yaml
- uses: safedep/pmg@v1
  with:
    config-file: pmg.yml
    disable-telemetry: "true"
- run: npm install
```

Use `safedep/pmg@v1` for the action. Do not use PMG binary release tags such as
`v0.12.1` as GitHub Action refs unless the repo documents that tag contains the
action.

## Validation checklist

- Confirm the package is transitive or direct and record the dependency path.
- Confirm the exact affected versions from OSV/vendor advisories.
- Prefer exact-version `trusted_packages` entries.
- Add a clear reason with advisory ID and affected versions.
- Verify local PMG reads the config with `pmg config get trusted_packages`.
- Verify CI uses repo config through `config-file`.
- Run the original install and relevant build command.
- If amending a pushed workflow commit, remind the user force-push may be needed.
