import json
import math
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel, Field


LOCAL_TZ = ZoneInfo("America/Los_Angeles")
RESERVED_TIME_TERMS = {
    "today",
    "yesterday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "week",
    "month",
}


def json_safe(obj: Any) -> Any:
    if obj is None:
        return None

    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj

    if isinstance(obj, dict):
        return {str(k): json_safe(v) for k, v in obj.items()}

    if isinstance(obj, (list, tuple)):
        return [json_safe(v) for v in obj]

    return obj


def ms_to_pretty(ms: Any) -> str:
    value = int(max(0, float(ms or 0)))
    total_seconds = value // 1000
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60

    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    if minutes or hours:
        parts.append(f"{minutes}m")
    if not hours:
        parts.append(f"{seconds}s")
    return " ".join(parts)


def to_local_datetime(value: Any) -> datetime | None:
    try:
        ts = float(value or 0)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    return datetime.fromtimestamp(ts / 1000, tz=LOCAL_TZ)


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return default


def start_of_day(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def build_domain_aliases(domain: str) -> set[str]:
    clean = (domain or "").strip().lower()
    if not clean:
        return set()

    aliases = {clean}
    without_www = clean.removeprefix("www.")
    aliases.add(without_www)
    labels = without_www.split(".")
    if labels:
        aliases.add(labels[0])
        aliases.add(labels[0].replace("-", " "))
    if len(labels) >= 2:
        aliases.add(f"{labels[0]} {labels[1]}")
        aliases.add(f"{labels[1]} {labels[0]}")
    if len(labels) >= 3 and labels[-2:] == ["google", "com"]:
        aliases.add(f"google {labels[0]}")
        aliases.add(f"{labels[0]} google")
    return {alias.strip() for alias in aliases if alias.strip()}


def canonical_phrase_for_domain(domain: str) -> str | None:
    clean = (domain or "").strip().lower().removeprefix("www.")
    special = {
        "docs.google.com": "google docs",
        "mail.google.com": "gmail",
        "calendar.google.com": "google calendar",
        "drive.google.com": "google drive",
        "chat.openai.com": "chatgpt",
        "chatgpt.com": "chatgpt",
    }
    return special.get(clean)


def collect_known_domains(context: dict[str, Any]) -> list[str]:
    domains: set[str] = set()
    for row in context.get("todaySummary", {}).get("topSites", []) or []:
        if isinstance(row, dict):
            domain = row.get("domain")
        else:
            domain = row
        if domain:
            domains.add(str(domain))
    for row in context.get("fullVisitHistory", []) or []:
        if not isinstance(row, dict):
            continue
        domain = row.get("domain")
        if domain:
            domains.add(str(domain))
    for session in context.get("fullSessionHistory", []) or []:
        if not isinstance(session, dict):
            continue
        for row in session.get("topSites", []) or []:
            if isinstance(row, dict):
                domain = row.get("domain")
            else:
                domain = row
            if domain:
                domains.add(str(domain))
        for domain in (session.get("timePerDomain") or {}).keys():
            if domain:
                domains.add(str(domain))
    return sorted(domains)


def detect_question_domains(question: str, context: dict[str, Any]) -> list[str]:
    q = question.lower()
    scored_matches: list[tuple[int, str]] = []
    for domain in collect_known_domains(context):
        normalized_domain = domain.lower().removeprefix("www.")
        root_label = normalized_domain.split(".")[0]
        if root_label in RESERVED_TIME_TERMS:
            continue
        aliases = build_domain_aliases(domain)
        canonical = canonical_phrase_for_domain(domain)
        best_score = -1

        if canonical and canonical in q:
            best_score = max(best_score, 1000 + len(canonical))

        if normalized_domain in q:
            best_score = max(best_score, 900 + len(normalized_domain))

        for alias in aliases:
            if not alias:
                continue
            if alias not in q:
                continue
            score = len(alias)
            if " " in alias:
                score += 200
            elif "." in alias:
                score += 150
            elif alias == normalized_domain.split(".")[0]:
                score += 25
            best_score = max(best_score, score)

        if best_score >= 0:
            scored_matches.append((best_score, domain))

    scored_matches.sort(key=lambda item: (-item[0], item[1]))
    ordered: list[str] = []
    for _, domain in scored_matches:
        if domain not in ordered:
            ordered.append(domain)
    return ordered[:3]


def extract_time_filter(question: str) -> tuple[int | None, str]:
    q = question.lower()
    now = datetime.now(LOCAL_TZ)
    weekday_names = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]
    if "today" in q:
        return int(start_of_day(now).timestamp() * 1000), "today"
    if "yesterday" in q:
        return int(start_of_day(now - timedelta(days=1)).timestamp() * 1000), "yesterday onward"
    if "since monday" in q:
        monday = start_of_day(now - timedelta(days=now.weekday()))
        return int(monday.timestamp() * 1000), "since Monday"
    for index, weekday in enumerate(weekday_names):
        if f"since {weekday}" in q:
            days_back = (now.weekday() - index) % 7
            weekday_start = start_of_day(now - timedelta(days=days_back))
            return int(weekday_start.timestamp() * 1000), f"since {weekday.capitalize()}"
    if "this week" in q or "week so far" in q:
        week_start = start_of_day(now - timedelta(days=now.weekday()))
        return int(week_start.timestamp() * 1000), "this week"
    if "this month" in q:
        month_start = start_of_day(now.replace(day=1))
        return int(month_start.timestamp() * 1000), "this month"
    return None, "all time"


