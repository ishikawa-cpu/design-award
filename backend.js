/* 宮工房 Design Award — データの出し入れ（Supabase 版 / デモ版）
   画面側（app.js）はここで定義した window.AwardAPI だけを使う。 */
(() => {
"use strict";
const C = window.AWARD_CONFIG || {};
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo") || !C.SUPABASE_URL || !C.SUPABASE_ANON_KEY;

function fail(message, code) { const e = new Error(message); if (code) e.code = code; return e; }

/* ---------- 行 → 画面用の形 ---------- */
const toMonth = (r) => ({ id: r.id, phase: r.phase, createdAt: r.created_at });
const toEntry = (r) => ({ id: r.id, month: r.month_id, title: r.title, photos: Array.isArray(r.photos) ? r.photos : [], authorId: r.author_id, createdAt: r.created_at });

/* =====================================================================
   Supabase 版
   ===================================================================== */
function supabaseBackend() {
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
  });
  const mapErr = (e) => {
    const m = (e && e.message) || "";
    if ((e && e.code === "42501") || /row-level security|permission denied|権限/i.test(m)) return fail("この操作の権限がありません。", "denied");
    if (/payload too large|maximum allowed size|exceeded/i.test(m)) return fail("ファイルが大きすぎます。", "too_large");
    if (/failed to fetch|network/i.test(m)) return fail("通信できませんでした。電波の良い場所でもう一度お試しください。", "network");
    return fail(m || "保存できませんでした。");
  };
  const ok = (res) => { if (res.error) throw mapErr(res.error); return res.data; };
  let meId = null;

  return {
    demo: false,
    // ログイン不要：初回は端末ごとの匿名IDを自動で発行する（以後はこのブラウザに保存される）
    async session() {
      let { data } = await sb.auth.getSession();
      let s = data && data.session;
      if (!s) {
        const r = await sb.auth.signInAnonymously();
        if (r.error) throw /anonymous/i.test(r.error.message || "") ? fail("Supabase で匿名ログイン（Allow anonymous sign-ins）が有効になっていません。", "anon_off") : mapErr(r.error);
        s = r.data && r.data.session;
      }
      if (!s) throw fail("接続できませんでした。");
      meId = s.user.id;
      const p = await sb.from("profiles").select("name,is_admin").eq("id", meId).maybeSingle();
      if (p.error) throw mapErr(p.error);
      return { id: meId, name: (p.data && p.data.name) || "", avatarUrl: "", isAdmin: !!(p.data && p.data.is_admin) };
    },
    async setName(name) { ok(await sb.rpc("set_my_name", { p_name: name })); },
    async adminLogin(password) { return !!ok(await sb.rpc("admin_login", { p_password: password })); },
    async adminLogout() { ok(await sb.rpc("admin_logout")); },
    onAuthChange() {},

    async loadAll() {
      const [m, r, e, v] = await Promise.all([
        sb.from("months").select("id,phase,created_at").order("id", { ascending: false }),
        sb.from("month_results").select("month_id,data"),
        sb.from("entries").select("id,month_id,title,photos,author_id,created_at").order("created_at"),
        sb.from("voters").select("user_id,month_id"),
      ]);
      const months = ok(m).map(toMonth);
      const results = {}; ok(r).forEach((x) => { results[x.month_id] = x.data; });
      months.forEach((mm) => { if (results[mm.id]) mm.results = results[mm.id]; });
      const voters = {};
      ok(v).forEach((x) => { (voters[x.user_id] = voters[x.user_id] || { months: {} }).months[x.month_id] = true; });
      return { months, entries: ok(e).map(toEntry), voters };
    },
    subscribe(cb) {
      const ch = sb.channel("design-award");
      ["months", "month_results", "entries", "voters"].forEach((t) => ch.on("postgres_changes", { event: "*", schema: "public", table: t }, () => cb(t)));
      ch.subscribe();
    },
    async profiles(ids) {
      const rows = ok(await sb.from("profiles").select("id,name,avatar_url").in("id", ids));
      const out = {}; ids.forEach((id) => { out[id] = { name: "", avatarUrl: "" }; });
      rows.forEach((p) => { out[p.id] = { name: p.name || "", avatarUrl: p.avatar_url || "" }; });
      return out;
    },

    async createMonth(id) { ok(await sb.from("months").insert({ id, phase: "entry" })); },
    async setPhase(id, phase) {
      const rows = ok(await sb.from("months").update({ phase }).eq("id", id).select("id"));
      if (!rows.length) throw fail("この操作の権限がありません。", "denied");
    },

    async uploadPhoto(blob) {
      const path = `${meId}/${crypto.randomUUID()}.jpg`;
      ok(await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", upsert: false, cacheControl: "31536000" }));
      return path;
    },
    async photoUrls(paths) {
      const data = ok(await sb.storage.from("photos").createSignedUrls(paths, 60 * 60 * 12));
      const out = {}; (data || []).forEach((d) => { if (d.signedUrl) out[d.path] = d.signedUrl; });
      return out;
    },
    async deletePhotos(paths) { if (paths.length) await sb.storage.from("photos").remove(paths); },

    async addEntry({ month, title, photos }) { ok(await sb.from("entries").insert({ month_id: month, title, photos })); },
    async deleteEntry(id) {
      const rows = ok(await sb.from("entries").delete().eq("id", id).select("id"));
      if (!rows.length) throw fail("この操作の権限がありません。", "denied");
    },

    async submitVote(month, picks) { ok(await sb.rpc("submit_vote", { p_month: month, p_picks: picks })); },
    async myBallot(month) {
      const r = ok(await sb.from("my_ballots").select("picks").eq("month_id", month).eq("user_id", meId).maybeSingle());
      return r ? { picks: r.picks || [] } : null;
    },
    async ballotsForTally(month) { return ok(await sb.rpc("tally_ballots", { p_month: month })) || []; },
    async saveResults(month, data) { ok(await sb.from("month_results").upsert({ month_id: month, data, updated_at: new Date().toISOString() })); },
  };
}

/* =====================================================================
   デモ版（Supabase 未設定時 or ?demo）— データはこのタブの中だけ。再読み込みで元に戻る。
   ===================================================================== */
function demoBackend() {
  const ME = "demo-me";
  const people = {
    "demo-me": { name: params.get("demo") === "new" ? "" : "あなた（デモ）", avatarUrl: "" },
    "demo-a": { name: "佐藤 デザイナー", avatarUrl: "" },
    "demo-b": { name: "鈴木 デザイナー", avatarUrl: "" },
    "demo-c": { name: "高橋 デザイナー", avatarUrl: "" },
    "demo-d": { name: "田中 デザイナー", avatarUrl: "" },
  };
  const blobs = {}; let seq = 0;
  // 縦横比の違う仮写真（実際の写真の代わり）
  function fakePhoto(w, hgt, hue, label) {
    const c = document.createElement("canvas"); c.width = w; c.height = hgt;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, hgt);
    g.addColorStop(0, `hsl(${hue},18%,72%)`); g.addColorStop(1, `hsl(${hue + 20},22%,42%)`);
    x.fillStyle = g; x.fillRect(0, 0, w, hgt);
    x.strokeStyle = "rgba(255,255,255,.35)"; x.lineWidth = Math.max(2, w / 300);
    for (let i = 1; i < 6; i++) { x.beginPath(); x.moveTo((w * i) / 6, 0); x.lineTo((w * i) / 6, hgt); x.stroke(); }
    x.fillStyle = "rgba(255,255,255,.9)"; x.font = `${Math.round(Math.min(w, hgt) / 9)}px Helvetica Neue, sans-serif`;
    x.fillText(label, w * 0.06, hgt * 0.9);
    const path = `demo/${++seq}.jpg`; blobs[path] = c.toDataURL("image/jpeg", 0.85);
    return { path, r: +(w / hgt).toFixed(4) };
  }
  const iso = (d) => new Date(Date.now() - d * 3600e3).toISOString();
  const db = {
    months: [{ id: "2026-11", phase: "voting", createdAt: iso(200) }, { id: "2026-10", phase: "announced", createdAt: iso(900) }],
    results: {},
    entries: [
      { id: "e1", month: "2026-11", title: "AVEL 関内オフィス", photos: [fakePhoto(1600, 1000, 30, "LOUNGE"), fakePhoto(900, 1200, 40, "ENTRANCE"), fakePhoto(1200, 1200, 20, "MEETING")], authorId: "demo-a", createdAt: iso(150) },
      { id: "e2", month: "2026-11", title: "Agnostri エントランス", photos: [fakePhoto(1000, 1500, 0, "ALL BURN."), fakePhoto(1600, 900, 10, "RECEPTION")], authorId: "demo-b", createdAt: iso(140) },
      { id: "e3", month: "2026-11", title: "4COLORS エントランス", photos: [fakePhoto(1800, 1000, 200, "BATON")], authorId: "demo-c", createdAt: iso(130) },
      { id: "e4", month: "2026-11", title: "オリックス赤坂 共用部", photos: [fakePhoto(1500, 1000, 140, "BREATHING"), fakePhoto(1000, 1300, 150, "7F")], authorId: "demo-d", createdAt: iso(120) },
      { id: "e5", month: "2026-11", title: "宮工房 自社ショールーム", photos: [fakePhoto(1400, 1000, 60, "SHOWROOM")], authorId: ME, createdAt: iso(110) },
      { id: "e6", month: "2026-10", title: "鎌倉 古民家オフィス", photos: [fakePhoto(1600, 1100, 90, "KAMAKURA")], authorId: "demo-c", createdAt: iso(800) },
      { id: "e7", month: "2026-10", title: "渋谷 スタートアップ本社", photos: [fakePhoto(1200, 900, 250, "SHIBUYA")], authorId: "demo-a", createdAt: iso(790) },
    ],
    ballots: [
      { month: "2026-11", picks: [{ rank: 1, entryId: "e1", comment: "素材の切り替えが自然で、長く居たくなる空間" }, { rank: 2, entryId: "e2", comment: "" }, { rank: 3, entryId: "e3", comment: "" }] },
      { month: "2026-11", picks: [{ rank: 1, entryId: "e2", comment: "黒の使い方に覚悟を感じる" }, { rank: 2, entryId: "e1", comment: "" }, { rank: 3, entryId: "e4", comment: "照明計画が上手い" }] },
      { month: "2026-11", picks: [{ rank: 1, entryId: "e1", comment: "" }, { rank: 2, entryId: "e4", comment: "" }, { rank: 3, entryId: "e5", comment: "" }] },
    ],
    voters: { "demo-a": { months: { "2026-11": true } }, "demo-b": { months: { "2026-11": true } }, "demo-c": { months: { "2026-11": true } } },
    mine: {},
  };
  db.results["2026-10"] = {
    ballots: 4, at: iso(700),
    ranking: [
      { entryId: "e6", title: "鎌倉 古民家オフィス", authorId: "demo-c", photos: db.entries[5].photos, points: 10, r1: 3, r2: 0, r3: 1, rank: 1 },
      { entryId: "e7", title: "渋谷 スタートアップ本社", authorId: "demo-a", photos: db.entries[6].photos, points: 7, r1: 1, r2: 2, r3: 0, rank: 2 },
    ],
    comments: [{ entryId: "e6", rank: 1, text: "既存の梁を活かした判断が光る" }],
  };
  let listeners = [];
  const changed = (t) => setTimeout(() => listeners.forEach((f) => f(t)), 30);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let asAdmin = params.get("demo") === "admin";
  const clone = (o) => JSON.parse(JSON.stringify(o));

  return {
    demo: true,
    get asAdmin() { return asAdmin; },
    setRole(admin) { asAdmin = admin; },
    async session() { return { id: ME, name: people[ME].name, avatarUrl: "", isAdmin: asAdmin }; },
    async setName(name) { people[ME].name = name; },
    async adminLogin(password) { await wait(300); if (password !== "demo1234") return false; asAdmin = true; return true; },
    async adminLogout() { asAdmin = false; },
    onAuthChange() {},
    async loadAll() {
      await wait(120);
      const months = clone(db.months).sort((a, b) => b.id.localeCompare(a.id));
      months.forEach((m) => { const r = db.results[m.id]; if (r && (asAdmin || m.phase === "announced")) m.results = clone(r); });
      return { months, entries: clone(db.entries), voters: clone(db.voters) };
    },
    subscribe(cb) { listeners.push(cb); },
    async profiles(ids) { const o = {}; ids.forEach((id) => { o[id] = people[id] || { name: "", avatarUrl: "" }; }); return o; },
    async createMonth(id) { if (!asAdmin) throw fail("この操作の権限がありません。", "denied"); db.months.push({ id, phase: "entry", createdAt: new Date().toISOString() }); changed("months"); },
    async setPhase(id, phase) { if (!asAdmin) throw fail("この操作の権限がありません。", "denied"); db.months.find((m) => m.id === id).phase = phase; changed("months"); },
    async uploadPhoto(blob) {
      await wait(250);
      const path = `demo/${++seq}.jpg`;
      blobs[path] = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      return path;
    },
    async photoUrls(paths) { const o = {}; paths.forEach((p) => { if (blobs[p]) o[p] = blobs[p]; }); return o; },
    async deletePhotos(paths) { paths.forEach((p) => delete blobs[p]); },
    async addEntry({ month, title, photos }) {
      const m = db.months.find((x) => x.id === month);
      if (!m || m.phase !== "entry") throw fail("エントリーは締め切られています。");
      db.entries.push({ id: "e" + Date.now(), month, title, photos, authorId: ME, createdAt: new Date().toISOString() }); changed("entries");
    },
    async deleteEntry(id) { db.entries = db.entries.filter((e) => e.id !== id); changed("entries"); },
    async submitVote(month, picks) {
      await wait(200);
      const m = db.months.find((x) => x.id === month);
      if (!m || m.phase !== "voting") throw fail("投票は締め切られました。");
      if (picks.some((p) => (db.entries.find((e) => e.id === p.entryId) || {}).authorId === ME)) throw fail("投票できない物件が含まれています。");
      const mine = db.mine[month];
      if (mine) mine.ballot.picks = clone(picks);
      else { const ballot = { month, picks: clone(picks) }; db.ballots.push(ballot); db.mine[month] = { ballot }; }
      (db.voters[ME] = db.voters[ME] || { months: {} }).months[month] = true; changed("voters");
    },
    async myBallot(month) { const m = db.mine[month]; return m ? { picks: clone(m.ballot.picks) } : null; },
    async ballotsForTally(month) { await wait(200); return db.ballots.filter((b) => b.month === month).map((b) => clone(b.picks)); },
    async saveResults(month, data) { db.results[month] = clone(data); changed("month_results"); },
  };
}

window.AwardAPI = DEMO ? demoBackend() : supabaseBackend();
})();
