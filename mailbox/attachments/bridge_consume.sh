#!/usr/bin/env bash
# One independently scheduled Hatch hook invokes this with its fixed channel and slot.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"
channel="${1:?channel required}"
slot="${2:?slot required}"
case "$channel" in
  qq) event=qq_questions_pending ;;
  desktop) event=desktop_messages_pending ;;
  *) exit 2 ;;
esac
case "$slot" in 1|2|3) ;; *) exit 2 ;; esac

if [[ "${HATCH_HOOK_DRY_RUN:-0}" == 1 ]]; then
  silent "dry_run" '{}'
  exit 0
fi
tools_dir="$HOME/workspace/bridge-tools"
state_dir="$HOME/hooks/state/${channel}-bridge"
mkdir -p "$state_dir"
# Existing local work can be claimed even if starting the receiver failed.
if ! python3 "$tools_dir/bridge_runtime.py" ensure "$channel" 2>>"$state_dir/relay.log"; then
  log "receiver_start_failed" '{}'
fi
if ! payload="$(python3 "$tools_dir/bridge_dispatch.py" offer "$channel" "$slot" --wait 4 2>>"$state_dir/relay.log")"; then
  silent "dispatcher_unavailable" '{}'
  exit 0
fi
if jq -e '.pending | type == "array" and length > 0' >/dev/null <<<"$payload"; then
  wake "$event" "$payload"
else
  silent "no_available_group" '{}'
fi