def filter_visits(visits: list[dict[str, Any]], *, start_ms: int | None, domains: list[str]) -> list[dict[str, Any]]:
    domain_set = {domain.lower() for domain in domains}
    rows: list[dict[str, Any]] = []
    for visit in visits:
        time_value = to_float(visit.get("time"), 0)
        if start_ms and time_value < start_ms:
            continue
        domain = str(visit.get("domain") or "").lower()
        if domain_set and domain not in domain_set:
            continue
        rows.append(visit)
    return rows


def filter_sessions(sessions: list[dict[str, Any]], *, start_ms: int | None, domains: list[str]) -> list[dict[str, Any]]:
    domain_set = {domain.lower() for domain in domains}
    rows: list[dict[str, Any]] = []
    for session in sessions:
        session_end = to_float(session.get("end"), 0)
        session_start = to_float(session.get("start"), 0)
        if start_ms and max(session_end, session_start) < start_ms:
            continue
        if domain_set:
            session_domains = {
                str(row.get("domain") or "").lower()
                for row in session.get("visits", []) or []
                if row.get("domain")
            }
            session_domains.update(str(domain).lower() for domain in (session.get("timePerDomain") or {}).keys())
            if not session_domains.intersection(domain_set):
                continue
        rows.append(session)
    return rows


def aggregate_time_for_domains(sessions: list[dict[str, Any]], domains: list[str]) -> int:
    domain_set = {domain.lower() for domain in domains}
    total = 0
    for session in sessions:
        time_per_domain = session.get("timePerDomain") or {}
        for domain, ms in time_per_domain.items():
            if str(domain).lower() in domain_set:
                try:
                    total += int(float(ms or 0))
                except (TypeError, ValueError):
                    continue
    return total


def build_retrieved_context(question: str, context: dict[str, Any]) -> dict[str, Any]:
    domains = detect_question_domains(question, context)
    start_ms, range_label = extract_time_filter(question)
    full_visits = context.get("fullVisitHistory") or []
    full_sessions = context.get("fullSessionHistory") or []
    relevant_visits = filter_visits(full_visits, start_ms=start_ms, domains=domains)
    relevant_sessions = filter_sessions(full_sessions, start_ms=start_ms, domains=domains)

    domain_counts = Counter(
        str(visit.get("domain") or "")
        for visit in relevant_visits
        if visit.get("domain")
    )
    recent_visits = sorted(
        relevant_visits,
        key=lambda row: to_float(row.get("time"), 0),
        reverse=True
    )[:40]

    session_samples = sorted(
        relevant_sessions,
        key=lambda row: max(to_float(row.get("end"), 0), to_float(row.get("start"), 0)),
        reverse=True
    )[:20]

    time_by_domain = defaultdict(int)
    for session in relevant_sessions:
        for domain, ms in (session.get("timePerDomain") or {}).items():
            if domains and str(domain).lower() not in {item.lower() for item in domains}:
                continue
            try:
                time_by_domain[str(domain)] += int(float(ms or 0))
            except (TypeError, ValueError):
                continue

    return {
        "questionScope": {
            "rangeLabel": range_label,
            "startMs": start_ms,
            "matchedDomains": domains,
        },
        "highLevelSummary": {
            "currentSession": context.get("currentSession"),
            "todaySummary": context.get("todaySummary"),
            "recentTodaySessions": context.get("recentTodaySessions"),
            "selectedAnchorSite": context.get("selectedAnchorSite"),
            "analytics": context.get("analytics"),
        },
        "retrievedHistory": {
            "visitCount": len(relevant_visits),
            "sessionCount": len(relevant_sessions),
            "topDomains": [
                {"domain": domain, "visits": count}
                for domain, count in domain_counts.most_common(12)
            ],
            "timeByDomain": [
                {"domain": domain, "timeMs": ms, "timePretty": ms_to_pretty(ms)}
                for domain, ms in sorted(time_by_domain.items(), key=lambda item: item[1], reverse=True)[:12]
            ],
            "recentVisits": recent_visits,
            "sampleSessions": session_samples,
        },
    }


