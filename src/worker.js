import { DurableObject } from "cloudflare:workers";
import { ASSETS } from "./assets.js";
import puppeteer from "@cloudflare/puppeteer";

const MODEL_CHAT = "@cf/qwen/qwen3-30b-a3b-fp8";
const MODEL_CODE = "@cf/qwen/qwen3-30b-a3b-fp8";
const MODEL_VISION = "@cf/meta/llama-4-scout-17b-16e-instruct";
const GEMINI_MODEL = "gemini-2.5-flash";

// ---------------- Durable Object: per-user memory + chats ----------------
export class Brain extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql; // legacy (unused; KV is used instead)
  }
  listMemories() { return this.sql.exec(`SELECT id,text,ts FROM memories ORDER BY id`).toArray(); }
  addMemory(text) {
    text = String(text || "").trim().slice(0, 500);
    if (!text) return false;
    const dup = this.sql.exec(`SELECT id FROM memories WHERE text=?`, text).toArray();
    if (!dup.length) this.sql.exec(`INSERT INTO memories(text,ts) VALUES(?,?)`, text, Date.now());
    return true;
  }
  deleteMemory(id) { this.sql.exec(`DELETE FROM memories WHERE id=?`, id); return true; }
  listChats() { return this.sql.exec(`SELECT id,title,ts FROM chats ORDER BY ts DESC LIMIT 100`).toArray(); }
  getChat(id) { const r = this.sql.exec(`SELECT data FROM chats WHERE id=?`, id).toArray(); return r.length ? JSON.parse(r[0].data) : null; }
  saveChat(id, title, messages) {
    this.sql.exec(`INSERT INTO chats(id,title,data,ts) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,data=excluded.data,ts=excluded.ts`,
      id, String(title).slice(0, 80), JSON.stringify(messages.slice(-60)), Date.now());
    return true;
  }
  deleteChat(id) { this.sql.exec(`DELETE FROM chats WHERE id=?`, id); return true; }
}


// ---------------- KV-backed per-user store (memories + chats) ----------------
class KVBrain {
  constructor(kv, uid) { this.kv = kv; this.u = uid; }
  async _get(k, d) { const v = await this.kv.get(this.u + ":" + k, "json"); return v ?? d; }
  async _put(k, v) { await this.kv.put(this.u + ":" + k, JSON.stringify(v)); }
  async listMemories() { return await this._get("mem", []); }
  async addMemory(text) {
    text = String(text || "").trim().slice(0, 500); if (!text) return false;
    const l = await this.listMemories(); if (l.some(m => m.text === text)) return true;
    l.push({ id: Date.now(), text, ts: Date.now() }); await this._put("mem", l.slice(-200)); return true;
  }
  async deleteMemory(id) { const l = await this.listMemories(); await this._put("mem", l.filter(m => m.id !== id)); return true; }
  async listChats() { return await this._get("chats", []); }
  async getChat(id) { return await this._get("chat:" + id, null); }
  async saveChat(id, title, messages) {
    id = String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    await this._put("chat:" + id, messages.slice(-60));
    const l = (await this.listChats()).filter(c => c.id !== id);
    l.unshift({ id, title: String(title).slice(0, 80), ts: Date.now() });
    await this._put("chats", l.slice(0, 100)); return true;
  }
  async deleteChat(id) {
    await this.kv.delete(this.u + ":chat:" + id);
    await this._put("chats", (await this.listChats()).filter(c => c.id !== id)); return true;
  }
}

