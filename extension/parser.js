/* global window */
(function (root) {
  "use strict";

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/g;
  const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/;
  const TURKEY_TIME = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  function text(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function visible(element) {
    if (!element || element.closest?.('[aria-hidden="true"]')) return false;
    if (element.getClientRects && element.getClientRects().length === 0) return false;
    return true;
  }

  function istanbulDate(now) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  }

  function pageState(doc, url) {
    if (!/^https:\/\/rez\.metu\.edu\.tr\/view\/home\.jsf(?:[?#]|$)/.test(url)) {
      return "login_required";
    }
    if (doc.querySelector('input[type="password"]')) return "login_required";
    const bodyText = text(doc.body).toLowerCase();
    if (/oturum zaman aşım|session expired|oturum aç|giriş yap/.test(bodyText)
      && !doc.querySelector('.fc-view')) return "login_required";
    return "ok";
  }

  function facility(doc) {
    const input = doc.getElementById("form:facility_input");
    const label = doc.getElementById("form:facility_label");
    const id = String(input?.value || "").trim();
    const name = text(label);
    if (!/^\d{1,4}$/.test(id) || !name || name.length > 180
      || /^(seç|select|choose)$/i.test(name)) return null;
    return { id, label: name };
  }

  function isDayView(doc, view) {
    const classes = String(view?.className || "");
    if (/(?:agenda|basic|timegrid|daygrid)[-_]?day/i.test(classes)) return true;
    const activeDay = doc.querySelector(
      '.fc-day-button.fc-state-active, .fc-timeGridDay-button.fc-button-active, '
      + '.fc-dayGridDay-button.fc-button-active, .fc-day-button.fc-button-active'
    );
    return Boolean(activeDay);
  }

  function dayDate(doc, view) {
    if (!view || !isDayView(doc, view)) return null;
    const dates = new Set();
    for (const element of view.querySelectorAll("[data-date]")) {
      const date = element.getAttribute("data-date");
      if (DATE_RE.test(date || "")) dates.add(date);
    }
    if (dates.size === 0) {
      for (const event of view.querySelectorAll(".fc-event")) {
        if (!visible(event)) continue;
        const date = event.getAttribute("data-start")?.slice(0, 10);
        if (!DATE_RE.test(date || "")) return null;
        dates.add(date);
      }
    }
    if (dates.size !== 1) return null;
    const [date] = dates;
    const actual = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(actual.getTime()) || actual.toISOString().slice(0, 10) !== date) return null;
    return date;
  }

  function times(value) {
    const matches = [...String(value || "").matchAll(TIME_RE)].map((match) => {
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) return null;
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }).filter(Boolean);
    return { start: matches[0] || null, end: matches[1] || null };
  }

  function validDate(date) {
    if (!DATE_RE.test(date || '')) return false;
    const actual = new Date(`${date}T12:00:00Z`);
    return !Number.isNaN(actual.getTime()) && actual.toISOString().slice(0, 10) === date;
  }

  function turkeyDateTime(value) {
    if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return null;
    const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const instant = new Date(normalized);
    if (!Number.isFinite(instant.getTime())) return null;
    const parts = Object.fromEntries(TURKEY_TIME.formatToParts(instant)
      .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (!validDate(date)) return null;
    return { date, time: `${parts.hour}:${parts.minute}` };
  }

  function eventDateTimes(event,evidence,now) {
    const start=turkeyDateTime(event?.start),end=turkeyDateTime(event?.end);
    if(!start||!end||start.date===end.date)return {start,end};
    // A site response was observed with a correct start and an end dated
    // exactly one week earlier. Never guess a duration or shift arbitrary
    // dates: require the separately verified booking-form session for the
    // same facility/day, checked within the last 24 hours.
    const priorWeek=new Date(`${start.date}T12:00:00Z`);
    priorWeek.setUTCDate(priorWeek.getUTCDate()-7);
    const catalog=evidence?.sessionCatalog?.[`${evidence.facilityId}|${start.date}`];
    const age=now.getTime()-Date.parse(catalog?.verifiedAt||'');
    if(event.allDay!==true&&end.date===priorWeek.toISOString().slice(0,10)
      &&start.time<end.time&&catalog?.source==='official-booking-form'
      &&Number.isFinite(age)&&age>=0&&age<=24*60*60_000&&Array.isArray(catalog.sessions)
      &&catalog.sessions.length<=100&&catalog.sessions.some(s=>s.start===start.time&&s.end===end.time)){
      return {start,end:{...end,date:start.date}};
    }
    return {start,end};
  }

  function extractFreshEvents(doc, url, evidence, now = new Date()) {
    const base = {
      schema: 1,
      source: 'rez-calendar-extension',
      observed_at: now.toISOString(),
      fresh: false,
      state: pageState(doc, url),
      facility: null,
      view: { type: 'unknown', date: null },
      slots: []
    };
    if (base.state !== 'ok') return base;
    const view = doc.querySelector('.fc-view');
    const selected = facility(doc);
    const week = evidence?.viewType === 'week';
    const visibleDates = week && view ? new Set(Array.from(view.querySelectorAll('[data-date]'))
      .map(node => node.getAttribute('data-date')).filter(validDate)) : null;
    if(week&&evidence.clippedDate===evidence.date&&evidence.date===istanbulDate(now)){
      const tomorrow=new Date(`${evidence.date}T12:00:00Z`);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
      if([...visibleDates].sort()[0]===tomorrow.toISOString().slice(0,10))visibleDates.add(evidence.date);
    }
    const verifiedView = week ? /(?:agenda|basic|timegrid|daygrid)[-_]?week/i.test(String(view?.className || ''))
      && visibleDates.has(evidence.date) : isDayView(doc, view);
    if (!view || !visible(view) || !verifiedView || !selected
      || !evidence || selected.id !== evidence.facilityId
      || !validDate(evidence.date)
      || !/^[a-f0-9-]{16,80}$/i.test(evidence.refreshId || '')
      || !Array.isArray(evidence.events) || evidence.events.length > 1000) {
      base.state = 'calendar_unavailable';
      return base;
    }
    const domDate = dayDate(doc, view);
    if (domDate && domDate !== evidence.date) {
      base.state = 'calendar_unavailable';
      return base;
    }
    const seen = new Set();
    const slots = [];
    let recognized = 0;
    for (const event of evidence.events) {
      if (!event || typeof event !== 'object' || typeof event.title !== 'string') {
        base.state = 'calendar_unavailable';
        return base;
      }
      const match = event.title.match(/(?:Boş|Bos)\s*:\s*(\d+)/i);
      if (!match) continue;
      recognized += 1;
      const free = Number(match[1]);
      if (!Number.isSafeInteger(free) || free > 10000 || event.allDay === true) {
        base.state = 'calendar_unavailable';
        return base;
      }
      const {start,end}=eventDateTimes(event,evidence,now);
      if (!start || !end || start.date !== evidence.date || end.date !== evidence.date
        || start.time >= end.time) {
        base.state = 'calendar_unavailable';
        return base;
      }
      const key = `${start.time}|${end.time}`;
      if (seen.has(key) || slots.length >= 200) {
        base.state = 'calendar_unavailable';
        return base;
      }
      seen.add(key);
      slots.push({ date: evidence.date, start: start.time, end: end.time, free });
    }
    // A changed event title must not be mistaken for a confirmed empty calendar.
    if (evidence.events.length > 0 && recognized === 0) {
      base.state = 'calendar_unavailable';
      return base;
    }
    base.state = 'ok';
    base.facility = selected;
    base.view = { type: 'day', date: evidence.date };
    base.slots = slots;
    base.fresh = true;
    base.refresh_id = evidence.refreshId;
    return base;
  }

  function extractFreshWeek(doc, url, evidence, now = new Date(), partial = false) {
    if (evidence?.viewType !== 'week' || !Array.isArray(evidence.dates)
      || !evidence.dates.length || evidence.dates.length > 7 || new Set(evidence.dates).size !== evidence.dates.length
      || !evidence.dates.every(validDate) || !Array.isArray(evidence.events)) return null;
    const byDay = new Map(evidence.dates.map(date => [date, []]));
    const weekStart = new Date(`${evidence.dates[0]}T12:00:00Z`);
    weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    const firstDay = weekStart.toISOString().slice(0,10);
    const afterWeek = weekEnd.toISOString().slice(0,10);
    if (evidence.dates.some(date => date < firstDay || date >= afterWeek)) return null;
    if(partial && evidence.dates.some(date=>{
      const check=extractFreshEvents(doc,url,{...evidence,date,events:[]},now);
      return check.state!=='ok'||!check.fresh;
    }))return null;
    const invalidDates = new Set();
    for (const event of evidence.events) {
      const start=turkeyDateTime(event?.start);
      if(!start||start.date<firstDay||start.date>=afterWeek)return null;
      // Disabled dates are not observations. A malformed old end date in
      // yesterday's excluded event must not poison tomorrow's valid pages.
      if(!byDay.has(start.date))continue;
      const {end}=eventDateTimes(event,evidence,now);
      if(!end||start.date!==end.date||start.time>=end.time){
        if(!partial)return null;
        invalidDates.add(start.date);
      }
      byDay.get(start.date).push(event);
    }
    const snapshots = evidence.dates.map(date => extractFreshEvents(doc, url,
      { ...evidence, date, events: byDay.get(date) }, now));
    if(!partial)return snapshots.every(item => item.state === 'ok' && item.fresh) ? snapshots : null;
    // Only a time-invalid event with a verified start date may quarantine its
    // own day. Missing DOM/provenance, unknown starts, or out-of-week records
    // still reject the capture. Never emit an empty/fresh page for a bad day.
    if(snapshots.some((item,i) => !invalidDates.has(evidence.dates[i]) && (item.state !== 'ok' || !item.fresh)))return null;
    const accepted=snapshots.filter((item,i)=>!invalidDates.has(evidence.dates[i]));
    if(!accepted.length)return null;
    return {snapshots:accepted,rejectedDates:evidence.dates.filter(date=>invalidDates.has(date))};
  }

  function extract(doc, url, now = new Date()) {
    const observedAt = now.toISOString();
    const state = pageState(doc, url);
    const base = {
      schema: 1,
      source: "rez-calendar-extension",
      observed_at: observedAt,
      fresh: false,
      state,
      facility: null,
      view: { type: "unknown", date: null },
      slots: []
    };
    if (state !== "ok") return base;

    base.facility = facility(doc);
    const view = doc.querySelector(".fc-view");
    if (!base.facility || !view || !visible(view)) {
      base.state = "calendar_unavailable";
      return base;
    }
    base.view.type = isDayView(doc, view) ? "day" : "week";
    const date = dayDate(doc, view);
    if (!date) {
      base.state = "calendar_unavailable";
      return base;
    }
    base.view.date = date;

    const slots = [];
    const seen = new Set();
    for (const event of view.querySelectorAll(".fc-event")) {
      if (!visible(event)) continue;
      const eventText = text(event);
      const titleText = text(event.querySelector(".fc-title")) || eventText;
      const freeMatch = titleText.match(/(?:Boş|Bos)\s*:\s*(\d+)/i);
      if (!freeMatch) continue;
      const free = Number(freeMatch[1]);
      const timeText = text(event.querySelector(".fc-time")) || eventText;
      const { start, end } = times(timeText);
      const eventDate = event.getAttribute("data-date") || event.getAttribute("data-start")?.slice(0, 10);
      if (!Number.isSafeInteger(free) || free > 10000 || !start || !end || start >= end
        || (eventDate && eventDate !== date)) {
        base.state = "calendar_unavailable";
        base.slots = [];
        return base;
      }
      const key = `${date}|${start}|${end}`;
      if (seen.has(key) || slots.length >= 200) {
        base.state = "calendar_unavailable";
        base.slots = [];
        return base;
      }
      seen.add(key);
      slots.push({ date, start, end, free });
    }
    base.slots = slots;
    return base;
  }

  root.RezCalendarParser = { extract, extractFreshEvents, extractFreshWeek, istanbulDate, times };
})(typeof window === "undefined" ? globalThis : window);
