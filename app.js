(() => {
"use strict";
const PHASES = [
  { k: "entry", label: "エントリー受付" },
  { k: "voting", label: "投票受付" },
  { k: "tallied", label: "集計完了" },
  { k: "announced", label: "結果発表" },
];
const POINTS = { 1: 3, 2: 2, 3: 1 };

const API = window.AwardAPI;
const S = {
  auth: "loading", authErr: "", loadErr: false,
  me: { id: null, canEdit: false, name: "", avatarUrl: "", email: "" }, canWrite: true,
  months: [], monthsLoaded: false, entries: [], voters: {},
  monthId: null, tab: "entries", profiles: {}, profPending: new Set(),
  myBallot: null, myBallotFor: null,
  photoCache: {}, photoLoading: {},
  draft: { title: "", files: [] }, showForm: false, formErr: "", formBusy: "",
  vote: { picks: {}, comments: {} }, editVote: false, voteBusy: false, voteErr: "",
  confirm: null, detail: null, stage: null, toast: null, slow: false, adminBusy: false, adminErr: "",
  newMonth: "",
  nameDraft: "", nameBusy: false, nameErr: "", adminOpen: false, adminPw: "", adminPwBusy: false, adminPwErr: "",
};

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const fmtMonth = (id) => (id || "").replace("-", ".");
const monthLabel = (id) => { const [y, m] = (id || "").split("-"); return `${y}年${Number(m)}月`; };
const phaseIdx = (k) => PHASES.findIndex((p) => p.k === k);
const phaseLabel = (k) => (PHASES.find((p) => p.k === k) || {}).label || "";
const curMonth = () => S.months.find((m) => m.id === S.monthId) || null;
const monthEntries = (mid) => S.entries.filter((e) => e.month === mid).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
const entryNo = (mid, e) => { const i = monthEntries(mid).findIndex((x) => x.id === e.id); return `No. ${fmtMonth(mid).slice(2)}-${String(i + 1).padStart(2, "0")}`; };
const votedIds = (mid) => Object.entries(S.voters).filter(([, v]) => v && v.months && v.months[mid]).map(([id]) => id);
const nowMonthId = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
function profile(id) { return S.profiles[id] || null; }
function nameOf(id) { if (id && id === S.me.id) return (profile(id) && profile(id).name) || "あなた"; const p = profile(id); return (p && p.name) || "メンバー"; }
function who(id) {
  const p = profile(id);
  return h("span", { class: "who" }, p && p.avatarUrl ? h("img", { src: p.avatarUrl, alt: "", referrerpolicy: "no-referrer" }) : null, h("span", null, nameOf(id)));
}
function errMsg(e) {
  if (e && e.message) return e.message;
  return "保存できませんでした。通信状況を確認して、もう一度お試しください。";
}
function toast(msg) { S.toast = msg; render(); clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = null; render(); }, 3200); }
function armed(key) { return S.confirm === key; }
function arm(key) { S.confirm = key; render(); clearTimeout(arm.t); arm.t = setTimeout(() => { if (S.confirm === key) { S.confirm = null; render(); } }, 4000); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* photos: storage path (p.path) → 期限付きURL。縦横比は一切変えない */
function photoImg(p, cls) {
  const img = h("img", { class: cls || null, alt: "", decoding: "async" });
  if (p && p.path) { img.dataset.pid = p.path; if (S.photoCache[p.path]) img.src = S.photoCache[p.path]; }
  img.addEventListener("error", () => {
    // 期限切れの可能性：一度だけ取り直す
    const id = img.dataset.pid;
    if (id && !img.dataset.retried && S.photoCache[id]) { img.dataset.retried = "1"; delete S.photoCache[id]; img.removeAttribute("src"); hydratePhotos(); return; }
    img.classList.add("broken");
  });
  return img;
}
let hydrating = false;
async function hydratePhotos() {
  const imgs = [...document.querySelectorAll("img[data-pid]")].filter((img) => !img.getAttribute("src"));
  const missing = [...new Set(imgs.map((i) => i.dataset.pid))].filter((id) => S.photoCache[id] == null && !S.photoLoading[id]);
  if (missing.length && !hydrating) {
    hydrating = true;
    missing.forEach((id) => { S.photoLoading[id] = true; });
    try { Object.assign(S.photoCache, await API.photoUrls(missing)); } catch (_) {}
    missing.forEach((id) => { delete S.photoLoading[id]; });
    hydrating = false;
  }
  document.querySelectorAll("img[data-pid]").forEach((img) => {
    if (!img.getAttribute("src") && S.photoCache[img.dataset.pid]) img.src = S.photoCache[img.dataset.pid];
  });
}
function cover(e, onclick) {
  const ps = (e && e.photos) || [];
  return h(onclick ? "button" : "div", { class: "ph", type: onclick ? "button" : null, onclick, "aria-label": onclick ? `${e.title} の写真を見る` : null },
    ps[0] ? photoImg(ps[0]) : null,
    ps.length > 1 ? h("span", { class: "count" }, `${ps.length} photos`) : null);
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error(`「${file.name}」を読み込めませんでした。JPEG / PNG 形式で保存し直してください。`)); };
    img.src = url;
  });
}
function drawScaled(img, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s)), hh = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement("canvas"); c.width = w; c.height = hh;
  const x = c.getContext("2d"); x.fillStyle = "#ffffff"; x.fillRect(0, 0, w, hh); x.drawImage(img, 0, 0, w, hh);
  return c;
}
const toBlob = (c, q) => new Promise((r) => c.toBlob(r, "image/jpeg", q));

/* ---------- render ---------- */
function render() {
  const a = document.activeElement; const fid = a && a.id; let ss = null, se = null;
  try { ss = a.selectionStart; se = a.selectionEnd; } catch (_) {}
  const app = $("#app");
  app.replaceChildren(view());
  if (fid) { const el = document.getElementById(fid); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { if (ss != null) el.setSelectionRange(ss, se); } catch (_) {} } }
  hydratePhotos();
  ensureProfiles();
}
function ensureProfiles() {
  if (S.auth !== "ok") return;
  const ids = new Set();
  S.entries.forEach((e) => e.authorId && ids.add(e.authorId));
  Object.keys(S.voters).forEach((id) => ids.add(id));
  S.months.forEach((m) => ((m.results && m.results.ranking) || []).forEach((r) => r.authorId && ids.add(r.authorId)));
  if (S.me.id) ids.add(S.me.id);
  const missing = [...ids].filter((id) => !S.profiles[id] && !S.profPending.has(id));
  if (!missing.length) return;
  missing.forEach((id) => S.profPending.add(id));
  API.profiles(missing).then((ps) => { Object.assign(S.profiles, ps); render(); }).catch(() => { missing.forEach((id) => S.profPending.delete(id)); });
}