// ---------------- helpers ----------------
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<(br|p|div|li|h\d|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
function decodeDDG(href) {
  try { const u = new URL(href, "https://duckduckgo.com"); const r = u.searchParams.get("uddg"); return r ? decodeURIComponent(r) : u.href; } catch { return href; }
}
async function ddg(q) {
  const out = [];
  try {
    const r = await fetch("https://html.duckduckgo.com/html/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA }, body: "q=" + encodeURIComponent(q) + "&kl=jp-jp" });
    const h = await r.text();
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m; while ((m = re.exec(h)) && out.length < 6) out.push({ title: htmlToText(m[2]), url: decodeDDG(m[1]), snippet: htmlToText(m[3]) });
  } catch (e) {}
  return out;
}
function unBing(u) {
  try { const x = new URL(u); const p = x.searchParams.get("u"); if (x.hostname.endsWith("bing.com") && p && p.startsWith("a1")) { let b = p.slice(2).replace(/-/g, "+").replace(/_/g, "/"); while (b.length % 4) b += "="; return decodeURIComponent(escape(atob(b))); } } catch (e) {}
  return u;
}
async function yahooTop() {
  const out = [];
  try {
    const x = await (await fetch("https://news.yahoo.co.jp/rss/topics/top-picks.xml", { headers: { "user-agent": UA } })).text();
    for (const it of x.split("<item>").slice(1, 9)) {
      const t = it.match(/<title>([\s\S]*?)<\/title>/), l = it.match(/<link>([\s\S]*?)<\/link>/), d = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      out.push({ title: t ? htmlToText(t[1]) : "", url: l ? l[1].trim() : "", date: d ? d[1] : "", source: "Yahoo!ニュース トピックス" });
    }
  } catch (e) {}
  return out;
}
async function bing(q) {
  const out = [];
  try {
    const r = await fetch("https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=ja&cc=JP", { headers: { "user-agent": UA, "accept-language": "ja" } });
    const h = await r.text();
    const blocks = h.split('<li class="b_algo"').slice(1);
    for (const b of blocks) {
      const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/); if (!a) continue;
      const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      out.push({ title: htmlToText(a[2]), url: unBing(a[1].replace(/&amp;/g, "&")), snippet: p ? htmlToText(p[1]) : "" });
      if (out.length >= 6) break;
    }
  } catch (e) {}
  return out;
}
async function gnews(q) {
  const out = [];
  try {
    const r = await fetch("https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=ja&gl=JP&ceid=JP:ja", { headers: { "user-agent": UA } });
    const x = await r.text();
    const items = x.split("<item>").slice(1);
    for (const it of items.slice(0, 6)) {
      const g = (t) => { const m = it.match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">")); return m ? htmlToText(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")) : ""; };
      out.push({ title: g("title"), url: g("link"), date: g("pubDate"), source: g("source") });
    }
  } catch (e) {}
  return out;
}
async function webSearch(q) {
  const newsy = /ニュース|最新|今日|速報|news/i.test(q);
  const [a, b, n] = await Promise.all([ddg(q), bing(q), newsy ? gnews(q.replace(/\d{4}年\d{1,2}月\d{1,2}日/g, "").trim() || "日本") : Promise.resolve([])]);
  const web = (a.length ? a : b).slice(0, 6);
  const res = {};
  let news = n;
  if (newsy && !news.length) news = await yahooTop();
  if (news.length) res.news = news;
  if (web.length) res.web = web;
  if (!n.length && !web.length) {
    try {
      const r = await fetch(`https://ja.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(q)}`, { headers: { "user-agent": "ReoAI/1.0" } });
      const d = await r.json();
      res.wikipedia = (d.query?.search || []).map(s => ({ title: s.title, url: "https://ja.wikipedia.org/wiki/" + encodeURIComponent(s.title), snippet: htmlToText(s.snippet) }));
    } catch (e) {}
  }
  return Object.keys(res).length ? res : { note: "検索結果が取得できませんでした" };
}
async function fetchUrl(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8" }, redirect: "follow" });
    const ct = r.headers.get("content-type") || "";
    const t = await r.text();
    const text = ct.includes("html") ? htmlToText(t) : t;
    return { url, status: r.status, text: text.slice(0, 7000) };
  } catch (e) { return { url, error: String(e) }; }
}
function nowJST() {
  return new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full", timeStyle: "short" });
}

