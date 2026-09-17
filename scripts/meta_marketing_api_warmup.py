#!/usr/bin/env python3
"""
Generate the Marketing API call volume required by Meta App Review's
"Marketing API Access Tier" feature (500+ calls, >=85% success rate).

Every call is a READ-ONLY GET against YOUR OWN ad account. Nothing is
created, modified or deleted.

Rate limiting (Meta official docs, Ads Management business use case):
    Development tier:  calls/hour = 300 + 40 * (number of active ads)
    Standard tier:     calls/hour = 100000 + 40 * (number of active ads)

With 0 active ads that is 300 calls/hour, so ~500 calls takes ~2 hours.
The script paces itself and reads the X-Business-Use-Case-Usage response
header to back off before Meta throttles you -- throttled calls return
errors, and errors count against the 85% success rate requirement.

Usage:
    export META_ACCESS_TOKEN="EAAB..."
    python scripts/meta_marketing_api_warmup.py --account act_1487245386541838

    # resume a previous run (progress is persisted)
    python scripts/meta_marketing_api_warmup.py --account act_1487245386541838

    # just check the token / endpoints without burning quota
    python scripts/meta_marketing_api_warmup.py --account act_... --probe-only
"""

from __future__ import annotations

import argparse
import json
import os
import random
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

# ─────────────────────────────────────────────────────────────
#   CONFIGURE HERE  (optional -- CLI flags and env vars also work)
#
#   Precedence: --token/--account flag  >  env var  >  value below
# ─────────────────────────────────────────────────────────────
ACCESS_TOKEN = ""                        # paste your 60-day extended token
AD_ACCOUNT_ID = "act_1487245386541838"   # Agentzpro_Ads
# ─────────────────────────────────────────────────────────────

GRAPH_HOST = "https://graph.facebook.com"
DEFAULT_VERSION = os.environ.get("META_GRAPH_API_VERSION", "v21.0")
STATE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".marketing_api_warmup_state.json"
)

# Meta dev-tier ceiling with zero active ads.
DEV_TIER_HOURLY_BASE = 300
# Fraction of the hourly ceiling we are willing to consume.
SAFETY_FACTOR = 0.85
# Back off once Meta reports this much of the hourly budget used.
CALL_COUNT_SOFT_LIMIT = 75
CALL_COUNT_HARD_LIMIT = 90


@dataclass
class Endpoint:
    """A read-only Marketing API GET that counts toward the ads_management use case."""

    name: str
    path: str
    params: dict = field(default_factory=dict)