function view() {
  const frag = document.createDocumentFragment();
  const M = curMonth();
  frag.append(header(M));
  const main = h("main", { class: "wrap" });
  if (S.auth === "loading") {
    main.append(h("div", { class: "empty" }, h("h2", null, "読み込み中…")));
  } else if (S.auth === "error") {
    main.append(h("div", { class: "empty" }, h("h2", null, "接続できませんでした"), h("p", null, S.authErr || "通信状況を確認して、ページを再読み込みしてください。"),
      h("div", { class: "row", style: "justify-content:center;margin-top:14px" }, h("button", { class: "btn", onclick: () => location.reload() }, "再読み込み"))));
  } else if (S.auth === "needname") {
    main.append(nameView());
  } else if (!S.monthsLoaded) {
    main.append(h("div", { class: "empty" }, h("h2", null, S.slow ? "データに接続できていません" : "読み込み中…"), S.slow ? h("p", null, "通信状況を確認してください。つながり次第、自動で表示されます。") : null));
  } else if (!M) {
    main.append(h("div", { class: "empty" },
      h("h2", null, "今月のアワードはまだ始まっていません"),
      h("p", null, S.me.canEdit ? "下の「アワードを開始」から今月の回を作成すると、メンバーがエントリーできるようになります。" : "管理者が今月の回を開始すると、ここから物件をエントリーできるようになります。")));
    if (S.me.canEdit) main.append(h("div", { style: "margin-top:24px" }, startMonthPanel()));
  } else {
    main.append(tabs(M));
    const body = h("div", { style: "margin-top:24px" });
    if (S.tab === "entries") body.append(entriesView(M));
    else if (S.tab === "vote") body.append(voteView(M));
    else if (S.tab === "results") body.append(resultsView(M));
    else if (S.tab === "archive") body.append(archiveView());
    else if (S.tab === "admin" && S.me.canEdit) body.append(adminView(M));
    main.append(body);
  }
  if (S.auth === "ok") main.append(footerAdmin());
  frag.append(main);
  if (API.demo) frag.append(demoBar());
  if (S.adminOpen) frag.append(adminLoginModal());
  if (S.detail) frag.append(detailModal());
  if (S.stage) frag.append(stageView());
  if (S.toast) frag.append(h("div", { class: "toast", role: "status" }, S.toast));
  return frag;
}

function header(M) {
  const top = h("header", { class: "top" });
  const inner = h("div", { class: "wrap top-in" },
    h("div", { class: "brand" }, h("span", { class: "brand-mark" }, "MIYAKOBO"), h("span", { class: "brand-name" }, "Design Award")),
    M ? h("div", { class: "month" },
      h("span", { class: "month-num" }, fmtMonth(M.id)),
      S.months.length > 1 ? h("select", { id: "month-sel", "aria-label": "表示する月", onchange: (e) => { S.monthId = e.target.value; S.editVote = false; S.vote = { picks: {}, comments: {} }; loadMyBallot(); render(); } },
        S.months.map((m) => { const o = h("option", { value: m.id }, `${monthLabel(m.id)}（${phaseLabel(m.phase)}）`); if (m.id === M.id) o.selected = true; return o; })) : null) : null,
    S.auth === "ok" ? h("div", { class: "acct" },
      S.me.canEdit ? h("span", { class: "badge" }, "管理者") : null,
      h("button", { class: "btn ghost sm", id: "rename", title: "名前を変更", "aria-label": `${S.me.name}（名前を変更）`, onclick: () => { S.nameDraft = S.me.name; S.nameErr = ""; S.auth = "needname"; render(); } },
        h("span", { class: "acct-name" }, S.me.name), " ✎")) : null);
  top.append(inner);
  if (M) {
    const pi = phaseIdx(M.phase);
    top.append(h("div", { class: "wrap" }, h("ol", { class: "steps", "aria-label": "進行状況" },
      PHASES.map((p, i) => h("li", { class: i < pi ? "done" : i === pi ? "cur" : null, "aria-current": i === pi ? "step" : null },
        h("span", null, h("span", { class: "n" }, String(i + 1).padStart(2, "0")), p.label))))));
  }
  return top;
}

/* ---------- 名前（ログインの代わり） ---------- */
function nameView() {
  const first = !S.me.name;
  return h("form", { class: "panel login", onsubmit: (ev) => { ev.preventDefault(); saveName(); } },
    h("h2", null, first ? "はじめに、お名前を教えてください" : "名前を変更"),
    h("p", null, "エントリーした物件や、投票済みの一覧に表示されます。投票の中身（どこに入れたか）は誰にも分かりません。"),
    h("div", { class: "field" }, h("label", { for: "f-name" }, "お名前"),
      h("input", { class: "input", id: "f-name", maxlength: "30", autocomplete: "name", placeholder: "例：山田 太郎", value: S.nameDraft, oninput: (ev) => { S.nameDraft = ev.target.value; } })),
    S.nameErr ? h("p", { class: "err" }, S.nameErr) : null,
    h("div", { class: "row" },
      h("button", { class: "btn accent", type: "submit", id: "save-name", disabled: S.nameBusy }, S.nameBusy ? "保存中…" : first ? "はじめる" : "保存"),
      first ? null : h("button", { class: "btn ghost", type: "button", onclick: () => { S.auth = "ok"; render(); } }, "キャンセル")),
    h("p", { class: "note" }, "この端末（ブラウザ）で一度入力すれば、次からは自動で入れます。スマホとPCの両方で使う場合は、それぞれで同じ名前を入れてください。"));
}
async function saveName() {
  const name = (S.nameDraft || "").trim();
  if (!name) { S.nameErr = "お名前を入力してください。"; render(); return; }
  S.nameBusy = true; S.nameErr = ""; render();
  try {
    await API.setName(name);
    S.me.name = name; S.profiles[S.me.id] = { name, avatarUrl: "" };
    const first = !S.monthsLoaded;
    S.auth = "ok"; S.nameBusy = false; render();
    if (first) { if (!subscribed) { subscribed = true; API.subscribe(softReload); } await reload(); }
  } catch (e) { S.nameBusy = false; S.nameErr = errMsg(e); render(); }
}

