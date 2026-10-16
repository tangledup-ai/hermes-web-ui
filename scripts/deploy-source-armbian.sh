#!/usr/bin/env bash
set -Eeuo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "${BLUE}[STEP]${NC} $*"; }

# ============================================================
# Proxy configuration for acceleration (local mirror)
# ============================================================
if [[ -z "${LOCAL_PROXY:-}" ]]; then
  LOCAL_PROXY="http://6.6.6.66:7890"
fi

export no_proxy="localhost,127.0.0.1,*.local,*.aliyuncs.com"
export NO_PROXY="${no_proxy}"

# Probe the proxy with a real HTTP request. /dev/tcp is unreliable on some
# Armbian images (IPv6 preference, DNS quirks, etc.).
proxy_reachable=0
if curl -x "${LOCAL_PROXY}" -s -o /dev/null --connect-timeout 5 --max-time 10 http://connectivitycheck.gstatic.com/generate_204 2>/dev/null; then
  proxy_reachable=1
fi

if [[ "${proxy_reachable}" -eq 1 ]]; then
  export http_proxy="${LOCAL_PROXY}"
  export https_proxy="${LOCAL_PROXY}"
  export HTTP_PROXY="${LOCAL_PROXY}"
  export HTTPS_PROXY="${LOCAL_PROXY}"
  info "Proxy reachable: ${LOCAL_PROXY}"
else
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
  warn "Proxy ${LOCAL_PROXY} unreachable on this network. Falling back to direct connection."
fi

trap 'err "Source deployment failed at line: $LINENO"' ERR

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    err "This script requires root or sudo."
    exit 1
  fi
  SUDO=(sudo)
fi

run() {
  "${SUDO[@]}" "$@"
}

# Recursively chown a path but never cross into mounted filesystems (e.g. an
# exFAT USB drive the Web UI mounts under the app home). Those don't support
# ownership changes, so chown -R aborts the whole deploy early with
# "Operation not permitted" (seen on 6.6.6.31 with a USB stick mounted at
# ~/.hermes-web-ui/mnt/usb). Fall back to plain chown -R when mountpoint(1)
# isn't available.
#
# Every chown carries -h (no-dereference): the tree may contain dangling
# symlinks (e.g. historical update backups under updates/backups/), and a
# bare chown fails on them ("cannot dereference"), which makes find -exec
# exit non-zero and aborts the whole deploy under set -e. 6.6.6.73 v0.8.1.
chown_r_mount_safe() {
  local owner="$1"
  local target="$2"
  run chown -h "${owner}" "${target}"
  # find(1) in default -P mode does not traverse into an argument symlink;
  # when target is a symlink (e.g. the deploy link) resolve the real tree
  # first or the recursion only touches the link itself (6.6.6.73 canary).
  local real_target
  real_target="$(readlink -f "${target}" 2>/dev/null || true)"
  if [[ -n "${real_target}" && -d "${real_target}" ]]; then
    target="${real_target}"
  fi
  if ! command -v mountpoint >/dev/null 2>&1; then
    run find "${target}" -mindepth 1 -exec chown -h "${owner}" '{}' +
    return
  fi
  run find "${target}" -mindepth 1 -xdev \
    \( -type d -exec mountpoint -q '{}' \; \) -prune \
    -o -exec chown -h "${owner}" '{}' +
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_safe_env_value() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    err "Environment variable ${name} contains an invalid newline."
    exit 1
  fi
}

run_as_app_user() {
  local command="$1"
  shift || true

  # Pass proxy env vars through sudo (which resets environment by default)
  local proxy_env=()
  [[ -n "${http_proxy:-}"  ]] && proxy_env+=( "http_proxy=${http_proxy}" )
  [[ -n "${https_proxy:-}" ]] && proxy_env+=( "https_proxy=${https_proxy}" )
  [[ -n "${HTTP_PROXY:-}"  ]] && proxy_env+=( "HTTP_PROXY=${HTTP_PROXY}" )
  [[ -n "${HTTPS_PROXY:-}" ]] && proxy_env+=( "HTTPS_PROXY=${HTTPS_PROXY}" )
  [[ -n "${no_proxy:-}"    ]] && proxy_env+=( "no_proxy=${no_proxy}" )
  [[ -n "${NO_PROXY:-}"    ]] && proxy_env+=( "NO_PROXY=${NO_PROXY}" )

  sudo -u "${APP_USER}" -H env HOME="${APP_USER_HOME}" "${proxy_env[@]}" "$@" bash -lc "$command"
}

is_clock_synchronized() {
  if ! command_exists timedatectl; then
    return 1
  fi

  local value
  value="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  [[ "$value" == "yes" ]]
}

try_sync_clock() {
  if ! command_exists timedatectl; then
    warn "timedatectl is not available. Skipping clock sync check."
    return 1
  fi

  step "Check clock sync status"
  if is_clock_synchronized; then
    info "System clock is synchronized."
    return 0
  fi

  warn "System clock is not synchronized yet. Enabling NTP and waiting."
  run timedatectl set-ntp true || true
  if command_exists systemctl; then
    run systemctl restart systemd-timesyncd || true
  fi

  local i
  for i in 1 2 3 4 5; do
    sleep 3
    if is_clock_synchronized; then
      info "System clock synchronized successfully."
      return 0
    fi
  done

  warn "System clock is still not synchronized. apt update will retry with date checks disabled."
  return 1
}

apt_update() {
  if run apt-get update -y; then
    return 0
  fi

  # First retry: disable sources that return 502/404 (e.g. apt.armbian.com
  # redirecting to mirrors.nju.edu.cn which may be temporarily unavailable).
  warn "apt-get update failed. Disabling unreachable sources and retrying."
  local disabled_files=()
  local src_file
  for src_file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
    [[ -f "${src_file}" ]] || continue
    local bad=0
    while IFS= read -r url; do
      local code
      code="$(curl -x "${http_proxy:-}" -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "${url}" 2>/dev/null || echo "000")"
      if [[ "${code}" =~ ^(404|502|503|000)$ ]]; then
        bad=1
        break
      fi
    done < <(grep -oE 'https?://[^ ]+' "${src_file}" 2>/dev/null | head -5)
    if [[ "${bad}" -eq 1 ]]; then
      warn "Disabling unreachable source: ${src_file}"
      run mv "${src_file}" "${src_file}.disabled"
      disabled_files+=("${src_file}")
    fi
  done

  if [[ ${#disabled_files[@]} -gt 0 ]] && run apt-get update -y; then
    info "apt-get update succeeded after disabling ${#disabled_files[@]} unreachable source(s)."
    return 0
  fi

  warn "Retrying after clock synchronization."
  try_sync_clock || true

  if run apt-get update -y; then
    return 0
  fi

  warn "apt-get update still failed after clock sync. Retrying with Acquire::Check-Date=false."
  if run apt-get -o Acquire::Check-Date=false update -y; then
    return 0
  fi

  # Last resort: if a proxy is set but the failure looks network-related,
  # drop the proxy and try direct connection. Useful when the proxy is
  # configured but the device is on a network that can't reach it.
  if [[ -n "${http_proxy:-}${https_proxy:-}" ]]; then
    warn "apt-get update still failed. Retrying with proxy unset (direct connection)."
    local saved_http="${http_proxy:-}" saved_https="${https_proxy:-}"
    local saved_HTTP="${HTTP_PROXY:-}" saved_HTTPS="${HTTPS_PROXY:-}"
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
    if run apt-get -o Acquire::Check-Date=false update -y; then
      return 0
    fi
    # Restore proxy in case later stages still need it
    [[ -n "${saved_http}"  ]] && export http_proxy="${saved_http}"
    [[ -n "${saved_https}" ]] && export https_proxy="${saved_https}"
    [[ -n "${saved_HTTP}"  ]] && export HTTP_PROXY="${saved_HTTP}"
    [[ -n "${saved_HTTPS}" ]] && export HTTPS_PROXY="${saved_HTTPS}"
  fi

  # Restore disabled sources so they are not silently lost
  local f
  for f in "${disabled_files[@]}"; do
    [[ -f "${f}.disabled" ]] && run mv "${f}.disabled" "${f}"
  done

  err "apt-get update failed after all retries."
  return 1
}

require_debian_like() {
  if [[ ! -r /etc/os-release ]]; then
    err "Cannot read /etc/os-release. This system is not supported."
    exit 1
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  local id_like_value="${ID_LIKE:-}"
  local id_value="${ID:-}"
  if [[ "${id_value}" != "ubuntu" && "${id_value}" != "debian" && "${id_like_value}" != *"debian"* ]]; then
    err "This script supports only Debian, Ubuntu, or Armbian-like systems."
    echo "Detected: ID=${id_value:-unknown}, ID_LIKE=${id_like_value:-unknown}"
    exit 1
  fi

  info "Detected supported system: ${PRETTY_NAME:-unknown}"
}

require_supported_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64)
      NODE_ARCH="arm64"
      info "Detected supported architecture: $arch"
      ;;
    x86_64|amd64)
      NODE_ARCH="x64"
      info "Detected supported architecture: $arch"
      ;;
    *)
      err "Unsupported or unverified architecture: $arch"
      err "Use an arm64/aarch64 or amd64/x86_64 device."
      exit 1
      ;;
  esac
}

install_base_packages() {
  step "Install base packages"
  apt_update
  run apt-get install -y \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    gnupg \
    libssl-dev \
    lsb-release \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    build-essential \
    pkg-config \
    xz-utils \
    fonts-wqy-zenhei \
    fonts-wqy-microhei
}

ensure_app_user() {
  step "Prepare runtime user"
  if id "${APP_USER}" >/dev/null 2>&1; then
    info "Runtime user already exists: ${APP_USER}"
  else
    run useradd --create-home --shell /bin/bash "${APP_USER}"
    info "Created runtime user: ${APP_USER}"
  fi

  APP_USER_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
  if [[ -z "${APP_USER_HOME}" ]]; then
    err "Failed to resolve HOME for runtime user ${APP_USER}."
    exit 1
  fi

  run mkdir -p "${APP_USER_HOME}/.local/bin"
  chown_r_mount_safe "${APP_USER}:${APP_USER}" "${APP_USER_HOME}"
}

