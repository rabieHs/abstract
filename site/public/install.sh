#!/bin/sh
# abstract installer — https://useabstract.co
#
#   curl -fsSL https://useabstract.co/install.sh | sh
#
# Downloads the standalone abstract for your system from GitHub Releases,
# verifies its SHA-256 checksum, and installs it to ~/.local/bin. Nothing else
# is needed — no Bun, no Node.
#
# Options (environment variables):
#   ABSTRACT_VERSION=0.2.0       install a specific version (default: latest)
#   ABSTRACT_INSTALL_DIR=<dir>   install somewhere else (default: ~/.local/bin)
#   ABSTRACT_NO_MODIFY_PATH=1    don't add the install folder to your shell's PATH
set -eu

REPO="rabieHs/abstract"
DIR="${ABSTRACT_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- what system is this? -------------------------------------------------
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "abstract runs on macOS and Linux. On Windows, use WSL (Linux) — untested — or see https://useabstract.co/docs/install/" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported processor: $(uname -m)" ;;
esac
# an Apple Silicon Mac running this shell under Rosetta still gets the native build
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ] && (ldd --version 2>&1 | grep -qi musl); then
  fail "musl-based Linux (e.g. Alpine) isn't supported — use a glibc distribution, or install with npm: https://useabstract.co/docs/install/"
fi
target="$os-$arch"

# --- download ---------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  fail "curl or wget is needed to download abstract"
fi

if [ -n "${ABSTRACT_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/v${ABSTRACT_VERSION#v}"
else
  base="https://github.com/$REPO/releases/latest/download"
fi
base="${ABSTRACT_DOWNLOAD_BASE:-$base}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading abstract for ${target}…"
fetch "$base/abstract-$target.tar.gz" "$tmp/abstract.tar.gz" || fail "download failed: $base/abstract-$target.tar.gz"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the checksums"

# --- verify -----------------------------------------------------------------
expected="$(grep " abstract-$target.tar.gz\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "no checksum published for abstract-$target.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/abstract.tar.gz" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/abstract.tar.gz" | cut -d' ' -f1)"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch — the download may be corrupted; nothing was installed"
say "Checksum verified."

# --- install ----------------------------------------------------------------
tar -xzf "$tmp/abstract.tar.gz" -C "$tmp" abstract
chmod +x "$tmp/abstract"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$tmp/abstract" 2>/dev/null || true
mkdir -p "$DIR"
mv -f "$tmp/abstract" "$DIR/abstract"
version="$("$DIR/abstract" --version 2>/dev/null || echo "abstract")"
say "Installed $version to $DIR/abstract"

# --- PATH -------------------------------------------------------------------
case ":$PATH:" in
  *":$DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac
if [ "$on_path" = 0 ] && [ -z "${ABSTRACT_NO_MODIFY_PATH:-}" ]; then
  line="export PATH=\"$DIR:\$PATH\""
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="$HOME/.zshrc" ;;
    bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    fish) rc="" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -n "$rc" ]; then
    if ! grep -qsF "$line" "$rc"; then
      printf '\n# added by the abstract installer\n%s\n' "$line" >>"$rc"
      say "Added $DIR to your PATH in $rc"
    fi
    say ""
    say "Open a new terminal (or run: $line), then:"
  else
    say ""
    say "Add $DIR to your PATH (fish: fish_add_path $DIR), then:"
  fi
else
  say ""
  say "Next:"
fi
say "  abstract ~/my-review      # opens your first workspace in the browser"
say ""
say "Docs: https://useabstract.co/docs/quick-start/"