/* ---------- 管理者（パスワード） ---------- */
function footerAdmin() {
  return h("div", { class: "admin-foot" }, S.me.canEdit
    ? h("button", { class: "btn ghost sm", id: "admin-exit", onclick: adminExit }, "管理者モードを終了")
    : h("button", { class: "linkish", id: "admin-open", onclick: () => { S.adminOpen = true; S.adminPw = ""; S.adminPwErr = ""; render(); } }, "管理者の方はこちら"));
}
function adminLoginModal() {
  const close = () => { S.adminOpen = false; render(); };
  return h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "管理者ログイン", onclick: (ev) => { if (ev.target.classList.contains("modal")) close(); } },
    h("form", { class: "sheet", style: "max-width:420px", onsubmit: (ev) => { ev.preventDefault(); adminEnter(); } },
      h("h2", null, "管理者ログイン"),
      h("p", { class: "note", style: "margin-bottom:12px" }, "管理者パスワードを入力すると、締切・集計・結果発表ができるようになります。"),
      h("div", { class: "field" }, h("label", { for: "f-adminpw" }, "パスワード"),
        h("input", { class: "input", id: "f-adminpw", type: "password", autocomplete: "current-password", value: S.adminPw, oninput: (ev) => { S.adminPw = ev.target.value; } })),
      S.adminPwErr ? h("p", { class: "err", style: "margin-bottom:10px" }, S.adminPwErr) : null,
      h("div", { class: "row" },
        h("button", { class: "btn accent", type: "submit", id: "admin-enter", disabled: S.adminPwBusy }, S.adminPwBusy ? "確認中…" : "入る"),
        h("button", { class: "btn ghost", type: "button", onclick: close }, "閉じる"))));
}
async function adminEnter() {
  if (!S.adminPw) { S.adminPwErr = "パスワードを入力してください。"; render(); return; }
  S.adminPwBusy = true; S.adminPwErr = ""; render();
  try {
    const okd = await API.adminLogin(S.adminPw);
    S.adminPwBusy = false;
    if (!okd) { S.adminPwErr = "パスワードが違います。"; render(); return; }
    S.adminOpen = false; S.adminPw = ""; S.me.canEdit = true; S.tab = "admin";
    toast("管理者モードに切り替えました");
    await reload();
  } catch (e) { S.adminPwBusy = false; S.adminPwErr = errMsg(e); render(); }
}
async function adminExit() {
  try { await API.adminLogout(); } catch (_) {}
  S.me.canEdit = false; if (S.tab === "admin") S.tab = "entries";
  toast("管理者モードを終了しました");
  await reload();
}
function demoBar() {
  return h("div", { class: "demo-bar" },
    h("span", null, "デモモード：仮データで動いています（保存されません）"),
    h("span", { class: "note" }, "管理者パスワード：demo1234"));
}

function tabs(M) {
  const n = monthEntries(M.id).length;
  const list = [["entries", "エントリー", n], ["vote", "投票", null], ["results", "結果発表", null], ["archive", "歴代受賞", null]];
  if (S.me.canEdit) list.push(["admin", "管理", null]);
  return h("div", { class: "tabs", role: "tablist" }, list.map(([k, label, c]) =>
    h("button", { class: "tab", role: "tab", id: "tab-" + k, "aria-selected": String(S.tab === k), onclick: () => { S.tab = k; render(); } },
      label, c != null ? h("span", { class: "cnt" }, c) : null)));
}

/* ---------- entries ---------- */
function entriesView(M) {
  const box = h("div");
  const list = monthEntries(M.id);
  const canEnter = M.phase === "entry" && S.me.id && S.canWrite !== false;
  const lead = {
    entry: "今月いちばん良かったと思う物件をエントリーしてください。物件名と写真（複数枚可）で登録できます。",
    voting: "エントリーは締め切られました。「投票」タブから1位〜3位を選んで投票してください。",
    tallied: "投票は締め切られ、集計が完了しました。結果発表をお待ちください。",
    announced: "結果が発表されました。「結果発表」タブで確認できます。",
  }[M.phase];
  box.append(h("div", { class: "row", style: "margin-bottom:20px" }, h("p", { class: "lead", style: "margin:0" }, lead), h("span", { class: "spacer" }),
    canEnter && !S.showForm ? h("button", { class: "btn", id: "open-form", onclick: () => { S.showForm = true; render(); } }, "＋ 物件をエントリーする") : null));
  if (canEnter && S.showForm) box.append(entryForm(M));
  if (!list.length) {
    box.append(h("div", { class: "empty" }, h("h2", null, "まだエントリーがありません"), h("p", null, M.phase === "entry" ? "最初の1件をエントリーしましょう。" : "この月はエントリーがありませんでした。")));
    return box;
  }
  box.append(h("div", { class: "grid" }, list.map((e) => entryCard(M, e))));
  return box;
}
function entryCard(M, e) {
  const mine = e.authorId && e.authorId === S.me.id;
  const canDel = (mine && M.phase === "entry") || (S.me.canEdit && (M.phase === "entry" || M.phase === "voting"));
  const key = "del-" + e.id;
  return h("article", { class: "card" + (mine ? " mine" : "") },
    cover(e, () => { S.detail = e.id; render(); }),
    h("div", { class: "meta" },
      h("div", { class: "row", style: "gap:8px" }, h("span", { class: "no" }, entryNo(M.id, e)), mine ? h("span", { class: "badge" }, "あなたのエントリー") : null),
      h("div", { class: "title" }, e.title),
      who(e.authorId),
      canDel ? h("div", { class: "actions" },
        h("button", { class: "btn danger sm" + (armed(key) ? " armed" : ""), onclick: () => armed(key) ? deleteEntry(e) : arm(key) }, armed(key) ? "もう一度押すと削除" : "削除")) : null));
}
function entryForm(M) {
  const d = S.draft;
  const fileInput = h("input", { type: "file", id: "f-files", accept: "image/jpeg,image/png,image/webp,image/gif", multiple: true, style: "display:none", onchange: (ev) => { addFiles(ev.target.files); ev.target.value = ""; } });
  const drop = h("div", { class: "drop" }, "ここに写真をドロップ、または ",
    h("button", { type: "button", class: "btn ghost sm", onclick: () => fileInput.click() }, "写真を選ぶ"),
    h("div", { class: "note", style: "margin-top:6px" }, "最大8枚。1枚目が一覧の表紙になります。縦横比はそのまま表示されます。"));
  drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (ev) => { ev.preventDefault(); drop.classList.remove("over"); addFiles(ev.dataTransfer.files); });
  return h("form", { class: "panel", onsubmit: (ev) => { ev.preventDefault(); submitEntry(M); } },
    h("h2", null, `${monthLabel(M.id)}のエントリー`),
    h("div", { class: "field" }, h("label", { for: "f-title" }, "物件名"),
      h("input", { class: "input", id: "f-title", maxlength: "60", placeholder: "例：AVEL 関内オフィス", value: d.title, oninput: (ev) => { d.title = ev.target.value; } })),
    h("div", { class: "field" }, h("label", null, "写真"), fileInput, drop,
      d.files.length ? h("div", { class: "thumbs", style: "margin-top:10px" }, d.files.map((f, i) =>
        h("div", { class: "thumb" }, h("img", { src: f.url, alt: "" }), h("button", { type: "button", "aria-label": "この写真を外す", onclick: () => { URL.revokeObjectURL(f.url); d.files.splice(i, 1); render(); } }, "×")))) : null),
    S.formErr ? h("p", { class: "err", style: "margin-bottom:10px" }, S.formErr) : null,
    h("div", { class: "row" },
      h("button", { class: "btn", type: "submit", disabled: !!S.formBusy }, S.formBusy || "エントリーする"),
      h("button", { class: "btn ghost", type: "button", disabled: !!S.formBusy, onclick: () => { S.showForm = false; S.formErr = ""; render(); } }, "閉じる")));
}
function addFiles(list) {
  const d = S.draft; S.formErr = "";
  for (const f of list) {
    if (!/^image\//.test(f.type)) { S.formErr = `「${f.name}」は画像ではありません。`; continue; }
    if (d.files.length >= 8) { S.formErr = "写真は8枚までです。"; break; }
    d.files.push({ file: f, url: URL.createObjectURL(f) });
  }
  render();
}
async function submitEntry(M) {
  const d = S.draft; const title = d.title.trim();
  if (!title) { S.formErr = "物件名を入力してください。"; render(); return; }
  if (!d.files.length) { S.formErr = "写真を1枚以上追加してください。"; render(); return; }
  S.formErr = ""; const photos = [];
  try {
    for (let i = 0; i < d.files.length; i++) {
      S.formBusy = `写真をアップロード中… ${i + 1} / ${d.files.length}`; render();
      const { img, url } = await loadImage(d.files[i].file);
      const ratio = +(img.naturalWidth / img.naturalHeight).toFixed(4);
      try {
        // 長辺2400pxまで縮小するだけ（トリミングなし・縦横比そのまま）
        const blob = await toBlob(drawScaled(img, 2400), 0.86);
        const path = await API.uploadPhoto(blob);
        photos.push({ path, r: ratio });
      } finally { URL.revokeObjectURL(url); }
    }
    S.formBusy = "登録中…"; render();
    await API.addEntry({ month: M.id, title: title.slice(0, 60), photos });
    d.files.forEach((f) => URL.revokeObjectURL(f.url));
    S.draft = { title: "", files: [] }; S.showForm = false; S.formBusy = "";
    toast("エントリーしました");
    await reload();
  } catch (e) {
    if (photos.length) API.deletePhotos(photos.map((p) => p.path)).catch(() => {});
    S.formBusy = ""; S.formErr = errMsg(e); render();
  }
}
async function deleteEntry(e) {
  S.confirm = null;
  try {
    await API.deleteEntry(e.id);
    API.deletePhotos((e.photos || []).map((p) => p.path).filter(Boolean)).catch(() => {});
    if (S.detail === e.id) S.detail = null;
    toast("エントリーを削除しました");
    await reload();
  } catch (err) { toast(errMsg(err)); }
}
function detailModal() {
  const e = S.entries.find((x) => x.id === S.detail);
  if (!e) return h("div");
  const close = () => { S.detail = null; render(); };
  return h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": e.title, onclick: (ev) => { if (ev.target.classList.contains("modal")) close(); } },
    h("div", { class: "sheet" },
      h("div", { class: "row" }, h("div", null, h("div", { class: "no" }, entryNo(e.month, e)), h("h2", { class: "title", style: "font-size:20px" }, e.title), who(e.authorId)), h("span", { class: "spacer" }),
        h("button", { class: "btn ghost sm", id: "close-detail", onclick: close }, "閉じる")),
      h("div", { class: "stack" }, (e.photos || []).map((p) => photoImg(p)))));
}