prepare_usb_mount_environment() {
  step "Prepare USB mount environment"

  # 1. Install exfat userspace utilities (needed for mount -t exfat)
  local -a exfat_pkgs=()
  if ! is_apt_package_installed "exfat-fuse" 2>/dev/null; then
    exfat_pkgs+=("exfat-fuse")
  fi
  # exfatprogs (newer) or exfat-utils (older) — install whichever is available
  if ! is_apt_package_installed "exfatprogs" 2>/dev/null && ! is_apt_package_installed "exfat-utils" 2>/dev/null; then
    if apt-cache show exfatprogs >/dev/null 2>&1; then
      exfat_pkgs+=("exfatprogs")
    elif apt-cache show exfat-utils >/dev/null 2>&1; then
      exfat_pkgs+=("exfat-utils")
    fi
  fi
  # ntfs-3g for NTFS USB drives
  if ! is_apt_package_installed "ntfs-3g" 2>/dev/null; then
    exfat_pkgs+=("ntfs-3g")
  fi
  if [[ ${#exfat_pkgs[@]} -gt 0 ]]; then
    info "Installing USB filesystem packages: ${exfat_pkgs[*]}"
    apt_update
    run apt-get install -y "${exfat_pkgs[@]}" || warn "Failed to install some USB filesystem packages (non-fatal)."
  else
    info "USB filesystem packages already installed."
  fi

  # 2. Load exfat kernel module immediately
  if run modprobe exfat 2>/dev/null; then
    info "Loaded exfat kernel module."
  else
    warn "Could not load exfat kernel module now (may need a reboot or module is built-in)."
  fi

  # 3. Persist exfat module auto-load at boot
  local modules_load_file="/etc/modules-load.d/hermes-usb-filesystems.conf"
  if [[ ! -f "${modules_load_file}" ]] || ! grep -q "^exfat$" "${modules_load_file}" 2>/dev/null; then
    run tee "${modules_load_file}" >/dev/null <<'EOF'
# Hermes Web UI: auto-load USB filesystem kernel modules at boot
exfat
EOF
    info "Persisted exfat module auto-load: ${modules_load_file}"
  else
    info "exfat module auto-load already configured."
  fi

  # 4. Add APP_USER to 'disk' group for block device read/write access
  if getent group disk >/dev/null 2>&1; then
    if ! id -nG "${APP_USER}" | grep -qw "disk"; then
      run usermod -aG disk "${APP_USER}"
      info "Added ${APP_USER} to 'disk' group for block device access."
    else
      info "${APP_USER} is already in the 'disk' group."
    fi
  fi

  # 5. Install sudoers policy for USB mount operations (NOPASSWD)
  local usb_sudoers_file="/etc/sudoers.d/hermes-usb-mount"
  local mount_bin umount_bin modprobe_bin blkid_bin
  mount_bin="$(command -v mount 2>/dev/null || echo /usr/bin/mount)"
  umount_bin="$(command -v umount 2>/dev/null || echo /usr/bin/umount)"
  modprobe_bin="$(command -v modprobe 2>/dev/null || echo /sbin/modprobe)"
  blkid_bin="$(command -v blkid 2>/dev/null || echo /usr/sbin/blkid)"

  local usb_sudoers_tmp
  usb_sudoers_tmp="$(mktemp)"
  cat >"${usb_sudoers_tmp}" <<EOF
# Hermes Web UI: allow ${APP_USER} to mount/unmount USB devices and load filesystem modules
${APP_USER} ALL=(root) NOPASSWD: ${mount_bin}, ${umount_bin}, ${modprobe_bin}, ${blkid_bin}
EOF
  run install -o root -g root -m 0440 "${usb_sudoers_tmp}" "${usb_sudoers_file}"
  if command -v visudo >/dev/null 2>&1; then
    run visudo -cf "${usb_sudoers_file}"
  fi
  rm -f "${usb_sudoers_tmp}"
  info "Installed USB mount sudoers policy: ${usb_sudoers_file}"

  # 6. Create USB mount root directory owned by APP_USER
  local usb_mount_root="${APP_USER_HOME}/.hermes-web-ui/mnt/usb"
  run mkdir -p "${usb_mount_root}"
  chown_r_mount_safe "${APP_USER}:${APP_USER}" "${APP_USER_HOME}/.hermes-web-ui/mnt"
  info "USB mount root directory ready: ${usb_mount_root}"
}

resolve_repo_dir() {
  # caller-provided DEPLOY_DIR is the single source of truth. If it is set
  # (non-empty) we trust it as-is, regardless of USE_CONFIGURED_DEPLOY_DIR.
  # This lets orchestrators (e.g. unzip.sh) redirect the build to a
  # permission-friendly path like /opt/hermes-web-ui/src without being
  # hijacked by the script's own BASH_SOURCE-derived location, which on
  # many systems lives under /root (mode 700) and is unreachable for
  # non-root users.
  if [[ -n "${DEPLOY_DIR}" ]]; then
    if [[ ! -d "${DEPLOY_DIR}" ]]; then
      err "DEPLOY_DIR=${DEPLOY_DIR} does not exist or is not a directory."
      err "Extract the source archive first, then rerun this script."
      exit 1
    fi
    if [[ "${USE_CONFIGURED_DEPLOY_DIR}" == "true" ]]; then
      info "Using DEPLOY_DIR provided by the caller: ${DEPLOY_DIR}"
    else
      info "Using DEPLOY_DIR from environment: ${DEPLOY_DIR}"
    fi
    return 0
  fi

  # Fall back to the source tree next to the script when DEPLOY_DIR is
  # unset. This preserves the historical behaviour for direct invocations
  # like `sudo bash scripts/deploy-source-armbian.sh`.
  local script_root
  script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ -f "${script_root}/package.json" ]]; then
    DEPLOY_DIR="${script_root}"
    info "Using source tree next to the script: ${DEPLOY_DIR}"
    return 0
  fi

  err "No source tree found."
  err "  - DEPLOY_DIR is empty"
  err "  - ${script_root}/package.json does not exist"
  err "Set DEPLOY_DIR or place package.json next to this script, then rerun."
  exit 1
}

prepare_deploy_dirs() {
  step "Prepare deployment directories"
  run mkdir -p "${DEPLOY_DIR}" "${HERMES_HOME_DIR}" "${NODE_INSTALL_DIR}" "$(dirname "${SERVICE_ENV_FILE}")"
  chown_r_mount_safe "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}"
  chown_r_mount_safe "${APP_USER}:${APP_USER}" "${HERMES_HOME_DIR}"
  info "Source directory: ${DEPLOY_DIR}"
  info "Hermes data directory: ${HERMES_HOME_DIR}"
}

download_file() {
  local output="$1"
  shift

  local url
  for url in "$@"; do
    if curl -fsSL --connect-timeout 10 --retry 2 --retry-delay 2 "$url" -o "$output"; then
      info "Downloaded successfully: $url"
      return 0
    fi
    warn "Download failed, trying next URL: $url"
  done

  return 1
}

resolve_hermes_agent_wheel_url() {
  local latest_flag="${HERMES_AGENT_UPDATE_LATEST_STABLE:-false}"
  case "${latest_flag,,}" in
    1|true|yes|on)
      ;;
    *)
      return 0
      ;;
  esac

  if [[ -n "${HERMES_AGENT_WHEEL_URL}" && "${HERMES_AGENT_WHEEL_URL}" != "${DEFAULT_HERMES_AGENT_WHEEL_URL}" ]]; then
    info "Using caller-provided Hermes Agent wheel URL override: ${HERMES_AGENT_WHEEL_URL}"
    return 0
  fi

  if [[ -n "${HERMES_AGENT_UPDATE_MANIFEST_URL:-}" ]]; then
    step "Resolve latest stable Hermes Agent wheel from update manifest"
    local resolved_manifest_values
    resolved_manifest_values="$(
      python3 - "${HERMES_AGENT_UPDATE_MANIFEST_URL}" <<'PY'
import json
import sys
import urllib.request

manifest_url = sys.argv[1]
request = urllib.request.Request(
    manifest_url,
    headers={
        "Accept": "application/json",
        "User-Agent": "hermes-web-ui-deploy-source-armbian",
    },
)
with urllib.request.urlopen(request, timeout=20) as response:
    payload = json.load(response)

wheel_urls = payload.get("wheelUrls") or []
wheel_url = ""
for candidate in wheel_urls:
    candidate = str(candidate or "").strip()
    if candidate:
        wheel_url = candidate
        break
if not wheel_url:
    wheel_url = str(payload.get("wheelUrl") or "").strip()
if not wheel_url:
    raise SystemExit(f"Manifest {manifest_url} does not contain wheelUrl or wheelUrls")

wheelhouse_url = str(payload.get("wheelhouseUrl") or "").strip()
print(wheel_url)
print(wheelhouse_url)
PY
    )" || true
    if [[ -n "${resolved_manifest_values}" ]]; then
      HERMES_AGENT_WHEEL_URL="$(printf '%s\n' "${resolved_manifest_values}" | sed -n '1p')"
      if [[ -z "${HERMES_AGENT_WHEELHOUSE_URL:-}" ]]; then
        HERMES_AGENT_WHEELHOUSE_URL="$(printf '%s\n' "${resolved_manifest_values}" | sed -n '2p')"
      fi
      info "Resolved latest stable Hermes Agent wheel from manifest: ${HERMES_AGENT_WHEEL_URL}"
      if [[ -n "${HERMES_AGENT_WHEELHOUSE_URL:-}" ]]; then
        info "Using Hermes Agent wheelhouse: ${HERMES_AGENT_WHEELHOUSE_URL}"
      fi
      return 0
    fi
    warn "Failed to resolve Hermes Agent wheel from ${HERMES_AGENT_UPDATE_MANIFEST_URL}. Falling back to GitHub release metadata."
  fi

  step "Resolve latest stable Hermes Agent wheel from PyPI"
  local resolved_url resolved_version
  resolved_url="$(
    python3 - "${HERMES_AGENT_PYPI_SIMPLE_URL:-https://pypi.org/simple/hermes-agent/}" "${HERMES_AGENT_RELEASES_API_URL}" <<'PY'
import json
import re
import sys
import urllib.request

simple_url = sys.argv[1]
pypi_json_url = sys.argv[2]
USER_AGENT = "hermes-web-ui-deploy-source-armbian"

WHEEL_RE = re.compile(r"hermes_agent-(\d+(?:\.\d+)+(?:[a-z0-9\.\-\+]*)?)-py3-none-any\.whl", re.IGNORECASE)


def parse_version(tag):
    parts = []
    for chunk in re.split(r"[^0-9a-zA-Z]+", tag):
        if not chunk:
            continue
        if chunk.isdigit():
            parts.append((0, int(chunk)))
        else:
            parts.append((1, chunk))
    return tuple(parts)


