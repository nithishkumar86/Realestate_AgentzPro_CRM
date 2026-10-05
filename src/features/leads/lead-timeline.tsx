"use client";

import { ArrowRightLeft, CalendarClock, CircleCheck, CircleX, ListTodo, StickyNote, UserPlus, type LucideIcon } from "lucide-react";
import { useId, useImperativeHandle, useState, type Ref } from "react";
import { Notice, SkeletonRows } from "@/components/ui";
import { TIMELINE_FILTERS, type LeadActivityType, type TimelineFilter } from "@/features/leads/lead-options";
import { formatActivityTime } from "@/features/leads/lead-task-client";
import { useLeadTimeline } from "@/features/leads/use-lead-timeline";

const TAB_LABELS: Record<TimelineFilter, string> = { all: "All", status: "Status", notes: "Notes", tasks: "Tasks" };

const EMPTY_MESSAGES: Record<TimelineFilter, string> = {
  all: "Nothing has happened on this lead yet.",
  status: "No status changes yet.",
  notes: "No notes yet. Add the first one above.",
  tasks: "No tasks yet. Add a follow-up task above.",
};

const TYPE_ICONS: Record<LeadActivityType, { icon: LucideIcon; tone: string }> = {
  lead_created: { icon: UserPlus, tone: "blue" },
  status_change: { icon: ArrowRightLeft, tone: "blue" },
  note_added: { icon: StickyNote, tone: "yellow" },
  task_created: { icon: ListTodo, tone: "teal" },
  task_rescheduled: { icon: CalendarClock, tone: "teal" },
  task_completed: { icon: CircleCheck, tone: "green" },
  task_cancelled: { icon: CircleX, tone: "gray" },
};

export interface LeadTimelineHandle { refresh: () => Promise<void> }

/**
 * The lead's history, newest first, with All / Status / Notes / Tasks tabs. Rows are written only by the
 * database; this component just reads them. The parent drawer calls refresh() after its own changes.
 */
export function LeadTimeline({ leadId, timezone, ref }: { leadId: string; timezone: string; ref?: Ref<LeadTimelineHandle> }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const timeline = useLeadTimeline(leadId, filter);
  const tabsId = useId();
  useImperativeHandle(ref, () => ({ refresh: timeline.refresh }), [timeline.refresh]);

  return <section className="mvp-timeline" aria-labelledby={`${tabsId}-title`}>
    <h3 id={`${tabsId}-title`} className="mvp-lead-drawer__section-title">Timeline</h3>
    <div className="mvp-members__tabs" role="tablist" aria-label="Timeline filter">
      {TIMELINE_FILTERS.map((value) => <button key={value} type="button" role="tab" id={`${tabsId}-${value}`} aria-selected={filter === value}
        aria-controls={`${tabsId}-panel`} className="mvp-members__tab" onClick={() => setFilter(value)}>{TAB_LABELS[value]}</button>)}
    </div>
    <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${filter}`} className="mvp-timeline__panel">
      {timeline.error ? <Notice tone="danger" title="Timeline unavailable" action={<button type="button" className="mvp-timeline__more" onClick={() => void timeline.retry()}>Retry</button>}>{timeline.error}</Notice> : null}
      {timeline.loading ? <SkeletonRows count={4} /> : null}
      {!timeline.loading && !timeline.error && timeline.items.length === 0 ? <p className="mvp-timeline__empty">{EMPTY_MESSAGES[filter]}</p> : null}
      {!timeline.loading && timeline.items.length > 0 ? <ol className="mvp-timeline__list">
        {timeline.items.map((item) => {
          const { icon: Icon, tone } = TYPE_ICONS[item.type] ?? TYPE_ICONS.status_change;
          return <li key={item.id} className="mvp-timeline__item">
            <span className={`mvp-timeline__icon mvp-timeline__icon--${tone}`} aria-hidden="true"><Icon size={16} /></span>
            <div className="mvp-timeline__content">
              <p className="mvp-timeline__summary">{item.type === "note_added" ? "Note added" : item.summary}</p>
              {item.type === "note_added" ? <p className="mvp-timeline__note">{item.noteBody ?? item.summary}</p> : null}
              <p className="mvp-timeline__meta"><span>{item.actorName}</span><span aria-hidden="true">·</span><time dateTime={item.createdAt}>{formatActivityTime(item.createdAt, timezone)}</time></p>
              {item.backfilled ? <p className="mvp-timeline__hint">Earlier history wasn&apos;t recorded.</p> : null}
            </div>
          </li>;
        })}
      </ol> : null}
      {!timeline.loading && timeline.hasMore ? <button type="button" className="mvp-timeline__more" disabled={timeline.loadingMore} onClick={() => void timeline.loadMore()}>
        {timeline.loadingMore ? "Loading..." : "Load more"}
      </button> : null}
    </div>
  </section>;
}