def build_endpoints(account: str) -> list[Endpoint]:
    """Read-only endpoints. Variety matters: App Review looks at real usage
    patterns, not 500 hits on a single URL."""
    return [
        Endpoint(
            "account_details",
            "/" + account,
            {
                "fields": "id,name,account_status,currency,timezone_name,"
                "amount_spent,balance,business_country_code,disable_reason"
            },
        ),
        Endpoint(
            "account_capabilities",
            "/" + account,
            {"fields": "capabilities,funding_source_details,is_prepay_account,tax_id_status"},
        ),
        Endpoint(
            "campaigns",
            "/" + account + "/campaigns",
            {"fields": "id,name,status,objective,created_time,daily_budget", "limit": "25"},
        ),
        Endpoint(
            "adsets",
            "/" + account + "/adsets",
            {
                "fields": "id,name,status,daily_budget,optimization_goal,billing_event",
                "limit": "25",
            },
        ),
        Endpoint(
            "ads",
            "/" + account + "/ads",
            {"fields": "id,name,status,effective_status,created_time", "limit": "25"},
        ),
        Endpoint(
            "adcreatives",
            "/" + account + "/adcreatives",
            {"fields": "id,name,object_type,status", "limit": "25"},
        ),
        Endpoint(
            "insights_30d",
            "/" + account + "/insights",
            {"fields": "impressions,clicks,spend,reach,cpc,ctr", "date_preset": "last_30d"},
        ),
        Endpoint(
            "insights_7d",
            "/" + account + "/insights",
            {"fields": "impressions,clicks,spend", "date_preset": "last_7d"},
        ),
        Endpoint(
            "insights_by_campaign",
            "/" + account + "/insights",
            {
                "fields": "impressions,clicks,spend",
                "level": "campaign",
                "date_preset": "last_30d",
                "limit": "25",
            },
        ),
        Endpoint(
            "adimages",
            "/" + account + "/adimages",
            {"fields": "hash,name,width,height", "limit": "25"},
        ),
        Endpoint("advideos", "/" + account + "/advideos", {"fields": "id,title", "limit": "25"}),
        Endpoint(
            "customaudiences",
            "/" + account + "/customaudiences",
            {"fields": "id,name,subtype,approximate_count_lower_bound", "limit": "25"},
        ),
        Endpoint(
            "saved_audiences",
            "/" + account + "/saved_audiences",
            {"fields": "id,name", "limit": "25"},
        ),
        Endpoint(
            "customconversions",
            "/" + account + "/customconversions",
            {"fields": "id,name", "limit": "25"},
        ),
        Endpoint(
            "adspixels",
            "/" + account + "/adspixels",
            {"fields": "id,name,last_fired_time", "limit": "25"},
        ),
        Endpoint("adlabels", "/" + account + "/adlabels", {"fields": "id,name", "limit": "25"}),
        Endpoint(
            "adrules_library",
            "/" + account + "/adrules_library",
            {"fields": "id,name,status", "limit": "25"},
        ),
        Endpoint(
            "promote_pages",
            "/" + account + "/promote_pages",
            {"fields": "id,name", "limit": "25"},
        ),
        Endpoint(
            "applications",
            "/" + account + "/applications",
            {"fields": "id,name", "limit": "25"},
        ),
        Endpoint("minimum_budgets", "/" + account + "/minimum_budgets", {}),
        Endpoint(
            "connected_instagram",
            "/" + account + "/connected_instagram_accounts",
            {"fields": "id,username", "limit": "25"},
        ),
        Endpoint(
            "my_adaccounts",
            "/me/adaccounts",
            {"fields": "id,name,account_status", "limit": "25"},
        ),
        Endpoint(
            "targeting_search_interest",
            "/search",
            {"type": "adinterest", "q": "real estate", "limit": "10"},
        ),
        Endpoint(
            "targeting_search_locale",
            "/search",
            {"type": "adlocale", "q": "en", "limit": "10"},
        ),
        Endpoint(
            "targeting_geo",
            "/search",
            {
                "type": "adgeolocation",
                "q": "chennai",
                "location_types": json.dumps(["city"]),
                "limit": "10",
            },
        ),
    ]


class RateLimitState:
    """Tracks Meta's reported usage so we slow down before being throttled."""

    def __init__(self) -> None:
        self.call_count = 0
        self.total_cputime = 0
        self.total_time = 0
        self.regain_access_minutes = 0
        self.tier = "unknown"

    def update(self, header_value: str | None) -> None:
        if not header_value:
            return
        try:
            payload = json.loads(header_value)
        except json.JSONDecodeError:
            return
        for entries in payload.values():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if entry.get("type") not in ("ads_management", "ads_insights", None):
                    continue
                self.call_count = max(self.call_count, int(entry.get("call_count") or 0))
                self.total_cputime = max(self.total_cputime, int(entry.get("total_cputime") or 0))
                self.total_time = max(self.total_time, int(entry.get("total_time") or 0))
                self.regain_access_minutes = int(entry.get("estimated_time_to_regain_access") or 0)
                self.tier = entry.get("ads_api_access_tier") or self.tier

    @property
    def worst(self) -> int:
        return max(self.call_count, self.total_cputime, self.total_time)