def from_simple_index(url):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.pypi.simple.v1+html, text/html", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read().decode("utf-8", errors="replace")

    candidates = []
    for match in re.finditer(r'href="([^"]+)"[^>]*>\s*([A-Za-z0-9._\-+]+)\s*</a>', body):
        href, name = match.group(1), match.group(2)
        m = WHEEL_RE.match(name)
        if not m:
            continue
        # Strip the `#sha256=...` fragment from the URL
        clean_url = href.split("#", 1)[0]
        candidates.append((parse_version(m.group(1)), clean_url, m.group(1)))

    if not candidates:
        raise SystemExit(f"No stable hermes-agent wheel found in PyPI simple index: {url}")
    candidates.sort(key=lambda c: c[0])
    best = candidates[-1]
    return best[1], best[2]


def from_pypi_json(url):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.load(response)

    urls = payload.get("urls") or []
    candidates = []
    for asset in urls:
        name = str(asset.get("filename") or "")
        link = str(asset.get("url") or "")
        m = WHEEL_RE.match(name)
        if not m or not link:
            continue
        candidates.append((parse_version(m.group(1)), link, m.group(1)))

    if not candidates:
        raise SystemExit(f"No stable hermes-agent wheel found in PyPI JSON payload: {url}")
    candidates.sort(key=lambda c: c[0])
    best = candidates[-1]
    return best[1], best[2]


# Try PyPI simple index first (lightweight, always lists every wheel).
try:
    url, version = from_simple_index(simple_url)
    print(url)
    print(version)
    sys.exit(0)
except Exception as exc:
    sys.stderr.write(f"PyPI simple index lookup failed: {exc}\n")

# Fallback: explicit PyPI JSON API (used when caller overrides).
try:
    url, version = from_pypi_json(pypi_json_url)
    print(url)
    print(version)
    sys.exit(0)
except Exception as exc:
    sys.stderr.write(f"PyPI JSON API lookup failed: {exc}\n")

raise SystemExit("Unable to resolve a stable hermes-agent wheel from PyPI.")
PY
  )" || {
    err "Failed to resolve the latest stable Hermes Agent wheel URL."
    exit 1
  }
  resolved_url="$(printf '%s\n' "${resolved_url}" | sed -n '1p')"
  resolved_version="$(printf '%s\n' "${resolved_url}" | sed -n '2p')"
  if [[ -z "${resolved_url}" ]]; then
    err "Failed to resolve the latest stable Hermes Agent wheel URL."
    exit 1
  fi
  HERMES_AGENT_WHEEL_URL="${resolved_url}"
  if [[ -n "${resolved_version}" ]]; then
    info "Resolved latest stable Hermes Agent wheel ${resolved_version}: ${HERMES_AGENT_WHEEL_URL}"
  else
    info "Resolved latest stable Hermes Agent wheel: ${HERMES_AGENT_WHEEL_URL}"
  fi
}

install_node() {
  step "Install Node.js ${NODE_VERSION}"

  local installed_major=""
  if [[ -x "${NODE_BIN}" ]]; then
    installed_major="$("${NODE_BIN}" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
  fi
  if [[ "${installed_major}" =~ ^[0-9]+$ ]] && [[ "${installed_major}" -ge "${NODE_REQUIRED_MAJOR}" ]]; then
    info "Node.js already satisfies the requirement: $("${NODE_BIN}" -v)"
    return 0
  fi

  local tmp_dir archive_path
  tmp_dir="$(mktemp -d)"
  archive_path="${tmp_dir}/node.tar.xz"

  download_file "${archive_path}" \
    "${NODE_MIRROR_URL%/}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    "${NODE_FALLBACK_URL%/}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"

  run rm -rf "${NODE_INSTALL_DIR}"
  run mkdir -p "${NODE_INSTALL_DIR}"
  run tar -xJf "${archive_path}" --strip-components=1 -C "${NODE_INSTALL_DIR}"

  rm -rf "${tmp_dir}"
  info "Node.js installation completed: $("${NODE_BIN}" -v)"
}

ensure_wheel_anthropic_pin() {
  local venv_dir="${APP_USER_HOME}/.hermes/hermes-agent-venv"
  if [[ -z "${HERMES_ANTHROPIC_VERSION:-}" ]]; then
    info "No HERMES_ANTHROPIC_VERSION override provided. Skipping Anthropic SDK pin."
    return 0
  fi

  if [[ ! -x "${venv_dir}/bin/pip" ]]; then
    warn "Wheel venv not found at ${venv_dir}; skipping Anthropic SDK pin."
    return 0
  fi

  step "Pin Anthropic SDK for Anthropic-compatible providers"
  run_as_app_user "'${venv_dir}/bin/pip' install --force-reinstall 'anthropic==${HERMES_ANTHROPIC_VERSION}'"
  run_as_app_user "'${venv_dir}/bin/python3' -c \"import anthropic; print(anthropic.__version__)\" >/dev/null"
  info "Pinned Anthropic SDK to ${HERMES_ANTHROPIC_VERSION} in ${venv_dir}"
}

install_hermes_agent() {
  local hermes_bin_candidate
  hermes_bin_candidate="${APP_USER_HOME}/.local/bin/hermes"
  resolve_hermes_agent_wheel_url

  # Mode A: Install from Wheel URL (Fast, no git clone)
  if [[ -n "${HERMES_AGENT_WHEEL_URL}" ]]; then
    local venv_dir="${APP_USER_HOME}/.hermes/hermes-agent-venv"
    local bin_dir="${APP_USER_HOME}/.local/bin"

    if run_as_app_user "test -x '${hermes_bin_candidate}'"; then
      step "Update Hermes Agent"
      info "Updating Hermes Agent from wheel: ${HERMES_AGENT_WHEEL_URL}"
    else
      step "Install Hermes Agent"
      info "Installing Hermes Agent from pre-built wheel: ${HERMES_AGENT_WHEEL_URL}"
    fi

    run_as_app_user "mkdir -p '${venv_dir}' '${bin_dir}'"
    if ! run_as_app_user "test -x '${venv_dir}/bin/python3'"; then
      run_as_app_user "python3 -m venv '${venv_dir}'"
    fi
    run_as_app_user "'${venv_dir}/bin/pip' install --upgrade pip"
    if [[ -n "${HERMES_AGENT_WHEELHOUSE_URL:-}" ]]; then
      if ! run_as_app_user "'${venv_dir}/bin/pip' install --upgrade --no-index --find-links '${HERMES_AGENT_WHEELHOUSE_URL}' '${HERMES_AGENT_WHEEL_URL}'"; then
        warn "Hermes Agent wheelhouse install failed. Retrying against the direct wheel URL."
        run_as_app_user "'${venv_dir}/bin/pip' install --upgrade '${HERMES_AGENT_WHEEL_URL}'"
      fi
    else
      run_as_app_user "'${venv_dir}/bin/pip' install --upgrade '${HERMES_AGENT_WHEEL_URL}'"
    fi
    ensure_wheel_anthropic_pin

    # Link the command
    run_as_app_user "ln -sf '${venv_dir}/bin/hermes' '${bin_dir}/hermes'"
    run_as_app_user "'${bin_dir}/hermes' version >/dev/null"
    info "Hermes Agent is ready from wheel at: ${hermes_bin_candidate}"
    return 0
  fi

  # Mode B: Official Installer (Legacy/Source)
  step "Install Hermes Agent"
  local install_command
  install_command=$(cat <<'EOF'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
tmp_installer="$(mktemp)"
cleanup() {
  rm -f "$tmp_installer"
}
trap cleanup EXIT
for url in \
  "${HERMES_INSTALLER_MIRROR}" \
  "${HERMES_INSTALLER_FALLBACK}"
do
  if curl -fsSL --connect-timeout 10 --retry 2 --retry-delay 2 "$url" -o "$tmp_installer"; then
    bash "$tmp_installer" ${HERMES_INSTALL_FLAGS}
    exit 0
  fi
done
echo "Failed to download the Hermes installer script." >&2
exit 1
EOF
)

  run_as_app_user "${install_command}" \
    HERMES_INSTALL_FLAGS="${HERMES_INSTALL_FLAGS}" \
    HERMES_INSTALLER_MIRROR="${HERMES_INSTALLER_MIRROR}" \
    HERMES_INSTALLER_FALLBACK="${HERMES_INSTALLER_FALLBACK}"

  if ! run_as_app_user "test -x '${hermes_bin_candidate}'"; then
    err "Hermes installation completed, but the binary was not found: ${hermes_bin_candidate}"
    exit 1
  fi

  info "Hermes installed at: ${hermes_bin_candidate}"
}

configure_app_user_shell_path() {
  step "Configure Hermes shell PATH"
  local profile_file
  profile_file="${APP_USER_HOME}/.profile"

  run touch "${profile_file}"
  if ! run grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "${profile_file}"; then
    run tee -a "${profile_file}" >/dev/null <<'EOF'
export PATH="$HOME/.local/bin:$PATH"
EOF
  fi

  run chown "${APP_USER}:${APP_USER}" "${profile_file}"
  info "Ensured ${APP_USER} login shells include ~/.local/bin in PATH."
}

