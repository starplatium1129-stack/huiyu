#!/usr/bin/env bash
# QQ bridge poller v5: long-poll + expiry fallback (v4 added long-polling).
# Each run loops for up to ~50s: ship finished answers and proactive sends,
# then hold a ?wait=25 fetch; a question wakes the fetch instantly, and
# answers written during a hold ship on the next pass.
# Expiry fallback: a composed reply that is still unshipped after its
# expiresAt window closed would be lost. If the gateway still lists the
# item as unanswered, or a short grace period has passed with no confirmed
# delivery, the reply is re-queued as a proactive send (sendbox, fresh UUID)
# with the same text/attachment, and the original is marked so neither the
# reply nor the fallback is attempted twice. Skip-intent replies are never
# converted. Inbox/outbox/sendbox file formats are unchanged from v2/v3.
# A flock guard keeps overlapping runs from piling up.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

BRIDGE="$HOME/workspace/qq-bridge"
INBOX="$BRIDGE/inbox"
OUTBOX="$BRIDGE/outbox"
SENDBOX="$BRIDGE/sendbox"
STATE="$HOME/hooks/state/qq-bridge"
mkdir -p "$INBOX" "$OUTBOX" "$SENDBOX" "$STATE"

DRY=0
[[ "${HATCH_HOOK_DRY_RUN:-0}" == "1" ]] && DRY=1

INBOX_PATH="/api/muse/qq/inbox"
REPLY_PATH="/api/muse/qq/reply"
TARGETS_PATH="/api/muse/qq/targets"
SEND_PATH="/api/muse/qq/send"

if [[ "$DRY" == "0" ]]; then
  exec 9>"$STATE/poll.lock"
  if ! flock -n 9; then
    silent "poll_already_running" '{}'
    exit 0
  fi
fi

# Watcher services self-heal: unit masters live in the workspace because
# /etc does not survive VM replacement (learned 2026-11-20 when a
# replacement silently killed all four watchers).
if [[ "$DRY" == "0" ]]; then
  bash "$HOME/workspace/bridge-tools/ensure_watchers.sh" >/dev/null 2>&1 || true
fi