def answer_range_visit_count(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not (("how many" in q or "count" in q) and any(term in q for term in ["visit", "visited", "times"])):
        return None
    domains = detect_question_domains(question, context)
    if not domains:
        return None
    start_ms, range_label = extract_time_filter(question)
    visits = filter_visits(context.get("fullVisitHistory") or [], start_ms=start_ms, domains=domains)
    count = len(visits)
    primary = domains[0]
    if count == 0:
        return f"I don’t see any visits to {primary} {range_label.lower()}."
    ordered = sorted(
        [dt for dt in (to_local_datetime(visit.get("time")) for visit in visits) if dt],
        key=lambda dt: dt.timestamp()
    )
    date_hint = ""
    if ordered:
        date_hint = f" The earliest one in that range was {ordered[0].strftime('%b %-d at %-I:%M %p')}."
    return f"You visited {primary} {count} times {range_label.lower()}.{date_hint}"


def answer_range_time(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not any(phrase in q for phrase in ["how much time", "time on", "spent on"]):
        return None
    domains = detect_question_domains(question, context)
    if not domains:
        return None
    start_ms, range_label = extract_time_filter(question)
    sessions = filter_sessions(context.get("fullSessionHistory") or [], start_ms=start_ms, domains=domains)
    total_ms = aggregate_time_for_domains(sessions, domains)
    primary = domains[0]
    if total_ms <= 0:
        return f"I don’t see tracked time for {primary} {range_label.lower()}."
    return f"You spent about {ms_to_pretty(total_ms)} on {primary} {range_label.lower()}."


def classify_question(question: str) -> str:
    q = question.lower()
    if any(phrase in q for phrase in ["how much time", "time today", "spent today", "today total"]):
        return "time_today"
    if any(phrase in q for phrase in ["top site", "most used site", "used today the most", "most time on"]):
        return "top_site_today"
    if any(phrase in q for phrase in ["how many sessions", "session count", "sessions today"]):
        return "sessions_today"
    if any(phrase in q for phrase in ["switch", "bounce", "between the most", "workflow"]):
        return "switching_pattern"
    if any(phrase in q for phrase in ["productive", "productivity", "focus", "focused"]):
        return "productivity"
    return "general"


def direct_answer(question: str, context: dict[str, Any]) -> str | None:
    direct_history_answer = answer_range_visit_count(question, context) or answer_range_time(question, context)
    if direct_history_answer:
        return direct_history_answer

    kind = classify_question(question)
    today_summary = context.get("todaySummary") or {}
    recent_sessions = context.get("recentTodaySessions") or []
    analytics = context.get("analytics") or {}

    if kind == "time_today":
        total_ms = today_summary.get("totalTimeMs") or 0
        session_count = today_summary.get("sessionCount") or 0
        current_session = context.get("currentSession") or {}
        current_ms = current_session.get("durationMs") or 0
        return (
            f"Today you've spent {ms_to_pretty(total_ms)} across {session_count} "
            f"{'session' if session_count == 1 else 'sessions'}. "
            f"Your current session is {ms_to_pretty(current_ms)}."
        )

    if kind == "top_site_today":
        top_sites = today_summary.get("topSites") or []
        if not top_sites:
            return "I don't have enough tracked browsing yet today to identify a top site."
        top = top_sites[0]
        follow_up = top_sites[1]["domain"] if len(top_sites) > 1 else None
        sentence = (
            f"Your top site today is {top['domain']} with about {top.get('minutes', 0)} minutes "
            f"across {top.get('visits', 0)} visits."
        )
        if follow_up:
            sentence += f" The next closest site is {follow_up}."
        return sentence

    if kind == "sessions_today":
        session_count = today_summary.get("sessionCount") or 0
        if not session_count:
            return "I don't see any tracked sessions for today yet."
        longest = max(recent_sessions, key=lambda row: row.get("durationMs", 0), default=None)
        if longest:
            return (
                f"You've had {session_count} sessions today. "
                f"Your longest recent session was {longest.get('name', 'Unnamed session')} at {ms_to_pretty(longest.get('durationMs', 0))}."
            )
        return f"You've had {session_count} sessions today."

    if kind == "switching_pattern":
        patterns = analytics.get("workflowPatterns") or []
        if not patterns:
            return "I don't have enough multi-site session history yet to identify a strong switching pattern."
        top = patterns[0]
        sites = top.get("sites") or []
        if not sites:
            return "I can see a switching pattern, but I don't have the site names cleanly enough to summarize it."
        if len(sites) == 2 and top.get("type") == "loop":
            return (
                f"Your strongest switching loop is between {sites[0]} and {sites[1]}. "
                f"I saw {top.get('occurrences', 0)} back-and-forth transitions across {top.get('sessions', 0)} sessions."
            )
        return (
            f"One of your strongest browsing paths is {' -> '.join(sites)}. "
            f"It appeared {top.get('occurrences', 0)} times across {top.get('sessions', 0)} sessions."
        )

    return None


def build_llm_prompt(question: str, compact_history: list[dict[str, str]], retrieved_context: dict[str, Any]) -> str:
    transcript_lines = []
    for message in compact_history:
        speaker = "User" if message["role"] == "user" else "Assistant"
        transcript_lines.append(f"{speaker}: {message['content']}")

    return "\n".join(
        [
            "You are the Screen Time Momentum analytics assistant.",
            "Answer like a conversational assistant, not a report generator.",
            "Start with the direct answer in one sentence.",
            "Then give one or two short bullet points grounded in the data.",
            "End with one short follow-up question only if it would genuinely help the user explore more.",
            "Use only the browsing and session data provided.",
            "Do not invent metrics, habits, or explanations that are not supported by the data.",
            "Convert milliseconds into readable time like '3h 50m' instead of exposing raw ms.",
            "If the context is insufficient, say that clearly.",
            "Be concise, practical, and specific.",
            "",
            "Conversation so far:",
            "\n".join(transcript_lines) if transcript_lines else "No prior conversation.",
            "",
            f"User: {question.strip()}",
            "",
            "The JSON below includes the relevant retrieved slice of browsing history for this question plus high-level summaries.",
            f"Context JSON:\n{json.dumps(retrieved_context, indent=2)}",
        ]
    )


class AssistantMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class AssistantRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    history: list[AssistantMessage] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)


app = FastAPI(title="Screen Time Momentum AI Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/analytics/ai")
def analytics_ai(payload: AssistantRequest) -> dict[str, str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
      raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key)
    safe_context = json_safe(payload.context)
    compact_history = [
        {"role": message.role, "content": message.content.strip()}
        for message in payload.history[-6:]
        if message.content.strip()
    ]

    shortcut = direct_answer(payload.question, safe_context)
    if shortcut:
        return {"answer": shortcut}

    retrieved_context = build_retrieved_context(payload.question, safe_context)
    prompt = build_llm_prompt(payload.question, compact_history, retrieved_context)

    try:
        response = client.responses.create(
            model="gpt-5-mini",
            instructions="Answer as a browsing analytics coach. Prefer a natural back-and-forth tone. Use short paragraphs or bullets when useful.",
            input=prompt,
        )
    except Exception as exc:  # pragma: no cover - surfaces upstream issue cleanly
        raise HTTPException(status_code=502, detail=f"OpenAI request failed: {exc}") from exc

    answer = getattr(response, "output_text", "") or ""
    answer = answer.strip()
    if not answer:
        raise HTTPException(status_code=502, detail="OpenAI returned an empty response")

    return {"answer": answer}
