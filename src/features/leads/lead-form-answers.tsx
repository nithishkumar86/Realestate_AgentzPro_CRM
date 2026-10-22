"use client";

import { ClipboardList, RotateCw } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { goToLogin } from "@/features/dashboard/navigation";
import { readError } from "@/features/leads/use-lead-filters";
import type { LeadFormAnswer } from "@/lib/server/lead-query-service";

const LOAD_ERROR = "The form answers could not be loaded.";
/** Answers longer than this take the full width of the card, so they read as a sentence instead of a narrow column. */
const WIDE_ANSWER_LENGTH = 40;

/** Meta sends each question as a key ("budget_range", "when_do_you_plan_to_buy?"); it is shown as "Budget range". */
export function formatQuestion(key: string): string {
  const text = key.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : key;
}

const OPTION_KEY = /^[\p{Ll}\p{N}'’+.-]+(?:_[\p{Ll}\p{N}'’+.-]+)*$/u;

/**
 * A multiple-choice answer arrives as the option's key ("within_a_month", "no") and is shown as "Within a month", "No".
 * Anything the lead typed themselves (spaces, capitals, an email, a URL) is shown exactly as written.
 */
export function formatAnswer(value: string): string {
  if (!OPTION_KEY.test(value)) return value;
  const text = value.replace(/_+/g, " ");
  return text[0].toUpperCase() + text.slice(1);
}

type AnswersState = { status: "loading" } | { status: "ready"; answers: LeadFormAnswer[] } | { status: "error"; message: string };

/** Loads one lead's form answers once (they never change after the lead arrives); retry() loads them again. */
function useLeadFormAnswers(leadId: string) {
  const [state, setState] = useState<AnswersState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      const response = await fetch(`/api/leads/${leadId}`, { cache: "no-store" }).catch(() => null);
      if (!active) return;
      if (response?.status === 401) { goToLogin(); return; }
      if (!response?.ok) {
        const message = response ? await readError(response, LOAD_ERROR) : LOAD_ERROR;
        if (active) setState({ status: "error", message });
        return;
      }
      const body = await response.json().catch(() => null) as { answers?: LeadFormAnswer[] } | null;
      if (!active) return;
      setState(Array.isArray(body?.answers) ? { status: "ready", answers: body.answers } : { status: "error", message: LOAD_ERROR });
    }
    void load();
    return () => { active = false; };
  }, [leadId, attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  return { state, retry };
}

function AnswerTile({ answer }: { answer: LeadFormAnswer }) {
  const values = answer.values.map(formatAnswer);
  const wide = values.join(", ").length > WIDE_ANSWER_LENGTH;
  return <div className={wide ? "mvp-form-answer mvp-form-answer--wide" : "mvp-form-answer"}>
    <dt>{formatQuestion(answer.name)}</dt>
    <dd>{values.length > 1
      ? <ul className="mvp-form-answer__chips">{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul>
      : values[0]}</dd>
  </div>;
}

/**
 * Everything the lead answered on the Meta form (budget, loan, timeline...), in the form's order, for the telecaller
 * to read before calling. Name, phone and email are not repeated here: the drawer already shows them above.
 * A failed load stays inside this card with its own Retry, so it never blocks the status, task or note steps.
 */
export function LeadFormAnswers({ leadId }: { leadId: string }) {
  const headingId = useId();
  const { state, retry } = useLeadFormAnswers(leadId);
  const count = state.status === "ready" ? state.answers.length : 0;

  return <section className="mvp-form-answers" aria-labelledby={headingId} aria-busy={state.status === "loading" || undefined}>
    <header className="mvp-form-answers__head">
      <span className="mvp-form-answers__icon" aria-hidden="true"><ClipboardList size={16} /></span>
      <h3 id={headingId}>Form answers</h3>
      {count ? <span className="mvp-form-answers__count">{count === 1 ? "1 answer" : `${count} answers`}</span> : null}
    </header>
    {state.status === "loading" ? <>
      <span className="sr-only" role="status">Loading form answers…</span>
      <div className="mvp-form-answers__grid" aria-hidden="true">
        <span className="mvp-form-answers__skeleton" />
        <span className="mvp-form-answers__skeleton" />
      </div>
    </> : null}
    {state.status === "error" ? <div className="mvp-form-answers__notice" role="alert">
      <span>{state.message}</span>
      <button type="button" className="mvp-form-answers__retry" onClick={retry}><RotateCw size={14} aria-hidden="true" />Retry</button>
    </div> : null}
    {state.status === "ready" && count === 0
      ? <p className="mvp-form-answers__empty">This lead&apos;s form had no questions besides name, phone and email.</p>
      : null}
    {state.status === "ready" && count > 0
      ? <dl className="mvp-form-answers__grid">{state.answers.map((answer, index) => <AnswerTile key={`${index}-${answer.name}`} answer={answer} />)}</dl>
      : null}
  </section>;
}
