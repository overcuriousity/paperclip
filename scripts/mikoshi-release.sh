#!/usr/bin/env bash
# Build the installable tarballs of a mikoshi fork release.
#
#   scripts/mikoshi-release.sh <version> [out-dir]
#   e.g. scripts/mikoshi-release.sh 2026.1012.0-mikoshi.1 release-out
#
# <version> is <upstream version>-mikoshi.<n>. The fork changes only
# @paperclipai/server, so the release carries two tarballs:
#   paperclipai-server-<version>.tgz  the forked server
#   paperclipai-<version>.tgz         the CLI; it depends on the server tarball
#                                     by its release-asset URL
# Every other @paperclipai/* dependency is pinned to the upstream version and
# resolves from the npm registry. Nothing is published to npm.
#
# Install: npm install -g <release url>/paperclipai-<version>.tgz
#
# The steps follow scripts/release.sh (workspace build, versioning, CLI
# bundle, bundled server pack), so rerun this after every rebase onto a new
# upstream tag. It expects `pnpm install` to have run.
set -euo pipefail

VERSION="${1:?usage: $0 <upstream-version>-mikoshi.<n> [out-dir]}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$(mkdir -p "${2:-$REPO_ROOT/release-out}" && cd "${2:-$REPO_ROOT/release-out}" && pwd)"
UPSTREAM_VERSION="${VERSION%%-mikoshi.*}"
REPOSITORY="${GITHUB_REPOSITORY:-overcuriousity/paperclip}"
TAG="v$VERSION"
SERVER_TGZ="paperclipai-server-$VERSION.tgz"
CLI_TGZ="paperclipai-$VERSION.tgz"
SERVER_URL="https://github.com/$REPOSITORY/releases/download/$TAG/$SERVER_TGZ"

case "$VERSION" in
  *-mikoshi.[0-9]*) ;;
  *) echo "version must look like <upstream>-mikoshi.<n>, got $VERSION" >&2; exit 1 ;;
esac

cd "$REPO_ROOT"
if [ -n "$(git status --porcelain -- . ':!pnpm-lock.yaml')" ]; then
  echo "working tree is dirty; commit or stash first" >&2
  exit 1
fi

restore() {
  cd "$REPO_ROOT"
  [ -f cli/package.dev.json ] && mv cli/package.dev.json cli/package.json
  git checkout -q -- $(git ls-files -m -- '*package.json' cli/README.md) 2>/dev/null || true
  rm -rf server/ui-dist server/skills packages/adapters/claude-local/skills packages/adapters/codex-local/skills
}
trap restore EXIT

echo "==> [1/5] Building the workspace"
export PAPERCLIP_RELEASE_REUSE_UI_DIST=1
pnpm build
node scripts/build-standalone-public-packages.mjs
bash scripts/prepare-server-ui-dist.sh
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$pkg_dir/skills"
  cp -r skills "$pkg_dir/skills"
done

echo "==> [2/5] Versioning: workspace $UPSTREAM_VERSION, server and CLI $VERSION"
node scripts/release-package-map.mjs set-version "$UPSTREAM_VERSION"
node -e '
  const fs = require("node:fs");
  for (const file of ["server/package.json", "cli/package.json"]) {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version = process.argv[1];
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  }
' "$VERSION"

echo "==> [3/5] Packing @paperclipai/server"
publish_dir="$(mktemp -d "${TMPDIR:-/tmp}/mikoshi-server.XXXXXX")"
node scripts/prepare-bundled-package.mjs "$REPO_ROOT/server" "$publish_dir"
# prepare-bundled-package maps workspace:* to the server's own version. Only
# the server is forked; its workspace siblings are the upstream packages.
node -e '
  const fs = require("node:fs");
  const [file, forked, upstream] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (name.startsWith("@paperclipai/") && spec.replace(/^[\^~]/, "") === forked) pkg[section][name] = upstream;
    }
  }
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$publish_dir/package.json" "$VERSION" "$UPSTREAM_VERSION"
(cd "$publish_dir" && npx --yes npm@10.9.7 pack --ignore-scripts --pack-destination "$OUT_DIR" >/dev/null)
rm -rf "$publish_dir"

echo "==> [4/5] Building and packing the paperclipai CLI"
./scripts/build-npm.sh --skip-checks --skip-typecheck
node -e '
  const fs = require("node:fs");
  const [url] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync("cli/package.json", "utf8"));
  if (!pkg.dependencies?.["@paperclipai/server"]) throw new Error("CLI does not depend on @paperclipai/server");
  pkg.dependencies["@paperclipai/server"] = url;
  fs.writeFileSync("cli/package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$SERVER_URL"
(cd cli && npx --yes npm@10.9.7 pack --ignore-scripts --pack-destination "$OUT_DIR" >/dev/null)

echo "==> [5/5] Checking the tarballs"
node -e '
  const { execFileSync } = require("node:child_process");
  const [dir, version, upstream, serverUrl, cliTgz, serverTgz] = process.argv.slice(1);
  const manifest = (tgz, name) => JSON.parse(execFileSync("tar", ["-xOzf", `${dir}/${tgz}`, "package/package.json"]));
  const cli = manifest(cliTgz), server = manifest(serverTgz);
  const fail = (msg) => { console.error(msg); process.exit(1); };
  if (cli.version !== version || server.version !== version) fail("tarball versions do not match");
  if (cli.dependencies["@paperclipai/server"] !== serverUrl) fail("CLI does not pin the server tarball URL");
  for (const pkg of [cli, server]) {
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      if (!name.startsWith("@paperclipai/") || spec === serverUrl) continue;
      if (spec !== upstream) fail(`${pkg.name} depends on ${name}@${spec}, expected ${upstream}`);
    }
  }
  console.log(`  ok: ${cliTgz} -> ${serverUrl}; other @paperclipai/* at ${upstream}`);
' "$OUT_DIR" "$VERSION" "$UPSTREAM_VERSION" "$SERVER_URL" "$CLI_TGZ" "$SERVER_TGZ"
(cd "$OUT_DIR" && sha256sum "$SERVER_TGZ" "$CLI_TGZ" > SHA256SUMS && cat SHA256SUMS)
