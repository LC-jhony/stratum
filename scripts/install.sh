#!/usr/bin/env bash
#
# Stratum installer for Linux.
#
# Installs the latest tagged release (or a pinned tag), verifies its SHA-256
# checksum and registers a desktop entry. Debian/Ubuntu use the .deb package;
# Fedora/RHEL/openSUSE use the .rpm package when the release provides one;
# every other distribution falls back to the AppImage.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/LC-jhony/stratum/main/scripts/install.sh | sudo bash
#   curl -fsSL .../install.sh | sudo bash -s -- --version v0.1.0
#   curl -fsSL .../install.sh | bash -s -- --user
#
set -euo pipefail
IFS=$'\n\t'

REPO="${STRATUM_REPO:-LC-jhony/stratum}"
DOWNLOAD_BASE="${STRATUM_DOWNLOAD_BASE:-https://github.com/$REPO/releases}"
VERSION="${STRATUM_VERSION:-latest}"
PACKAGE_TYPE=""
DO_UNINSTALL=0
USER_INSTALL=0
ASSUME_YES=0
DRY_RUN=0

APP_NAME="Stratum"
PACKAGE_NAME="stratum"
ASSET_DEB="stratum_amd64.deb"
ASSET_RPM="stratum_x86_64.rpm"
ASSET_APPIMAGE="stratum_x86_64.AppImage"
SUMS="SHA256SUMS"
REMOVED=0

if [ -t 1 ]; then
  BOLD=$'\033[1m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  RED=$'\033[31m'
  RESET=$'\033[0m'
else
  BOLD=''
  GREEN=''
  YELLOW=''
  RED=''
  RESET=''
fi

log()  { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
${BOLD}Stratum installer${RESET}

Usage:
  install.sh [options]

Options:
  --version <tag>   Install a specific release tag (default: latest)
  --deb             Force the Debian package
  --rpm             Force the RPM package
  --appimage        Force the AppImage package
  --user            Install the AppImage under ~/.local (no root)
  --uninstall       Remove Stratum, preserving user settings
  --dry-run         Print what would be installed and exit
  -y, --yes         Do not ask for confirmation
  -h, --help        Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | sudo bash
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | sudo bash -s -- --version v0.1.0
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | bash -s -- --user

Environment:
  STRATUM_VERSION        Release tag to install (same as --version)
  STRATUM_REPO           GitHub repository (default: $REPO)
  STRATUM_DOWNLOAD_BASE  Override the release download base URL
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version needs a value"
      VERSION="$2"
      shift 2
      ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --deb) PACKAGE_TYPE=deb; shift ;;
    --rpm) PACKAGE_TYPE=rpm; shift ;;
    --appimage) PACKAGE_TYPE=appimage; shift ;;
    --user) USER_INSTALL=1; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

if [ "$VERSION" != "latest" ]; then
  case "$VERSION" in
    v*) ;;
    *) VERSION="v$VERSION" ;;
  esac
fi

[ "$(uname -s)" = "Linux" ] || die "This installer supports Linux only."

if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
else
  command -v sudo >/dev/null 2>&1 || die "Run as root or install sudo."
  SUDO=(sudo)
fi

run_root() {
  if [ "${#SUDO[@]}" -eq 0 ]; then
    "$@"
  else
    "${SUDO[@]}" "$@"
  fi
}

package_installed() {
  if command -v dpkg-query >/dev/null 2>&1 \
    && dpkg-query -W -f='${Status}' "$PACKAGE_NAME" 2>/dev/null | grep -q 'install ok installed'; then
    return 0
  fi
  if command -v rpm >/dev/null 2>&1 && rpm -q "$PACKAGE_NAME" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

update_desktop_caches() {
  local applications_dir="$1" icons_dir="$2" use_root="$3"
  if command -v update-desktop-database >/dev/null 2>&1; then
    if [ "$use_root" -eq 1 ]; then
      run_root update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
    else
      update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
    fi
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d "$icons_dir" ]; then
    if [ "$use_root" -eq 1 ]; then
      run_root gtk-update-icon-cache -f "$icons_dir" >/dev/null 2>&1 || true
    else
      gtk-update-icon-cache -f "$icons_dir" >/dev/null 2>&1 || true
    fi
  fi
}

