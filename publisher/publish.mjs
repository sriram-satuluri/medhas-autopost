// MEDHAS autopost: publishes one grid day (right carousel, reel, left carousel) per calendar day to
// Instagram and Facebook, with captions and first comments. Runs from GitHub Actions every 15 minutes;
// almost every run exits at once because nothing is due.
//
// Rules, in order:
//   1. settings.paused stops everything.
//   2. A day that was started but not finished is finished first, whatever the time, so the grid row
//      is never left broken. Instagram goes right, reel, left; Facebook follows the same order.
//   3. Otherwise, once a day after settings.post_time (in settings.timezone), the next approved day in
//      queue order goes out. Held days are skipped. If the bot was down, it never posts two days at once.
//
// Usage: node publisher/publish.mjs [--now] [--dry-run]
//   --now      ignore the post time for today (manual "post now" from the Actions tab)
//   --dry-run  check the queue and every media URL, print the plan, publish nothing
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const queue = JSON.parse(readFileSync(new URL('queue.json', ROOT), 'utf8'));
const statusFile = new URL('status.json', ROOT);
const status = JSON.parse(readFileSync(statusFile, 'utf8'));
status.days ||= {};

const S = queue.settings;
const GRAPH = 'https://graph.facebook.com/v23.0';
const ORDER = ['right', 'reel', 'left'];
const MAX_ATTEMPTS = 8;
const NOW = process.argv.includes('--now');
const DRY = process.argv.includes('--dry-run');
const token = process.env.META_PAGE_TOKEN;

const save = () => writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (path) => new URL(path, S.media_base_url).href;
const day = (id) => (status.days[id] ||= { posts: {} });

function zoned(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: S.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}

const isDone = (d, pl) => d.posts.every((p) => status.days[d.id]?.posts?.[p.slot]?.[pl]?.id);
const settled = (d) => S.platforms.every((pl) => isDone(d, pl) || status.days[d.id]?.gave_up?.[pl]);

/* ---------------- Graph API ---------------- */

class GraphError extends Error {}

async function graph(path, { method = 'GET', body, headers, base = GRAPH } = {}) {
  const target = path.startsWith('http') ? path : `${base}/${path}`;
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(180000) };
  if (method === 'GET') {
    const sep = target.includes('?') ? '&' : '?';
    const res = await fetch(`${target}${sep}access_token=${token}`, init);
    return parse(res, path);
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify({ ...body, access_token: token });
  }
  return parse(await fetch(target, init), path);
}

async function parse(res, label) {
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok || body.error) {
    const e = body.error || {};
    throw new GraphError(`${label.split('?')[0]}: ${e.error_user_msg || e.message || body.raw?.slice(0, 200) || `HTTP ${res.status}`}`);
  }
  return body;
}

async function waitFor(check, label, timeoutMs = 15 * 60 * 1000, everyMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(everyMs);
  }
  throw new GraphError(`timed out waiting for ${label}`);
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

/* ---------------- Instagram ---------------- */

async function igContainer(params) {
  return (await graph(`${S.instagram_user_id}/media`, { method: 'POST', body: params })).id;
}

async function igReady(id, label) {
  await waitFor(async () => {
    const b = await graph(`${id}?fields=status_code,status`);
    if (b.status_code === 'ERROR' || b.status_code === 'EXPIRED') throw new GraphError(`Instagram could not process ${label}: ${b.status || b.status_code}`);
    return b.status_code === 'FINISHED' || b.status_code === 'PUBLISHED';
  }, `Instagram ${label}`);
}

// If a run died after Instagram published but before status.json was saved, adopt that post
// instead of posting it twice.
async function igExisting(caption) {
  const b = await graph(`${S.instagram_user_id}/media?fields=id,caption,permalink,timestamp&limit=12`);
  const want = norm(caption);
  const hit = (b.data || []).find((m) => norm(m.caption) === want && Date.now() - Date.parse(m.timestamp) < 72 * 3600e3);
  return hit && { id: hit.id, permalink: hit.permalink, adopted: true };
}