# Shipping is owned by the bridge-qq-ship watcher service (Codex's
# bridge_watch.py): a finished reply ships the moment its file lands.
# The poll is the backup shipper. It takes over not only when the
# watcher service is down, but also when the watcher is alive yet not
# delivering (2026-11-20: process up, every send failing on a missing
# proxy env, backlog sat for minutes). Takeover condition: an unshipped
# file older than 60s. A shared flock (the same file bridge_watch holds
# during its ship jobs) keeps the two shippers mutually exclusive, so a
# takeover can never double-send.
watcher_ineffective() {
  local f key age now_s
  now_s="$(date +%s)"
  for f in "$OUTBOX"/*.json "$SENDBOX"/*.json; do
    [[ -e "$f" ]] || continue
    key="$(basename "$f" .json)"
    [[ -f "$STATE/sent-$key" ]] && continue
    [[ -f "$STATE/sent-send-$key" ]] && continue
    [[ -f "$STATE/fallback-$key" ]] && continue
    age=$(( now_s - $(stat -c %Y "$f") ))
    (( age > 60 )) && return 0
  done
  return 1
}

run_inloop_ship() {
  (
    flock -n 9 || exit 0
    ship_outbox
    ship_sendbox
  ) 9>"$STATE/ship-watch.lock"
}

WATCH_SHIP=0
if systemctl is-active --quiet bridge-qq-ship.service 2>/dev/null; then
  WATCH_SHIP=1
  if [[ "$DRY" == "0" ]] && watcher_ineffective; then
    WATCH_SHIP=0
    log "ship_takeover" '{"reason":"watcher_ineffective"}'
  fi
fi

# Cache the bound conversation targets once per run. An empty list from a
# freshly moved bridge must not erase the known targets record, so only
# cache non-empty.
if targets="$(python3 "$BRIDGE/fetch_relay.py" "$TARGETS_PATH" 2>>"$STATE/relay.log")"; then
  tcount="$(printf '%s' "$targets" | jq -r '(.targets // []) | length' 2>/dev/null || echo 0)"
  if [[ "$tcount" != "0" && "$DRY" == "0" ]] && ! printf '%s' "$targets" | cmp -s - "$BRIDGE/targets.json" 2>/dev/null; then
    printf '%s' "$targets" > "$BRIDGE/targets.json.tmp" && mv "$BRIDGE/targets.json.tmp" "$BRIDGE/targets.json"
  fi
fi

ship_outbox() {
  local f key status is_skip
  for f in "$OUTBOX"/*.json; do
    [[ -e "$f" ]] || continue
    key="$(basename "$f" .json)"
    [[ -f "$STATE/sent-$key" ]] && continue
    [[ -f "$STATE/fallback-$key" ]] && continue
    status="$(python3 "$BRIDGE/ship_relay.py" "$REPLY_PATH" "$f" 2>>"$STATE/relay.log" || echo ship_error)"
    is_skip="$(jq -r '.skip // false' "$f" 2>/dev/null || echo false)"
    if [[ "$status" == "sent" || "$status" == "skipped" || ( "$is_skip" == "true" && "$status" != http_error* && "$status" != "ship_error" ) ]]; then
      [[ "$DRY" == "0" ]] && touch "$STATE/sent-$key"
      [[ "$DRY" == "0" ]] && printf '{"key":"%s","status":"%s","at":%s,"via":"reply"}\n' "$key" "$status" "$(( $(date +%s) * 1000 ))" >> "$BRIDGE/receipts.jsonl"
      log "reply_shipped" "{\"requestKey\": \"$key\", \"status\": \"$status\"}"
    else
      log "reply_ship_failed" "{\"requestKey\": \"$key\", \"status\": \"$status\"}"
    fi
  done
}

ship_sendbox() {
  local f key status
  for f in "$SENDBOX"/*.json; do
    [[ -e "$f" ]] || continue
    key="$(basename "$f" .json)"
    [[ -f "$STATE/sent-send-$key" ]] && continue
    status="$(python3 "$BRIDGE/ship_relay.py" "$SEND_PATH" "$f" 2>>"$STATE/relay.log" || echo ship_error)"
    if [[ "$status" == "sent" ]]; then
      [[ "$DRY" == "0" ]] && touch "$STATE/sent-send-$key"
      [[ "$DRY" == "0" ]] && printf '{"key":"%s","status":"%s","at":%s,"via":"send"}\n' "$key" "$status" "$(( $(date +%s) * 1000 ))" >> "$BRIDGE/receipts.jsonl"
      log "send_shipped" "{\"requestKey\": \"$key\"}"
    else
      log "send_ship_failed" "{\"requestKey\": \"$key\", \"status\": \"$status\"}"
    fi
  done
}

FETCH_COUNT=0
fetch_once() {
  local path="$1" resp count item key
  FETCH_COUNT=0
  if resp="$(python3 "$BRIDGE/fetch_relay.py" "$path" 2>>"$STATE/relay.log")"; then
    count="$(printf '%s' "$resp" | jq -r '(.items // []) | length' 2>/dev/null || echo 0)"
    if [[ "$DRY" == "0" ]]; then
      printf '%s' "$resp" | jq -r '(.items // [])[].requestKey // empty' > "$STATE/listed.txt.tmp" 2>/dev/null \
        && mv "$STATE/listed.txt.tmp" "$STATE/listed.txt" || true
    fi
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

# Convert expired, unshipped replies into proactive sends (see header).
fallback_expired() {
  [[ "$DRY" == "0" ]] || return 0
  local f key ib exp conv now_ms fbkey tx ip ap listed
  now_ms=$(( $(date +%s) * 1000 ))
  for f in "$OUTBOX"/*.json; do
    [[ -e "$f" ]] || continue
    key="$(basename "$f" .json)"
    [[ -f "$STATE/sent-$key" ]] && continue
    [[ -f "$STATE/fallback-$key" ]] && continue
    ib="$INBOX/$key.json"
    [[ -f "$ib" ]] || continue
    exp="$(jq -r '.expiresAt // 0' "$ib" 2>/dev/null || echo 0)"
    [[ "$exp" == "0" || "$now_ms" -le "$exp" ]] && continue
    if [[ "$(jq -r '.skip // false' "$f" 2>/dev/null || echo false)" == "true" ]]; then
      touch "$STATE/fallback-$key"
      log "reply_expired_skip" "{\"requestKey\": \"$key\"}"
      continue
    fi
    listed=0
    if [[ -f "$STATE/listed.txt" ]] && grep -qx "$key" "$STATE/listed.txt" 2>/dev/null; then
      listed=1
    fi
    # Convert at once when the gateway still lists the item as unanswered;
    # otherwise wait a 20s grace period for any in-flight attempt to settle.
    if [[ "$listed" == "0" && "$now_ms" -le $(( exp + 20000 )) ]]; then
      continue
    fi
    conv="$(jq -r '.conversationId // empty' "$ib" 2>/dev/null || echo "")"
    tx="$(jq -r '.text // empty' "$f" 2>/dev/null || echo "")"
    ip="$(jq -r '.imagePath // empty' "$f" 2>/dev/null || echo "")"
    ap="$(jq -r '.audioPath // empty' "$f" 2>/dev/null || echo "")"
    if [[ -z "$conv" || ( -z "$tx" && -z "$ip" && -z "$ap" ) ]]; then
      touch "$STATE/fallback-$key"
      log "reply_expired_empty" "{\"requestKey\": \"$key\"}"
      continue
    fi
    fbkey="$(cat /proc/sys/kernel/random/uuid)"
    jq -n --arg rk "$fbkey" --arg cv "$conv" --arg tx "$tx" --arg ip "$ip" --arg ap "$ap" \
      '{requestKey: $rk, conversationId: $cv}
       + (if $tx != "" then {text: $tx} else {} end)
       + (if $ip != "" then {imagePath: $ip} else {} end)
       + (if $ap != "" then {audioPath: $ap} else {} end)' \
      > "$SENDBOX/$fbkey.json.tmp" && mv "$SENDBOX/$fbkey.json.tmp" "$SENDBOX/$fbkey.json"
    touch "$STATE/fallback-$key"
    log "reply_fallback_queued" "{\"requestKey\": \"$key\", \"sendKey\": \"$fbkey\"}"
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
  fallback_expired
  if [[ "$WATCH_SHIP" == "0" ]]; then
    run_inloop_ship
  fi
  [[ "$FETCH_COUNT" != "0" ]] && break
  [[ $(date +%s) -ge $deadline ]] && break
done

# Refresh the context pool (auto-recorded conversation diary) so the
# answering agent always reads fresh context. Never fail the poll over it.
if [[ "$DRY" == "0" ]]; then
  python3 "$BRIDGE/pool.py" sync >>"$STATE/relay.log" 2>&1 || true
fi

# Wake the answering agent if unanswered, unexpired questions exist.
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
  wake "qq_questions_pending" "$payload"
else
  silent "no_pending_questions" '{}'
fi