const BASE_TOOLS = [
  { name: "web_search", description: "Search the web for up-to-date information (news, facts, prices, docs). Returns titles, urls, snippets.", parameters: { type: "object", properties: { query: { type: "string", description: "search query" } }, required: ["query"] } },
  { name: "fetch_url", description: "Open a web page and read its text content.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "remember", description: "Save a durable fact about the user (preferences, name, projects, goals) to long-term memory. Use when the user shares something worth remembering or says 覚えて.", parameters: { type: "object", properties: { fact: { type: "string", description: "one short sentence in Japanese" } }, required: ["fact"] } },
];
const GOOGLE_TOOLS = [
  { name: "calendar_events", description: "List the user's Google Calendar events between two dates (all calendars).", parameters: { type: "object", properties: { start: { type: "string", description: "ISO date/time, e.g. 2026-10-18T00:00:00+09:00" }, end: { type: "string", description: "ISO date/time" }, query: { type: "string", description: "optional keyword filter" } }, required: ["start", "end"] } },
  { name: "calendar_create", description: "Create an event on the user's primary Google Calendar. Only when the user explicitly asks to add/schedule something.", parameters: { type: "object", properties: { title: { type: "string" }, start: { type: "string", description: "ISO date/time with +09:00" }, end: { type: "string", description: "ISO date/time with +09:00" }, location: { type: "string" }, description: { type: "string" } }, required: ["title", "start", "end"] } },
  { name: "gmail_search", description: "Search the user's Gmail with Gmail search syntax (e.g. 'is:unread newer_than:2d', 'from:amazon'). Returns sender, subject, date, snippet, id.", parameters: { type: "object", properties: { query: { type: "string" }, max: { type: "number", description: "max results, default 10" } }, required: ["query"] } },
  { name: "gmail_read", description: "Read the full body of one Gmail message by id (from gmail_search).", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "gmail_draft", description: "Create a Gmail DRAFT (never sends). Only when the user asks to write an email.", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } },
];

async function callGas(gas, action, args) {
  if (!gas?.url) return { error: "Google連携が未設定です" };
  try {
    const r = await fetch(gas.url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token: gas.token, action, ...args }), redirect: "follow" });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { error: "Apps Scriptの応答を読めません（デプロイ設定を確認）", status: r.status, body: t.slice(0, 300) }; }
  } catch (e) { return { error: String(e) }; }
}