install_root_hermes_wrapper() {
  step "Install root Hermes wrapper"
  run tee /usr/local/bin/hermes >/dev/null <<EOF
#!/usr/bin/env bash
exec sudo -u ${APP_USER} -H env \\
  HERMES_HOME=${HERMES_HOME_DIR} \\
  PATH=${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
  ${APP_USER_HOME}/.local/bin/hermes "\$@"
EOF
  run chmod 0755 /usr/local/bin/hermes
  info "Installed /usr/local/bin/hermes wrapper for root and admin shells."
}

write_npmrc() {
  step "Write npm mirror configuration"
  run tee "${APP_USER_HOME}/.npmrc" >/dev/null <<EOF
registry=${NPM_REGISTRY}
disturl=${NODE_MIRROR_URL%/}
electron_mirror=${NPM_BINARY_MIRROR_PREFIX%/}/electron/
puppeteer_download_host=${NPM_BINARY_MIRROR_PREFIX%/}
sharp_binary_host=${NPM_BINARY_MIRROR_PREFIX%/}/sharp
sharp_libvips_binary_host=${NPM_BINARY_MIRROR_PREFIX%/}/sharp-libvips
sqlite3_binary_site=${NPM_BINARY_MIRROR_PREFIX%/}/sqlite3
sass_binary_site=${NPM_BINARY_MIRROR_PREFIX%/}/node-sass
chromedriver_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/chromedriver
operadriver_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/operadriver
phantomjs_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/phantomjs
selenium_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/selenium
EOF
  run chown "${APP_USER}:${APP_USER}" "${APP_USER_HOME}/.npmrc"
  info "Wrote ${APP_USER_HOME}/.npmrc"
}

resolve_host_dependency_manifest_file() {
  local manifest_path="${DEPLOY_DIR}/${HOST_DEPENDENCY_MANIFEST_RELATIVE_PATH}"
  [[ -f "${manifest_path}" ]] || return 1
  printf '%s\n' "${manifest_path}"
}

load_managed_host_dependency_packages() {
  local manifest_path parsed_packages

  if ! manifest_path="$(resolve_host_dependency_manifest_file)"; then
    MANAGED_HOST_DEPENDENCY_MANIFEST_FILE=""
    MANAGED_HOST_APT_PACKAGES=()
    info "No managed host dependency manifest found at ${DEPLOY_DIR}/${HOST_DEPENDENCY_MANIFEST_RELATIVE_PATH}; skipping host dependency reconcile."
    return 0
  fi

  parsed_packages="$(
    python3 - "${manifest_path}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
payload = json.loads(manifest_path.read_text(encoding='utf-8'))
if not isinstance(payload, dict):
    raise SystemExit(f"Host dependency manifest must be a JSON object: {manifest_path}")

schema = int(payload.get('schema') or 0)
if schema != 1:
    raise SystemExit(f"Host dependency manifest schema must be 1: {manifest_path}")

apt_packages = []
seen = set()
for entry in payload.get('aptPackages') or []:
    normalized = str(entry or '').strip()
    if not normalized or normalized in seen:
        continue
    seen.add(normalized)
    apt_packages.append(normalized)

if not apt_packages:
    raise SystemExit(f"Host dependency manifest aptPackages must contain at least one package: {manifest_path}")

print("\n".join(apt_packages))
PY
  )" || {
    err "Failed to parse managed host dependency manifest: ${manifest_path}"
    exit 1
  }

  MANAGED_HOST_DEPENDENCY_MANIFEST_FILE="${manifest_path}"
  MANAGED_HOST_APT_PACKAGES=()
  while IFS= read -r package_name; do
    [[ -n "${package_name}" ]] && MANAGED_HOST_APT_PACKAGES+=("${package_name}")
  done <<< "${parsed_packages}"

  info "Loaded managed host dependencies from ${manifest_path}: ${MANAGED_HOST_APT_PACKAGES[*]}"
}

is_apt_package_installed() {
  local package_name="$1"
  dpkg-query -W -f='${db:Status-Status}' "${package_name}" 2>/dev/null | grep -qx 'installed'
}

reconcile_host_dependencies() {
  local package_name
  local -a missing_packages=()

  load_managed_host_dependency_packages
  if [[ ${#MANAGED_HOST_APT_PACKAGES[@]} -eq 0 ]]; then
    return 0
  fi

  for package_name in "${MANAGED_HOST_APT_PACKAGES[@]}"; do
    if ! is_apt_package_installed "${package_name}"; then
      missing_packages+=("${package_name}")
    fi
  done

  if [[ ${#missing_packages[@]} -eq 0 ]]; then
    info "Managed host dependencies are already installed."
    return 0
  fi

  step "Install managed host dependencies"
  info "Installing missing host dependencies from ${MANAGED_HOST_DEPENDENCY_MANIFEST_FILE}: ${missing_packages[*]}"
  apt_update
  run apt-get install -y "${missing_packages[@]}"
}

resolve_dependency_snapshot_file() {
  local webui_home
  webui_home="${HERMES_WEB_UI_HOME:-${APP_USER_HOME}/.hermes-web-ui}"
  printf '%s\n' "${HERMES_WEB_UI_DEPENDENCY_SNAPSHOT_FILE:-${webui_home}/updates/dependency-manifest.json}"
}

detect_update_package_manager() {
  if [[ -f "${DEPLOY_DIR}/pnpm-lock.yaml" ]]; then
    UPDATE_DEPENDENCY_MANAGER="pnpm"
  elif [[ -f "${DEPLOY_DIR}/yarn.lock" ]]; then
    UPDATE_DEPENDENCY_MANAGER="yarn"
  else
    UPDATE_DEPENDENCY_MANAGER="npm"
  fi
}

capture_dependency_snapshot() {
  DEPENDENCY_SNAPSHOT_JSON="$(
    python3 - "${DEPLOY_DIR}" "${UPDATE_DEPENDENCY_MANAGER}" <<'PY'
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

deploy_dir = Path(sys.argv[1])
package_manager = sys.argv[2]
tracked_files = [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
]

payload = {
    'packageManager': package_manager,
    'files': {},
}
for relative_path in tracked_files:
    path = deploy_dir / relative_path
    if not path.is_file():
        continue
    payload['files'][relative_path] = hashlib.sha256(path.read_bytes()).hexdigest()

print(json.dumps(payload, sort_keys=True))
PY
  )"
}

evaluate_dependency_snapshot() {
  local snapshot_file compare_result
  snapshot_file="$(resolve_dependency_snapshot_file)"

  detect_update_package_manager
  capture_dependency_snapshot

  if [[ ! -f "${snapshot_file}" ]]; then
    DEPENDENCY_SNAPSHOT_CHANGED=true
    DEPENDENCY_INSTALL_REASON="No previous dependency snapshot found; running a full ${UPDATE_DEPENDENCY_MANAGER} install."
    return 0
  fi

  compare_result="$(
    python3 - "${snapshot_file}" "${DEPENDENCY_SNAPSHOT_JSON}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

snapshot_path = Path(sys.argv[1])
current = json.loads(sys.argv[2])
previous = json.loads(snapshot_path.read_text(encoding='utf-8'))

previous_manager = str(previous.get('packageManager') or '').strip()
current_manager = str(current.get('packageManager') or '').strip()
if previous_manager != current_manager:
    print('changed')
    print(f'Package manager changed from {previous_manager or "unknown"} to {current_manager or "unknown"}; reinstalling dependencies.')
    raise SystemExit(0)

previous_files = previous.get('files') or {}
current_files = current.get('files') or {}
if previous_files != current_files:
    changed_files = sorted({
        *previous_files.keys(),
        *current_files.keys(),
    })
    print('changed')
    print(f'Dependency manifests changed ({", ".join(changed_files)}); reinstalling dependencies.')
    raise SystemExit(0)

print('unchanged')
print(f'Dependency manifests are unchanged; reinstalling {current_manager or "npm"} dependencies for a clean runtime cutover.')
PY
  )"

  DEPENDENCY_SNAPSHOT_CHANGED=true
  if [[ "$(printf '%s\n' "${compare_result}" | sed -n '1p')" == "unchanged" ]]; then
    DEPENDENCY_SNAPSHOT_CHANGED=false
  fi
  DEPENDENCY_INSTALL_REASON="$(printf '%s\n' "${compare_result}" | sed -n '2p')"
}

persist_dependency_snapshot() {
  local snapshot_file snapshot_dir
  snapshot_file="$(resolve_dependency_snapshot_file)"
  snapshot_dir="$(dirname "${snapshot_file}")"
  run mkdir -p "${snapshot_dir}"
  printf '%s\n' "${DEPENDENCY_SNAPSHOT_JSON}" | run tee "${snapshot_file}" >/dev/null
  chown_r_mount_safe "${APP_USER}:${APP_USER}" "${snapshot_dir}"
  info "Recorded dependency snapshot: ${snapshot_file}"
}

run_dependency_install_command() {
  local path_env="$1"
  case "${UPDATE_DEPENDENCY_MANAGER}" in
    npm)
      run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' npm install --include=dev --ignore-scripts"
      ;;
    pnpm)
      run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' corepack pnpm install --frozen-lockfile --ignore-scripts"
      ;;
    yarn)
      run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' corepack yarn install --frozen-lockfile --ignore-scripts --non-interactive"
      ;;
    *)
      err "Unsupported package manager for update dependency install: ${UPDATE_DEPENDENCY_MANAGER}"
      exit 1
      ;;
  esac
}

install_webui_dependencies() {
  if [[ -n "${WEBUI_BUNDLE_URL}" ]]; then
    step "Install hermes-web-ui from bundle"
    local tmp_bundle
    tmp_bundle="$(mktemp)"
    if download_file "${tmp_bundle}" "${WEBUI_BUNDLE_URL}"; then
      run chown "${APP_USER}:${APP_USER}" "${tmp_bundle}"
      run_as_app_user "cd '${DEPLOY_DIR}' && tar -xzf '${tmp_bundle}'"
      rm -f "${tmp_bundle}"
      info "Extracted web-ui bundle to ${DEPLOY_DIR}"
      return 0
    fi
    warn "Failed to download web-ui bundle. Falling back to npm install."
  fi

  step "Install hermes-web-ui dependencies"
  local path_env
  path_env="${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  evaluate_dependency_snapshot
  chown_r_mount_safe "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}"
  if [[ "${WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES}" != "true" ]]; then
    err "Automatic dependency installation is disabled, but update-only deploys require node_modules to be rebuilt."
    exit 1
  fi
  info "${DEPENDENCY_INSTALL_REASON}"
  # Use --ignore-scripts so the root `prepare` hook (which calls `npm run build`
  # itself) does not race with build_webui below and leave a stale `dist/` from
  # an older source tree. build_webui is the single source of truth for the
  # deploy build.
  run_dependency_install_command "${path_env}"

  # Rebuild optional native bindings skipped by --ignore-scripts.
  # node-pty is a native module (binding.gyp) that needs node-gyp + build-essential.
  # Failure is non-fatal — terminal feature degrades gracefully.
  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' npm rebuild node-pty 2>/dev/null" || \
    warn "Optional native binding node-pty rebuild failed (terminal feature will be disabled)"

  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' npm ls --depth=0 @vscode/markdown-it-katex naive-ui typescript vite vue-tsc >/dev/null"
  persist_dependency_snapshot
}