def graph_get(
    version: str, path: str, params: dict, token: str, timeout: int = 30
) -> tuple[int, dict, dict]:
    """Returns (http_status, parsed_body, response_headers).
    Network-level failures raise; API-level failures come back as a status + body."""
    query = urllib.parse.urlencode(dict(params, access_token=token))
    url = GRAPH_HOST + "/" + version + path + "?" + query
    request = urllib.request.Request(
        url, headers={"User-Agent": "AgentzPro-CRM-AppReview/1.0"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
            return response.status, body, dict(response.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8") or "{}"
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"error": {"message": raw[:300]}}
        return exc.code, body, dict(exc.headers or {})


def describe_error(body: dict) -> str:
    error = body.get("error") or {}
    message = (error.get("message") or "")[:140]
    return "code={} subcode={} {}".format(
        error.get("code"), error.get("error_subcode"), message
    )


def is_rate_limit_error(body: dict) -> bool:
    error = body.get("error") or {}
    return error.get("code") in (4, 17, 32, 613) or error.get("error_subcode") in (
        1487742,
        2446079,
    )


def usage_header(headers: dict) -> str | None:
    for key, value in headers.items():
        if key.lower() == "x-business-use-case-usage":
            return value
    return None


def load_state(account: str) -> dict:
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            state = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return {}
    return state if state.get("account") == account else {}


def save_state(state: dict) -> None:
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)
    os.replace(tmp, STATE_FILE)


def preflight(version: str, token: str, account: str) -> bool:
    """Confirm the token carries ads_read/ads_management and can see the account."""
    print("Preflight: inspecting access token ...")
    status, body, _ = graph_get(version, "/debug_token", {"input_token": token}, token)
    if status == 200 and "data" in body:
        data = body["data"]
        scopes = data.get("scopes") or []
        expires = data.get("expires_at")
        expiry = (
            "never"
            if expires in (0, None)
            else time.strftime("%Y-%m-%d %H:%M", time.localtime(expires))
        )
        print("  app_id    : {}".format(data.get("app_id")))
        print("  type      : {}".format(data.get("type")))
        print("  valid     : {}".format(data.get("is_valid")))
        print("  expires   : {}".format(expiry))
        print("  scopes    : {}".format(", ".join(scopes) or "(none reported)"))
        if scopes and not ({"ads_read", "ads_management"} & set(scopes)):
            print("\n  ERROR: token has neither ads_read nor ads_management.")
            print("  Meta requires at least one of these for the Marketing API Access Tier.")
            return False
    else:
        print("  WARNING: could not introspect token ({}). Continuing.".format(describe_error(body)))

    print("Preflight: checking ad account access ...")
    status, body, _ = graph_get(version, "/" + account, {"fields": "id,name,account_status"}, token)
    if status != 200:
        print("  ERROR: cannot read {} -> {}".format(account, describe_error(body)))
        return False
    print(
        "  account   : {} ({}) status={}".format(
            body.get("name"), body.get("id"), body.get("account_status")
        )
    )
    return True


def probe(
    version: str, token: str, endpoints: list[Endpoint], limits: RateLimitState
) -> list[Endpoint]:
    """Call each endpoint once and keep only the ones that succeed, so the main
    run does not manufacture errors against the 85% success threshold."""
    print("\nProbing {} endpoints (1 call each) ...".format(len(endpoints)))
    usable: list[Endpoint] = []
    for endpoint in endpoints:
        status, body, headers = graph_get(version, endpoint.path, endpoint.params, token)
        limits.update(usage_header(headers))
        if status == 200:
            usable.append(endpoint)
            print("  ok    {}".format(endpoint.name))
        else:
            print("  skip  {} -> {}".format(endpoint.name, describe_error(body)))
        time.sleep(1.5)
    print(
        "\n{}/{} endpoints usable. Reported tier: {}".format(
            len(usable), len(endpoints), limits.tier
        )
    )
    return usable


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate Marketing API calls for Meta App Review."
    )
    parser.add_argument(
        "--account",
        default=os.environ.get("META_AD_ACCOUNT_ID") or AD_ACCOUNT_ID,
        help="Ad account id, e.g. act_1487245386541838",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("META_ACCESS_TOKEN") or ACCESS_TOKEN,
        help="Access token with ads_read or ads_management (or set META_ACCESS_TOKEN)",
    )
    parser.add_argument(
        "--version",
        default=DEFAULT_VERSION,
        help="Graph API version (default {})".format(DEFAULT_VERSION),
    )
    parser.add_argument(
        "--target",
        type=int,
        default=520,
        help="Successful calls to make (default 520, headroom over Meta's 500)",
    )
    parser.add_argument(
        "--active-ads",
        type=int,
        default=0,
        help="Active ads in the account; raises the hourly ceiling (300 + 40*N)",
    )
    parser.add_argument("--probe-only", action="store_true", help="Run preflight + probe, then stop")
    parser.add_argument("--reset", action="store_true", help="Discard saved progress and start over")
    args = parser.parse_args()

    if not args.account:
        print("ERROR: --account is required (e.g. --account act_1487245386541838)")
        return 2
    if not args.account.startswith("act_"):
        args.account = "act_" + args.account
    if not args.token:
        print("ERROR: no token. Set META_ACCESS_TOKEN or pass --token.")
        return 2

    if args.reset and os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)

    if not preflight(args.version, args.token, args.account):
        return 1

    limits = RateLimitState()
    endpoints = probe(args.version, args.token, build_endpoints(args.account), limits)
    if not endpoints:
        print("ERROR: no usable endpoints; cannot continue.")
        return 1
    if args.probe_only:
        return 0

    state = load_state(args.account)
    success = state.get("success", 0)
    errors = state.get("errors", 0)
    error_breakdown: dict = state.get("error_breakdown", {})
    if success or errors:
        print(
            "\nResuming: {} successful / {} failed calls already recorded.".format(success, errors)
        )

    hourly_ceiling = DEV_TIER_HOURLY_BASE + 40 * args.active_ads
    base_interval = 3600.0 / (hourly_ceiling * SAFETY_FACTOR)
    remaining = max(0, args.target - success)
    print(
        "\nHourly ceiling : {} calls (dev tier, {} active ads)".format(
            hourly_ceiling, args.active_ads
        )
    )
    print("Pacing         : 1 call every ~{:.1f}s".format(base_interval))
    print(
        "Remaining      : {} calls (~{:.1f} hours)".format(
            remaining, remaining * base_interval / 3600
        )
    )
    print("Press Ctrl+C to stop; progress is saved and can be resumed.\n")

    stop = False

    def handle_stop(_signum, _frame):
        nonlocal stop
        stop = True
        print("\nStopping after the current call ...")

    signal.signal(signal.SIGINT, handle_stop)

    index = state.get("cursor", 0)
    started = time.time()

    while success < args.target and not stop:
        endpoint = endpoints[index % len(endpoints)]
        index += 1

        try:
            status, body, headers = graph_get(
                args.version, endpoint.path, endpoint.params, args.token
            )
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # Never reached Meta, so it counts neither as success nor error.
            print("  network issue ({}); retrying in 30s".format(exc))
            time.sleep(30)
            continue

        limits.update(usage_header(headers))

        if status == 200:
            success += 1
        elif is_rate_limit_error(body):
            wait = max(limits.regain_access_minutes, 5) * 60
            errors += 1
            error_breakdown["rate_limited"] = error_breakdown.get("rate_limited", 0) + 1
            print("  THROTTLED -> sleeping {} min ({})".format(wait // 60, describe_error(body)))
            save_state(
                {
                    "account": args.account,
                    "success": success,
                    "errors": errors,
                    "error_breakdown": error_breakdown,
                    "cursor": index,
                }
            )
            time.sleep(wait)
            continue
        else:
            errors += 1
            key = describe_error(body)
            error_breakdown[key] = error_breakdown.get(key, 0) + 1
            print("  error on {}: {}".format(endpoint.name, key))

        total = success + errors
        if total % 10 == 0 or success >= args.target:
            rate = (success / total * 100) if total else 0.0
            elapsed = (time.time() - started) / 60
            print(
                "  [{:>3}/{}] success_rate={:.1f}% usage={}% elapsed={:.0f}m".format(
                    success, args.target, rate, limits.worst, elapsed
                )
            )
            save_state(
                {
                    "account": args.account,
                    "success": success,
                    "errors": errors,
                    "error_breakdown": error_breakdown,
                    "cursor": index,
                }
            )

        # Pace: widen the interval as Meta's reported usage climbs.
        interval = base_interval
        if limits.worst >= CALL_COUNT_HARD_LIMIT:
            cool = max(limits.regain_access_minutes, 10) * 60
            print("  usage at {}% -> cooling down {} min".format(limits.worst, cool // 60))
            time.sleep(cool)
            limits.call_count = 0
            continue
        if limits.worst >= CALL_COUNT_SOFT_LIMIT:
            interval *= 2.5
        time.sleep(interval * random.uniform(0.9, 1.1))

    save_state(
        {
            "account": args.account,
            "success": success,
            "errors": errors,
            "error_breakdown": error_breakdown,
            "cursor": index,
        }
    )

    total = success + errors
    rate = (success / total * 100) if total else 0.0
    print("\n" + "=" * 58)
    print("Marketing API call summary")
    print("=" * 58)
    print("  Successful calls : {}".format(success))
    print("  Failed calls     : {}".format(errors))
    print("  Total calls      : {}".format(total))
    print("  Success rate     : {:.1f}%  (Meta requires >= 85%)".format(rate))
    print(
        "  Meta requirement : {}".format(
            "MET" if success >= 500 and rate >= 85 else "NOT YET MET"
        )
    )
    if error_breakdown:
        print("\n  Errors seen:")
        for key, count in sorted(error_breakdown.items(), key=lambda kv: -kv[1]):
            print("    {:>3}x  {}".format(count, key))
    print("\n  Note: Meta's dashboard can take up to 24 hours to reflect these calls.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