write_desktop_file() {
  local target="$1" exec_path="$2" extra="${3:-}"
  cat > "$target" <<EOF
[Desktop Entry]
Type=Application
Name=Stratum
Comment=A DataGrip-style database IDE with VS Code theme compatibility
Exec="$exec_path"$extra %U
Icon=stratum
Terminal=false
Categories=Development;Database;
StartupWMClass=stratum
EOF
}

uninstall_system() {
  if command -v dpkg-query >/dev/null 2>&1 \
    && dpkg-query -W -f='${Status}' "$PACKAGE_NAME" 2>/dev/null | grep -q 'install ok installed'; then
    log "Removing the Debian package"
    run_root apt-get remove -y "$PACKAGE_NAME" || warn "apt-get remove failed"
    REMOVED=1
  elif command -v rpm >/dev/null 2>&1 && rpm -q "$PACKAGE_NAME" >/dev/null 2>&1; then
    log "Removing the RPM package"
    if command -v dnf >/dev/null 2>&1; then
      run_root dnf remove -y "$PACKAGE_NAME" || warn "dnf remove failed"
    elif command -v yum >/dev/null 2>&1; then
      run_root yum remove -y "$PACKAGE_NAME" || warn "yum remove failed"
    elif command -v zypper >/dev/null 2>&1; then
      run_root zypper --non-interactive remove "$PACKAGE_NAME" || warn "zypper remove failed"
    fi
    REMOVED=1
  fi

  if [ -d /opt/Stratum ] || [ -L /usr/local/bin/stratum ] \
    || [ -f /usr/share/applications/stratum.desktop ]; then
    log "Removing the system-wide AppImage installation"
    run_root rm -rf /opt/Stratum
    run_root rm -f /usr/local/bin/stratum /usr/share/applications/stratum.desktop
    run_root rm -f /usr/share/icons/hicolor/512x512/apps/stratum.png
    REMOVED=1
  fi
}

uninstall_user() {
  local data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  if [ -d "$HOME/.local/opt/stratum" ]; then
    log "Removing the user AppImage installation"
    rm -rf "$HOME/.local/opt/stratum"
    REMOVED=1
  fi
  rm -f "$HOME/.local/bin/stratum" \
    "$data_home/applications/stratum.desktop" \
    "$data_home/icons/hicolor/512x512/apps/stratum.png"
}

if [ "$DO_UNINSTALL" -eq 1 ]; then
  if [ "$USER_INSTALL" -eq 1 ]; then
    [ "$(id -u)" -ne 0 ] || die "--user must run as a normal user, not root."
    uninstall_user
  elif [ "$(id -u)" -eq 0 ]; then
    uninstall_system
  else
    uninstall_user
    if package_installed || [ -d /opt/Stratum ] || [ -L /usr/local/bin/stratum ]; then
      uninstall_system
    fi
  fi
  if [ "$REMOVED" -eq 0 ]; then
    warn "No Stratum installation was found."
  else
    log "Stratum was removed. Settings in ${XDG_CONFIG_HOME:-$HOME/.config}/Stratum were preserved."
  fi
  exit 0
fi

if [ "$USER_INSTALL" -eq 1 ]; then
  [ "$(id -u)" -ne 0 ] || die "--user must run as a normal user, not root."
  [ -z "$PACKAGE_TYPE" ] || [ "$PACKAGE_TYPE" = "appimage" ] \
    || die "--user only supports the AppImage package."
  PACKAGE_TYPE="appimage"
fi

detect_distro() {
  local id="" like=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    id="${ID:-}"
    like="${ID_LIKE:-}"
  fi
  DISTRO_NAME="${PRETTY_NAME:-${NAME:-Linux}}"
  case " $id $like " in
    *debian*|*ubuntu*) echo "deb" ;;
    *fedora*|*rhel*|*centos*|*rocky*|*almalinux*|*opensuse*|*suse*) echo "rpm" ;;
    *alpine*) echo "unsupported" ;;
    *) echo "appimage" ;;
  esac
}

case "$(uname -m)" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) die "No aarch64 packages are published yet; build from source instead." ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac

if [ -z "$PACKAGE_TYPE" ]; then
  PACKAGE_TYPE="$(detect_distro)"
fi
[ "$PACKAGE_TYPE" = "unsupported" ] \
  && die "Alpine Linux is not supported by the AppImage; build from source instead."

case "$PACKAGE_TYPE" in
  deb) ASSET="$ASSET_DEB" ;;
  rpm) ASSET="$ASSET_RPM" ;;
  appimage) ASSET="$ASSET_APPIMAGE" ;;
  *) die "Unknown package type: $PACKAGE_TYPE" ;;
esac

[ -n "${DISTRO_NAME:-}" ] || DISTRO_NAME="Linux"

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required."

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stratum-install.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

case "$VERSION" in
  latest) RELEASE_URL="$DOWNLOAD_BASE/latest/download" ;;
  *) RELEASE_URL="$DOWNLOAD_BASE/download/$VERSION" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run: $APP_NAME $VERSION would install $ASSET from $RELEASE_URL"
  exit 0
fi

fetch() {
  local url="$1" dest="$2"
  curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
    --proto '=https' --tlsv1.2 --output "$dest" "$url"
}

has_asset() {
  local asset="$1"
  grep -E "[[:space:]]${asset}$" "$TMP_DIR/$SUMS" >/dev/null 2>&1
}

verify_asset() {
  local asset="$1" line
  line="$(grep -E "[[:space:]]${asset}$" "$TMP_DIR/$SUMS" || true)"
  [ -n "$line" ] || die "Checksum file has no entry for $asset."
  ( cd "$TMP_DIR" && printf '%s\n' "$line" | sha256sum --check --strict - ) \
    || die "Checksum verification failed for $asset."
}

log "Resolving $APP_NAME $VERSION for $DISTRO_NAME ($ARCH)"
fetch "$RELEASE_URL/$SUMS" "$TMP_DIR/$SUMS" \
  || die "Could not download $SUMS. Check that release $VERSION exists."

if ! has_asset "$ASSET"; then
  if [ "$PACKAGE_TYPE" != "appimage" ] && has_asset "$ASSET_APPIMAGE"; then
    warn "This release has no $PACKAGE_TYPE package; falling back to the AppImage."
    PACKAGE_TYPE="appimage"
    ASSET="$ASSET_APPIMAGE"
  else
    die "Release asset $ASSET is missing from $SUMS."
  fi
fi

log "Downloading $ASSET"
fetch "$RELEASE_URL/$ASSET" "$TMP_DIR/$ASSET" \
  || die "Could not download $ASSET."
verify_asset "$ASSET"
log "SHA-256 checksum verified"

if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  printf 'Install %s %s? [Y/n] ' "$APP_NAME" "$VERSION"
  read -r answer
  case "${answer:-y}" in
    [nN]*) log "Cancelled."; exit 0 ;;
  esac
fi

install_deb() {
  command -v apt-get >/dev/null 2>&1 || die "apt-get was not found; use --appimage instead."
  log "Installing the Debian package (dependencies resolved by apt)"
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$TMP_DIR/$ASSET_DEB"
}

install_rpm() {
  local pkg="$TMP_DIR/$ASSET_RPM"
  log "Installing the RPM package"
  if command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y --nogpgcheck "$pkg"
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y --nogpgcheck "$pkg"
  elif command -v zypper >/dev/null 2>&1; then
    run_root zypper --non-interactive install --allow-unsigned-rpm "$pkg" \
      || run_root zypper --non-interactive install "$pkg"
  else
    die "No RPM package manager (dnf, yum or zypper) was found; use --appimage instead."
  fi
}