// ---------------- Browser (Cloudflare Browser Run) ----------------
const BROWSER_TOOLS = [
  { name: "browser_open", description: "Open a URL in a real Chrome browser that you control. Returns the page text and a numbered list of clickable/typeable elements. Use for sites that need clicking, typing, searching or JavaScript (fetch_url is faster for simply reading a static page).", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_click", description: "Click element number [id] from the latest element list.", parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "browser_type", description: "Type text into input element number [id]. Set enter=true to press Enter afterwards (e.g. to submit a search).", parameters: { type: "object", properties: { id: { type: "number" }, text: { type: "string" }, enter: { type: "boolean" } }, required: ["id", "text"] } },
  { name: "browser_scroll", description: "Scroll the page down or up by one screen and get the newly visible elements.", parameters: { type: "object", properties: { direction: { type: "string", enum: ["down", "up"] } }, required: ["direction"] } },
  { name: "browser_back", description: "Go back to the previous page.", parameters: { type: "object", properties: {} } },
  { name: "browser_read", description: "Read the full text of the current page (longer than the summary).", parameters: { type: "object", properties: {} } },
];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getBrowser(ctx) {
  if (ctx.bw) return ctx.bw;
  if (!ctx.env.BROWSER) throw new Error("ブラウザ機能が有効になっていません");
  if (ctx.browserSession) { try { ctx.bw = await puppeteer.connect(ctx.env.BROWSER, ctx.browserSession); } catch (e) { ctx.bw = null; } }
  if (!ctx.bw) {
    try { ctx.bw = await puppeteer.launch(ctx.env.BROWSER, { keep_alive: 180000 }); }
    catch (e) { throw new Error(/limit|429|quota|time/i.test(String(e)) ? "今日のブラウザ無料枠（1日10分）を使い切ったか、同時起動の上限です。明日また使えます。" : "ブラウザを起動できません: " + String(e.message || e)); }
  }
  ctx.browserSession = ctx.bw.sessionId();
  ctx.emit?.({ type: "browser_session", id: ctx.browserSession });
  return ctx.bw;
}
async function getPage(ctx) {
  if (ctx.page) return ctx.page;
  const bw = await getBrowser(ctx);
  const pages = await bw.pages();
  ctx.page = pages.find(p => p.url() !== "about:blank") || pages[0] || await bw.newPage();
  await ctx.page.setViewport({ width: 1100, height: 760 });
  await ctx.page.setExtraHTTPHeaders({ "accept-language": "ja,en;q=0.8" }).catch(() => {});
  return ctx.page;
}
async function settle(page) {
  await sleep(600);
  try { await page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 }); } catch (e) {}
}
async function pageState(ctx, full = false) {
  const page = ctx.page;
  const info = await page.evaluate((full) => {
    document.querySelectorAll("[data-reo]").forEach(e => e.removeAttribute("data-reo"));
    const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],summary,[onclick]';
    const vh = innerHeight, out = []; let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < -50 || r.top > vh * 1.6) continue;
      const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none") continue;
      n++; el.setAttribute("data-reo", n);
      const tag = el.tagName.toLowerCase();
      let label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.querySelector?.("img")?.alt || "").replace(/\s+/g, " ").trim().slice(0, 70);
      let extra = tag === "input" ? ` type=${el.type}${el.placeholder ? ' placeholder="' + el.placeholder.slice(0, 40) + '"' : ""}` : "";
      if (tag === "a") { try { extra += " → " + new URL(el.href).pathname.slice(0, 50); } catch (e) {} }
      out.push(`[${n}] ${tag}${extra} "${label}"`);
      if (n >= 90) break;
    }
    const text = (document.body?.innerText || "").replace(/\n\s*\n+/g, "\n").slice(0, full ? 9000 : 2500);
    return { title: document.title, url: location.href, elements: out.join("\n"), text };
  }, full);
  try {
    const shot = await page.screenshot({ type: "jpeg", quality: 55, encoding: "base64" });
    ctx.emit?.({ type: "screenshot", data: "data:image/jpeg;base64," + shot, url: info.url });
    ctx.lastShot = shot;
  } catch (e) {}
  return info;
}
async function runBrowser(name, args, ctx) {
  try {
    const page = await getPage(ctx);
    if (name === "browser_open") {
      let u = String(args.url || "").trim(); if (!/^https?:\/\//.test(u)) u = "https://" + u;
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 25000 }); await settle(page);
    } else if (name === "browser_click") {
      const h = await page.$(`[data-reo="${Number(args.id)}"]`);
      if (!h) return { error: "その番号の要素が見つかりません。最新の一覧を確認してください", ...(await pageState(ctx)) };
      await h.evaluate(e => { e.scrollIntoView({ block: "center" }); if (e.tagName === "A" && e.target === "_blank") e.target = "_self"; });
      try { await h.click(); } catch (e) { await h.evaluate(e => e.click()); }
      await settle(page);
    } else if (name === "browser_type") {
      const h = await page.$(`[data-reo="${Number(args.id)}"]`);
      if (!h) return { error: "その番号の要素が見つかりません", ...(await pageState(ctx)) };
      await h.click({ clickCount: 3 }).catch(() => {});
      await h.evaluate(e => { if ("value" in e) e.value = ""; });
      await h.type(String(args.text || ""), { delay: 15 });
      if (args.enter) { await page.keyboard.press("Enter"); await settle(page); } else await sleep(300);
    } else if (name === "browser_scroll") {
      await page.evaluate(d => scrollBy(0, (d === "up" ? -1 : 1) * innerHeight * 0.85), args.direction); await sleep(500);
    } else if (name === "browser_back") {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); await settle(page);
    }
    return await pageState(ctx, name === "browser_read");
  } catch (e) { return { error: String(e.message || e) }; }
}

async function runTool(name, args, ctx) {
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
  args = args || {};
  if (name === "web_search") return await webSearch(args.query || args.q || "");
  if (name === "fetch_url") return await fetchUrl(args.url || "");
  if (name === "remember") { await ctx.brain.addMemory(args.fact || ""); return { saved: true }; }
  if (GOOGLE_TOOLS.some(t => t.name === name)) return await callGas(ctx.gas, name, args);
  if (name.startsWith("browser_")) return await runBrowser(name, args, ctx);
  return { error: "unknown tool" };
}

