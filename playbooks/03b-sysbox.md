# 03b - Sysbox Runtime

Install the Sysbox container runtime for secure Docker-in-Docker on VPS-1.

## Overview

Sysbox enables running Docker-in-Docker securely for OpenClaw sandboxes. It provides user namespace isolation so containers can run `dockerd` internally without privileged mode on the host.

## Prerequisites

- [03-docker.md](03-docker.md) completed on VPS-1 (Sysbox registers itself as a Docker runtime)
- SSH access as `adminclaw` on port `<SSH_PORT>`

## Variables

No external variables required.

---

## 3b.1 Version Check (fresh deployments only)

Before installing, fetch the latest release from GitHub:

```
https://github.com/nestybox/sysbox/releases
```

Compare the latest release tag against `SYSBOX_VERSION` below.

- **If a newer version exists:** Note the newer version in the output but proceed with the pinned version. Do not pause to ask — the pinned version has a verified checksum. The user can update later.
- **If the pinned version is already the latest:** Proceed directly.

<!-- Pinned version — update both values together -->
`SYSBOX_VERSION=0.6.7`
`SYSBOX_SHA256=b7ac389e5a19592cadf16e0ca30e40919516128f6e1b7f99e1cb4ff64554172e`

---

## 3b.2 Install

```bash
#!/bin/bash
SYSBOX_VERSION="0.6.7"
SYSBOX_SHA256="b7ac389e5a19592cadf16e0ca30e40919516128f6e1b7f99e1cb4ff64554172e"
SYSBOX_DEB="sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb"

# Download
wget "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"

# Verify download integrity
echo "${SYSBOX_SHA256}  ${SYSBOX_DEB}" | sha256sum -c -

# Install dependencies
sudo apt install -y jq fuse

# Install Sysbox
sudo dpkg -i "${SYSBOX_DEB}"

# Verify installation
sudo systemctl status sysbox

# Verify runtime is available
sudo docker info | grep -i "sysbox"

# Cleanup
rm "${SYSBOX_DEB}"
```

**If sha256sum fails:**

> "The Sysbox download didn't match the expected checksum. This could mean a
> corrupted download or a version mismatch. Delete the file and re-download:"
>
> `rm ${SYSBOX_DEB} && wget "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"`

**If `dpkg -i` fails with dependency errors:**

> "Sysbox has unmet dependencies. Fix with:"
>
> `sudo apt --fix-broken install -y`

---

## 3b.3 AppArmor fusermount3 Compatibility

Ubuntu 25.04+ ships a `fusermount3` AppArmor profile in enforce mode that blocks sysbox-fs from creating FUSE mounts (used for container `/proc` and `/sys` virtualization). This causes containers to fail with `rpc error: code = DeadlineExceeded` during sysbox pre-registration.

**Only needed when the profile is loaded and enforcing.** Run this check after installing Sysbox:

```bash
#!/bin/bash
# Check if fusermount3 AppArmor profile is blocking sysbox-fs
if sudo aa-status 2>/dev/null | grep -q 'fusermount3'; then
  echo "fusermount3 AppArmor profile is enforcing — disabling for sysbox-fs compatibility"

  # Disable the profile (persists across reboots)
  sudo ln -sf /etc/apparmor.d/fusermount3 /etc/apparmor.d/disable/
  sudo apparmor_parser -R /etc/apparmor.d/fusermount3 2>/dev/null || true

  # Restart sysbox services to pick up the change
  sudo systemctl restart sysbox-fs sysbox-mgr sysbox

  echo "fusermount3 profile disabled, sysbox restarted"
else
  echo "fusermount3 AppArmor profile not enforcing — no action needed"
fi
```

**Security note:** The fusermount3 profile restricts which processes can invoke FUSE mounts. Sysbox legitimately needs FUSE for filesystem virtualization. On a single-purpose VPS with key-only SSH + Cloudflare Access, disabling this profile has negligible security impact. This is not needed on Ubuntu 24.04 where the profile is absent or in complain mode.

---

## 3b.4 Disable Broken Overlayfs ID-Mapped Mounts

Sysbox 0.6.7 detects kernel support for ID-mapped mounts on overlayfs but fails to apply them, causing Docker image files inside containers to appear as `nobody:nogroup`. This breaks any file with restrictive permissions (e.g., `.env` at mode 0600).

The fix is to disable overlayfs-on-idmapped-mount, forcing Sysbox to use rootfs cloning (chown) instead. This adds a few seconds to container start/stop but ensures correct uid mapping.

See: https://github.com/nestybox/sysbox/issues/968

```bash
#!/bin/bash
# Create sysbox-mgr override to force rootfs cloning
sudo mkdir -p /etc/systemd/system/sysbox-mgr.service.d
sudo tee /etc/systemd/system/sysbox-mgr.service.d/override.conf << 'EOF'
[Service]
# Force rootfs cloning (chown) instead of broken ID-mapped mount on overlayfs.
# Sysbox 0.6.7 detects kernel ID-mapped mount support but fails to apply it,
# causing image files to appear as nobody:nogroup inside containers.
# This slows container start/stop by a few seconds but ensures correct uid mapping.
# See: https://github.com/nestybox/sysbox/issues/968
ExecStart=
ExecStart=/usr/bin/sysbox-mgr --disable-ovfs-on-idmapped-mount --log-level info
EOF
sudo systemctl daemon-reload
sudo systemctl restart sysbox

# Verify the override is active
sudo systemctl show sysbox-mgr --property=ExecStart | grep -q 'disable-ovfs-on-idmapped-mount' \
  && echo "sysbox-mgr override active" \
  || echo "ERROR: override not applied"
```

> **When to remove:** Once Sysbox fixes the overlayfs ID-mapped mount bug (check future releases), remove the override with `sudo rm /etc/systemd/system/sysbox-mgr.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart sysbox`.

---

## Verification

```bash
# Check Sysbox service
sudo systemctl status sysbox

# Verify runtime registered with Docker
sudo docker info | grep -i "sysbox"

# Verify rootfs cloning is active (should show "Use of overlayfs on ID-mapped mounts disabled")
sudo journalctl -u sysbox-mgr --no-pager -n 20 | grep -i "idmap\|overlayfs"
```

---

## Troubleshooting

### Sysbox Not Found

```bash
# Check Sysbox service
sudo systemctl status sysbox

# Reinstall if needed
sudo dpkg -i sysbox-ce_*.deb
```
