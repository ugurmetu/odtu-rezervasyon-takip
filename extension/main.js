/* global PrimeFaces */
"use strict";

// Runs in the page's MAIN world so it can use the site's own PrimeFaces widget.
// It never sends a direct HTTP request or touches login, booking or CAPTCHA controls.
// The whole module is one self-contained function: a file injection runs the
// legacy one-shot refresh, while the service worker can pass this function to
// scripting.executeScript({func, args}) for a single verified facility read.
function rezMainPage(request, root) {
  "use strict";
  root = root || window;
  const SOURCE_ID = "form:myschedule";
  const MIN_INTERVAL_MS = 15_000;
  const RESPONSE_TIMEOUT_MS = 15_000;
  const HOME_URL = /^https:\/\/rez\.metu\.edu\.tr\/view\/home\.jsf(?:[?#]|$)/;
  const ABUSE_DENIAL_RE = /access denied[.\s]+automated abuse,\s*scraping,\s*or malicious behavior/i;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ISTANBUL_DAY = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const ISTANBUL_HOUR = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul", hour: "2-digit", hourCycle: "h23"
  });

  function todayInIstanbul(timestamp) {
    const parts = Object.fromEntries(ISTANBUL_DAY.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function validDay(value) {
    if (!DAY_RE.test(value || "")) return false;
    const parsed = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function nextDay(day) {
    const date = new Date(`${day}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  function desiredDay(timestamp) {
    const today = todayInIstanbul(timestamp);
    // The new week's sessions are published on Sunday evening. Move the
    // selected day to Monday once the local clock reaches 21:00; a first
    // reading on Monday is only a baseline, never a vacancy notification.
    const sunday = new Date(`${today}T12:00:00Z`).getUTCDay() === 0;
    return sunday && Number(ISTANBUL_HOUR.format(new Date(timestamp))) >= 21
      ? nextDay(today) : today;
  }

  // The site's extender supplies a time-bearing end (Sunday 23:59:59).
  // FullCalendar's weekly date profile floors that end to Sunday midnight,
  // leaving no visible day on Sunday. Read whole days within the same local
  // dates; a date-only or midnight end remains exclusive. Actual vacancies
  // must still come from the normal authenticated schedule response.
  function normalizeReadRange(range) {
    if (!range || typeof range !== 'object') return range;
    function boundary(value, end) {
      if (typeof value === 'string' && validDay(value)) return value;
      let day, time;
      if (typeof value?.format === 'function') {
        day = value.format('YYYY-MM-DD');
        time = value.format('HH:mm:ss.SSS');
      } else {
        const stamp = value instanceof Date ? value.getTime()
          : typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(stamp)) return value;
        day = todayInIstanbul(stamp);
        time = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Istanbul',
          hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(stamp));
        if (new Date(stamp).getUTCMilliseconds()) time += '.001';
      }
      if (!validDay(day)) return value;
      return end && /^\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(time)
        && /[1-9]/.test(time) ? nextDay(day) : day;
    }
    return {...range, ...('start' in range ? {start:boundary(range.start,false)} : {}),
      ...('end' in range ? {end:boundary(range.end,true)} : {})};
  }

  function normalizeReaderConfig(cfg) {
    function wrap(target) {
      const range = target.validRange;
      if (typeof range === 'function') target.validRange = function(...args) {
        return normalizeReadRange(range.apply(this,args));
      };
      else if (range) target.validRange = normalizeReadRange(range);
    }
    const extender = cfg.extender;
    if (typeof extender === 'function') cfg.extender = function(...args) {
      const result = extender.apply(this,args);
      wrap(this.cfg || cfg);
      return result;
    };
    else wrap(cfg);
  }

  function inspectContext(env) {
    if (!HOME_URL.test(env.location.href)) return { reason: "unexpected_page" };
    // A denial can replace the whole page without an AJAX response. In that
    // case there is no widget to call, so detect the known page before probing it.
    if (ABUSE_DENIAL_RE.test(String(env.document.body?.textContent || "").slice(0, 16_384))) {
      return { reason: "site_access_denied" };
    }
    if (env.document.querySelector('input[type="password"]')) return { reason: "login_form_present" };
    const pf = env.PrimeFaces;
    const handle = pf?.ajax?.Request?.handle;
    if (typeof handle !== "function") return { reason: "primefaces_unavailable" };
    const widgets = Object.values(pf.widgets || {});
    const matches = widgets.filter((item) => item?.id === SOURCE_ID);
    if (!matches.length) return { reason: "schedule_widget_missing" };
    if (matches.length !== 1 || typeof matches[0].update !== "function"
      || typeof matches[0].jqc?.fullCalendar !== "function") {
      return { reason: "schedule_widget_unusable" };
    }
    const widget = matches[0];
    let view;
    let dateValue;
    try {
      view = widget.jqc.fullCalendar("getView");
      dateValue = widget.jqc.fullCalendar("getDate");
    } catch (_error) { return { reason: "calendar_view_unavailable" }; }
    const viewName = String(view?.name || view?.type || "");
    const week = /(?:agenda|basic|timeGrid|dayGrid)Week$/i.test(viewName);
    if (!week && !/(?:agenda|basic|timeGrid|dayGrid)Day$/i.test(viewName)) return { reason: "not_day_view" };
    if (typeof dateValue?.format !== "function") return { reason: "calendar_date_unavailable" };
    let date;
    try {
      date = dateValue.format("YYYY-MM-DD");
    } catch (_error) { return { reason: "calendar_date_unavailable" }; }
    if (!validDay(date)) return { reason: "calendar_date_unavailable" };
    if (typeof view?.start?.format === "function") {
      let start;
      try { start = view.start.format("YYYY-MM-DD"); }
      catch (_error) { return { reason: "calendar_date_unavailable" }; }
      if (!week && start !== date) return { reason: "calendar_date_mismatch" };
    }
    const dates = [];
    let clippedDate = null;
    if (week) {
      // FullCalendar clips the active week to the site's valid range. Disabled
      // past days have no data-date and must never become empty observations.
      const cells = env.document.getElementById('form:myschedule_container')
        ?.querySelectorAll?.('.fc-view [data-date]');
      const enabled = cells ? [...new Set(Array.from(cells).map(node => node.getAttribute('data-date'))
        .filter(validDay))].sort() : [];
      if (enabled.length) {
        dates.push(...enabled);
        // A validRange starting at today's current time clips the whole-day
        // DOM cell. Keep today only when it is this view's anchor and directly
        // precedes the enabled range. Past days remain excluded. Only the
        // verified normal AJAX response can produce an availability event.
        if(date===todayInIstanbul(env.Date.now())&&nextDay(date)===dates[0]){dates.unshift(date);clippedDate=date;}
      }
      else {
        const start = view?.start?.format?.('YYYY-MM-DD');
        const end = view?.end?.format?.('YYYY-MM-DD');
        if (!validDay(start) || !validDay(end)) return { reason: 'calendar_date_unavailable' };
        for (let day = start; day < end && dates.length < 8; day = nextDay(day)) dates.push(day);
      }
      if (!dates.length || dates.length > 7 || dates.some((day, index) => index && nextDay(dates[index - 1]) !== day)) {
        return { reason: 'calendar_date_mismatch' };
      }
    }
    const facilityId = String(env.document.getElementById("form:facility_input")?.value || "").trim();
    if (!/^\d{1,4}$/.test(facilityId)) return { reason: "facility_not_selected" };
    const target = desiredDay(env.Date.now());
    return { context: { widget, pf, date, facilityId, ...(week ? { dates,clippedDate } : {}) },
      advanceTo: (week ? dates[6] < target : date < target) ? target : null };
  }

  function readContext(env) {
    return inspectContext(env).context || null;
  }

  function parseScheduleResponse(responseXML, status, xhr) {
    if (status !== "success" || Number(xhr?.status) !== 200) return null;
    if (xhr.responseURL && !String(xhr.responseURL).startsWith("https://rez.metu.edu.tr/")) return null;
    const xml = responseXML || xhr?.responseXML;
    const rootNode = xml?.documentElement;
    if (String(rootNode?.localName || rootNode?.nodeName || "").toLowerCase() !== "partial-response") {
      return null;
    }
    if (xml.getElementsByTagName("error").length || xml.getElementsByTagName("redirect").length) {
      return null;
    }
    const updates = Array.from(xml.getElementsByTagName("update"))
      .filter((node) => node.getAttribute("id") === SOURCE_ID);
    if (updates.length !== 1) return null;
    const content = updates[0].textContent?.trim() || "";
    if (!content || content.length > 2_000_000) return null;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_error) {
      return null;
    }
    if (!Array.isArray(parsed?.events) || parsed.events.length > 1000) return null;
    const events = [];
    for (const event of parsed.events) {
      if (!event || typeof event !== "object" || typeof event.title !== "string"
        || typeof event.start !== "string" || typeof event.end !== "string"
        || event.title.length > 300 || event.start.length > 80 || event.end.length > 80) return null;
      events.push({
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay === true
      });
    }
    return events;
  }

  function siteBlockReason(xhr, responseXML = xhr?.responseXML) {
    const status = Number(xhr?.status);
    if (status === 403) return "site_access_denied";
    if (status === 429) return "site_rate_limited";
    // The site can serve its explicit abuse-denial page with HTTP 200. Treat
    // that response like a 403 so a blocked account does not keep polling.
    const body = typeof xhr?.responseText === "string" ? xhr.responseText
      : String(responseXML?.documentElement?.textContent || "");
    if (ABUSE_DENIAL_RE.test(body.slice(0, 16_384))) return "site_access_denied";
    return null;
  }

  function sessionExpiryReason(xhr, responseXML = xhr?.responseXML) {
    if (Number(xhr?.status) === 401) return "login_required";
    if (responseXML?.getElementsByTagName?.("redirect")?.length) return "login_required";
    const xmlText = String(responseXML?.documentElement?.textContent || "").slice(0, 16_384);
    if (/\bViewExpiredException\b/.test(xmlText)) return "login_required";
    const body = typeof xhr?.responseText === "string" ? xhr.responseText.slice(0, 16_384) : xmlText;
    const rootName = String(responseXML?.documentElement?.localName || "").toLowerCase();
    if (rootName !== "html" && !/<(?:!doctype\s+html|html\b)/i.test(body.slice(0, 1024))) return null;
    if (responseXML?.querySelector?.('input[type="password"]')
      || /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(body)
      || /\b(?:session expired|oturum zaman aşım|oturum aç|giriş yap|sign in|log in)\b/i.test(body)) {
      return "login_required";
    }
    return null;
  }

  function createController(env) {
    let busy = false;
    let lastAttempt = 0;

    async function refresh() {
      const now = env.Date.now();
      if (busy || now - lastAttempt < MIN_INTERVAL_MS) return { ok: false, reason: "rate_limited" };
      const inspection = inspectContext(env);
      if (!inspection.context) return { ok: false, reason: inspection.reason };
      const context = inspection.context;
      busy = true;
      lastAttempt = now;

      try {
        if (inspection.advanceTo) {
          // Navigation can itself ask the site for events. Do not also call
          // widget.update() in this attempt; the next gated attempt verifies
          // a fresh schedule for the new day.
          try {
            context.widget.jqc.fullCalendar("gotoDate", inspection.advanceTo);
            const selected = context.widget.jqc.fullCalendar("getDate")?.format?.("YYYY-MM-DD");
            return { ok: false, reason: selected === inspection.advanceTo
              ? "calendar_day_advanced" : "calendar_day_advance_failed" };
          } catch (_error) {
            return { ok: false, reason: "calendar_day_advance_failed" };
          }
        }
        return await new Promise((resolve) => {
          let settled = false;
          let intercepted = 0;
          let updateReturned = false;
          let proof = null;
          const originalHandle = context.pf.ajax.Request.handle;
          const timeout = env.setTimeout(() => finish({ ok: false, reason: "timeout" }), RESPONSE_TIMEOUT_MS);

          function finish(value) {
            if (settled) return;
            settled = true;
            env.clearTimeout(timeout);
            resolve(value);
          }

          function sameContext() {
            const current = inspectContext(env);
            return !current.advanceTo && current.context?.widget === context.widget
              && current.context.facilityId === context.facilityId
              && current.context.date === context.date
              && String(current.context.dates) === String(context.dates);
          }

          context.pf.ajax.Request.handle = function (options, ...rest) {
            if (options?.source !== SOURCE_ID) return originalHandle.call(this, options, ...rest);
            intercepted += 1;
            if (intercepted > 1) {
              finish({ ok: false, reason: "ambiguous_request" });
              return originalHandle.call(this, options, ...rest);
            }
            const originalSuccess = options.onsuccess;
            const originalError = options.onerror;
            options.onerror = function (xhr, status, error, ...args) {
              let result;
              try {
                if (typeof originalError === "function") result = originalError.call(this, xhr, status, error, ...args);
              } finally {
                finish({ ok: false, reason: siteBlockReason(xhr) || sessionExpiryReason(xhr)
                  || "unverified_response" });
              }
              return result;
            };
            options.onsuccess = function (responseXML, status, xhr, ...args) {
              const blocked = siteBlockReason(xhr, responseXML);
              const expired = sessionExpiryReason(xhr, responseXML);
              let events = null;
              try {
                events = parseScheduleResponse(responseXML, status, xhr);
              } catch (_error) {
                // An unexpected AJAX shape must never be reported as a fresh calendar.
              }
              let result;
              try {
                if (typeof originalSuccess !== "function") throw new Error("missing_schedule_callback");
                result = originalSuccess.call(this, responseXML, status, xhr, ...args);
              } catch (_error) {
                finish({ ok: false, reason: blocked || expired || "schedule_render_failed" });
                return false;
              }
              if (blocked) {
                finish({ ok: false, reason: blocked });
                return result;
              }
              if (expired) {
                finish({ ok: false, reason: expired });
                return result;
              }
              if (!events || !sameContext()) {
                finish({ ok: false, reason: "unverified_response" });
                return result;
              }
              proof = {
                ok: true,
                date: context.date,
                facilityId: context.facilityId,
                events,
                ...(context.dates ? { viewType: "week", dates: context.dates,
                  ...(context.clippedDate?{clippedDate:context.clippedDate}:{}) } : {}),
                refreshId: env.crypto.randomUUID()
              };
              if (updateReturned && intercepted === 1) finish(proof);
              return result;
            };
            return originalHandle.call(this, options, ...rest);
          };

          try {
            context.widget.update();
            updateReturned = true;
            if (intercepted !== 1) finish({ ok: false, reason: "no_schedule_request" });
            else if (proof) finish(proof);
          } catch (_error) {
            finish({ ok: false, reason: "refresh_failed" });
          } finally {
            // Only the synchronous widget invocation needs the temporary hook.
            context.pf.ajax.Request.handle = originalHandle;
          }
        });
      } finally {
        busy = false;
      }
    }

    return { refresh };
  }

  const UNIT_SOURCE = "form:unit";
  const FACILITY_SOURCE = "form:facility";
  const READ_STEP_TIMEOUT_MS = 12_000;
  const MAX_READ_ACTIONS = 5;
  const FATAL_READ_REASONS = new Set(["login_required", "site_access_denied", "site_rate_limited"]);

  // A facility or unit change is a normal PrimeFaces behavior request. Only a
  // successful partial response without an error proves that the server, not
  // just the page's hidden input, now holds the selected facility.
  function behaviorFailure(xhr, status) {
    const xml = xhr?.responseXML;
    const blocked = siteBlockReason(xhr, xml);
    if (blocked) return blocked;
    const expired = sessionExpiryReason(xhr, xml);
    if (expired) return expired;
    if (status !== "success" || Number(xhr?.status) !== 200) return "unverified_response";
    const rootNode = xml?.documentElement;
    if (rootNode && (String(rootNode.localName || rootNode.nodeName || "").toLowerCase() !== "partial-response"
      || xml.getElementsByTagName("error").length)) return "unverified_response";
    return null;
  }

  // One facility read as a short series of page calls. Each call does only
  // synchronous work: install the response hook, make the next site action
  // when the budget allows, or report the verified result. All waiting is
  // done by the caller, because Chrome heavily throttles timers in a hidden
  // tab once FullCalendar rendering has used up its background budget.
  // Order: unit/facility selection, week view, dates, then the schedule load
  // the selection itself triggered, or one normal widget refresh.
  // PrimeFaces 7 refreshes Schedule without destroying its old FullCalendar.
  // jQuery removes the DOM data during a form replacement, so cleanup must run
  // before updateElement, while the instance is still reachable by its API.
  function disposeScheduleForUpdate(env, targetId) {
    const target = env.document.getElementById(targetId);
    const schedule = Object.values(env.PrimeFaces?.widgets || {}).find(widget => widget?.id === SOURCE_ID);
    const container = schedule?.jqc, element = container?.[0];
    if (!target || !element || element.isConnected === false
      || !(target === element || target.contains?.(element)) || typeof container.fullCalendar !== 'function') return false;
    const calendar = container.fullCalendar('getCalendar');
    if (!calendar || typeof calendar.destroy !== 'function') return false;
    container.fullCalendar('destroy');
    return true;
  }

  function createReader(env) {
    const states = env.__rezReadStates || (env.__rezReadStates = new Map());
    const widgetById = (id) => Object.values(env.PrimeFaces?.widgets || {}).find((item) => item?.id === id) || null;
    const inputValue = (id) => String(env.document.getElementById(id)?.value || "").trim();

    function finish(state, value) {
      const pf = env.PrimeFaces;
      if (pf?.ajax?.Request && pf.ajax.Request.handle === state.hook) pf.ajax.Request.handle = state.original;
      if (pf && state.cwHook && pf.cw === state.cwHook) pf.cw = state.originalCw;
      if (pf?.ajax?.Utils && state.updateHook && pf.ajax.Utils.updateElement === state.updateHook) pf.ajax.Utils.updateElement = state.originalUpdate;
      states.delete(state.token);
      const stats = { ...state.stats, actions: state.actions.length, ms: env.Date.now() - state.started };
      return { done: true, result: { ...value, actions: state.actions.slice(), stats } };
    }

    function begin(request) {
      const facilityId = String(request?.facilityId || "");
      const unitId = request?.unitId ? String(request.unitId) : null;
      const wanted = Array.isArray(request?.dates) ? request.dates.filter(validDay) : [];
      const state = { token: String(request?.token || ""), facilityId, unitId, wanted, started: env.Date.now(),
        gap: Math.max(1000, Number(request?.minGapMs) || 1000), actions: [], log: [], lastActionAt: 0, lastProgressAt: env.Date.now(),
        changed: false, selectedAt: 0, tried: {}, pending: null, updateMark: null,
        stats: { reused: false, selectionVerified: null, weekDefault: false, requests: { unit: 0, facility: 0, schedule: 0 } } };
      if (!/^\d{1,4}$/.test(facilityId) || (unitId && !/^\d{1,4}$/.test(unitId))
        || !wanted.length || wanted.length > 7 || !/^[a-f0-9-]{16,80}$/i.test(state.token)) {
        return finish(state, { ok: false, reason: "invalid_capture_payload" });
      }
      const first = inspectContext(env);
      if (!first.context && ["unexpected_page", "site_access_denied", "login_form_present", "primefaces_unavailable",
        "schedule_widget_missing", "schedule_widget_unusable"].includes(first.reason)) {
        return finish(state, { ok: false, reason: first.reason });
      }
      const pf = env.PrimeFaces;
      if (typeof pf.ajax?.Utils?.updateElement === 'function') {
        state.originalUpdate = pf.ajax.Utils.updateElement;
        state.updateHook = function (targetId, ...args) {
          try {
            if (disposeScheduleForUpdate(env, targetId)) state.stats.calendarDisposed = true;
          } catch (_error) { state.stats.calendarCleanupFailed = true; }
          return state.originalUpdate.call(this, targetId, ...args);
        };
        pf.ajax.Utils.updateElement = state.updateHook;
      }
      // A facility change re-renders the whole form and the site recreates its
      // schedule in day view. Recreating it directly as the wanted week makes the
      // load the selection triggers the week itself: one site action per read.
      if (typeof pf.cw === "function") {
        state.originalCw = pf.cw;
        state.cwHook = function (type, widgetVar, cfg, ...rest) {
          if (cfg && cfg.id === SOURCE_ID) {
            cfg.defaultView = "agendaWeek";
            cfg.defaultDate = state.wanted[0];
            normalizeReaderConfig(cfg);
            state.stats.weekDefault = true;
          }
          return state.originalCw.call(this, type, widgetVar, cfg, ...rest);
        };
        pf.cw = state.cwHook;
      }
      state.original = pf.ajax.Request.handle;
      state.hook = function (options, ...rest) {
        const source = String(options?.source || "");
        const kind = source === SOURCE_ID ? "schedule" : source === FACILITY_SOURCE ? "facility"
          : source === UNIT_SOURCE ? "unit" : null;
        if (!kind) return state.original.call(this, options, ...rest);
        const entry = { kind, at: env.Date.now(), done: false, reason: null };
        state.log.push(entry);
        state.stats.requests[kind] += 1;
        if (kind === "schedule") {
          const success = options.onsuccess;
          const failure = options.onerror;
          options.onerror = function (xhr, status, error, ...args) {
            try {
              if (typeof failure === "function") return failure.call(this, xhr, status, error, ...args);
              return undefined;
            } finally {
              entry.reason = siteBlockReason(xhr) || sessionExpiryReason(xhr) || "unverified_response";
              entry.done = true;
            }
          };
          options.onsuccess = function (responseXML, status, xhr, ...args) {
            const blocked = siteBlockReason(xhr, responseXML);
            const expired = sessionExpiryReason(xhr, responseXML);
            let events = null;
            try { events = parseScheduleResponse(responseXML, status, xhr); } catch (_error) { events = null; }
            let result;
            try {
              if (typeof success !== "function") throw new Error("missing_schedule_callback");
              result = success.call(this, responseXML, status, xhr, ...args);
            } catch (_error) {
              entry.reason = blocked || expired || "schedule_render_failed";
              entry.done = true;
              return false;
            }
            entry.reason = blocked || expired || (events ? null : "unverified_response");
            entry.events = events;
            entry.view = matching(state);
            entry.done = true;
            return result;
          };
        } else {
          const complete = options.oncomplete;
          const failure = options.onerror;
          options.onerror = function (xhr, status, ...args) {
            entry.failed = siteBlockReason(xhr) || sessionExpiryReason(xhr) || "unverified_response";
            if (typeof failure === "function") return failure.call(this, xhr, status, ...args);
            return undefined;
          };
          options.oncomplete = function (xhr, status, ...args) {
            try {
              if (typeof complete === "function") return complete.call(this, xhr, status, ...args);
              return undefined;
            } finally {
              entry.reason = entry.failed || behaviorFailure(xhr, status);
              entry.verified = !entry.reason && Boolean(xhr?.responseXML?.documentElement);
              entry.done = true;
            }
          };
        }
        return state.original.call(this, options, ...rest);
      };
      pf.ajax.Request.handle = state.hook;
      states.set(state.token, state);
      return { state };
    }

    function matching(state) {
      const context = inspectContext(env).context;
      if (!context?.dates || context.facilityId !== state.facilityId) return null;
      if (state.unitId && inputValue("form:unit_input") !== state.unitId) return null;
      if (state.wanted.some((day) => !context.dates.includes(day))) return null;
      return { date: context.date, dates: context.dates.slice(), clippedDate: context.clippedDate || null };
    }
    const sameView = (a, b) => Boolean(a && b) && a.date === b.date && String(a.dates) === String(b.dates);

    function proofResult(state, proof) {
      // Diagnostic only: which event titles are not "Boş : N" (digits masked).
      const other = proof.events.filter((event) => !/(?:Boş|Bos)\s*:\s*\d+/i.test(event.title));
      state.stats.events = proof.events.length;
      state.stats.otherEvents = other.length;
      state.stats.otherTitles = [...new Set(other.map((event) => event.title.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 40)))].slice(0, 5);
      return finish(state, {
        ok: true, date: proof.view.date, facilityId: state.facilityId, events: proof.events, viewType: "week",
        dates: proof.view.dates, ...(proof.view.clippedDate ? { clippedDate: proof.view.clippedDate } : {}),
        refreshId: env.crypto.randomUUID()
      });
    }

    // What the just-settled action proved, or why the read must stop.
    function settledFailure(state) {
      const pending = state.pending;
      state.pending = null;
      if (!pending) return null;
      const entries = state.log.slice(pending.mark);
      if (pending.kind === "unit") return entries.find((entry) => entry.kind === "unit" && entry.reason)?.reason || null;
      if (pending.kind === "facility") {
        const behaviors = entries.filter((entry) => entry.kind === "facility");
        const bad = behaviors.find((entry) => entry.reason);
        if (bad) return bad.reason;
        if (behaviors.length > 1) return "ambiguous_request";
        state.stats.selectionVerified = behaviors.length === 1 && behaviors[0].verified === true;
        // PrimeFaces queues a schedule load issued while this response is
        // rendering, so it reaches the server after the facility change.
        state.selectedAt = behaviors[0]?.at || 0;
        state.changed = true;
      }
      if (pending.kind === "unit") state.changed = true;
      return null;
    }

    function act(state, kind, run) {
      if (state.actions.length >= MAX_READ_ACTIONS) return finish(state, { ok: false, reason: "ambiguous_request" });
      const wait = state.lastActionAt ? state.lastActionAt + state.gap - env.Date.now() : 0;
      if (wait > 0) return { done: false, retryAfterMs: wait };
      state.lastActionAt = env.Date.now();
      state.lastProgressAt = state.lastActionAt;
      state.actions.push(state.lastActionAt);
      state.tried[kind] = true;
      const mark = state.log.length;
      if (kind === "update") state.updateMark = mark;
      else state.pending = { kind, mark };
      run();
      if (kind === "update" && !state.log.slice(mark).some((entry) => entry.kind === "schedule")) {
        return finish(state, { ok: false, reason: "no_schedule_request" });
      }
      return { done: false, retryAfterMs: 100 };
    }

    function step(request) {
      let state = states.get(String(request?.token || ""));
      if (!state) {
        for (const other of [...states.values()]) finish(other, { ok: false, reason: "ambiguous_request" });
        const started = begin(request);
        if (started.done) return started;
        state = started.state;
      }
      const pf = env.PrimeFaces;
      const fatal = state.log.find((entry) => FATAL_READ_REASONS.has(entry.reason))?.reason;
      if (fatal) return finish(state, { ok: false, reason: fatal });
      const queue = pf?.ajax?.Queue;
      if ((typeof queue?.isEmpty === "function" && !queue.isEmpty()) || state.log.some((entry) => !entry.done)) {
        if (env.Date.now() - state.lastProgressAt > READ_STEP_TIMEOUT_MS) return finish(state, { ok: false, reason: "timeout" });
        return { done: false, retryAfterMs: 100 };
      }
      const failed = settledFailure(state);
      if (failed) return finish(state, { ok: false, reason: failed });
      const { facilityId, unitId, wanted } = state;
      if (unitId && inputValue("form:unit_input") !== unitId) {
        const unit = widgetById(UNIT_SOURCE);
        if (state.tried.unit || typeof unit?.selectValue !== "function") return finish(state, { ok: false, reason: "facility_not_selected" });
        return act(state, "unit", () => unit.selectValue(unitId));
      }
      if (inputValue("form:facility_input") !== facilityId) {
        const field = widgetById(FACILITY_SOURCE);
        if (state.tried.facility || typeof field?.selectValue !== "function") return finish(state, { ok: false, reason: "facility_not_selected" });
        return act(state, "facility", () => field.selectValue(facilityId));
      }
      const current = inspectContext(env);
      if (current.reason === "not_day_view" || (current.context && !current.context.dates)) {
        const schedule = widgetById(SOURCE_ID);
        if (state.tried.view || typeof schedule?.jqc?.fullCalendar !== "function") return finish(state, { ok: false, reason: "calendar_view_unavailable" });
        return act(state, "view", () => schedule.jqc.fullCalendar("changeView", "agendaWeek"));
      }
      if (current.context?.dates && wanted.some((day) => !current.context.dates.includes(day))) {
        const schedule = widgetById(SOURCE_ID);
        if (state.tried.dates) return finish(state, { ok: false, reason: "calendar_date_mismatch" });
        return act(state, "dates", () => schedule.jqc.fullCalendar("gotoDate", wanted[0]));
      }
      const view = matching(state);
      if (!view) return finish(state, { ok: false, reason: current.reason || "calendar_date_mismatch" });
      if (state.updateMark !== null) {
        const created = state.log.slice(state.updateMark).filter((entry) => entry.kind === "schedule");
        if (created.length !== 1) return finish(state, { ok: false, reason: "ambiguous_request" });
        if (created[0].reason) return finish(state, { ok: false, reason: created[0].reason });
        if (!sameView(created[0].view, view)) return finish(state, { ok: false, reason: "unverified_response" });
        return proofResult(state, created[0]);
      }
      // A schedule response that started after the last action (and after a
      // verified facility response) was triggered by this read. Reuse it
      // instead of asking the site for the same week a second time.
      const triggered = state.changed && state.lastActionAt
        ? state.log.filter((entry) => entry.kind === "schedule" && entry.at >= state.lastActionAt && entry.at >= state.selectedAt) : [];
      if (triggered.length === 1 && state.stats.selectionVerified !== false && !triggered[0].reason
        && triggered[0].events && sameView(triggered[0].view, view)) {
        state.stats.reused = true;
        return proofResult(state, triggered[0]);
      }
      const schedule = widgetById(SOURCE_ID);
      if (typeof schedule?.update !== "function") return finish(state, { ok: false, reason: "schedule_widget_unusable" });
      return act(state, "update", () => schedule.update());
    }

    function abort(request) {
      const state = states.get(String(request?.token || ""));
      return state ? finish(state, { ok: false, reason: "timeout" }) : { done: true, result: { ok: false, reason: "timeout", actions: [] } };
    }

    // The same steps with local waits, for tests and direct callers.
    async function read(request) {
      const token = request?.token || env.crypto.randomUUID();
      for (;;) {
        const result = step({ ...request, token });
        if (result.done) return result.result;
        await new Promise((resolve) => env.setTimeout(resolve, Math.max(0, result.retryAfterMs || 0)));
      }
    }

    return { step, abort, read };
  }

  if (request === "module") return { createController, createReader, parseScheduleResponse, readContext, disposeScheduleForUpdate, normalizeReadRange };
  if (request?.mode === "read-step" || request?.mode === "read-abort") {
    try {
      const reader = createReader(root);
      return request.mode === "read-step" ? reader.step(request) : reader.abort(request);
    } catch (_error) {
      return { done: true, result: { ok: false, reason: "refresh_failed", actions: [] } };
    }
  }
  // In Chrome a file injection runs one legacy capture. Its Promise result
  // travels through Chrome's InjectionResult, never through a page-visible
  // postMessage event that another site script could race.
  return createController(root).refresh().catch(() => ({ ok: false, reason: "refresh_failed" }));
}

// A page file injection returns the legacy refresh promise. The service worker
// and the Node tests only load the self-contained function.
(typeof window !== "undefined" && window.document && window.location)
  ? rezMainPage(null, window)
  : void Object.assign(globalThis, { RezRefreshMain: rezMainPage("module", globalThis), rezMainPage });