async function publishInstagram(p) {
  const existing = await igExisting(p.caption);
  if (existing) return existing;
  let creation;
  if (p.type === 'carousel') {
    const children = [];
    for (const [i, path] of p.media.entries()) {
      const params = { image_url: url(path), is_carousel_item: true };
      const alt = p.alt?.[i];
      try {
        children.push(await igContainer(alt ? { ...params, alt_text: alt } : params));
      } catch (e) {
        if (!alt || !/alt/i.test(e.message)) throw e;
        children.push(await igContainer(params)); // alt text refused: post without it rather than not at all
      }
    }
    for (const c of children) await igReady(c, 'a carousel slide');
    creation = await igContainer({ media_type: 'CAROUSEL', children: children.join(','), caption: p.caption });
  } else if (p.type === 'reel') {
    creation = await igContainer({
      media_type: 'REELS', video_url: url(p.media[0]), caption: p.caption, share_to_feed: true,
      ...(p.cover ? { cover_url: url(p.cover) } : {}),
    });
  } else {
    throw new GraphError(`unknown post type ${p.type}`);
  }
  await igReady(creation, p.type);
  const { id } = await graph(`${S.instagram_user_id}/media_publish`, { method: 'POST', body: { creation_id: creation } });
  const { permalink } = await graph(`${id}?fields=permalink`);
  const out = { id, permalink };
  if (p.first_comment) {
    try { out.comment = (await graph(`${id}/comments`, { method: 'POST', body: { message: p.first_comment } })).id; }
    catch (e) { out.comment_error = e.message; log('  first comment failed:', e.message); }
  }
  return out;
}

/* ---------------- Facebook ---------------- */

async function fbExisting(p) {
  const want = norm(p.caption_fb || p.caption);
  const edge = p.type === 'reel' ? 'videos?fields=id,description,created_time,permalink_url' : 'posts?fields=id,message,created_time,permalink_url';
  const b = await graph(`${S.facebook_page_id}/${edge}&limit=12`);
  const hit = (b.data || []).find((m) => norm(m.message ?? m.description) === want && Date.now() - Date.parse(m.created_time) < 72 * 3600e3);
  return hit && { id: hit.id, permalink: hit.permalink_url?.startsWith('http') ? hit.permalink_url : `https://www.facebook.com${hit.permalink_url || `/${hit.id}`}`, adopted: true };
}

async function fbComment(objectId, out, message) {
  if (!message) return;
  try { out.comment = (await graph(`${objectId}/comments`, { method: 'POST', body: { message } })).id; }
  catch (e) { out.comment_error = e.message; log('  first comment failed:', e.message); }
}

async function publishFacebook(p) {
  const existing = await fbExisting(p);
  if (existing) return existing;
  const caption = p.caption_fb || p.caption;
  const page = S.facebook_page_id;
  if (p.type === 'carousel') {
    const ids = [];
    for (const [i, path] of p.media.entries()) {
      const photo = await graph(`${page}/photos`, {
        method: 'POST', body: { url: url(path), published: false, ...(p.alt?.[i] ? { alt_text_custom: p.alt[i] } : {}) },
      });
      ids.push(photo.id);
    }
    const post = await graph(`${page}/feed`, { method: 'POST', body: { message: caption, attached_media: ids.map((media_fbid) => ({ media_fbid })) } });
    const { permalink_url } = await graph(`${post.id}?fields=permalink_url`).catch(() => ({}));
    const out = { id: post.id, permalink: permalink_url || `https://www.facebook.com/${post.id}` };
    await fbComment(post.id, out, p.first_comment);
    return out;
  }
  if (p.type === 'reel') {
    const start = await graph(`${page}/video_reels`, { method: 'POST', body: { upload_phase: 'start' } });
    await parse(await fetch(start.upload_url || `https://rupload.facebook.com/video-upload/v23.0/${start.video_id}`, {
      method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: url(p.media[0]) }, signal: AbortSignal.timeout(600000),
    }), 'Facebook reel upload');
    await graph(`${page}/video_reels`, {
      method: 'POST', body: { upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: caption },
    });
    const out = { id: start.video_id, permalink: `https://www.facebook.com/reel/${start.video_id}` };
    try {
      await waitFor(async () => {
        const v = await graph(`${start.video_id}?fields=status`);
        if (v.status?.video_status === 'error') throw new GraphError(`Facebook could not process the reel: ${JSON.stringify(v.status)}`);
        return v.status?.video_status === 'ready' && v.status?.publishing_phase?.status !== 'in_progress';
      }, 'Facebook reel processing', 10 * 60 * 1000, 10000);
    } catch (e) {
      out.processing_note = e.message; // the reel is uploaded and set to publish; Facebook finishes it on its side
    }
    await fbComment(start.video_id, out, p.first_comment);
    return out;
  }
  throw new GraphError(`unknown post type ${p.type}`);
}

const PUBLISH = { instagram: publishInstagram, facebook: publishFacebook };

/* ---------------- Plan ---------------- */

function pickDay(today) {
  const started = queue.days.find((d) => status.days[d.id]?.started && !settled(d));
  if (started) return { d: started, why: 'finishing a day already started' };
  if (today.date < S.start_date) return { why: `queue starts ${S.start_date}` };
  if ((S.skip_dates || []).includes(today.date)) return { why: `${today.date} is a skip date` };
  const usedToday = Object.entries(status.days).find(([, s]) => s.date === today.date);
  if (usedToday) return { why: `today's slot already went to ${usedToday[0]}` };
  const [h, m] = S.post_time.split(':').map(Number);
  if (!NOW && today.minutes < h * 60 + m) return { why: `post time is ${S.post_time} ${S.timezone}` };
  const next = queue.days.find((d) => d.approved && !status.days[d.id]?.started);
  return next ? { d: next, why: 'next approved day' } : { why: 'queue is empty: every approved day has gone out' };
}