function systemPrompt(memories, mode, hasGoogle) {
  const mem = memories.length ? memories.map(m => "- " + m.text).join("\n") : "(まだありません)";
  return `あなたは「Reo AI」。ユーザーの日常生活とコーディングを手伝う、有能で温かいパーソナルAIです。
現在日時: ${nowJST()} (日本時間, UTC+09:00)
## ルール
- 日本語で、結論から簡潔に答える。必要なときだけ箇条書きや見出しを使う。
- 最新情報・事実確認・ニュース・価格・天気などは web_search を使い（ニュースは「ニュース」を含む短いクエリで、日付は入れない）、必要なら fetch_url でページを読む。出典URLを最後に添える。
- ユーザーの好み・名前・予定・取り組み中のことなど、今後も役立つ新しい情報を聞いたら remember で保存する（下の「覚えていること」に既にある内容は保存しない）。
- コードは必ず \`\`\`言語名 のコードブロックで、動く完全なコードを書く。HTML/JSは画面の「▶実行」ボタンでプレビューできる。
- 画像が添付されたら、よく観察して質問に答える。
- 本物のブラウザを操作できる（browser_open / browser_click / browser_type / browser_scroll / browser_back / browser_read）。ユーザーが「〜のサイトで…して」「開いて」「検索して操作して」など操作を頼んだときや、JavaScriptが必要なページで使う。結果の要素番号[n]で操作し、1手ずつ画面を確認する。画面はユーザーにもスクショで見えている。
- ブラウザで購入・支払い・予約確定・投稿・メッセージ送信・個人情報やパスワードの入力をする前には、必ず手を止めてユーザーに確認する。ログインが必要なら、その旨を伝えて止まる。無料枠は1日10分なので、無駄な操作はしない。
- 知らないことは推測で断定しない。
${hasGoogle ? "- Googleカレンダー/Gmailに接続済み。予定やメールの質問は calendar_events / gmail_search / gmail_read で確認してから答える。予定の追加や下書き作成は、ユーザーが頼んだときだけ行い、内容を報告する。メールの送信はできない（下書きのみ）。" : "- Googleカレンダー/Gmailは未接続。聞かれたら設定画面の「Google連携」で接続できると案内する。"}
${mode === "code" ? "- 今はコーディングモード。設計→実装→使い方の順で、実用的で正確なコードを優先する。" : ""}
## ユーザーについて覚えていること
${mem}`;
}

// strip <think> blocks from a streamed text
function makeThinkFilter() {
  let inT = false, buf = "";
  return (chunk) => {
    buf += chunk; let out = "";
    for (;;) {
      if (inT) { const i = buf.indexOf("</think>"); if (i < 0) { buf = buf.slice(-7); return out; } buf = buf.slice(i + 8); inT = false; continue; }
      const i = buf.indexOf("<think>");
      if (i >= 0) { out += buf.slice(0, i); buf = buf.slice(i + 7); inT = true; continue; }
      const j = buf.lastIndexOf("<");
      if (j >= 0 && buf.length - j < 7 && "<think>".startsWith(buf.slice(j))) { out += buf.slice(0, j); buf = buf.slice(j); }
      else { out += buf; buf = ""; }
      return out;
    }
  };
}

async function* sseLines(stream) {
  const rd = stream.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    const { value, done } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l.startsWith("data:")) yield l.slice(5).trim(); }
  }
  if (buf.trim().startsWith("data:")) yield buf.trim().slice(5).trim();
}

// one streamed Workers AI step: emits text deltas, returns {text, calls}
async function streamStep(env, model, input, emit) {
  const st = await env.AI.run(model, { ...input, stream: true });
  const filt = makeThinkFilter(); let text = ""; const tc = {}; let thinkingSent = false;
  for await (const data of sseLines(st)) {
    if (data === "[DONE]") break;
    let d; try { d = JSON.parse(data); } catch { continue; }
    const delta = d.choices?.[0]?.delta;
    let piece = "";
    if (delta) {
      if ((delta.reasoning || delta.reasoning_content) && !thinkingSent) { emit({ type: "thinking" }); thinkingSent = true; }
      if (typeof delta.content === "string") piece = delta.content;
      for (const t of delta.tool_calls || []) {
        const k = t.index ?? 0; tc[k] = tc[k] || { id: "", name: "", args: "" };
        if (t.id) tc[k].id = t.id; if (t.function?.name) tc[k].name = t.function.name; if (t.function?.arguments) tc[k].args += t.function.arguments;
      }
    } else {
      if (typeof d.response === "string") piece = d.response;
      for (const [k, t] of (d.tool_calls || []).entries()) if (t.name) tc[k] = { id: "", name: t.name, args: typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments || {}) };
    }
    if (piece) { const out = filt(piece); if (out) { text += out; if (text.trim()) emit({ type: "delta", text: out }); } }
  }
  const calls = Object.values(tc).filter(c => c.name).map((c, i) => { let a = {}; try { a = JSON.parse(c.args || "{}"); } catch {} return { id: c.id || ("call_" + Date.now() + "_" + i), name: c.name, args: a }; });
  return { text: text.trim(), calls };
}