check_webui_dependencies() {
  step "Check installed Web UI dependencies"

  # Always verify the build-time node_modules are present, even if a previous
  # `dist/` exists.  Trusting a stale build artifact here is what allowed
  # `dist/server/index.js` from an older version to keep being executed after
  # a source upgrade.
  run test -f "${DEPLOY_DIR}/node_modules/naive-ui/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/naive-ui/es/index.d.ts"
  run test -f "${DEPLOY_DIR}/node_modules/typescript/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/vue-tsc/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/vite/package.json"
  info "Required build-time dependencies are present."
}

build_webui() {
  # Force a clean rebuild on every deploy.  A previous `dist/` from an older
  # source tree (with a different `__APP_VERSION__` baked in via
  # scripts/build-server.mjs) would otherwise be reused by the systemd unit,
  # causing the version cutover check in post_deploy_self_check to fail with
  # "did not report webui_version=<expected>".
  step "Clean previous build artifacts"
  run rm -rf "${DEPLOY_DIR}/dist"

  step "Build hermes-web-ui"
  local path_env
  path_env="${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' npm run build"
}

# Pre-warm the Python venv used by the meeting-asr backend so that the first
# meeting start on ARM64 doesn't block 5-10 minutes on `pip install`.
# Runs as the app user so the resulting .venv is owned correctly.
#
# v0.7.16+: the venv lives under the meeting-asr data directory, NOT under
# `dist/server/python-backend/`. The dist tree is owned by the deploy user and
# must not be writable by the runtime user; keeping the venv next to
# `config.json` / `analysis.json` / `.env` means it shares the data-dir
# ownership guarantees and survives device-package upgrades.
prewarm_meeting_asr_venv() {
  local python_backend_dir="${DEPLOY_DIR}/dist/server/python-backend"
  local requirements_file="${DEPLOY_DIR}/dist/server/requirements.txt"
  local data_dir="${MEETING_ASR_DATA_DIR:-/var/lib/hermes-web-ui/meeting-asr}"
  local venv_dir="${data_dir}/.venv"

  if [[ ! -d "${python_backend_dir}" ]]; then
    info "Meeting ASR backend not packaged (no ${python_backend_dir}); skipping venv pre-warm."
    return 0
  fi
  if [[ ! -f "${requirements_file}" ]]; then
    info "Meeting ASR requirements.txt missing at ${requirements_file}; skipping venv pre-warm."
    return 0
  fi

  step "Pre-warm Meeting ASR Python venv at ${venv_dir} (ARM64 pip install may take several minutes)"
  # /var/lib is root-owned, so create the state dir as root first, then hand
  # it to the app user; the venv itself must be created by the app user so the
  # deployed tree stays non-writable by runtime. (StateDirectory= in the unit
  # template would do this on first start, but pre-warming happens before the
  # service ever runs — see the v0.8.0 6.6.6.31 failure.)
  run mkdir -p "${data_dir}"
  run chown "${APP_USER}:${APP_USER}" "${data_dir}"
  run_as_app_user "python3 -m venv '${venv_dir}'"
  # Use the venv pip directly. Avoid printing the full install log on success;
  # surface only tail on failure. cwd stays in backend dir so relative paths in
  # requirements.txt resolve; the venv itself is under the data dir.
  if ! run_as_app_user "cd '${python_backend_dir}' && '${venv_dir}/bin/pip' install --disable-pip-version-check -r '${requirements_file}'" 2>&1 | tail -20; then
    warn "Meeting ASR venv pre-warm failed. The service will retry on first /api/meeting-asr/start."
    warn "Check 'journalctl -u ${SYSTEMD_SERVICE_NAME}' for details."
    return 0
  fi
  # Marker is written by the service on first successful start; we don't
  # pre-create it so the marker always reflects a runtime-verified install.
  info "Meeting ASR venv pre-warmed successfully at ${venv_dir}."
}

write_service_env() {
  step "Write service environment file"
  local hermes_bin
  local hermes_agent_root
  local webui_home
  local update_runner_request_file
  hermes_bin="${APP_USER_HOME}/.local/bin/hermes"
  hermes_agent_root=""
  webui_home="${HERMES_WEB_UI_HOME:-${APP_USER_HOME}/.hermes-web-ui}"
  update_runner_request_file="${WEBUI_UPDATE_RUNNER_REQUEST_FILE:-${webui_home}/updates/update-runner-request.json}"
  if [[ -z "${HERMES_AGENT_WHEEL_URL}" ]]; then
    hermes_agent_root="${APP_USER_HOME}/.hermes/hermes-agent"
  fi

  run tee "${SERVICE_ENV_FILE}" >/dev/null <<EOF
PORT=${PORT}
BIND_HOST=${BIND_HOST}
NODE_ENV=production
HOME=${APP_USER_HOME}
PATH=${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# The update controller passes this to the orchestrator verbatim. It MUST
# stay the deploy LINK (not a resolved physical path): systemd resolves
# WorkingDirectory at start time, so a cwd fallback goes stale after the
# first swap and drives every later update through the orchestrator's
# legacy real-dir branch (6.6.6.73 web-click failure, 2026-09-08).
DEPLOY_DIR=${DEPLOY_DIR}
HERMES_HOME=${HERMES_HOME_DIR}
HERMES_BIN=${hermes_bin}
${hermes_agent_root:+HERMES_AGENT_ROOT=${hermes_agent_root}}
HERMES_WEB_UI_HOME=${webui_home}
# Meeting ASR data dir (must match prewarm_meeting_asr_venv so the pre-warmed
# venv is the one the runtime service reuses; see v0.7.16 audit #1). Must
# also match hermes-web-ui.service's StateDirectory= so systemd chowns it
# to the runtime user before first start.
MEETING_ASR_DATA_DIR=${MEETING_ASR_DATA_DIR:-/var/lib/hermes-web-ui/meeting-asr}
LANG=C.UTF-8
LC_ALL=C.UTF-8
EOF

  run chown root:root "${SERVICE_ENV_FILE}"
  run chmod 0644 "${SERVICE_ENV_FILE}"

  local update_env_name update_env_value
  for update_env_name in \
    UPLOAD_DIR \
    HERMES_AGENT_SERVICE_NAME \
    HERMES_AGENT_BRIDGE_ENDPOINT \
    HERMES_AGENT_BRIDGE_KILL_STALE_IPC \
    HERMES_AGENT_WHEEL_URL \
    HERMES_AGENT_WHEELHOUSE_URL \
    HERMES_AGENT_RELEASES_API_URL \
    HERMES_AGENT_UPDATE_MANIFEST_URL \
    HERMES_ANTHROPIC_VERSION \
    WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES \
    WEBUI_UPDATE_ENABLED \
    WEBUI_UPDATE_PACKAGE \
    WEBUI_UPDATE_REGISTRY \
    WEBUI_UPDATE_CLI_BIN \
    WEBUI_UPDATE_SOURCE_LABEL \
    WEBUI_UPDATE_DIST_TAG \
    WEBUI_UPDATE_STRATEGY \
    WEBUI_UPDATE_SCRIPT \
    WEBUI_UPDATE_REPO \
    WEBUI_UPDATE_MANIFEST_URL \
    WEBUI_UPDATE_MANIFEST_URLS \
    WEBUI_UPDATE_MANIFEST_BASE_URL \
    WEBUI_UPDATE_MANIFEST_BASE_URLS \
    WEBUI_UPDATE_CHANNEL \
    WEBUI_UPDATE_PACKAGE_TYPE \
    WEBUI_UPDATE_INSTALLER_SCRIPT \
    WEBUI_UPDATE_RUNNER_SERVICE \
    WEBUI_UPDATE_RUNNER_REQUEST_FILE \
    WEBUI_UPDATE_VERIFY_SHA256 \
    WEBUI_UPDATE_STAGING_DIR \
    WEBUI_UPDATE_BACKUP_DIR \
    WEBUI_UPDATE_HEALTHCHECK_URL \
    WEBUI_UPDATE_STATE_FILE \
    WEBUI_UPDATE_LOG_DIR \
    WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS \
    WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS \
    WEBUI_UPDATE_HEALTHCHECK_RETRIES \
    WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS \
    HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES \
    HERMES_WEB_UI_UPDATE_RESTART_AGENT_RUNTIME \
    USB_USE_SUDO
  do
    update_env_value="${!update_env_name:-}"
    if [[ -z "${update_env_value}" ]]; then
      case "${update_env_name}" in
        WEBUI_UPDATE_RUNNER_SERVICE)
          update_env_value="${UPDATE_RUNNER_SERVICE_NAME}"
          ;;
        WEBUI_UPDATE_RUNNER_REQUEST_FILE)
          update_env_value="${update_runner_request_file}"
          ;;
        WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES|HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES)
          update_env_value="${WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES}"
          ;;
        HERMES_WEB_UI_UPDATE_RESTART_AGENT_RUNTIME)
          update_env_value="${RESTART_AGENT_RUNTIME}"
          ;;
        HERMES_AGENT_BRIDGE_KILL_STALE_IPC)
          update_env_value="1"
          ;;
        USB_USE_SUDO)
          update_env_value="true"
          ;;
      esac
    fi
    if [[ -n "${update_env_value}" ]]; then
      run tee -a "${SERVICE_ENV_FILE}" >/dev/null <<EOF
${update_env_name}=${update_env_value}
EOF
    fi
  done

  info "Wrote ${SERVICE_ENV_FILE}"
}

systemd_unit_exists() {
  local unit_name="$1"
  systemctl cat "${unit_name}" >/dev/null 2>&1
}

