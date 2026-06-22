# Security policy — Stalcraft Trading Assistant

## Secrets
- Never hardcode STALCRAFT_CLIENT_ID, STALCRAFT_CLIENT_SECRET, SECRET_KEY, DATABASE_URL passwords, or JWT secrets in source, scripts, or .claude/settings.json. They belong only in .env / process environment.
- Flag any literal API key, token, or password assigned to a variable, shell command string, or permission-allowlist entry — even one that looks like a one-off debug command.

## IDOR / data scoping
- Data model: most tables are global (user_id=NULL); personalization happens per-request. Any query against user-scoped tables (user_watchlist, user_tokens, user_feed_exclusion, settings) MUST filter by current_user.id — see existing pattern in backend/app/api/v1/endpoints/watchlist.py, settings.py, inventory.py. Flag any new endpoint or query that omits this filter or accepts a user_id from client input instead of from the auth dependency.

## Admin endpoints
- backend/app/api/v1/endpoints/admin.py and any admin-only action must depend on an is_admin check, not just is_approved/authenticated. Flag any new admin route missing this dependency.

## Rate limiting (Stalcraft API)
- backend/app/core/rate_limiter.py implements the Stalcraft API token bucket (400 req/min global limit, verified 2026-06-07). Flag any new direct call to the Stalcraft API client (backend/app/services/collector/client.py) that bypasses TokenCost/acquire(), and any change to LOTS_PER_RUN, BATCH_SIZE, or REFRESH_INTERVAL constants — these require explicit user confirmation per project policy, not just code review.

## SQL
- SQLAlchemy 2.0 async ORM only. Flag any raw text()/execute() call built with f-strings, .format(), or % formatting on user-controlled input.

## Auth
- backend/app/api/v1/endpoints/auth.py: flag any change that weakens JWT expiry, algorithm pinning, or password hashing (passlib/bcrypt).

## Telegram bot
- telegram_bot/bot.py: flag any handler that trusts a Telegram update's user/account claims without validating the linked app user_id mapping.