/* ---------- vote ---------- */
function voteView(M) {
  const box = h("div");
  const voters = votedIds(M.id);
  const hasVoted = S.me.id && voters.includes(S.me.id);
  const eligible = monthEntries(M.id).filter((e) => e.authorId !== S.me.id);
  const need = Math.min(3, eligible.length);
  box.append(h("p", { class: "lead" }, `現在 ${voters.length}人 が投票済み。1位 3pt・2位 2pt・3位 1pt で集計し、同点の場合は1位票が多い物件が上位になります。自分のエントリーには投票できません。`));

  if (M.phase === "entry") { box.append(h("div", { class: "empty" }, h("h2", null, "投票はエントリー締切後に始まります"), h("p", null, "管理者がエントリーを締め切ると、ここで投票できるようになります。"))); return box; }
  if (M.phase !== "voting") {
    box.append(h("div", { class: "empty" }, h("h2", null, "投票は締め切られました"), h("p", null, M.phase === "announced" ? "「結果発表」タブで結果を確認できます。" : "結果発表をお待ちください。")));
    if (S.myBallot && S.myBallotFor === M.id) box.append(h("div", { class: "panel", style: "margin-top:20px" }, h("h2", null, "あなたの投票"), myPicksList(M)));
    return box;
  }
  if (!S.me.id || S.canWrite === false) { box.append(h("div", { class: "empty" }, h("h2", null, "投票できません"), h("p", null, "ページを再読み込みしてください。"))); return box; }
  if (!eligible.length) { box.append(h("div", { class: "empty" }, h("h2", null, "投票できる物件がありません"), h("p", null, "自分以外のエントリーがあると投票できます。"))); return box; }

  if (hasVoted && !S.editVote) {
    box.append(h("div", { class: "panel voted" }, h("div", { class: "check", "aria-hidden": "true" }, "✓"),
      h("div", { style: "flex:1;min-width:0" }, h("h2", { style: "margin-bottom:4px" }, "投票済みです"),
        h("p", { class: "note" }, "投票内容は匿名で集計されます。締切までは修正できます。"),
        S.myBallot && S.myBallotFor === M.id ? myPicksList(M) : null),
      S.myBallot && S.myBallotFor === M.id ? h("button", { class: "btn ghost", id: "edit-vote", onclick: () => {
        S.editVote = true; S.vote = { picks: {}, comments: {} };
        (S.myBallot.picks || []).forEach((p) => { S.vote.picks[p.rank] = p.entryId; S.vote.comments[p.rank] = p.comment || ""; });
        render();
      } }, "投票を修正する") : null));
    return box;
  }

  const v = S.vote;
  const valid = (id) => eligible.some((e) => e.id === id);
  [1, 2, 3].forEach((r) => { if (v.picks[r] && !valid(v.picks[r])) delete v.picks[r]; });
  const filled = [1, 2, 3].filter((r) => v.picks[r]).length;

  box.append(h("div", { class: "slots" }, [1, 2, 3].slice(0, need).map((r) => {
    const e = eligible.find((x) => x.id === v.picks[r]);
    return h("div", { class: "slot" + (e ? " filled" : "") },
      h("div", { class: "slot-h" }, h("span", { class: "rk" }, r, h("small", null, r === 1 ? "st" : r === 2 ? "nd" : "rd")), h("span", { class: "pt" }, `${r}位 · ${POINTS[r]}pt`), h("span", { class: "spacer" }),
        e ? h("button", { class: "btn ghost sm", onclick: () => { delete v.picks[r]; render(); } }, "外す") : null),
      e ? h("div", { class: "pick" }, cover(e), h("div", { style: "min-width:0" }, h("div", { class: "title" }, e.title), who(e.authorId)))
        : h("div", { class: "ph-empty" }, "下の一覧から選んでください"),
      e ? h("textarea", { class: "input", id: "c-" + r, maxlength: "300", rows: "2", placeholder: "推しポイント（任意・匿名で発表されます）", oninput: (ev) => { v.comments[r] = ev.target.value; } }, v.comments[r] || "") : null);
  })));

  box.append(h("h3", { class: "section-h" }, "エントリー一覧"));
  box.append(h("div", { class: "grid" }, eligible.map((e) => h("article", { class: "card" },
    cover(e, () => { S.detail = e.id; render(); }),
    h("div", { class: "meta" }, h("span", { class: "no" }, entryNo(M.id, e)), h("div", { class: "title" }, e.title), who(e.authorId),
      h("div", { class: "actions" }, h("div", { class: "rank-btns", style: "width:100%" }, [1, 2, 3].slice(0, need).map((r) =>
        h("button", { type: "button", "aria-pressed": String(v.picks[r] === e.id), "aria-label": `${e.title} を${r}位にする`, onclick: () => {
          if (v.picks[r] === e.id) { delete v.picks[r]; }
          else { [1, 2, 3].forEach((x) => { if (v.picks[x] === e.id) { delete v.picks[x]; } }); v.picks[r] = e.id; }
          render();
        } }, `${r}位`)))))))));

  box.append(h("div", { class: "submitbar" },
    h("button", { class: "btn accent", id: "submit-vote", disabled: filled < need || S.voteBusy, onclick: () => submitVote(M, need) }, S.voteBusy ? "送信中…" : hasVoted ? "修正した内容で投票する" : "この内容で投票する"),
    S.editVote ? h("button", { class: "btn ghost", onclick: () => { S.editVote = false; render(); } }, "修正をやめる") : null,
    h("span", { class: "note" }, filled < need ? `あと${need - filled}件選んでください` : "誰がどこに投票したかは、管理者を含め誰にも表示されません。"),
    S.voteErr ? h("span", { class: "err" }, S.voteErr) : null));
  return box;
}
function myPicksList(M) {
  const picks = (S.myBallot && S.myBallot.picks) || [];
  return h("ul", { class: "mini-list" }, picks.slice().sort((a, b) => a.rank - b.rank).map((p) => {
    const e = S.entries.find((x) => x.id === p.entryId);
    return h("li", null, h("span", { class: "rkk" }, `${p.rank}位`), e ? e.title : "（削除されたエントリー）");
  }));
}
async function submitVote(M, need) {
  const v = S.vote; const uid = S.me.id;
  const picks = [1, 2, 3].filter((r) => v.picks[r]).map((r) => ({ rank: r, entryId: v.picks[r], comment: String(v.comments[r] || "").trim().slice(0, 300) }));
  if (picks.length < need) return;
  S.voteBusy = true; S.voteErr = ""; render();
  try {
    // 投票者と票の対応はサーバー側で本人だけが読める場所に保存される
    await API.submitVote(M.id, picks);
    S.myBallot = { picks }; S.myBallotFor = M.id;
    if (uid) (S.voters[uid] = S.voters[uid] || { months: {} }).months[M.id] = true;
    S.voteBusy = false; S.editVote = false; S.vote = { picks: {}, comments: {} };
    toast("投票しました");
    await reload();
  } catch (e) { S.voteBusy = false; S.voteErr = errMsg(e); render(); }
}
async function loadMyBallot() {
  const M = curMonth(); if (!M || !S.me.id || S.auth !== "ok") return;
  if (S.myBallotFor === M.id) return;
  const mid = M.id;
  try {
    const b = await API.myBallot(mid);
    if (curMonth() && curMonth().id === mid) { S.myBallot = b; S.myBallotFor = mid; render(); }
  } catch (_) {}
}

