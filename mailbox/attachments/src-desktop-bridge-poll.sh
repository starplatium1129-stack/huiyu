#!/usr/bin/env bash
# Desktop character-chat bridge poller v3: expiry bookkeeping (v2: long-poll).
# Each run loops for up to ~60s: ship finished replies, then hold a ?wait=25
# fetch on the relay; a message wakes the fetch instantly, and replies
# written during a hold are shipped on the next pass.
# The desktop API has no proactive-send operation (only inbox + reply), so
# an expired reply cannot be re-delivered as a standalone message the way
# the QQ bridge falls back to /api/muse/qq/send. Instead, an expired,
# unshipped reply is marked lost-<key> and logged (reply_expired_lost) so
# the loss is on record and the ship loop stops retrying a dead key.
# A flock guard keeps overlapping runs from piling up.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

BRIDGE="$HOME/workspace/desktop-bridge"
INBOX="$BRIDGE/inbox"
OUTBOX="$BRIDGE/outbox"
STATE="$HOME/hooks/state/desktop-bridge"
mkdir -p "$INBOX" "$OUTBOX" "$STATE"

DRY=0
[[ "${HATCH_HOOK_DRY_RUN:-0}" == "1" ]] && DRY=1

REPLY_PATH="/api/muse/desktop/reply"
INBOX_PATH="/api/muse/desktop/inbox"

if [[ "$DRY" == "0" ]]; then
  exec 9>"$STATE/poll.lock"
  if ! flock -n 9; then
    silent "poll_already_running" '{}'
    exit 0
  fi
fi

# Watcher services self-heal (see qq-bridge-poll.sh note, 2026-11-20).
if [[ "$DRY" == "0" ]]; then
  bash "$HOME/workspace/bridge-tools/ensure_watchers.sh" >/dev/null 2>&1 || true
fi

# Shipping is owned by the bridge-desktop-ship watcher service (Codex's
# bridge_watch.py). The poll is the backup shipper and takes over when
# the watcher is down OR alive but not delivering (unshipped file older
# than 60s; same lesson as the QQ bridge, 2026-11-20). A shared flock
# (the file bridge_watch holds during its ship jobs) keeps the two
# shippers mutually exclusive.
watcher_ineffective() {
  local f key age now_s
  now_s="$(date +%s)"
  for f in "$OUTBOX"/*.json; do
    [[ -e "$f" ]] || continue
    key="$(basename "$f" .json)"
    [[ -f "$STATE/sent-$key" ]] && continue
    [[ -f "$STATE/lost-$key" ]] && continue
    age=$(( now_s - $(stat -c %Y "$f") ))
    (( age > 60 )) && return 0
  done
  return 1
}

run_inloop_ship() {
  (
    flock -n 9 || exit 0
    ship_outbox
  ) 9>"$STATE/ship-watch.lock"
}

WATCH_SHIP=0
if systemctl is-active --quiet bridge-desktop-ship.service 2>/dev/null; then
  WATCH_SHIP=1
  if [[ "$DRY" == "0" ]] && watcher_ineffective; then
    WATCH_SHIP=0
    log "ship_takeover" '{"reason":"watcher_ineffective"}'
  fi
fi

ship_outbox() {
  local f key status
  for f in "$OUTBOX"/*.json; do
    [[ -e "$f" ]] || continue
    key="$(basename "$f" .json)"
    [[ -f "$STATE/sent-$key" ]] && continue
    [[ -f "$STATE/lost-$key" ]] && continue
    status="$(python3 "$BRIDGE/ship_relay.py" "$REPLY_PATH" "$f" 2>>"$STATE/relay.log" || echo ship_error)"
    if [[ "$status" == "sent" ]]; then
      [[ "$DRY" == "0" ]] && touch "$STATE/sent-$key"
      [[ "$DRY" == "0" ]] && printf '{"key":"%s","status":"%s","at":%s,"via":"reply"}\n' "$key" "$status" "$(( $(date +%s) * 1000 ))" >> "$BRIDGE/receipts.jsonl"
      log "reply_shipped" "{\"requestKey\": \"$key\", \"status\": \"$status\"}"
    else
      log "reply_ship_failed" "{\"requestKey\": \"$key\", \"status\": \"$status\"}"
    fi
  done
}

FETCH_COUNT=0
fetch_once() {
  local path="$1" resp count item key
  FETCH_COUNT=0
  if resp="$(python3 "$BRIDGE/fetch_relay.py" "$path" 2>>"$STATE/relay.log")"; then
    count="$(printf '%s' "$resp" | jq -r '(.items // []) | length' 2>/dev/null || echo 0)"
    if [[ "$count" != "0" && "$DRY" == "0" ]]; then
      printf '%s' "$resp" | jq -c '.items[]' | while read -r item; do
        key="$(printf '%s' "$item" | jq -r '.requestKey // empty')"
        [[ -n "$key" ]] || continue
        if [[ ! -f "$INBOX/$key.json" ]]; then
          printf '%s' "$item" > "$INBOX/$key.json.tmp" && mv "$INBOX/$key.json.tmp" "$INBOX/$key.json"
        fi
      done
    fi
    FETCH_COUNT="$count"
    log "fetch_ok" "{\"items\": $count}"
  else
    log "fetch_failed" '{}'
  fi
}

# Record expired, unshipped replies as lost (see header: no fallback
# channel exists for desktop yet).
expire_check() {
  [[ "$DRY" == "0" ]] || return 0
  local f key ib exp now_ms
  now_ms=$(( $(date +%s) * 1000 ))
  for f in "$OUTBOX"/*.json; do
    [[ -e "$f" ]] || continue
    key="$(basename "$f" .json)"
    [[ -f "$STATE/sent-$key" ]] && continue
    [[ -f "$STATE/lost-$key" ]] && continue
    ib="$INBOX/$key.json"
    [[ -f "$ib" ]] || continue
    exp="$(jq -r '.expiresAt // 0' "$ib" 2>/dev/null || echo 0)"
    if [[ "$exp" != "0" && "$now_ms" -gt "$exp" ]]; then
      touch "$STATE/lost-$key"
      log "reply_expired_lost" "{\"requestKey\": \"$key\"}"
    fi
  done
}

deadline=$(( $(date +%s) + 50 ))
while :; do
  if [[ "$WATCH_SHIP" == "0" ]]; then
    run_inloop_ship
  fi
  if [[ "$DRY" == "1" ]]; then
    fetch_once "$INBOX_PATH"
    break
  fi
  fetch_once "$INBOX_PATH?wait=25"
  expire_check
  [[ "$FETCH_COUNT" != "0" ]] && break
  [[ $(date +%s) -ge $deadline ]] && break
done

# Wake the answering agent if unanswered, unexpired messages exist.
now_ms=$(( $(date +%s) * 1000 ))
pending_keys=()
for f in "$INBOX"/*.json; do
  [[ -e "$f" ]] || continue
  key="$(basename "$f" .json)"
  [[ -f "$OUTBOX/$key.json" ]] && continue
  exp="$(jq -r '.expiresAt // 0' "$f" 2>/dev/null || echo 0)"
  if [[ "$exp" != "0" && "$now_ms" -gt "$exp" ]]; then
    continue
  fi
  pending_keys+=("$key")
done

if [[ ${#pending_keys[@]} -gt 0 ]]; then
  payload="$(printf '%s\n' "${pending_keys[@]}" | jq -R . | jq -s '{pending: .}')"
  wake "desktop_messages_pending" "$payload"
else
  silent "no_pending_messages" '{}'
fi
