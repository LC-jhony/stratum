#!/bin/bash

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Keep the Chromium SUID sandbox helper setuid root, unconditionally.
#
# electron-builder's stock post-install probes "can we use the namespace sandbox?" by running
# `unshare --user true`, but the probe runs as root (the package installation runs as root), where
# user namespaces always work. The check therefore passes on every modern kernel and the helper is
# left at 0755. That breaks startup on distributions with restricted unprivileged user namespaces
# (Ubuntu 24.04+ ships kernel.apparmor_restrict_unprivileged_userns=1, where the real user cannot
# set up the namespace sandbox): Chromium falls back to the SUID helper, finds it not setuid and
# aborts before the window opens with
#   FATAL:setuid_sandbox_host.cc: The SUID sandbox helper binary was found, but is not configured
#   correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that
#   /opt/${sanitizedProductName}/chrome-sandbox is owned by root and has mode 4755.
#
# Marking the helper setuid unconditionally matches Chromium's own packaging; it is only used when
# the namespace sandbox is unavailable, so systems with working user namespaces are unaffected.
if [ -f '/opt/${sanitizedProductName}/chrome-sandbox' ]; then
    chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' || true
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