/* ---------- tally ---------- */
async function tally(M) {
  const list = await API.ballotsForTally(M.id);
  const snap = { size: list.length, docs: list.map((picks) => ({ data: () => ({ picks }) })) };
  const entries = monthEntries(M.id);
  const score = {};
  entries.forEach((e) => { score[e.id] = { entryId: e.id, title: e.title, authorId: e.authorId || null, photos: (e.photos || []).slice(0, 8), points: 0, r1: 0, r2: 0, r3: 0 }; });
  const comments = [];
  snap.docs.forEach((d) => {
    const b = d.data(); const seen = new Set();
    (Array.isArray(b.picks) ? b.picks : []).forEach((p) => {
      const s = score[p.entryId]; const r = Number(p.rank);
      if (!s || ![1, 2, 3].includes(r) || seen.has(p.entryId)) return;
      seen.add(p.entryId);
      s.points += POINTS[r]; s["r" + r] += 1;
      if (typeof p.comment === "string" && p.comment.trim()) comments.push({ entryId: p.entryId, rank: r, text: p.comment.trim().slice(0, 300) });
    });
  });
  const ranking = Object.values(score).sort((a, b) => b.points - a.points || b.r1 - a.r1 || a.title.localeCompare(b.title, "ja"));
  ranking.forEach((s, i) => { const prev = ranking[i - 1]; s.rank = prev && prev.points === s.points && prev.r1 === s.r1 ? prev.rank : i + 1; });
  return { ballots: snap.size, ranking, comments: shuffle(comments), at: new Date().toISOString() };
}

/* ---------- results ---------- */
function resultsView(M) {
  const box = h("div");
  const R = M.results;
  const visible = R && (M.phase === "announced" || (M.phase === "tallied" && S.me.canEdit));
  if (!visible) {
    box.append(h("div", { class: "empty" }, h("h2", null, "まだ発表されていません"),
      h("p", null, M.phase === "tallied" ? "集計は完了しています。管理者の発表をお待ちください。" : `現在は「${phaseLabel(M.phase)}」の段階です。`)));
    return box;
  }
  if (M.phase !== "announced") box.append(h("div", { class: "banner" }, "管理者プレビュー：この結果はまだメンバーには公開されていません。「管理」タブから発表すると全員に表示されます。"));
  const rk = R.ranking || [];
  if (!rk.length || !rk[0].points) {
    box.append(h("div", { class: "empty" }, h("h2", null, "有効な票がありませんでした"), h("p", null, `投票数 ${R.ballots || 0}`)));
    return box;
  }
  box.append(h("div", { class: "row", style: "margin-bottom:20px" },
    h("div", null, h("div", { class: "eyebrow" }, `${fmtMonth(M.id)} RESULTS`), h("h2", { style: "font-size:22px" }, `${monthLabel(M.id)} デザインアワード`)),
    h("span", { class: "spacer" }),
    h("button", { class: "btn accent", id: "open-stage", onclick: () => openStage(M) }, "発表モードで見る")));

  const top = rk.filter((r) => r.rank === 1);
  const rest = rk.filter((r) => r.rank > 1 && r.rank <= 3 && r.points > 0);
  box.append(h("div", { class: "podium" },
    h("div", { class: "side" }, top.map((r) => resultCard(r, true))),
    h("div", { class: "side" }, rest.map((r) => resultCard(r, false)))));

  box.append(h("h3", { class: "section-h" }, "全体の順位"));
  box.append(h("div", { class: "tbl-wrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", { class: "num" }, "順位"), h("th", null, "物件名"), h("th", null, "エントリー"), h("th", { class: "num" }, "合計"), h("th", { class: "num" }, "1位票"), h("th", { class: "num" }, "2位票"), h("th", { class: "num" }, "3位票"))),
    h("tbody", null, rk.map((r) => h("tr", null, h("td", { class: "num" }, r.rank), h("td", null, r.title), h("td", null, nameOf(r.authorId)),
      h("td", { class: "num" }, `${r.points}pt`), h("td", { class: "num" }, r.r1), h("td", { class: "num" }, r.r2), h("td", { class: "num" }, r.r3)))))));
  box.append(h("p", { class: "note", style: "margin:-16px 0 28px" }, `投票数 ${R.ballots}票 · 集計 ${new Date(R.at).toLocaleString("ja-JP")}`));

  const cm = R.comments || [];
  if (cm.length) {
    box.append(h("h3", { class: "section-h" }, `みんなのコメント（匿名・${cm.length}件）`));
    box.append(h("div", { class: "comments" }, cm.map((c) => {
      const r = rk.find((x) => x.entryId === c.entryId);
      return h("div", { class: "cmt" }, h("div", { class: "about" }, `${r ? r.title : ""} へ · ${c.rank}位票`), h("q", null, c.text));
    })));
  }
  return box;
}
function resultCard(r, win) {
  return h("article", { class: "card" + (win ? " win" : "") },
    cover(r),
    h("div", { class: "meta" },
      h("div", { class: "rank-tag" }, h("span", { class: "rk" }, r.rank, h("small", null, r.rank === 1 ? "st" : r.rank === 2 ? "nd" : "rd")), win ? h("span", { class: "eyebrow" }, "GRAND PRIX") : null),
      h("div", { class: "title", style: win ? "font-size:22px" : null }, r.title),
      who(r.authorId),
      h("span", { class: "score" }, `${r.points}pt · 1位票 ${r.r1} / 2位票 ${r.r2} / 3位票 ${r.r3}`)));
}