async function checkToken() {
  const today = zoned().date;
  if (status.token?.checked === today) return;
  const b = await graph(`debug_token?input_token=${token}`);
  const t = b.data || {};
  status.token = {
    checked: today, valid: !!t.is_valid, type: t.type,
    expires: t.expires_at ? new Date(t.expires_at * 1000).toISOString() : 'never',
    data_access_expires: t.data_access_expires_at ? new Date(t.data_access_expires_at * 1000).toISOString() : null,
  };
  save();
  if (!t.is_valid) throw new GraphError(`the Meta token is no longer valid: ${t.error?.message || 'reconnect it'}`);
}

/* ---------------- Dry run ---------------- */

async function dryRun() {
  const problems = [];
  const seen = new Set();
  for (const d of queue.days) {
    if (seen.has(d.id)) problems.push(`${d.id}: duplicate id`);
    seen.add(d.id);
    const slots = d.posts.map((p) => p.slot).join(',');
    if (slots !== ORDER.join(',')) problems.push(`${d.id}: posts must be ${ORDER.join(', ')}, found ${slots}`);
    for (const p of d.posts) {
      if ((p.caption || '').length > 2200) problems.push(`${d.id}/${p.slot}: caption over 2,200 characters`);
      const tags = `${p.caption} ${p.first_comment || ''}`.match(/#\w+/g) || [];
      if (tags.length > 30) problems.push(`${d.id}/${p.slot}: ${tags.length} hashtags, Instagram allows 30`);
      if (p.type === 'carousel' && (p.media.length < 2 || p.media.length > 10)) problems.push(`${d.id}/${p.slot}: carousel needs 2 to 10 slides`);
      for (const path of [...p.media, ...(p.cover ? [p.cover] : [])]) {
        const res = await fetch(url(path), { method: 'HEAD' }).catch((e) => ({ ok: false, status: e.message }));
        if (!res.ok) problems.push(`${d.id}/${p.slot}: ${url(path)} -> ${res.status}`);
      }
    }
  }
  const today = zoned();
  const { d, why } = pickDay(today);
  log(`today ${today.date}, ${why}${d ? `: would post ${d.id}` : ''}`);
  log(problems.length ? `PROBLEMS:\n  ${problems.join('\n  ')}` : `queue OK: ${queue.days.length} days, every media URL answers`);
  if (problems.length) process.exitCode = 1;
}

/* ---------------- Main ---------------- */

async function main() {
  if (DRY) return dryRun();
  if (S.paused) return log('paused in queue.json settings, nothing to do');
  if (!token) throw new Error('META_PAGE_TOKEN is not set (GitHub repository secret)');
  await checkToken();

  const today = zoned();
  const { d, why } = pickDay(today);
  if (!d) return log(`nothing due: ${why}`);
  log(`posting ${d.id} (${d.title}): ${why}`);

  const s = day(d.id);
  if (!s.started) Object.assign(s, { started: new Date().toISOString(), date: today.date });
  s.attempts ||= {};
  s.errors ||= {};
  save();

  let failed = false;
  for (const pl of S.platforms) {
    if (s.gave_up?.[pl]) continue;
    for (const slot of ORDER) {
      const p = d.posts.find((x) => x.slot === slot);
      if (s.posts[slot]?.[pl]?.id) continue;
      try {
        log(`  ${pl} ${slot} ${p.type}…`);
        const result = await PUBLISH[pl](p);
        (s.posts[slot] ||= {})[pl] = { ...result, at: new Date().toISOString() };
        delete s.errors[pl];
        save();
        log(`  ${pl} ${slot} done ${result.permalink || result.id}${result.adopted ? ' (found already posted)' : ''}`);
      } catch (e) {
        failed = true;
        s.attempts[pl] = (s.attempts[pl] || 0) + 1;
        s.errors[pl] = `${slot}: ${e.message}`;
        if (s.attempts[pl] >= MAX_ATTEMPTS) (s.gave_up ||= {})[pl] = new Date().toISOString();
        save();
        log(`  ${pl} ${slot} FAILED (attempt ${s.attempts[pl]}/${MAX_ATTEMPTS}): ${e.message}`);
        break; // keep the grid order: never post the next slot on this platform before this one
      }
    }
  }
  if (settled(d)) { s.finished = new Date().toISOString(); save(); log(`${d.id} complete`); }
  if (failed) process.exitCode = 1; // a red run, so GitHub emails the owner; the next run retries
}

main().catch((e) => { log('ERROR', e.message); process.exitCode = 1; });
