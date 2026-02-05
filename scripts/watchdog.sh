#!/bin/bash
# daemon-engine watchdog
# Checks /health endpoint. If unresponsive 3 times in a row, restarts the service.
# On restart, emails Stefan. Designed to run via systemd timer every 60 seconds.

HEALTH_URL="http://localhost:8080/health"
STATE_FILE="/tmp/daemon-engine-watchdog-failures"
ALERT_COOLDOWN_FILE="/tmp/daemon-engine-watchdog-last-alert"
MAX_FAILURES=3
TIMEOUT=10
ALERT_COOLDOWN=900  # 15 min between alerts
STEFAN_EMAIL="stefan@lbsa71.net"

# GOG_KEYRING_PASSWORD and GOG_ACCOUNT must be set in the environment
# (e.g., via systemd EnvironmentFile or shell profile)
# NEVER hardcode credentials in scripts committed to git.
if [ -z "$GOG_KEYRING_PASSWORD" ] || [ -z "$GOG_ACCOUNT" ]; then
    logger -t daemon-engine-watchdog "WARNING: GOG_KEYRING_PASSWORD or GOG_ACCOUNT not set. Email alerts disabled."
fi

send_alert() {
    local subject="$1"
    local body="$2"

    # Rate limit alerts
    local now=$(date +%s)
    local last_alert=$(cat "$ALERT_COOLDOWN_FILE" 2>/dev/null || echo 0)
    local elapsed=$((now - last_alert))

    if [ "$elapsed" -lt "$ALERT_COOLDOWN" ]; then
        logger -t daemon-engine-watchdog "Alert suppressed (cooldown: ${elapsed}s/${ALERT_COOLDOWN}s)"
        return
    fi

    echo "$now" > "$ALERT_COOLDOWN_FILE"

    gog gmail send \
        --to "$STEFAN_EMAIL" \
        --subject "$subject" \
        --body "$body" \
        --no-input \
        --force 2>/dev/null

    if [ $? -eq 0 ]; then
        logger -t daemon-engine-watchdog "Alert sent to $STEFAN_EMAIL"
    else
        logger -t daemon-engine-watchdog "Failed to send alert email"
    fi
}

# Check health endpoint
response=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$HEALTH_URL" 2>/dev/null)

if [ "$response" = "200" ]; then
    # Healthy - reset failure counter
    echo 0 > "$STATE_FILE"
    exit 0
fi

# Unhealthy - increment failure counter
failures=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
failures=$((failures + 1))
echo "$failures" > "$STATE_FILE"

logger -t daemon-engine-watchdog "Health check failed ($failures/$MAX_FAILURES). HTTP status: $response"

if [ "$failures" -ge "$MAX_FAILURES" ]; then
    logger -t daemon-engine-watchdog "Max failures reached. Restarting daemon-engine."

    # Restart
    systemctl --user restart daemon-engine.service
    restart_result=$?

    # Alert Stefan
    timestamp=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
    send_alert \
        "[daemon-engine] Watchdog restart triggered" \
        "daemon-engine was unresponsive and has been automatically restarted.

Time: $timestamp
Consecutive failures: $failures
Last HTTP status: $response
Restart result: $([ $restart_result -eq 0 ] && echo 'success' || echo 'FAILED')

This is an automated alert from the daemon-engine watchdog.
Check status: ssh rook@34.63.182.98 'systemctl --user status daemon-engine'"

    echo 0 > "$STATE_FILE"
fi