cleanup_stale_agent_runtime() {
  local bridge_endpoint="${HERMES_AGENT_BRIDGE_ENDPOINT:-ipc:///tmp/hermes-agent-bridge.sock}"
  local removed_any=false

  if [[ "${bridge_endpoint}" != ipc://* ]]; then
    info "Skipping stale bridge cleanup for non-IPC endpoint: ${bridge_endpoint}"
    return 0
  fi

  python3 - "${bridge_endpoint}" "${APP_USER}" <<'PY'
from __future__ import annotations

import os
import pwd
import signal
import sys
import time
from pathlib import Path

endpoint, app_user = sys.argv[1:3]
sock_path = endpoint.replace('ipc://', '', 1)
if not sock_path:
    raise SystemExit(0)

socket_paths = {sock_path}
worker_dir = Path(sock_path).parent / 'hermes-agent-bridge-workers'
if worker_dir.is_dir():
    for entry in worker_dir.iterdir():
        socket_paths.add(str(entry))

uid = None
if app_user:
    try:
        uid = pwd.getpwnam(app_user).pw_uid
    except KeyError:
        uid = None

patterns = (
    'hermes_bridge.py',
    'bridge_server.py',
    'bridge_broker.py',
    'hermes-agent-bridge',
)

def process_uid(pid: int) -> int | None:
    try:
        for line in Path(f'/proc/{pid}/status').read_text(encoding='utf-8').splitlines():
            if line.startswith('Uid:'):
                return int(line.split()[1])
    except Exception:
        return None
    return None

def process_cmdline(pid: int) -> str:
    try:
        return Path(f'/proc/{pid}/cmdline').read_bytes().decode('utf-8', errors='ignore').replace('\x00', ' ')
    except Exception:
        return ''

def process_has_socket(pid: int) -> bool:
    fd_dir = Path(f'/proc/{pid}/fd')
    if not fd_dir.is_dir():
        return False
    for fd in fd_dir.iterdir():
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if target in socket_paths:
            return True
    return False

def pid_exists(pid: int) -> bool:
    return Path(f'/proc/{pid}').exists()

pids: list[int] = []
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    pid = int(entry.name)
    if pid == os.getpid():
        continue
    if uid is not None and process_uid(pid) != uid:
        continue
    cmdline = process_cmdline(pid)
    if process_has_socket(pid) or any(pattern in cmdline for pattern in patterns):
        pids.append(pid)

if pids:
    print(f"[INFO] stopping stale agent runtime pids: {', '.join(str(pid) for pid in pids)}")
for pid in sorted(set(pids), reverse=True):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        continue
    except PermissionError:
        continue

time.sleep(0.5)
for pid in sorted(set(pids), reverse=True):
    if not pid_exists(pid):
        continue
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        continue
    except PermissionError:
        continue

for path_str in socket_paths:
    path = Path(path_str)
    try:
        if path.exists() or path.is_socket():
            path.unlink()
            print(f"[INFO] removed stale bridge socket: {path}")
    except FileNotFoundError:
        continue
    except Exception as exc:
        print(f"[WARN] failed to remove stale bridge socket {path}: {exc}", file=sys.stderr)
PY

  if [[ -d "$(dirname "${bridge_endpoint#ipc://}")/hermes-agent-bridge-workers" ]]; then
    run find "$(dirname "${bridge_endpoint#ipc://}")/hermes-agent-bridge-workers" -mindepth 1 -delete || true
    removed_any=true
  fi

  if [[ "${removed_any}" == "true" ]]; then
    info "Cleaned stale agent bridge worker sockets."
  fi
}

stop_runtime_for_update_cutover() {
  step "Stop runtime services before update cutover"

  if systemctl is-active --quiet "${SYSTEMD_SERVICE_NAME}" >/dev/null 2>&1; then
    WEBUI_SERVICE_WAS_ACTIVE=true
    run systemctl stop "${SYSTEMD_SERVICE_NAME}"
    info "Stopped ${SYSTEMD_SERVICE_NAME} before update cutover."
  else
    info "${SYSTEMD_SERVICE_NAME} was already stopped before update cutover."
  fi

  HERMES_AGENT_SERVICE_EXISTS=false
  HERMES_AGENT_SERVICE_WAS_ACTIVE=false
  if [[ "${RESTART_AGENT_RUNTIME}" == "true" && -n "${HERMES_AGENT_SERVICE_NAME}" ]] && systemd_unit_exists "${HERMES_AGENT_SERVICE_NAME}"; then
    HERMES_AGENT_SERVICE_EXISTS=true
    if systemctl is-active --quiet "${HERMES_AGENT_SERVICE_NAME}" >/dev/null 2>&1; then
      HERMES_AGENT_SERVICE_WAS_ACTIVE=true
      run systemctl stop "${HERMES_AGENT_SERVICE_NAME}"
      info "Stopped ${HERMES_AGENT_SERVICE_NAME} before Web UI restart."
    else
      info "${HERMES_AGENT_SERVICE_NAME} is installed but inactive; leaving it stopped."
    fi
  elif [[ "${RESTART_AGENT_RUNTIME}" == "true" ]]; then
    warn "Hermes Agent service unit not found: ${HERMES_AGENT_SERVICE_NAME}. Falling back to stale-process cleanup only."
  else
    info "Hermes Agent runtime restart is disabled for this deploy."
  fi

  cleanup_stale_agent_runtime
}

start_runtime_after_update_cutover() {
  if [[ "${RESTART_AGENT_RUNTIME}" != "true" ]]; then
    return 0
  fi
  if [[ "${HERMES_AGENT_SERVICE_EXISTS}" != "true" || "${HERMES_AGENT_SERVICE_WAS_ACTIVE}" != "true" ]]; then
    return 0
  fi
  step "Start Hermes Agent runtime after Web UI restart"
  run systemctl start "${HERMES_AGENT_SERVICE_NAME}"
  info "Started ${HERMES_AGENT_SERVICE_NAME} after Web UI restart."
}

wait_for_http_ready() {
  local url="$1"
  local expected_fragment="$2"
  local max_attempts="${3:-20}"
  local i
  for ((i=1; i<=max_attempts; i++)); do
    local body
    # Generous per-attempt timeout: on ARM the first /health call can take 5s+
    # while the Hermes Agent CLI cold-starts inside the handler (getVersion).
    if body="$(curl -fsS --max-time 30 "$url" 2>/dev/null)" && [[ "$body" == *"$expected_fragment"* ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

require_log_dir_writable() {
  local state_dir="${APP_USER_HOME}/.hermes-web-ui"
  local log_dir="${state_dir}/logs"
  step "Check runtime directory permissions"
  run mkdir -p "${log_dir}"
  chown_r_mount_safe "${APP_USER}:${APP_USER}" "${state_dir}"
  run_as_app_user "test -w '${state_dir}' && test -w '${log_dir}'"
  info "Runtime directories are writable: ${log_dir}"
}

check_runtime_artifacts() {
  local hermes_bin="${APP_USER_HOME}/.local/bin/hermes"
  step "Check runtime artifacts"
  run test -x "${NODE_BIN}"
  run_as_app_user "test -x '${hermes_bin}' && '${hermes_bin}' --version >/dev/null"
  run test -x /usr/local/bin/hermes
  run /usr/local/bin/hermes --version >/dev/null
  run test -f "${DEPLOY_DIR}/dist/server/index.js"
  run test -f "${DEPLOY_DIR}/dist/client/index.html"
  info "Node, Hermes, and build artifacts look good."
}

check_terminal_runtime_ready() {
  local probe_url="http://127.0.0.1:${PORT}"
  step "Check terminal runtime readiness"
  if wait_for_http_ready "${probe_url}/health" "\"terminal\":{\"enabled\":true,\"ready\":true" 2>/dev/null; then
    info "Terminal runtime check passed."
  else
    warn "Terminal runtime not ready (likely missing native binding: node-pty). Terminal is optional — update continues."
  fi
  return 0
}

check_bridge_status() {
  local bridge_log="${APP_USER_HOME}/.hermes-web-ui/logs/bridge.log"
  step "Check agent bridge log"
  if [[ ! -f "${bridge_log}" ]]; then
    warn "bridge.log does not exist yet. Skipping bridge stability check."
    return 0
  fi

  if run bash -lc "tail -n 200 '${bridge_log}' | grep -E 'bridge exited unexpectedly|agent-bridge\\] exited code='" >/dev/null 2>&1; then
    err "Detected an unexpected agent bridge exit. Check ${bridge_log}"
    return 1
  fi

  info "No unexpected agent bridge exits detected."
}

post_deploy_self_check() {
  local probe_url="http://127.0.0.1:${PORT}"
  local deployed_version=""
  step "Run post-deploy self-checks"

  if ! run systemctl is-active --quiet "${SYSTEMD_SERVICE_NAME}"; then
    err "systemd service is not active: ${SYSTEMD_SERVICE_NAME}"
    run systemctl status "${SYSTEMD_SERVICE_NAME}" --no-pager || true
    return 1
  fi
  info "systemd service is active."

  check_runtime_artifacts
  require_log_dir_writable

  if ! wait_for_http_ready "${probe_url}/health" "\"status\":\"ok\""; then
    err "Health check failed: ${probe_url}/health"
    run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
    return 1
  fi
  info "Health check passed."

  deployed_version="$(
    python3 - "${DEPLOY_DIR}/package.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

package_path = Path(sys.argv[1])
payload = json.loads(package_path.read_text(encoding="utf-8"))
version = str(payload.get("version") or "").strip()
if version:
    print(version)
PY
  )"
  if [[ -n "${deployed_version}" ]]; then
    if ! wait_for_http_ready "${probe_url}/health" "\"webui_version\":\"${deployed_version}\""; then
      err "Version cutover check failed: ${probe_url}/health did not report webui_version=${deployed_version}"
      run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
      return 1
    fi
    info "Version cutover check passed: ${deployed_version}"
  fi

  if ! wait_for_http_ready "${probe_url}/api/auth/status" "\"hasPasswordLogin\":true"; then
    err "Auth status check failed: ${probe_url}/api/auth/status"
    run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
    return 1
  fi
  info "Auth status check passed."

  if [[ "${WEBUI_UPDATE_ENABLED,,}" == "true" || "${WEBUI_UPDATE_ENABLED}" == "1" ]]; then
    if ! wait_for_http_ready "${probe_url}/health" "\"webui_update_enabled\":true"; then
      err "Update configuration check failed: ${probe_url}/health did not report webui_update_enabled=true"
      run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
      return 1
    fi
    info "Update configuration check passed."
  fi

  check_terminal_runtime_ready

  if [[ "${HERMES_AGENT_SERVICE_WAS_ACTIVE}" == "true" ]]; then
    if ! run systemctl is-active --quiet "${HERMES_AGENT_SERVICE_NAME}"; then
      err "Hermes Agent service did not come back after update: ${HERMES_AGENT_SERVICE_NAME}"
      run systemctl status "${HERMES_AGENT_SERVICE_NAME}" --no-pager || true
      return 1
    fi
    info "Hermes Agent service is active after update: ${HERMES_AGENT_SERVICE_NAME}"
  fi

  check_bridge_status
}

install_systemd_service() {
  step "Install systemd service"

  # Fix: git clone / pull on filesystems with core.fileMode=true may reset
  # the +x bit on .sh/.mjs files to 0664 (umask). Without this, systemd
  # ExecStartPre=.../*.sh reports 203/EXEC and the service enters an
  # auto-restart loop, which the update-runner then marks as failed.
  if [[ -d "${DEPLOY_DIR}/scripts" ]]; then
    find "${DEPLOY_DIR}/scripts" -maxdepth 1 -type f \
      \( -name '*.sh' -o -name '*.mjs' \) \
      -exec chmod +x {} +
  fi

  local rendered_service
  rendered_service="$(mktemp)"

  python3 - "${SERVICE_TEMPLATE}" "${rendered_service}" \
    "${APP_USER}" "${APP_USER_HOME}" "${DEPLOY_DIR}" "${SERVICE_ENV_FILE}" \
    "${NODE_BIN}" <<'PY'
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
replacements = {
    "{{APP_USER}}": sys.argv[3],
    "{{APP_USER_HOME}}": sys.argv[4],
    "{{DEPLOY_DIR}}": sys.argv[5],
    "{{SERVICE_ENV_FILE}}": sys.argv[6],
    "{{NODE_BIN}}": sys.argv[7],
}

content = template_path.read_text(encoding="utf-8")
for old, new in replacements.items():
    content = content.replace(old, new)
output_path.write_text(content, encoding="utf-8")
PY

  run cp "${rendered_service}" "/etc/systemd/system/${SYSTEMD_SERVICE_NAME}"
  rm -f "${rendered_service}"
  run systemctl daemon-reload
  run systemctl enable "${SYSTEMD_SERVICE_NAME}"
  run systemctl start "${SYSTEMD_SERVICE_NAME}"
  info "systemd service started: ${SYSTEMD_SERVICE_NAME}"
}

install_update_runner_script() {
  step "Install managed update runner"
  run install -o root -g root -m 0755 "${UPDATE_RUNNER_SCRIPT_SOURCE}" "${UPDATE_RUNNER_SCRIPT_PATH}"
  info "Managed update runner installed: ${UPDATE_RUNNER_SCRIPT_PATH}"
}

install_update_runner_service() {
  step "Install managed update systemd service"

  local rendered_service
  rendered_service="$(mktemp)"

  python3 - "${UPDATE_RUNNER_TEMPLATE}" "${rendered_service}" \
    "${DEPLOY_DIR}" "${SERVICE_ENV_FILE}" "${UPDATE_RUNNER_SCRIPT_PATH}" <<'PY'
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
replacements = {
    "{{DEPLOY_DIR}}": sys.argv[3],
    "{{SERVICE_ENV_FILE}}": sys.argv[4],
    "{{UPDATE_RUNNER_BIN}}": sys.argv[5],
}

content = template_path.read_text(encoding="utf-8")
for old, new in replacements.items():
    content = content.replace(old, new)
output_path.write_text(content, encoding="utf-8")
PY

  run cp "${rendered_service}" "/etc/systemd/system/${UPDATE_RUNNER_SERVICE_NAME}"
  rm -f "${rendered_service}"
  info "Managed update service installed: ${UPDATE_RUNNER_SERVICE_NAME}"
}

install_update_runner_sudoers() {
  step "Install managed update sudoers policy"

  local systemctl_bin
  local journalctl_bin
  local sudoers_tmp

  systemctl_bin="$(command -v systemctl)"
  journalctl_bin="$(command -v journalctl)"
  sudoers_tmp="$(mktemp)"

  cat >"${sudoers_tmp}" <<EOF
Defaults:${APP_USER} env_reset,use_pty,log_output,secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Defaults!${systemctl_bin} !setenv
Defaults!${journalctl_bin} !setenv

Cmnd_Alias HERMES_WEB_UI_UPDATE = ${systemctl_bin} start ${UPDATE_RUNNER_SERVICE_NAME}, ${systemctl_bin} status ${UPDATE_RUNNER_SERVICE_NAME}, ${journalctl_bin} -u ${UPDATE_RUNNER_SERVICE_NAME} -n 200 --no-pager

${APP_USER} ALL=(root) NOPASSWD: HERMES_WEB_UI_UPDATE
EOF

  run install -o root -g root -m 0440 "${sudoers_tmp}" "${UPDATE_RUNNER_SUDOERS_FILE}"
  if command -v visudo >/dev/null 2>&1; then
    run visudo -cf "${UPDATE_RUNNER_SUDOERS_FILE}"
  fi
  rm -f "${sudoers_tmp}"
  info "Managed update sudoers installed: ${UPDATE_RUNNER_SUDOERS_FILE}"
}

show_summary() {
  local server_url
  server_url="http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"

  echo
  info "Source deployment completed"
  echo "----------------------------------------"

  # Self-check: verify EVERY script is executable before systemd tries to use
  # them via ExecStartPre. A single missing +x bit produces 203/EXEC and puts
  # the service into an auto-restart loop. Iterate the whole scripts/ tree
  # instead of a hardcoded list so adding a new script is automatically covered.
  local -a broken_scripts=()
  if [[ -d "${DEPLOY_DIR}/scripts" ]]; then
    while IFS= read -r -d '' f; do
      if [[ ! -x "$f" ]]; then
        broken_scripts+=("${f#${DEPLOY_DIR}/}")
      fi
    done < <(find "${DEPLOY_DIR}/scripts" -type f -name '*.sh' -print0 2>/dev/null)
    while IFS= read -r -d '' f; do
      if [[ ! -x "$f" ]] && head -1 "$f" 2>/dev/null | grep -q '^#!.*python'; then
        broken_scripts+=("${f#${DEPLOY_DIR}/}")
      fi
    done < <(find "${DEPLOY_DIR}/scripts" -type f -name '*.py' -print0 2>/dev/null)
  fi
  if [[ ${#broken_scripts[@]} -gt 0 ]]; then
    err "DEPLOY BUG: ${#broken_scripts[@]} script(s) missing +x bit — systemd ExecStartPre will fail with 203/EXEC"
    err "  ${broken_scripts[*]}"
    exit 1
  fi

  echo "Server URL: ${server_url}"
  echo "Local URL: http://127.0.0.1:${PORT}"
  echo "Source directory: ${DEPLOY_DIR}"
  echo "Hermes data directory: ${HERMES_HOME_DIR}"
  echo "Runtime user: ${APP_USER}"
  echo
  echo "Initial Hermes setup:"
  echo "  sudo -u ${APP_USER} -H env HERMES_HOME=${HERMES_HOME_DIR} ${APP_USER_HOME}/.local/bin/hermes setup"
  echo "  sudo -u ${APP_USER} -H env HERMES_HOME=${HERMES_HOME_DIR} ${APP_USER_HOME}/.local/bin/hermes model"
  echo
  echo "CLI usage:"
  echo "  hermes version"
  echo "  su - ${APP_USER}"
  echo "  hermes version"
  echo "  # Avoid: su ${APP_USER}  (non-login shell may miss ~/.local/bin)"
  echo
  echo "Common commands:"
  echo "  sudo systemctl status ${SYSTEMD_SERVICE_NAME}"
  echo "  sudo journalctl -u ${SYSTEMD_SERVICE_NAME} -f"
  echo "  sudo systemctl restart ${SYSTEMD_SERVICE_NAME}"
  echo "  sudo systemctl stop ${SYSTEMD_SERVICE_NAME}"
  echo
}

DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
PORT="${PORT:-6060}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
APP_USER="${APP_USER:-hermesui}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${DEPLOY_DIR}/hermes_data}"
NODE_REQUIRED_MAJOR="${NODE_REQUIRED_MAJOR:-23}"
NODE_VERSION="${NODE_VERSION:-23.11.1}"
NODE_INSTALL_DIR="${NODE_INSTALL_DIR:-/opt/node-v${NODE_REQUIRED_MAJOR}}"
NODE_BIN="${NODE_INSTALL_DIR}/bin/node"
NODE_MIRROR_URL="${NODE_MIRROR_URL:-https://npmmirror.com/mirrors/node}"
NODE_FALLBACK_URL="${NODE_FALLBACK_URL:-https://nodejs.org/dist}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NPM_BINARY_MIRROR_PREFIX="${NPM_BINARY_MIRROR_PREFIX:-https://cdn.npmmirror.com/binaries}"
HERMES_INSTALLER_MIRROR="${HERMES_INSTALLER_MIRROR:-https://cdn.jsdelivr.net/gh/NousResearch/hermes-agent@main/scripts/install.sh}"
HERMES_INSTALLER_FALLBACK="${HERMES_INSTALLER_FALLBACK:-https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh}"
OSS_PUBLIC_BASE_URL="${OSS_PUBLIC_BASE_URL:-https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui}"
DEFAULT_HERMES_AGENT_WHEEL_URL="https://files.pythonhosted.org/packages/e3/e2/d18d5ec6735b412fde47ecac3b6a63874c824c83e9821e1c1f4a07bcff85/hermes_agent-0.17.0-py3-none-any.whl"
HERMES_AGENT_WHEEL_URL="${HERMES_AGENT_WHEEL_URL:-${DEFAULT_HERMES_AGENT_WHEEL_URL}}"
HERMES_AGENT_WHEELHOUSE_URL="${HERMES_AGENT_WHEELHOUSE_URL:-${OSS_PUBLIC_BASE_URL}/hermes-agent/wheelhouse/}"
HERMES_AGENT_RELEASES_API_URL="${HERMES_AGENT_RELEASES_API_URL:-https://pypi.org/pypi/hermes-agent/json}"
HERMES_AGENT_UPDATE_MANIFEST_URL="${HERMES_AGENT_UPDATE_MANIFEST_URL:-${OSS_PUBLIC_BASE_URL}/hermes-agent/stable/latest.json}"
HERMES_AGENT_UPDATE_LATEST_STABLE="${HERMES_AGENT_UPDATE_LATEST_STABLE:-false}"
HERMES_ANTHROPIC_VERSION="${HERMES_ANTHROPIC_VERSION:-}"
WEBUI_BUNDLE_URL="${WEBUI_BUNDLE_URL:-}"
HERMES_INSTALL_FLAGS="${HERMES_INSTALL_FLAGS:---skip-setup --skip-browser}"
SERVICE_TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hermes-web-ui.service"
UPDATE_RUNNER_TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hermes-web-ui-update.service"
UPDATE_RUNNER_SCRIPT_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hermes-web-ui-update-runner.sh"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-hermes-web-ui.service}"
UPDATE_RUNNER_SERVICE_NAME="${WEBUI_UPDATE_RUNNER_SERVICE:-hermes-web-ui-update.service}"
UPDATE_RUNNER_SCRIPT_PATH="${UPDATE_RUNNER_SCRIPT_PATH:-/usr/local/sbin/hermes-web-ui-update-runner}"
UPDATE_RUNNER_SUDOERS_FILE="${UPDATE_RUNNER_SUDOERS_FILE:-/etc/sudoers.d/hermes-web-ui-update}"
SERVICE_ENV_FILE="${SERVICE_ENV_FILE:-/etc/default/hermes-web-ui}"
WEBUI_UPDATE_ENABLED="${WEBUI_UPDATE_ENABLED:-true}"
WEBUI_UPDATE_PACKAGE="${WEBUI_UPDATE_PACKAGE:-@quanthermes/hermes-web-ui}"
WEBUI_UPDATE_REGISTRY="${WEBUI_UPDATE_REGISTRY:-https://registry.npmjs.org}"
WEBUI_UPDATE_CLI_BIN="${WEBUI_UPDATE_CLI_BIN:-hermes-web-ui.mjs}"
WEBUI_UPDATE_SOURCE_LABEL="${WEBUI_UPDATE_SOURCE_LABEL:-Quanthermes Device Releases}"
WEBUI_UPDATE_DIST_TAG="${WEBUI_UPDATE_DIST_TAG:-latest}"
WEBUI_UPDATE_STRATEGY="${WEBUI_UPDATE_STRATEGY:-source-deploy}"
WEBUI_UPDATE_SCRIPT="${WEBUI_UPDATE_SCRIPT:-${DEPLOY_DIR}/scripts/update-source-deploy.sh}"
WEBUI_UPDATE_REPO="${WEBUI_UPDATE_REPO:-https://github.com/tangledup-ai/hermes-web-ui}"
WEBUI_UPDATE_MANIFEST_BASE_URL="${WEBUI_UPDATE_MANIFEST_BASE_URL:-${OSS_PUBLIC_BASE_URL}/releases}"
WEBUI_UPDATE_MANIFEST_URLS="${WEBUI_UPDATE_MANIFEST_URLS:-${OSS_PUBLIC_BASE_URL}/releases/stable/latest.json}"
WEBUI_UPDATE_PACKAGE_TYPE="${WEBUI_UPDATE_PACKAGE_TYPE:-source-deploy}"

# Browser surface (docs/web-agent-browser/spec-01): deliberately NOT written to
# SERVICE_ENV_FILE. The surface defaults to `local` and starts only when the
# runtime hard gate passes on the device (MemTotal / MemAvailable / free disk /
# resolvable browser executable), so an env value here would be a second source
# of truth that silently overrides the gate. If a specific low-spec model must
# stay off, write an explicit off for it right here and record the reason.
_browser_surface_guard() {
  local var="HERMES_BROWSER_SURFACE"
  local value="${!var:-}"
  case "${value,,}" in
    ""|local|off)
      ;;
    *)
      echo "[deploy] WARN: ${var}=${value} is not off|local; the server will treat it as off" >&2
      ;;
  esac
}
_browser_surface_guard

# Update-source hardening (task-12; the v0.8.6 candidate-pin incident):
# a WEBUI_UPDATE_MANIFEST_URL/URLS pinned to a versioned
# `releases/vX.Y.Z/manifest.json` or a `candidates/<channel>/<version>.json`
# answers successfully forever and freezes the device on that version — the
# device never sees a channel release after the pin. Reject it at deploy
# time unless the operator explicitly allows a pin (rollback drills).
_pin_manifest_guard() {
  local var value
  for var in WEBUI_UPDATE_MANIFEST_URL WEBUI_UPDATE_MANIFEST_URLS; do
    value="${!var:-}"
    # comma-separated list support for the *_URLS variant
    local one
    local IFS=','
    for one in ${value}; do
      case "$one" in
        */releases/v[0-9]*/*|*/candidates/*)
          if [ "${ALLOW_PINNED_MANIFEST:-0}" != "1" ]; then
            echo "[deploy] FATAL: ${var} pins a frozen manifest (versioned or candidate path): ${one}" >&2
            echo "[deploy] Use the channel latest.json (releases/<channel>/latest.json), or set ALLOW_PINNED_MANIFEST=1 to override deliberately." >&2
            exit 1
          fi
          echo "[deploy] WARN: ${var} pins a frozen manifest (ALLOW_PINNED_MANIFEST=1): ${one}" >&2
          ;;
      esac
    done
    unset IFS
  done
}
_pin_manifest_guard
WEBUI_UPDATE_INSTALLER_SCRIPT="${WEBUI_UPDATE_INSTALLER_SCRIPT:-${DEPLOY_DIR}/scripts/install-device-package.sh}"
WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES_RAW="${HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES:-${WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES:-true}}"
RESTART_AGENT_RUNTIME_RAW="${HERMES_WEB_UI_UPDATE_RESTART_AGENT_RUNTIME:-true}"
HERMES_AGENT_SERVICE_NAME="${HERMES_AGENT_SERVICE_NAME:-hermes-agent.service}"
UPDATE_ONLY_RAW="${DEPLOY_UPDATE_ONLY:-false}"
AGENT_ONLY_RAW="${DEPLOY_HERMES_AGENT_ONLY:-false}"
USE_CONFIGURED_DEPLOY_DIR_RAW="${DEPLOY_USE_CONFIGURED_DIR:-false}"
APP_USER_HOME=""
NODE_ARCH=""
WEBUI_SERVICE_WAS_ACTIVE=false
HERMES_AGENT_SERVICE_EXISTS=false
HERMES_AGENT_SERVICE_WAS_ACTIVE=false
UPDATE_DEPENDENCY_MANAGER="npm"
DEPENDENCY_SNAPSHOT_CHANGED=true
DEPENDENCY_INSTALL_REASON=""
DEPENDENCY_SNAPSHOT_JSON=""
HOST_DEPENDENCY_MANIFEST_RELATIVE_PATH="release/device-host-dependencies.json"
MANAGED_HOST_DEPENDENCY_MANIFEST_FILE=""
MANAGED_HOST_APT_PACKAGES=()

case "${UPDATE_ONLY_RAW,,}" in
  1|true|yes|on)
    UPDATE_ONLY=true
    ;;
  *)
    UPDATE_ONLY=false
    ;;
esac

case "${AGENT_ONLY_RAW,,}" in
  1|true|yes|on)
    AGENT_ONLY=true
    ;;
  *)
    AGENT_ONLY=false
    ;;
esac

case "${USE_CONFIGURED_DEPLOY_DIR_RAW,,}" in
  1|true|yes|on)
    USE_CONFIGURED_DEPLOY_DIR=true
    ;;
  *)
    USE_CONFIGURED_DEPLOY_DIR=false
    ;;
esac

case "${WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES_RAW,,}" in
  0|false|no|off)
    WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES=false
    ;;
  *)
    WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES=true
    ;;
esac

case "${RESTART_AGENT_RUNTIME_RAW,,}" in
  0|false|no|off)
    RESTART_AGENT_RUNTIME=false
    ;;
  *)
    RESTART_AGENT_RUNTIME=true
    ;;
esac

require_safe_env_value "PORT" "${PORT}"
require_safe_env_value "BIND_HOST" "${BIND_HOST}"
require_safe_env_value "APP_USER" "${APP_USER}"
require_safe_env_value "DEPLOY_DIR" "${DEPLOY_DIR}"
require_safe_env_value "HERMES_HOME_DIR" "${HERMES_HOME_DIR}"
require_safe_env_value "SERVICE_ENV_FILE" "${SERVICE_ENV_FILE}"
require_safe_env_value "UPDATE_RUNNER_SERVICE_NAME" "${UPDATE_RUNNER_SERVICE_NAME}"
require_safe_env_value "WEBUI_UPDATE_ENABLED" "${WEBUI_UPDATE_ENABLED}"
require_safe_env_value "WEBUI_UPDATE_PACKAGE" "${WEBUI_UPDATE_PACKAGE}"
require_safe_env_value "WEBUI_UPDATE_REGISTRY" "${WEBUI_UPDATE_REGISTRY}"
require_safe_env_value "WEBUI_UPDATE_CLI_BIN" "${WEBUI_UPDATE_CLI_BIN}"
require_safe_env_value "WEBUI_UPDATE_SOURCE_LABEL" "${WEBUI_UPDATE_SOURCE_LABEL}"
require_safe_env_value "WEBUI_UPDATE_DIST_TAG" "${WEBUI_UPDATE_DIST_TAG}"
require_safe_env_value "WEBUI_UPDATE_STRATEGY" "${WEBUI_UPDATE_STRATEGY}"
require_safe_env_value "WEBUI_UPDATE_SCRIPT" "${WEBUI_UPDATE_SCRIPT}"
require_safe_env_value "WEBUI_UPDATE_REPO" "${WEBUI_UPDATE_REPO}"
require_safe_env_value "HERMES_AGENT_SERVICE_NAME" "${HERMES_AGENT_SERVICE_NAME}"

echo
echo "hermes / hermes-web-ui source deployment"
echo "=================================="
echo

require_debian_like
require_supported_arch
if [[ "${UPDATE_ONLY}" != "true" && "${AGENT_ONLY}" != "true" ]]; then
  install_base_packages
elif [[ "${AGENT_ONLY}" == "true" ]]; then
  info "Running source deployment in hermes-agent-only mode."
else
  info "Running source deployment in update-only mode."
fi
ensure_app_user
resolve_repo_dir
prepare_deploy_dirs
if [[ "${AGENT_ONLY}" == "true" ]]; then
  install_hermes_agent
  echo
  info "Hermes Agent update completed"
  exit 0
fi

prepare_usb_mount_environment

install_node
if [[ "${UPDATE_ONLY}" != "true" ]]; then
  install_hermes_agent
  configure_app_user_shell_path
  install_root_hermes_wrapper
fi
write_npmrc
install_webui_dependencies
reconcile_host_dependencies
check_webui_dependencies
if [[ "${DEPLOY_SKIP_BUILD:-false}" == "true" ]]; then
  # Device packages ship a prebuilt dist/ (baked with the release version), so a
  # source rebuild is neither possible (build scripts are not allowlisted into
  # the package) nor needed. Source deploys keep the clean-rebuild path.
  info "Skipping Web UI build: device package ships a prebuilt dist/"
else
  build_webui
fi
prewarm_meeting_asr_venv
write_service_env
install_update_runner_script
install_update_runner_service
install_update_runner_sudoers
stop_runtime_for_update_cutover
install_systemd_service
start_runtime_after_update_cutover
post_deploy_self_check
show_summary