install_appimage_system() {
  local app_dir="/opt/Stratum"
  local image="$TMP_DIR/$ASSET_APPIMAGE"
  local extracted="$TMP_DIR/squashfs-root"
  local source_icon="$extracted/usr/share/icons/hicolor/512x512/apps/stratum.png"

  if package_installed; then
    die "Stratum is installed through the package manager. Remove it first (apt remove stratum / dnf remove stratum)."
  fi

  chmod +x "$image"
  log "Extracting the AppImage"
  ( cd "$TMP_DIR" && "$image" --appimage-extract >/dev/null 2>&1 ) \
    || die "Could not extract the AppImage."
  [ -x "$extracted/stratum" ] || die "The AppImage does not contain the expected executable."

  if [ -d "$app_dir" ]; then
    log "Replacing the existing installation in $app_dir"
    run_root rm -rf "$app_dir"
  fi
  run_root install -d -m 0755 "$app_dir"
  run_root cp -a "$extracted/." "$app_dir/"
  run_root chown -R root:root "$app_dir"
  if [ -f "$app_dir/chrome-sandbox" ]; then
    run_root chmod 4755 "$app_dir/chrome-sandbox" || warn "Could not mark chrome-sandbox setuid."
  fi
  run_root ln -sfn "$app_dir/stratum" /usr/local/bin/stratum

  write_desktop_file "$TMP_DIR/stratum.desktop" "$app_dir/stratum"
  run_root install -m 0644 "$TMP_DIR/stratum.desktop" /usr/share/applications/stratum.desktop
  if [ -f "$source_icon" ]; then
    run_root install -D -m 0644 "$source_icon" /usr/share/icons/hicolor/512x512/apps/stratum.png
  fi
  update_desktop_caches "/usr/share/applications" "/usr/share/icons/hicolor" 1
  log "Installed to $app_dir"
}

install_appimage_user() {
  local app_dir="$HOME/.local/opt/stratum"
  local data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  local image="$TMP_DIR/$ASSET_APPIMAGE"
  local extracted="$TMP_DIR/squashfs-root"
  local source_icon="$extracted/usr/share/icons/hicolor/512x512/apps/stratum.png"
  local sandbox_flag="" restricted="0"

  [ "$(id -u)" -ne 0 ] || die "A user installation cannot run as root."
  chmod +x "$image"
  log "Extracting the AppImage"
  ( cd "$TMP_DIR" && "$image" --appimage-extract >/dev/null 2>&1 ) \
    || die "Could not extract the AppImage."
  [ -x "$extracted/stratum" ] || die "The AppImage does not contain the expected executable."

  rm -rf "$app_dir"
  mkdir -p "$app_dir"
  cp -a "$extracted/." "$app_dir/"
  chmod 0755 "$app_dir/stratum"

  if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
    restricted="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)"
  fi
  if [ -r /proc/sys/kernel/unprivileged_userns_clone ] \
    && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; then
    restricted="1"
  fi
  if [ -r /proc/sys/user/max_user_namespaces ] \
    && [ "$(cat /proc/sys/user/max_user_namespaces)" = "0" ]; then
    restricted="1"
  fi
  if [ "$restricted" = "1" ] && [ ! -u "$app_dir/chrome-sandbox" ]; then
    sandbox_flag=" --no-sandbox"
    warn "Unprivileged user namespaces are restricted; the desktop entry will use --no-sandbox."
    warn "Use the system package for a sandboxed installation."
  fi

  mkdir -p "$HOME/.local/bin" "$data_home/applications" \
    "$data_home/icons/hicolor/512x512/apps"
  ln -sfn "$app_dir/stratum" "$HOME/.local/bin/stratum"
  write_desktop_file "$data_home/applications/stratum.desktop" "$app_dir/stratum" "$sandbox_flag"
  if [ -f "$source_icon" ]; then
    install -D -m 0644 "$source_icon" "$data_home/icons/hicolor/512x512/apps/stratum.png"
  fi
  update_desktop_caches "$data_home/applications" "$data_home/icons/hicolor" 0
  log "Installed to $app_dir"

  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) warn "$HOME/.local/bin is not on PATH; run $app_dir/stratum directly or add it to PATH." ;;
  esac
}

case "$PACKAGE_TYPE" in
  deb) install_deb ;;
  rpm) install_rpm ;;
  appimage)
    if [ "$USER_INSTALL" -eq 1 ]; then
      install_appimage_user
    else
      install_appimage_system
    fi
    ;;
esac

log "$APP_NAME $VERSION installed."
if [ "$USER_INSTALL" -eq 1 ]; then
  log "Launch it with: $HOME/.local/opt/stratum/stratum"
else
  log "Launch it from the application menu or with: stratum"
fi