/* ---------- reveal stage（案B 図面：表紙 → 3位 → 2位 → グランプリ。各シートは伏せ → 公開の2段階） ---------- */
const INK = "#17181B", ACC = "#8A6727";
const RANK_LABEL = { 1: "GRAND PRIX", 2: "2ND PLACE", 3: "3RD PLACE" };
const sufOf = (n) => (n === 1 ? "st" : n === 2 ? "nd" : "rd");
const pad2 = (n) => String(n).padStart(2, "0");
function fitStage() { document.documentElement.style.setProperty("--k", String(Math.min(innerWidth / 1920, innerHeight / 1080))); }
addEventListener("resize", fitStage);
function openStage(M) {
  const rk = (M.results.ranking || []).filter((r) => r.rank <= 3 && r.points > 0);
  const ranks = [...new Set(rk.map((r) => r.rank))].sort((a, b) => b - a);
  const items = ranks.flatMap((n) => { const g = rk.filter((r) => r.rank === n); return g.map((item) => ({ type: "rank", rank: n, item, tie: g.length > 1 })); });
  const yymm = fmtMonth(M.id).slice(2).replace(".", "");
  items.forEach((s, j) => { s.dwg = `DA-${yymm}-${pad2(items.length - j)}`; });
  S.stage = { mid: M.id, sheets: [{ type: "cover" }, ...items], i: 0, revealed: false, seen: {}, photo: 0, anim: false };
  fitStage(); render();
  const el = $(".stage"); if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
}
function stageGo(i) { const st = S.stage; st.i = i; st.revealed = !!st.seen[i]; st.photo = 0; st.anim = false; render(); }
function stageNext() {
  const st = S.stage; if (!st) return; const sh = st.sheets[st.i];
  if (sh.type === "rank" && !st.revealed) {
    st.revealed = true; st.seen[st.i] = true; st.anim = true; render();
    setTimeout(() => { if (S.stage === st) st.anim = false; }, 900);
    return;
  }
  if (st.i < st.sheets.length - 1) stageGo(st.i + 1);
}
function stagePrev() { const st = S.stage; if (st && st.i > 0) stageGo(st.i - 1); }
function stagePhoto(d) {
  const st = S.stage; const sh = st && st.sheets[st.i];
  if (!sh || sh.type !== "rank" || !st.revealed) return false;
  const n = (sh.item.photos || []).length; const p = st.photo + d;
  if (n < 2 || p < 0 || p >= n) return false;
  st.photo = p; st.anim = false; render(); return true;
}
function closeStage() { S.stage = null; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); render(); }
function stageView() {
  const st = S.stage; const M = S.months.find((m) => m.id === st.mid);
  if (!M || !M.results) { S.stage = null; return h("div"); }
  const sh = st.sheets[st.i]; const N = st.sheets.length; const last = st.i === N - 1;
  let hint;
  if (sh.type === "cover") hint = "SPACE・クリック　はじめる";
  else if (!st.revealed) hint = "SPACE・クリック　発表する";
  else if (last) hint = "以上です。おめでとうございます！";
  else hint = ((sh.item.photos || []).length > 1 ? "← →　写真を切替　／　" : "") + "SPACE・クリック　次のシートへ";
  return h("div", { class: "stage", role: "dialog", "aria-modal": "true", "aria-label": "結果発表" },
    h("div", { class: "dsheet", onclick: stageNext },
      h("button", { class: "x-close", id: "stage-close", type: "button", onclick: (e) => { e.stopPropagation(); closeStage(); } }, "閉じる　ESC"),
      h("div", { class: "f1" }, sh.type === "cover" ? coverSheet(M, st, N) : rankSheet(M, st, sh, N, hint)),
      sh.type === "cover" ? h("div", { class: "foot-r" }, hint) : null));
}
function coverSheet(M, st, N) {
  const R = M.results;
  const rows = st.sheets.slice(1).flatMap((s, j) => {
    const gp = s.rank === 1; const open = !!st.seen[j + 1];
    const rl = (gp ? "グランプリ" : `第${s.rank}位`) + (s.tie ? "（同率）" : "");
    return [
      h("span", { class: "lat" + (gp ? " gp" : "") }, s.dwg),
      h("span", { class: gp ? "gp" : null, style: gp ? "font-weight:700" : null }, rl),
      h("span", { class: open ? null : "wait" }, open ? s.item.title : "発表待ち")];
  });
  return h("div", { class: "f2", style: "grid-template-columns:minmax(0,1fr) 720px" },
    h("div", { class: "cv-l" },
      h("span", { class: "lbl", style: "font-size:13px;letter-spacing:.32em" }, "MIYAKOBO"),
      h("span", { class: "lat cv-t" }, "Design", h("br"), "Award"),
      h("span", { style: "flex:1" }),
      h("span", { class: "lat cv-m" }, fmtMonth(M.id)),
      h("span", { style: "font-size:22px" }, `${monthLabel(M.id)} 受賞作品発表`),
      h("div", { class: "lbl", style: "position:absolute;left:80px;bottom:24px" }, `SHEET 1 / ${N}`)),
    h("div", { class: "cv-r" },
      h("div", { class: "lbl cv-h" }, "図面リスト｜DRAWING LIST"),
      h("div", { class: "dl" }, h("span", { class: "lbl" }, "DWG No."), h("span", { class: "lbl" }, "順位"), h("span", { class: "lbl" }, "物件名"), rows),
      h("span", { style: "flex:1" }),
      h("div", { class: "cnt" },
        h("div", null, h("span", { class: "lbl" }, "ENTRIES"), h("b", null, String((R.ranking || []).length))),
        h("div", null, h("span", { class: "lbl" }, "BALLOTS"), h("b", null, String(R.ballots || 0))))));
}
function rankSheet(M, st, sh, N, hint) {
  const r = sh.item; const rev = st.revealed; const anim = st.anim ? " rv" : "";
  const ps = r.photos || []; const pi = Math.min(st.photo, Math.max(0, ps.length - 1));
  const col = r.rank === 1 ? ACC : INK;
  const mine = ((M.results.comments) || []).filter((c) => c.entryId === r.entryId);
  let photo;
  if (!rev) photo = h("div", { class: "hatch" }, h("span", null, "発表待ち"));
  else if (!ps[pi]) photo = h("div", { class: "hatch" + anim }, h("span", null, "写真なし"));
  else {
    const dim = h("span", null, "—");
    const img = photoImg(ps[pi], "sp-img");
    const setDim = () => { if (img.naturalWidth) dim.textContent = `W ${img.naturalWidth.toLocaleString()} × H ${img.naturalHeight.toLocaleString()} px`; };
    img.addEventListener("load", setDim); setDim();
    photo = h("div", { class: "sp" + anim },
      h("div", { class: "dim lat" }, h("i", { class: "t" }), h("i", { class: "ln" }), dim, h("i", { class: "ln" }), h("i", { class: "t" })),
      img);
  }
  const under = rev && ps.length ? h("div", { class: "sp" + anim, style: "align-items:center" },
    h("div", { class: "cap lat" }, `VIEW ${pad2(pi + 1)} / ${pad2(ps.length)}`),
    ps.length > 1 ? h("div", { class: "thumbs" }, ps.map((p, k) => h("button", {
      type: "button", "aria-label": `写真 ${k + 1}`, style: k === pi ? `outline:2px solid ${col}` : null,
      onclick: (e) => { e.stopPropagation(); st.photo = k; st.anim = false; render(); } }, photoImg(p)))) : null) : null;
  const cm = !rev ? h("div", { class: "tb-wait" }, "発表後に表示")
    : mine.length ? [mine.slice(0, 3).map((c, k) => h("div", { class: "c2" + anim }, `${k + 1}. 「${c.text}」`)), mine.length > 3 ? h("div", { class: "more" + anim }, `ほか ${mine.length - 3} 件`) : null]
    : h("div", { class: "more" }, "コメントはありません");
  return h("div", { class: "f2", style: "grid-template-columns:minmax(0,1fr) 520px" },
    h("div", { class: "dw" },
      h("div", { class: "grid6 lbl" }, ["A", "B", "C", "D", "E", "F"].map((c) => h("span", null, c))),
      h("div", { class: "dw-c" }, photo, under),
      h("div", { class: "foot-l" }, `MIYAKOBO DESIGN AWARD — SHEET ${st.i + 1} / ${N}`),
      h("div", { class: "foot-r" }, hint)),
    h("div", { class: "tb" },
      h("div", { class: "tb-rank" },
        h("span", { class: "tb-lbl", style: `color:${col}` }, RANK_LABEL[r.rank] + (sh.tie ? " — TIE" : "")),
        h("div", { class: "tb-row" },
          h("span", { class: "lat tb-num", style: `color:${col}` }, String(r.rank), h("span", null, sufOf(r.rank))),
          sh.tie ? h("span", { class: "tie", style: `color:${col};border-color:${col}` }, "同率") : null)),
      h("div", { class: "tb-cm" }, h("span", { class: "lbl", style: "letter-spacing:.24em" }, "特記事項｜みんなのコメント"), cm),
      h("div", { class: "tbl" },
        h("span", null, "PROJECT"), h("span", { class: "pj" + anim }, rev ? r.title : "■■■■■■■■"),
        h("span", null, "DESIGNER"), h("span", { class: anim.trim() || null }, rev ? nameOf(r.authorId) : "—"),
        h("span", null, "SCORE"), h("span", { class: "lat" + anim }, rev ? `${r.points}pt ｜ 1位票 ${r.r1}・2位票 ${r.r2}・3位票 ${r.r3}` : "—"),
        h("span", null, "DWG No."), h("span", { class: "lat", style: "letter-spacing:.08em" }, `${sh.dwg}　${fmtMonth(M.id)}`))));
}
document.addEventListener("keydown", (e) => {
  if (S.stage) {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); stageNext(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stagePhoto(1) || stageNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); stagePhoto(-1) || stagePrev(); }
    else if (e.key === "Escape") closeStage();
  } else if (S.detail && e.key === "Escape") { S.detail = null; render(); }
});

