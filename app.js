/* 学员管理工作台 — 纯前端 PWA */
(() => {
  "use strict";

  const STORE_KEY = "smw_v1";
  const NOTIFY_KEY = "smw_notify_v1";
  const WEEK = ["周日","周一","周二","周三","周四","周五","周六"];
  const ACCENTS = ["#3a80ff","#7c4dff","#34d399","#fbbf24","#ff5a6a","#22d3ee","#f472b6"];

  // ---------- 状态 ----------
  let state = load();
  let editingStudentId = null;   // 学员档案弹层
  let editingSession = null;     // {studentId, sessionId|null} 课次弹层
  let detailStudentId = null;    // 详情弹层
  let deferredInstall = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        // 旧数据迁移：spelling（旧拼写量）→ spellCheck；wordsPerLesson 需用户重填
        (d.students || []).forEach(s => {
          if (s.spelling !== undefined && s.wordsPerLesson === undefined && s.spellCheck === undefined) {
            s.spellCheck = s.spelling;
          }
        });
        return { students: d.students || [], settings: d.settings || defaultSettings() };
      }
    } catch (e) { console.warn("读取失败", e); }
    return { students: [], settings: defaultSettings() };
  }
  function defaultSettings() { return { lead: 15, repeat: 1 }; }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }
  function loadNotified() {
    try { return new Set(JSON.parse(localStorage.getItem(NOTIFY_KEY) || "[]")); }
    catch { return new Set(); }
  }
  function saveNotified(set) {
    //  prune 过期 key（时间已过 1 天以上）
    const cut = Date.now() - 86400000;
    const live = [...set].filter(k => {
      const t = Number(String(k.split("|")[2]).split("-")[0]); // 触发点 key 形如 sid|type|ms-k
      return isNaN(t) || t > cut;
    });
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(live));
    return new Set(live);
  }
  let notified = loadNotified();

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));

  // ---------- 工具 ----------
  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }

  function parseDT(s) { return s ? new Date(s) : null; }
  function fmtDT(d) {
    if (!d || isNaN(d)) return "—";
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${WEEK[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtTime(d) {
    if (!d || isNaN(d)) return "—";
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function countdown(ms) {
    if (ms <= 0) return "已到";
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m} 分钟后`;
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return mm ? `${h} 小时${mm} 分后` : `${h} 小时后`;
    const day = Math.floor(h / 24);
    return `${day} 天${h % 24} 小时后`;
  }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  // ---------- 批量导入（文字/截图转进来的结构化行） ----------
  function dayToNum(x) { return { "一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"日":0,"天":0,"0":0,"1":1,"2":2,"3":3,"4":4,"5":5,"6":6 }[x]; }
  function nextWeekdayDT(weekday, hh, mm) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    let diff = (weekday - d.getDay() + 7) % 7;
    if (diff === 0 && d.getTime() <= now.getTime()) diff = 7; // 今天的该时间已过，取下周
    d.setDate(d.getDate() + diff);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function toDT(s) {
    if (s == null) return "";
    s = String(s).trim();
    if (!s) return "";
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]?(\d{1,2}):(\d{2})/); // 2026-03-20 15:00
    if (m) { const p = n => String(+n).padStart(2, "0"); return `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${m[5]}`; }
    m = s.match(/周\s*([一二三四五六日天0-6])\s*(\d{1,2}):(\d{2})/); // 周三 15:00
    if (m) return nextWeekdayDT(dayToNum(m[1]), +m[2], m[3]);
    m = s.match(/^(\d{1,2}):(\d{2})$/); // 仅时间 → 今天/下一个该时间
    if (m) return nextWeekdayDT(new Date().getDay(), +m[1], m[2]);
    return "";
  }
  function boolOf(s) { return /^(是|yes|true|1|y|要|有|带|开)$/i.test(String(s || "").trim()); }
  function parseBulk(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    const items = [], errors = [];
    lines.forEach((line, i) => {
      const cols = line.split(/[,，、\t]/).map(c => c.trim());
      const name = cols[0];
      if (!name) { errors.push(`第${i + 1}行：缺姓名`); return; }
      const session = {};
      const cls = toDT(cols[1]);
      if (cls) session.classTime = cls;
      const reviews = [cols[2], cols[3], cols[4]].map(toDT);
      if (reviews.some(Boolean)) session.reviews = reviews;
      session.merged = boolOf(cols[5]);
      session.weekly = boolOf(cols[12]); // 第13列：每周重复（可选）
      if (cols[6]) session.words = cols[6];   // 每节课学词量（课次）
      items.push({
        name,
        wordsPerLesson: cols[6] || "",        // 每节课学词量（学生档案默认）
        spellCheck: cols[7] || "",            // 拼写量（特殊需求，可选）
        withReading: boolOf(cols[8]),
        emphasizePronunciation: boolOf(cols[9]), needFeedback: boolOf(cols[10]), notes: cols[11] || "", session
      });
    });
    return { items, errors };
  }
  function importBulk(text) {
    const { items, errors } = parseBulk(text);
    if (!items.length) { toast("没解析到学员" + (errors.length ? "：" + errors[0] : "，检查格式")); return 0; }
    items.forEach(it => {
      const st = { id: uid(), color: ACCENTS[state.students.length % ACCENTS.length], sessions: [],
        name: it.name, wordsPerLesson: it.wordsPerLesson, spellCheck: it.spellCheck,
        withReading: it.withReading,
        emphasizePronunciation: it.emphasizePronunciation, needFeedback: it.needFeedback, notes: it.notes };
      if (it.session && it.session.classTime) {
        st.sessions.push({ id: uid(), classTime: it.session.classTime, reviews: it.session.reviews || ["","",""], merged: !!it.session.merged, weekly: !!it.session.weekly, words: it.session.words || "" });
      }
      state.students.push(st);
    });
    save(); renderStudents(); renderToday(); pushSchedule(); closeAllSheets();
    toast(`已导入 ${items.length} 位学员` + (errors.length ? `（${errors.length} 行有问题）` : ""));
    return items.length;
  }

  // ---------- 事件建模 ----------
  // 把一个 session 展开为若干提醒事件
  function sessionMode(se) { return se.mode || (se.weekly ? "weekly" : "once"); }
  function eventsOf(student, session) {
    const now = Date.now();
    const out = [];
    if (sessionMode(session) === "days") {
      // 每周多天循环：展开未来 14 天内所有选中上课日的正课 + 抗遗忘（课后偏移）
      const days = session.days || [];
      const parts = String(session.dayTime || "18:00").split(":").map(Number);
      const hh = parts[0] || 18, mm = parts[1] || 0;
      const offsets = (session.offsets || [0, 24, 48]).map(x => Number(x) || 0);
      for (let i = 0; i < 14; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        if (!days.includes(d.getDay())) continue;
        const cls = new Date(d); cls.setHours(hh, mm, 0, 0);
        if (cls.getTime() < now - 60000) continue; // 今天该时间已过 → 跳过
        out.push({ student, session, type: "class", label: "正课", time: cls, color: "var(--primary)" });
        if (session.merged) {
          const r = new Date(cls.getTime() + offsets[0] * 3600000);
          out.push({ student, session, type: "merged", label: "抗遗忘（合并）", time: r, color: "var(--warn)" });
        } else {
          offsets.forEach((off, idx) => {
            const r = new Date(cls.getTime() + off * 3600000);
            out.push({ student, session, type: "review" + idx, label: `抗遗忘 ${"①②③"[idx]}`, time: r, color: "var(--primary-2)" });
          });
        }
      }
      return out;
    }
    const cls = classOccurrence(session, now);
    if (cls) out.push({ student, session, type: "class", label: "正课", time: cls, color: "var(--primary)" });
    const reviews = reviewOccurrences(session, now);
    if (session.merged) {
      if (reviews[0]) out.push({ student, session, type: "merged", label: "抗遗忘（合并）", time: reviews[0], color: "var(--warn)" });
    } else {
      reviews.forEach((d, i) => out.push({ student, session, type: "review" + i, label: `抗遗忘 ${"①②③"[i]}`, time: d, color: "var(--primary-2)" }));
    }
    return out;
  }
  function allEvents() {
    const out = [];
    state.students.forEach(st => (st.sessions || []).forEach(se => out.push(...eventsOf(st, se))));
    return out;
  }
  function eventKey(e) { return `${e.session.id}|${e.type}|${e.time.getTime()}`; }

  // ---------- 重复提醒（到达前拆成 N 个触发点） ----------
  function repeatCount() { return Math.min(5, Math.max(1, state.settings.repeat || 1)); }
  function firePointsOf(e) {
    const lead = (state.settings.lead || 15) * 60000;
    const n = repeatCount();
    const base = eventKey(e), due = e.time.getTime(), pts = [];
    for (let k = 1; k <= n; k++) {
      const off = Math.round(lead * (n - k + 1) / n); // N=3 → lead, 2/3·lead, 1/3·lead 分钟前
      pts.push({ key: `${base}-${k}`, fireAt: due - off, dueAt: due, offMin: Math.max(1, Math.round(off / 60000)) });
    }
    return pts;
  }
  function bodyOf(e, offMin) { return `${fmtDT(e.time)} 开始 · 还剩约 ${offMin} 分钟`; }

  // ---------- 每周重复（锚点即时换算 + 本周临时改期） ----------
  function toLocalStr(d) { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  // 由锚点(某日的星期+时间)换算出"下一个未过期"的具体日期时间
  function occurrenceOf(dtStr, now) {
    const a = new Date(dtStr); if (isNaN(a)) return null;
    const wd = a.getDay(), hh = a.getHours(), mm = a.getMinutes();
    for (let off = 0; off <= 7; off++) {
      const c = new Date(now); c.setDate(c.getDate() + off); c.setHours(hh, mm, 0, 0);
      if (c.getDay() !== wd) continue;
      if (c.getTime() >= now - 60000) return c;
    }
    return null;
  }
  function classOccurrence(se, now) {
    if (!se.weekly) { const d = parseDT(se.classTime); return (d && !isNaN(d)) ? d : null; }
    if (se.exClass) { const d = new Date(se.exClass); if (!isNaN(d) && d.getTime() >= now - 60000) return d; } // 本周临时改期优先
    return occurrenceOf(se.classTime, now);
  }
  function reviewOccurrences(se, now) {
    const useEx = se.weekly && se.exClass && (new Date(se.exClass).getTime() >= now - 60000);
    const raw = useEx ? (se.exReviews || []) : (se.reviews || []);
    return raw.map(r => {
      if (!r) return null;
      if (se.weekly && !useEx) return occurrenceOf(r, now);
      const d = new Date(r); return isNaN(d) ? null : d;
    }).filter(Boolean);
  }
  // 清掉已过去的"本周临时改期"，恢复按锚点
  function cleanExceptions() {
    const now = Date.now(); let changed = false;
    state.students.forEach(st => (st.sessions || []).forEach(se => {
      if (se.exClass) { const d = new Date(se.exClass).getTime(); if (isNaN(d) || d < now - 60000) { se.exClass = ""; se.exReviews = null; changed = true; } }
    }));
    if (changed) { save(); renderStudents(); renderToday(); pushSchedule(); }
  }

  // ---------- 提醒引擎 ----------
  function checkReminders() {
    cleanExceptions();
    const now = Date.now();
    let fired = 0;
    allEvents().forEach(e => firePointsOf(e).forEach(pt => {
      if (notified.has(pt.key)) return;
      if (now >= pt.fireAt && now <= pt.dueAt + 60000) {
        notify(e, pt); notified.add(pt.key); fired++;
      } else if (now > pt.dueAt + 60000) {
        notified.add(pt.key); // 过期标记，避免滞后补弹
      }
    }));
    if (fired) { saveNotified(notified); renderToday(); }
  }
  function notify(e, pt) {
    const title = `${e.student.name} · ${e.label}`;
    const body = bodyOf(e, pt ? pt.offMin : state.settings.lead);
    const opts = { body, icon: "icon-192.png", badge: "icon-192.png", tag: pt ? pt.key : eventKey(e), renotify: true };
    // 已连接后端时由系统推送送达，避免与系统通知重复；仅在本地模式弹窗
    if (!pushReady) {
      if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts)).catch(() => fallbackNotify(title, opts));
      } else {
        fallbackNotify(title, opts);
      }
    }
    toast(`🔔 ${title}`);
  }
  function fallbackNotify(title, opts) {
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification(title, opts); return; } catch {}
    }
    toast(`🔔 ${title}`);
  }

  // ---------- 渲染：学员列表 ----------
  function nextEventFor(student) {
    const now = Date.now();
    let best = null;
    (student.sessions || []).forEach(se => eventsOf(student, se).forEach(e => {
      if (e.time.getTime() > now && (!best || e.time.getTime() < best.time.getTime())) best = e;
    }));
    return best;
  }
  function renderStudents() {
    const list = $("#studentList");
    $("#studentCount").textContent = `${state.students.length} 位学员`;
    $("#emptyStudents").style.display = state.students.length ? "none" : "block";
    list.innerHTML = state.students.map(st => {
      const next = nextEventFor(st);
      const tags = [];
      if (st.wordsPerLesson) tags.push(`<span class="tag on">学词 ${esc(st.wordsPerLesson)}</span>`);
      if (st.spellCheck) tags.push(`<span class="tag on">拼写 ${esc(st.spellCheck)}</span>`);
      if (st.withReading) tags.push(`<span class="tag on">带阅读</span>`);
      if (st.emphasizePronunciation) tags.push(`<span class="tag on">重发音</span>`);
      if (st.needFeedback) tags.push(`<span class="tag on">要反馈</span>`);
      const sessions = st.sessions || [];
      const mergedCount = sessions.filter(s => s.merged).length;
      return `<div class="stu-card" data-open="${st.id}" style="--accent:${st.color}">
        <div class="stu-top">
          <div class="stu-name">${esc(st.name)}</div>
          <div class="muted" style="font-size:12px">${sessions.length} 课次</div>
        </div>
        <div class="stu-meta">${next ? `下次：${esc(next.label)} · ${fmtDT(next.time)}` : "暂无排课"}</div>
        ${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}
        ${mergedCount ? `<div class="tags"><span class="tag merged">${mergedCount} 次抗遗忘已合并</span></div>` : ""}
      </div>`;
    }).join("");
  }

  // ---------- 渲染：今日 ----------
  function renderToday() {
    const wrap = $("#todayList");
    const now = Date.now();
    const horizon = now + 2 * 86400000; // 今起两天
    let evs = allEvents().filter(e => e.time.getTime() >= now - 60000 && e.time.getTime() <= horizon);
    evs.sort((a, b) => a.time - b.time);
    $("#emptyToday").style.display = evs.length ? "none" : "block";
    if (!evs.length) { wrap.innerHTML = ""; return; }
    let html = "", lastDay = "";
    evs.forEach(e => {
      const dayKey = e.time.toDateString();
      if (dayKey !== lastDay) {
        lastDay = dayKey;
        const isToday = e.time.toDateString() === new Date().toDateString();
        html += `<div class="section-label">${isToday ? "今天" : fmtDT(e.time).split(" ")[0] + " " + WEEK[e.time.getDay()]}</div>`;
      }
      const diff = e.time.getTime() - now;
      const cls = diff < 0 ? "past" : diff < 30 * 60000 ? "soon" : "";
      html += `<div class="today-item">
        <span class="today-dot" style="background:${e.color}"></span>
        <div class="today-main">
          <div class="today-title">${esc(e.student.name)} · ${esc(e.label)}</div>
          <div class="today-sub">${fmtDT(e.time)}</div>
        </div>
        <div class="today-count ${cls}">${countdown(diff)}</div>
      </div>`;
    });
    wrap.innerHTML = html;
  }

  // ---------- 渲染：学员详情 ----------
  function renderDetail() {
    const st = state.students.find(s => s.id === detailStudentId);
    if (!st) return;
    $("#detailName").textContent = st.name;
    const body = $("#detailBody");
    const prof = [];
    prof.push(`<div class="session-sub">姓名：${esc(st.name)}</div>`);
    if (st.wordsPerLesson) prof.push(`<div class="session-sub">每节课学词量：${esc(st.wordsPerLesson)}</div>`);
    if (st.spellCheck) prof.push(`<div class="session-sub">拼写量：${esc(st.spellCheck)}</div>`);
    prof.push(`<div class="session-sub">带阅读：${st.withReading ? "是" : "否"} ｜ 重发音：${st.emphasizePronunciation ? "是" : "否"} ｜ 课后反馈：${st.needFeedback ? "是" : "否"}</div>`);
    if (st.notes) prof.push(`<div class="session-sub">备注：${esc(st.notes)}</div>`);
    let html = `<div class="card" style="box-shadow:none;margin-bottom:10px">${prof.join("")}</div>`;
    html += `<div class="section-label">课次（${st.sessions.length}）</div>`;
    if (!st.sessions.length) html += `<p class="muted" style="padding:6px 2px">还没有排课，点下方「+ 课次」添加。</p>`;
    st.sessions.slice().sort((a, b) => parseDT(a.classTime) - parseDT(b.classTime)).forEach(se => {
      const cls = parseDT(se.classTime);
      const mode = sessionMode(se);
      let clsTitle, revTxt, exNote = "";
      if (mode === "days") {
        const dayNames = (se.days || []).map(d => WEEK[d]).join("、");
        clsTitle = `每周 ${dayNames} ${se.dayTime} 🔁`;
        const offs = se.offsets || [];
        revTxt = se.merged
          ? `抗遗忘（合并）· 课后 ${offs[0] ?? "—"} 小时`
          : `抗遗忘：课后 ${offs.map((o, i) => `${"①②③"[i]} ${o ?? "—"}h`).join(" / ")}`;
      } else {
        const revs = (se.reviews || []).map(parseDT);
        revTxt = se.merged
          ? `抗遗忘（合并）· ${fmtDT(revs[0])}`
          : `抗遗忘：${revs.map((d, i) => `${"①②③"[i]} ${fmtTime(d)}`).join(" / ")}`;
        clsTitle = mode === "weekly" ? (`每${WEEK[parseDT(se.classTime).getDay()]} ${fmtTime(parseDT(se.classTime))} 🔁`) : fmtDT(cls);
        if (mode === "weekly" && se.exClass) exNote = ` <span style="color:var(--warn)">本周临时 ${fmtDT(new Date(se.exClass))}</span>`;
      }
      html += `<div class="session-row">
        <div class="session-info">
          <div class="session-title">正课 ${clsTitle}${exNote}</div>
          <div class="session-sub">${revTxt}${se.words ? " ｜ 学词 " + esc(se.words) : ""}</div>
        </div>
        <div class="row-actions">
          <button class="mini-btn" data-edit-session="${se.id}">编辑</button>
          <button class="mini-btn danger" data-del-session="${se.id}">删</button>
        </div>
      </div>`;
    });
    body.innerHTML = html;
  }

  // ---------- 弹层控制 ----------
  function openSheet(id) { $(id).classList.remove("hidden"); }
  function closeSheet(id) { $(id).classList.add("hidden"); }
  function closeAllSheets() { $all(".sheet").forEach(s => s.classList.add("hidden")); }

  // 学员档案
  function openStudentModal(id) {
    editingStudentId = id || null;
    const st = id ? state.students.find(s => s.id === id) : null;
    $("#studentModalTitle").textContent = st ? "编辑学员" : "新增学员";
    $("#sf-name").value = st?.name || "";
    $("#sf-words").value = st?.wordsPerLesson || "";
    $("#sf-spellCheck").value = st?.spellCheck || "";
    $("#sf-reading").checked = !!st?.withReading;
    $("#sf-pron").checked = !!st?.emphasizePronunciation;
    $("#sf-feedback").checked = !!st?.needFeedback;
    $("#sf-notes").value = st?.notes || "";
    openSheet("#studentModal");
    setTimeout(() => $("#sf-name").focus(), 50);
  }
  function saveStudent() {
    const name = $("#sf-name").value.trim();
    if (!name) { toast("请填写姓名"); return; }
    const data = {
      name,
      wordsPerLesson: $("#sf-words").value.trim(),
      spellCheck: $("#sf-spellCheck").value.trim(),
      withReading: $("#sf-reading").checked,
      emphasizePronunciation: $("#sf-pron").checked,
      needFeedback: $("#sf-feedback").checked,
      notes: $("#sf-notes").value.trim()
    };
    if (editingStudentId) {
      Object.assign(state.students.find(s => s.id === editingStudentId), data);
    } else {
      state.students.push({ id: uid(), color: ACCENTS[state.students.length % ACCENTS.length], sessions: [], ...data });
    }
    save(); renderStudents(); pushSchedule(); closeAllSheets();
    toast(editingStudentId ? "已更新" : "已建档");
  }

  // 课次
  function setSessionMode(mode) {
    $all("#ss-mode .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    $("#ss-fields-once").classList.toggle("hidden", mode === "days");
    $("#ss-fields-days").classList.toggle("hidden", mode !== "days");
    $("#ss-once-hint").hidden = mode !== "weekly";
    syncMergedDisabled();
  }
  function syncMergedDisabled() {
    const m = $("#ss-merged").checked;
    const mode = activeSessionMode();
    if (mode === "days") {
      $("#ss-d1").disabled = m; $("#ss-d2").disabled = m;
    } else {
      $("#ss-r1").disabled = m; $("#ss-r2").disabled = m;
    }
  }
  function activeSessionMode() {
    return $("#ss-mode .seg-btn.active")?.dataset.mode || "once";
  }
  function openSessionModal(studentId, sessionId) {
    editingSession = { studentId, sessionId: sessionId || null };
    const st = state.students.find(s => s.id === studentId);
    const se = sessionId ? st.sessions.find(x => x.id === sessionId) : null;
    $("#sessionModalTitle").textContent = se ? "编辑课次" : `添加课次 · ${st.name}`;
    // 默认正课时间：下一个整点
    const def = new Date(); def.setMinutes(0, 0, 0); def.setHours(def.getHours() + 1);
    const toLocal = d => { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
    // 重置表单
    $all("#ss-mode .seg-btn").forEach(b => b.classList.remove("active"));
    $all("#ss-days .chip").forEach(c => c.classList.remove("on"));
    $("#ss-d0").value = ""; $("#ss-d1").value = ""; $("#ss-d2").value = "";
    $("#ss-merged").checked = !!se?.merged;
    $("#ss-words").value = se?.words || "";
    $("#ss-once-hint").hidden = true;
    const mode = sessionId ? (se.mode || (se.weekly ? "weekly" : "once")) : "once";
    setSessionMode(mode);
    if (mode === "days") {
      (se.days || []).forEach(d => $all(`#ss-days .chip`).forEach(c => { if (+c.dataset.d === d) c.classList.add("on"); }));
      $("#ss-dayTime").value = se?.dayTime || "18:00";
      const offs = se?.offsets || [];
      $("#ss-d0").value = offs[0] ?? "";
      $("#ss-d1").value = offs[1] ?? "";
      $("#ss-d2").value = offs[2] ?? "";
      $("#ss-class").value = se?.classTime || toLocal(def);
      $("#ss-r0").value = se?.reviews?.[0] || "";
      $("#ss-r1").value = se?.reviews?.[1] || "";
      $("#ss-r2").value = se?.reviews?.[2] || "";
    } else {
      $("#ss-class").value = se?.classTime || toLocal(def);
      $("#ss-r0").value = se?.reviews?.[0] || "";
      $("#ss-r1").value = se?.reviews?.[1] || "";
      $("#ss-r2").value = se?.reviews?.[2] || "";
    }
    syncMergedDisabled();
    openSheet("#sessionModal");
  }
  function saveSession() {
    const { studentId, sessionId } = editingSession;
    const st = state.students.find(s => s.id === studentId);
    if (!st) return;
    const mode = activeSessionMode();
    const merged = $("#ss-merged").checked;
    const words = $("#ss-words").value.trim();
    if (mode === "days") {
      const days = $all("#ss-days .chip.on").map(c => +c.dataset.d);
      if (!days.length) { toast("请至少选择一个上课日"); return; }
      const dayTime = $("#ss-dayTime").value;
      if (!dayTime) { toast("请填写每天上课时间"); return; }
      const offs = [0, 1, 2].map(i => {
        const v = $(`#ss-d${i}`).value;
        return v === "" ? null : Math.max(0, parseFloat(v));
      });
      const data = { mode: "days", days, dayTime, offsets: merged ? [offs[0]] : offs, merged, words };
      if (sessionId) Object.assign(st.sessions.find(x => x.id === sessionId), data);
      else st.sessions.push({ id: uid(), ...data });
    } else {
      const cls = $("#ss-class").value;
      if (!cls) { toast("请填写正课时间"); return; }
      const reviews = [$("#ss-r0").value, merged ? "" : $("#ss-r1").value, merged ? "" : $("#ss-r2").value];
      const data = { mode, classTime: cls, reviews, merged, words };
      if (sessionId) {
        const se = st.sessions.find(x => x.id === sessionId);
        if (mode === "weekly") {
          const timesChanged = data.classTime !== se.classTime || JSON.stringify(data.reviews) !== JSON.stringify(se.reviews);
          if (timesChanged) {
            const onlyThisWeek = confirm("这是每周重复的课，你改了时间：\n\n【确定】仅本周临时改这一次\n【取消】以后每周都改成新时间");
            if (onlyThisWeek) { se.exClass = data.classTime; se.exReviews = data.reviews; }
            else { se.classTime = data.classTime; se.reviews = data.reviews; se.exClass = ""; se.exReviews = null; }
          }
          se.merged = data.merged; se.weekly = true; se.mode = "weekly"; se.words = data.words;
        } else {
          Object.assign(se, data); se.exClass = ""; se.exReviews = null; se.weekly = false;
        }
      } else {
        st.sessions.push({ id: uid(), ...data });
      }
    }
    save(); renderStudents(); renderDetail(); renderToday(); pushSchedule(); closeAllSheets();
    toast(sessionId ? "课次已更新" : "课次已添加");
  }

  // ---------- 设置 ----------
  // ---------- 推送状态（Web Push 关屏强推） ----------
  let vapidKey = null;
  let pushReady = false;
  const deviceId = (() => {
    let d = localStorage.getItem("smw_device");
    if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : "d" + Date.now() + Math.random().toString(16).slice(2)); localStorage.setItem("smw_device", d); }
    return d;
  })();

  function urlBase64ToUint8Array(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
    return Uint8Array.from([...s].map(c => c.charCodeAt(0)));
  }
  async function getVapid() {
    try { const r = await fetch("./api/vapid"); if (r.ok) { const j = await r.json(); vapidKey = j.publicKey; } }
    catch { /* 无后端：保持本地通知模式 */ }
    return vapidKey;
  }
  function ensureSW() {
    if ("serviceWorker" in navigator) return navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW 注册失败", e));
    return Promise.resolve();
  }
  async function subscribePush() {
    if (!vapidKey || !("PushManager" in window)) return false;
    try { await ensureSW(); } catch {}
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
    await fetch("./api/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, subscription: sub }) });
    pushReady = true;
    return true;
  }
  function buildSchedule() {
    const out = [];
    allEvents().forEach(e => firePointsOf(e).forEach(pt => out.push({
      id: pt.key, fireAt: pt.fireAt, dueAt: pt.dueAt,
      title: `${e.student.name} · ${e.label}`, body: bodyOf(e, pt.offMin)
    })));
    return out;
  }
  async function pushSchedule() {
    if (!pushReady) return;
    try { await fetch("./api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, events: buildSchedule() }) }); }
    catch (e) { console.warn("推送同步失败", e); }
  }
  async function initPush() {
    await getVapid();
    if (vapidKey && "Notification" in window && Notification.permission === "granted" && "PushManager" in window) {
      try { await ensureSW(); await subscribePush().catch(() => {}); await pushSchedule(); } catch {}
    }
    refreshNotifyUI();
  }
  async function enableReminders() {
    if (!("Notification" in window)) { toast("当前浏览器不支持通知"); return; }
    let p = Notification.permission;
    if (p === "default") { try { p = await Notification.requestPermission(); } catch { toast("授权失败"); return; } }
    refreshNotifyUI();
    if (p !== "granted") { toast("未授权，将仅用「今日」页提醒"); return; }
    try { await ensureSW(); } catch {}
    const ok = vapidKey ? await subscribePush().catch(() => false) : false;
    if (ok) { toast("系统推送已开启（关屏也强推）🔔"); pushSchedule(); }
    else toast("已开启本地通知（未连接后端，息屏不保证）");
  }
  function refreshNotifyUI() {
    const btn = $("#btnNotify");
    if (!("Notification" in window)) { btn.hidden = true; $("#notifyState").textContent = "不支持"; return; }
    const push = !vapidKey ? "仅本地" : (pushReady ? "系统强推✓" : "可系统强推");
    if (Notification.permission === "granted") {
      btn.hidden = true; $("#notifyState").textContent = `已开启 · ${push}`;
    } else if (Notification.permission === "denied") {
      btn.hidden = true; $("#notifyState").textContent = "被拒绝";
    } else {
      btn.hidden = false; $("#notifyState").textContent = `未授权 · ${push}`;
    }
  }

  // ---------- 导入/导出 ----------
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `学员工作台备份-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出备份");
  }
  function importData(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d.students) throw new Error("格式不正确");
        state = { students: d.students, settings: d.settings || defaultSettings() };
        save(); renderStudents(); renderToday(); refreshNotifyUI(); pushSchedule();
        toast("导入成功，已覆盖当前数据");
      } catch (e) { toast("导入失败：" + e.message); }
    };
    r.readAsText(file);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    // 标签切换
    $all(".tab").forEach(t => t.addEventListener("click", () => {
      $all(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      $all(".view").forEach(v => v.classList.remove("active"));
      $("#view-" + t.dataset.view).classList.add("active");
      if (t.dataset.view === "today") renderToday();
    }));

    // 通用关闭
    $all("[data-close]").forEach(el => el.addEventListener("click", closeAllSheets));

    $("#btnAddStudent").addEventListener("click", () => openStudentModal(null));
    $("#btnBulk").addEventListener("click", () => { $("#bk-text").value = ""; openSheet("#bulkModal"); });
    $("#bk-save").addEventListener("click", () => importBulk($("#bk-text").value));
    $("#sf-save").addEventListener("click", saveStudent);
    $("#ss-save").addEventListener("click", saveSession);

    // 排课方式切换
    $all("#ss-mode .seg-btn").forEach(b => b.addEventListener("click", () => {
      $all("#ss-mode .seg-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      setSessionMode(b.dataset.mode);
    }));
    // 星期 chips 多选
    $("#ss-days").addEventListener("click", e => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      chip.classList.toggle("on");
    });
    // 抗遗忘合并互斥：合并开启时禁用另外两个时间
    $("#ss-merged").addEventListener("change", syncMergedDisabled);

    // 学员卡片点击 -> 详情
    $("#studentList").addEventListener("click", e => {
      const card = e.target.closest("[data-open]");
      if (card) { detailStudentId = card.dataset.open; renderDetail(); openSheet("#detailModal"); }
    });
    $("#detail-add-session").addEventListener("click", () => { closeAllSheets(); openSessionModal(detailStudentId, null); });
    $("#detail-edit").addEventListener("click", () => { closeAllSheets(); openStudentModal(detailStudentId); });
    $("#detail-del").addEventListener("click", () => {
      if (confirm("确定删除该学员及其所有课次？")) {
        state.students = state.students.filter(s => s.id !== detailStudentId);
        save(); renderStudents(); pushSchedule(); closeAllSheets(); toast("已删除");
      }
    });
    // 详情内课次编辑/删除（委托）
    $("#detailBody").addEventListener("click", e => {
      const ed = e.target.closest("[data-edit-session]");
      const dl = e.target.closest("[data-del-session]");
      if (ed) { closeAllSheets(); openSessionModal(detailStudentId, ed.dataset.editSession); }
      if (dl) {
        const st = state.students.find(s => s.id === detailStudentId);
        st.sessions = st.sessions.filter(x => x.id !== dl.dataset.delSession);
        save(); renderDetail(); renderStudents(); renderToday(); pushSchedule();
      }
    });

    // 今日刷新
    $("#btnRefreshToday").addEventListener("click", renderToday);

    // 设置
    $("#setLead").addEventListener("change", e => {
      const v = Math.min(240, Math.max(1, parseInt(e.target.value) || 15));
      e.target.value = v; state.settings.lead = v; save(); pushSchedule();
    });
    $("#setRepeat").addEventListener("change", e => {
      const v = Math.min(5, Math.max(1, parseInt(e.target.value) || 1));
      e.target.value = v; state.settings.repeat = v; save(); pushSchedule();
    });
    $("#btnNotify").addEventListener("click", enableReminders);
    $("#btnTestNotify").addEventListener("click", async () => {
      if (!("Notification" in window)) { toast("浏览器不支持通知"); return; }
      if (Notification.permission !== "granted") {
        const p = await Notification.requestPermission(); refreshNotifyUI();
        if (p !== "granted") { toast("未授权"); return; }
        try { await ensureSW(); } catch {}
        if (vapidKey) await subscribePush().catch(() => {});
      }
      const opts = { body: "这是一条测试提醒，确认能正常弹窗 🔔", icon: "icon-192.png" };
      if (navigator.serviceWorker?.controller) navigator.serviceWorker.ready.then(r => r.showNotification("测试提醒", opts)).catch(() => new Notification("测试提醒", opts));
      else new Notification("测试提醒", opts);
      if (pushReady) {
        const ev = { id: "test-" + Date.now(), fireAt: Date.now() - 1000, dueAt: Date.now() + 30000, title: "测试 · 系统推送", body: "关屏强推验证 ✅（约 15s 内到达）" };
        fetch("./api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, events: [ev] }) }).catch(() => {});
        toast("已发：本地 + 系统推送（系统推送约 15s 内到达）");
      } else {
        toast("已发送本地测试提醒");
      }
    });
    $("#btnExport").addEventListener("click", exportData);
    $("#btnImport").addEventListener("click", () => $("#fileImport").click());
    $("#fileImport").addEventListener("change", e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ""; });

    // 安装提示
    window.addEventListener("beforeinstallprompt", ev => { ev.preventDefault(); deferredInstall = ev; $("#installHint").textContent = "点下方按钮可一键添加到主屏幕。"; showInstallBtn(); });
    if (deferredInstall) showInstallBtn();
  }
  function showInstallBtn() {
    if (!deferredInstall) return;
    const bar = document.querySelector(".tabbar");
    // 避免重复
    if ($("#btnInstall")) return;
    const b = document.createElement("button");
    b.id = "btnInstall"; b.className = "tab"; b.style.color = "var(--primary)";
    b.innerHTML = '<span class="ic">➕</span><span>安装</span>';
    b.addEventListener("click", async () => {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null; b.remove();
    });
    bar.insertBefore(b, bar.lastElementChild);
  }

  // ---------- 启动 ----------
  function init() {
    bind();
    renderStudents();
    renderToday();
    refreshNotifyUI();
    $("#setLead").value = state.settings.lead;
    $("#setRepeat").value = state.settings.repeat || 1;
    if ("serviceWorker" in navigator) ensureSW();   // 注册 SW（离线 + push 事件）
    initPush();
    checkReminders();
    setInterval(checkReminders, 30000);          // 每 30s 检查（本地兜底）
    setInterval(pushSchedule, 60000);            // 每分钟把时刻表同步给后端（强推调度）
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReminders(); });
    // 种子示例（首次使用）
    if (!state.students.length && !localStorage.getItem(STORE_KEY + "_seen")) {
      seedExample();
      localStorage.setItem(STORE_KEY + "_seen", "1");
    }
  }
  function seedExample() {
    const now = new Date();
    const plus = h => { const d = new Date(now); d.setHours(d.getHours() + h); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
    state.students.push({
      id: uid(), name: "示例学员·小明", color: ACCENTS[0],
      wordsPerLesson: "20 词", spellCheck: "15 词", withReading: true, emphasizePronunciation: true, needFeedback: true,
      notes: "家长关注发音，每课要反馈。",
      sessions: [{
        id: uid(), classTime: plus(2),
        reviews: [plus(6), plus(26), plus(50)],
        merged: false, words: "20"
      }]
    });
    save(); renderStudents(); renderToday();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
