/* global chrome, RezCalendarParser */
(function () {
"use strict";

function unavailable(reason = "calendar_unavailable") {
  return {
    schema: 1,
    source: "rez-calendar-extension",
    observed_at: new Date().toISOString(),
    fresh: false,
    state: "calendar_unavailable",
    detail: reason,
    facility: null,
    view: { type: "unknown", date: null },
    slots: []
  };
}

const previous = globalThis.__rezCalendarMessageListener;
if (typeof previous === "function") {
  try { chrome.runtime.onMessage.removeListener(previous); } catch (_error) { /* Old context may be gone. */ }
}
const listener = (message, _sender, sendResponse) => {
  if (message?.type !== "rez:parse") return;
  try {
    const passive = RezCalendarParser.extract(document, location.href);
    if (passive.state === "login_required") {
      sendResponse(passive);
      return;
    }
    if (message.evidence?.ok !== true) {
      sendResponse(unavailable("unverified_response"));
      return;
    }
    const evidence={...message.evidence,sessionCatalog:message.sessionCatalog||{}};
    if (message.evidence.viewType === 'week') {
      const snapshots = RezCalendarParser.extractFreshWeek(document, location.href, evidence);
      if(snapshots)sendResponse({...snapshots[0],snapshots});
      else {
        const partial=RezCalendarParser.extractFreshWeek(document, location.href, evidence, new Date(), true);
        if(partial?.snapshots?.length)sendResponse({...partial.snapshots[0],...partial});
        else sendResponse({...unavailable('parse_failed'),parserDomDates:Array.from(new Set(Array.from(document.querySelectorAll('.fc-view [data-date]')).map(e=>e.getAttribute('data-date')))).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')).slice(0,7)});
      }
      return;
    }
    const snapshot = RezCalendarParser.extractFreshEvents(document, location.href, evidence);
    if (snapshot.state === "calendar_unavailable") snapshot.detail = "parse_failed";
    sendResponse(snapshot);
  } catch (_error) {
    sendResponse(unavailable("parse_failed"));
  }
};
globalThis.__rezCalendarMessageListener = listener;
chrome.runtime.onMessage.addListener(listener);
})();