/* ---------- archive ---------- */
function archiveView() {
  const done = S.months.filter((m) => m.phase === "announced" && m.results && (m.results.ranking || [])[0] && m.results.ranking[0].points > 0);
  if (!done.length) return h("div", { class: "empty" }, h("h2", null, "受賞作品はまだありません"), h("p", null, "毎月の結果発表後、グランプリ作品がここに並びます。"));
  return h("div", { class: "grid" }, done.map((m) => {
    const wins = m.results.ranking.filter((r) => r.rank === 1);
    return h("article", { class: "card" },
      cover(wins[0], () => { S.monthId = m.id; S.tab = "results"; loadMyBallot(); render(); window.scrollTo(0, 0); }),
      h("div", { class: "meta" }, h("span", { class: "eyebrow" }, `${fmtMonth(m.id)} GRAND PRIX`),
        wins.map((w) => h("div", null, h("div", { class: "title" }, w.title), who(w.authorId)))));
  }));
}

/* ---------- admin ---------- */
function startMonthPanel() {
  if (!S.newMonth) S.newMonth = nowMonthId();
  return h("form", { class: "panel", onsubmit: async (ev) => {
    ev.preventDefault();
    const id = S.newMonth;
    if (!/^\d{4}-\d{2}$/.test(id)) { S.adminErr = "月を選んでください。"; render(); return; }
    if (S.months.some((m) => m.id === id)) { S.adminErr = `${monthLabel(id)}の回はすでにあります。`; render(); return; }
    S.adminBusy = true; S.adminErr = ""; render();
    try { await API.createMonth(id); S.monthId = id; S.tab = "entries"; S.adminBusy = false; toast(`${monthLabel(id)}のアワードを開始しました`); await reload(); }
    catch (e) { S.adminBusy = false; S.adminErr = errMsg(e); render(); }
  } },
    h("h2", null, "アワードを開始"),
    h("div", { class: "row" },
      h("input", { class: "input", type: "month", id: "new-month", value: S.newMonth, style: "max-width:200px", oninput: (ev) => { S.newMonth = ev.target.value; } }),
      h("button", { class: "btn", type: "submit", disabled: S.adminBusy }, "この月のエントリー受付を始める")),
    S.adminErr && !curMonth() ? h("p", { class: "err", style: "margin-top:8px" }, S.adminErr) : null);
}
async function setPhase(M, phase) {
  S.adminBusy = true; S.adminErr = ""; S.confirm = null; render();
  try { await API.setPhase(M.id, phase); S.adminBusy = false; await reload(); return true; }
  catch (e) { S.adminBusy = false; S.adminErr = errMsg(e); render(); return false; }
}
async function closeAndTally(M) {
  S.adminBusy = true; S.adminErr = ""; S.confirm = null; render();
  try {
    // 先に締め切ってから集計する（集計中に票が増えないように）
    if (M.phase !== "tallied") await API.setPhase(M.id, "tallied");
    const results = await tally(M);
    await API.saveResults(M.id, results);
    S.adminBusy = false; toast("投票を締め切り、集計しました"); S.tab = "results"; await reload();
  } catch (e) { S.adminBusy = false; S.adminErr = errMsg(e) + "（「再集計する」でやり直せます）"; await reload(); }
}
function adminView(M) {
  const box = h("div");
  const voters = votedIds(M.id);
  const n = monthEntries(M.id).length;
  const p = M.phase;
  const btn = (key, label, cls, fn, needConfirm) => h("button", { class: "btn " + (cls || "") + (needConfirm && armed(key) ? " armed" : ""), disabled: S.adminBusy, onclick: () => needConfirm && !armed(key) ? arm(key) : fn() },
    needConfirm && armed(key) ? "もう一度押して確定" : label);
  const actions = [];
  if (p === "entry") actions.push(btn("to-vote", "エントリーを締め切って投票を始める", "accent", async () => { if (await setPhase(M, "voting")) toast("投票を開始しました"); }, true));
  if (p === "voting") {
    actions.push(btn("tally", "投票を締め切って集計する", "accent", () => closeAndTally(M), true));
    actions.push(btn("back-entry", "エントリー受付に戻す", "ghost", () => setPhase(M, "entry"), true));
  }
  if (p === "tallied") {
    actions.push(btn("announce", "結果を全員に発表する", "accent", async () => { if (await setPhase(M, "announced")) { S.tab = "results"; toast("結果を発表しました"); render(); } }, true));
    actions.push(btn("retally", "再集計する", "ghost", () => closeAndTally(M), true));
    actions.push(btn("reopen", "投票を再開する", "ghost", () => setPhase(M, "voting"), true));
  }
  if (p === "announced") actions.push(btn("unannounce", "発表を取り消す", "ghost", () => setPhase(M, "tallied"), true));

  box.append(h("div", { class: "panel" },
    h("h2", null, `${monthLabel(M.id)}の進行`),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", null, n), h("span", null, "エントリー")),
      h("div", { class: "stat" }, h("b", null, voters.length), h("span", null, "投票済み")),
      M.results ? h("div", { class: "stat" }, h("b", null, M.results.ballots), h("span", null, "集計した票")) : null),
    h("p", { class: "note", style: "margin-bottom:12px" }, `現在：${phaseLabel(p)}。` + (p === "voting" ? "全員の投票がそろったら、または締切時刻になったら締め切ってください。" : "")),
    h("div", { class: "row" }, actions),
    S.adminErr ? h("p", { class: "err", style: "margin-top:10px" }, S.adminErr) : null));

  box.append(h("div", { class: "panel" },
    h("h2", null, "投票済みのメンバー"),
    h("p", { class: "note", style: "margin-bottom:10px" }, "表示されるのは投票したかどうかだけです。誰がどの物件に投票したかは記録していません。"),
    voters.length ? h("div", { class: "chips" }, voters.map((id) => { const pr = profile(id); return h("span", { class: "chip" }, pr && pr.avatarUrl ? h("img", { src: pr.avatarUrl, alt: "", referrerpolicy: "no-referrer" }) : null, nameOf(id)); }))
      : h("p", { class: "note" }, "まだ誰も投票していません。")));

  box.append(startMonthPanel());
  box.append(h("div", { class: "panel" }, h("h2", null, "メンバーへの共有"),
    h("p", { class: "note" }, "このページのURLを社内に共有してください。ログインは不要で、URLを開いて名前を入れれば誰でもエントリーと投票ができます。管理（締切・集計・発表）は、画面下の「管理者の方はこちら」から管理者パスワードを入れた人だけができます。"),
    h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "btn ghost sm", id: "copy-url", onclick: async () => {
      try { await navigator.clipboard.writeText(location.origin + location.pathname); toast("URLをコピーしました"); } catch (_) { toast(location.origin + location.pathname); }
    } }, "このページのURLをコピー"))));
  return box;
}