function toOAIMessages(messages) {
  return messages.map((m, i) => {
    if (m.image && i === messages.length - 1 && m.role === "user")
      return { role: "user", content: [{ type: "text", text: m.content || "この画像について教えて" }, { type: "image_url", image_url: { url: m.image } }] };
    return { role: m.role, content: (m.hadImage ? "[画像を添付] " : "") + m.content };
  });
}

async function chatWorkersAI(env, ctx, messages, mode, emit) {
  const memories = await ctx.brain.listMemories();
  const hasImage = !!messages[messages.length - 1]?.image;
  const tools = [...BASE_TOOLS, ...BROWSER_TOOLS, ...(ctx.gas ? GOOGLE_TOOLS : [])].map(t => ({ type: "function", function: t }));
  const msgs = [{ role: "system", content: systemPrompt(memories, mode, !!ctx.gas) }, ...toOAIMessages(messages)];
  const model = hasImage ? MODEL_VISION : (mode === "code" ? MODEL_CODE : MODEL_CHAT);
  for (let step = 0; step < 14; step++) {
    const { text, calls } = await streamStep(env, model, { messages: msgs, tools, max_tokens: 4096 }, emit);
    if (!calls.length) return text;
    emit({ type: "reset" });
    msgs.push({ role: "assistant", content: text || "", tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
    for (const c of calls) {
      emit({ type: "tool", name: c.name, args: c.args });
      const res = await runTool(c.name, c.args, ctx);
      if (c.name.startsWith("browser_")) for (const m of msgs) if (m.role === "tool" && m.name?.startsWith("browser_") && m.content.length > 300) m.content = '{"note":"古い画面の情報は省略。最新の結果を使うこと"}';
      msgs.push({ role: "tool", tool_call_id: c.id, name: c.name, content: JSON.stringify(res).slice(0, 9000) });
    }
  }
  const { text } = await streamStep(env, model, { messages: [...msgs, { role: "user", content: "ここまでの情報で最終回答をしてください。" }], max_tokens: 4096 }, emit);
  return text;
}

async function chatGemini(key, ctx, messages, mode, emit) {
  const memories = await ctx.brain.listMemories();
  const contents = messages.map((m, i) => {
    const parts = [{ text: (m.hadImage && !m.image ? "[画像を添付] " : "") + (m.content || "この画像について教えて") }];
    if (m.image && i === messages.length - 1) { const mm = m.image.match(/^data:([^;]+);base64,(.*)$/); if (mm) parts.push({ inline_data: { mime_type: mm[1], data: mm[2] } }); }
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const body = { systemInstruction: { parts: [{ text: systemPrompt(memories, mode, !!ctx.gas) }] }, tools: [{ functionDeclarations: [...BASE_TOOLS, ...BROWSER_TOOLS, ...(ctx.gas ? GOOGLE_TOOLS : [])] }], contents };
  for (let step = 0; step < 14; step++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body),
    });
    if (!r.ok) { let m = r.status; try { m = (await r.json()).error?.message || m; } catch {} throw new Error("Gemini: " + m); }
    let text = ""; const allParts = []; const fcs = [];
    for await (const data of sseLines(r.body)) {
      let d; try { d = JSON.parse(data); } catch { continue; }
      for (const p of d.candidates?.[0]?.content?.parts || []) {
        allParts.push(p);
        if (p.functionCall) fcs.push(p.functionCall);
        else if (p.text && !p.thought) { text += p.text; emit({ type: "delta", text: p.text }); }
      }
    }
    if (!fcs.length) return text;
    emit({ type: "reset" });
    body.contents.push({ role: "model", parts: allParts });
    const resp = [];
    for (const fc of fcs) {
      emit({ type: "tool", name: fc.name, args: fc.args });
      const res = await runTool(fc.name, fc.args, ctx);
      resp.push({ functionResponse: { name: fc.name, response: { result: res } } });
    }
    body.contents.push({ role: "user", parts: resp });
  }
  return "（処理が長くなったため中断しました）";
}

// ---------------- router ----------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return new Response(ASSETS.html, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (p === "/manifest.json") return new Response(ASSETS.manifest, { headers: { "content-type": "application/manifest+json" } });
    if (p === "/icon.svg") return new Response(ASSETS.icon, { headers: { "content-type": "image/svg+xml", "cache-control": "public,max-age=86400" } });
    if (p === "/sw.js") return new Response(ASSETS.sw, { headers: { "content-type": "application/javascript" } });
    if (p === "/gas.js") return new Response(ASSETS.gas, { headers: { "content-type": "text/plain; charset=utf-8" } });

    if (!p.startsWith("/api/")) return new Response("Not found", { status: 404 });
    const pass = req.headers.get("x-pass") || "";
    if (env.APP_PASSCODE && pass !== env.APP_PASSCODE) return json({ error: "passcode" }, 401);
    const uid = (req.headers.get("x-uid") || "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
    const brain = new KVBrain(env.KV, uid);
    const gasUrl = req.headers.get("x-gas-url") || "";
    const gas = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(gasUrl) ? { url: gasUrl, token: req.headers.get("x-gas-token") || "" } : null;
    const ctx = { brain, gas, env, browserSession: (req.headers.get("x-browser-session") || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80) || null };

    if (p === "/api/ping") return json({ ok: true });
    if (p === "/api/browser/close" && req.method === "POST") { if (ctx.browserSession && env.BROWSER) { try { const b = await puppeteer.connect(env.BROWSER, ctx.browserSession); await b.close(); } catch (e) {} } return json({ ok: true }); }
    if (p === "/api/gastest") return json(await callGas(gas, "ping", {}));
    if (p === "/api/memories") {
      if (req.method === "GET") return json(await brain.listMemories());
      if (req.method === "POST") { const b = await req.json(); return json({ ok: await brain.addMemory(b.text) }); }
      if (req.method === "DELETE") return json({ ok: await brain.deleteMemory(Number(url.searchParams.get("id"))) });
    }
    if (p === "/api/chats") {
      if (req.method === "GET") { const id = url.searchParams.get("id"); return json(id ? await brain.getChat(id) : await brain.listChats()); }
      if (req.method === "POST") { const b = await req.json(); return json({ ok: await brain.saveChat(b.id, b.title, b.messages || []) }); }
      if (req.method === "DELETE") return json({ ok: await brain.deleteChat(url.searchParams.get("id")) });
    }
    if (p === "/api/chat" && req.method === "POST") {
      const b = await req.json();
      const raw = (b.messages || []).filter(m => m && (m.content || m.image)).slice(-20);
      const messages = raw.map((m, i) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 12000),
        image: i === raw.length - 1 && typeof m.image === "string" && m.image.startsWith("data:image/") && m.image.length < 6_000_000 ? m.image : null,
        hadImage: !!(m.image || m.thumb),
      }));
      const mode = b.mode === "code" ? "code" : "auto";
      const geminiKey = req.headers.get("x-gemini-key") || "";
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter(); const enc = new TextEncoder();
      const emit = (o) => w.write(enc.encode("data: " + JSON.stringify(o) + "\n\n")).catch(() => {});
      ctx.emit = emit;
      (async () => {
        try {
          const text = geminiKey ? await chatGemini(geminiKey, ctx, messages, mode, emit) : await chatWorkersAI(env, ctx, messages, mode, emit);
          emit({ type: "text", text: text || "（空の応答でした）", provider: geminiKey ? "Gemini" : "Workers AI" });
        } catch (e) { emit({ type: "error", message: String(e.message || e) }); }
        if (ctx.bw) { try { ctx.bw.disconnect(); } catch (e) {} }
        emit({ type: "done" }); w.close().catch(() => {});
      })();
      return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    return json({ error: "not found" }, 404);
  },
};
