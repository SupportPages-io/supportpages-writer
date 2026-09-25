#!/usr/bin/env bash
# Compatibility shim: hooks registered by older installs point here. The hook
# itself is trace_hook.js; see that file for its contract. Always exits 0.
exec node "$(dirname "$0")/trace_hook.js" 2>/dev/null || exit 0