/* ---------- boot ---------- */
let reloading = null, reloadAgain = false;
async function reload() {
  if (S.auth !== "ok") return;
  if (reloading) { reloadAgain = true; return reloading; }
  reloading = (async () => {
    const slowT = setTimeout(() => { S.slow = true; render(); }, 10000);
    try {
      const d = await API.loadAll();
      S.slow = false;
      S.months = d.months.filter((m) => /^\d{4}-\d{2}$/.test(m.id)).sort((a, b) => b.id.localeCompare(a.id));
      S.entries = d.entries; S.voters = d.voters;
      const had = S.monthsLoaded; S.monthsLoaded = true;
      if (!S.monthId || !S.months.some((m) => m.id === S.monthId)) S.monthId = S.months[0] ? S.months[0].id : null;
      if (!had) { const M = curMonth(); if (M) S.tab = M.phase === "voting" ? "vote" : M.phase === "announced" ? "results" : "entries"; }
      loadMyBallot();
    } catch (_) { S.slow = true; }
    clearTimeout(slowT);
    render();
  })();
  await reloading; reloading = null;
  if (reloadAgain) { reloadAgain = false; await reload(); }
}
let pendingT = null;
const softReload = () => { clearTimeout(pendingT); pendingT = setTimeout(reload, 250); };

let subscribed = false;
async function boot() {
  try {
    const me = await API.session();
    S.me = { id: me.id, canEdit: !!me.isAdmin, name: me.name || "", avatarUrl: "", email: "" };
    S.profiles[me.id] = { name: me.name || "", avatarUrl: "" };
    if (S.tab === "admin" && !S.me.canEdit) S.tab = "entries";
    if (!S.me.name) { S.auth = "needname"; S.nameDraft = ""; render(); return; }
    S.auth = "ok";
    render();
    if (!subscribed) { subscribed = true; API.subscribe(softReload); }
    await reload();
  } catch (e) {
    S.auth = "error"; S.authErr = errMsg(e); render();
  }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") softReload(); });
render();
boot();
})();
