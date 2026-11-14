// Facebook browser automation. Drives a real Chrome window with your own login.
// Shares a Facebook post link into every group: it opens the group's post box,
// pastes your message + the link, waits for Facebook's link preview, and posts.
// Facebook changes its page often — if a step fails, the label patterns below
// are the first thing to adjust. They assume Facebook's language is English.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, 'chrome-profile');

const L = {
  composer: /write something|create a public post|create post/i,
  discussion: /start (a )?discussion/i,
  sell: /sell something/i,
  postBtn: /^post$/i,
  commentBox: /write a (public )?comment|comment as/i,
  commentBtn: /^(leave a )?comment$/i,
  commentMenu: /edit or delete|more options|actions for this comment/i,
  deleteItem: /^delete$/i,
};

// Pauses between groups so it looks like a person, not a bot.
const DELAY = { share: [2, 4], bump: [2, 4] }; // seconds

let context = null;
let stopRequested = false;

export function requestStop() { stopRequested = true; }

async function getContext() {
  if (context) return context;
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome', // use your installed Google Chrome
    viewport: null,
    args: ['--start-maximized'],
  });
  context.on('close', () => { context = null; });
  return context;
}

async function getPage() {
  const ctx = await getContext();
  return ctx.pages()[0] || ctx.newPage();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pause([min, max], log) {
  const s = Math.round(min + Math.random() * (max - min));
  log(`  waiting ${s}s before next group…`);
  for (let i = 0; i < s && !stopRequested; i++) await sleep(1000);
}

function cleanGroupUrl(url) {
  const u = new URL(url.trim());
  const m = u.pathname.match(/\/groups\/([^/]+)/);
  if (!m) throw new Error(`not a group link: ${url}`);
  return `https://www.facebook.com/groups/${m[1]}`;
}

export async function openLogin(log) {
  const page = await getPage();
  await page.goto('https://www.facebook.com/');
  log('Chrome is open — log in to Facebook there. You only need to do this once.');
}

async function myUserId(log) {
  const cookies = await (await getContext()).cookies('https://www.facebook.com');
  const c = cookies.find((x) => x.name === 'c_user');
  if (!c) { log('❌ Not logged in. Click "Log in to Facebook" first.'); return null; }
  return c.value;
}

class SkipGroup extends Error {}

// ---------- Shared history: remembers which item went to which group ----------
const SHARED_FILE = path.join(ROOT, 'shared.json');
const key = (groupUrl, itemId) => `${groupUrl}|${itemId}`;
export function loadShared() {
  try { return JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8')); } catch { return {}; }
}
function markShared(groupUrl, itemId) {
  const h = loadShared();
  h[key(groupUrl, itemId)] = new Date().toISOString();
  fs.writeFileSync(SHARED_FILE, JSON.stringify(h, null, 2) + '\n');
}
export function clearShared() { fs.writeFileSync(SHARED_FILE, '{}\n'); }

// Opens the post box. Normal groups show "Write something…"; buy/sell groups
// show "Sell something" + "Start discussion" instead — there we use
// "Start discussion", which takes text + links like a normal post.
async function openComposer(page, log) {
  const find = (re) => page.getByRole('button', { name: re }).or(page.getByText(re)).first();
  const composer = find(L.composer);
  const discussion = find(L.discussion);
  const sell = find(L.sell);
  const postDialog = page.getByRole('dialog').filter({ has: page.getByRole('textbox') }).last();

  await composer.or(discussion).or(sell).first().waitFor({ timeout: 20000 }).catch(() => {
    throw new Error('could not find a post box in this group (are you a member?)');
  });

  if (await composer.isVisible()) return composer.click();

  if (await discussion.isVisible()) {
    log('  buy/sell group → using "Start discussion"');
    await discussion.click();
    await postDialog.or(composer).first().waitFor({ timeout: 10000 }).catch(() => {});
    if (!(await postDialog.isVisible()) && (await composer.isVisible())) await composer.click();
    return;
  }

  throw new SkipGroup('this group only allows "Sell something" listings, no discussion posts — skipped');
}

// Opens every group in the history as a tab, on the page listing *your* posts there.
export async function openSharedGroups(log) {
  const groups = [...new Set(Object.keys(loadShared()).map((k) => k.split('|')[0]))];
  if (!groups.length) { log('No shared groups yet.'); return; }
  const uid = await myUserId(log);
  if (!uid) return;
  const ctx = await getContext();
  log(`Opening ${groups.length} shared group(s) in Chrome…`);
  for (const g of groups) {
    const page = await ctx.newPage();
    await page.goto(`${g}/user/${uid}/`, { waitUntil: 'commit' }).catch(() => {});
    await sleep(800);
  }
  log(`Opened ${groups.length} tab(s).`);
}

// ---------- Share to every group ----------
export async function shareToGroups(groups, items, log) {
  stopRequested = false;
  if (!(await myUserId(log))) return;
  const page = await getPage();
  let ok = 0, fail = 0, skipped = 0, already = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    if (stopRequested) { log('⏹ Stopped.'); break; }
    let url;
    try { url = cleanGroupUrl(groups[gi]); } catch (e) { log(`❌ ${e.message}`); fail++; continue; }
    let skipThisGroup = false;

    const history = loadShared();
    const todo = items.filter((it) => !history[key(url, it.id)]);
    if (!todo.length) {
      log(`[${gi + 1}/${groups.length}] ${url} — ⏭ already shared here, skipping`);
      already++;
      continue;
    }

    for (const item of todo) {
      if (stopRequested) break;
      log(`[${gi + 1}/${groups.length}] ${url} — sharing "${item.title}"`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await openComposer(page, log);

        const dialog = page.getByRole('dialog').filter({ has: page.getByRole('textbox') }).last();
        const box = dialog.getByRole('textbox').first();
        await box.click({ timeout: 15000 });
        if (item.text.trim()) {
          await page.keyboard.insertText(item.text.trim());
          await page.keyboard.press('Enter');
          await page.keyboard.press('Enter');
        }
        // Typing the link (not pasting) plus a trailing space makes Facebook build the preview card.
        await page.keyboard.type(item.link);
        await page.keyboard.type(' ');
        // Move on the moment the preview card shows up (max 4s if it never does).
        await dialog.getByRole('button', { name: /remove (link )?preview|close link preview/i })
          .or(dialog.locator('a[href*="facebook.com"] img, a[role="link"] img'))
          .first().waitFor({ timeout: 4000 }).catch(() => {});

        const postBtn = dialog.getByRole('button', { name: L.postBtn }).last();
        await postBtn.waitFor({ timeout: 15000 });
        for (let i = 0; i < 300 && (await postBtn.getAttribute('aria-disabled')) === 'true'; i++) await sleep(200);
        await postBtn.click();
        await dialog.waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
        log('  ✅ shared (if the group needs admin approval it will show as pending)');
        markShared(url, item.id);
        ok++;
      } catch (e) {
        if (e instanceof SkipGroup) { log(`  ⏭ ${e.message}`); skipped++; skipThisGroup = true; break; }
        log(`  ❌ failed: ${e.message.split('\n')[0]}`);
        fail++;
      }
      if (todo.length > 1) await sleep(500);
    }
    if (gi < groups.length - 1 && !skipThisGroup) await pause(DELAY.share, log);
  }
  log(`Done. ${ok} shared, ${fail} failed, ${already} already shared, ${skipped} skipped (sell-only groups).`);
}

// ---------- Joined groups: scrape the "Your groups" page ----------
const NOT_GROUPS = new Set(['joins', 'feed', 'discover', 'create', 'notifications', 'search', 'browse', 'you', 'category']);
export async function listJoinedGroups(log) {
  if (!(await myUserId(log))) return [];
  const page = await getPage();
  log('Loading your joined groups…');
  await page.goto('https://www.facebook.com/groups/joins/?nav_source=tab', { waitUntil: 'domcontentloaded' });
  await page.locator('a[href*="/groups/"]').first().waitFor({ timeout: 15000 }).catch(() => {});
  const found = new Set();
  let still = 0;
  // Keep scrolling until no new groups show up a few times in a row.
  while (still < 3 && !stopRequested) {
    const hrefs = await page.$$eval('a[href*="/groups/"]', (as) => as.map((a) => a.href));
    const before = found.size;
    for (const h of hrefs) {
      const m = h.match(/facebook\.com\/groups\/([^/?#]+)/);
      if (m && !NOT_GROUPS.has(m[1].toLowerCase())) found.add(`https://www.facebook.com/groups/${m[1]}`);
    }
    still = found.size === before ? still + 1 : 0;
    await page.mouse.wheel(0, 8000);
    await sleep(700);
  }
  log(`Found ${found.size} joined group(s).`);
  return [...found];
}

// ---------- Leave: exit each group in the list ----------
// Runs several Chrome tabs at once, each leaving groups back-to-back with no pauses.
const LEAVE_TABS = 3;
export async function leaveGroups(groups, log) {
  stopRequested = false;
  if (!(await myUserId(log))) return;
  const ctx = await getContext();
  const queue = groups.map((g, i) => ({ g, n: i + 1 }));
  let ok = 0, fail = 0;

  async function leaveOne(page, url, n) {
    log(`[${n}/${groups.length}] ${url} — leaving`);
    await page.goto(url, { waitUntil: 'commit' });
    const joined = page.getByRole('button', { name: /^joined$/i }).first();
    await joined.waitFor({ timeout: 20000 }).catch(() => { throw new Error('no "Joined" button (already left, or not a member?)'); });
    await joined.click();
    await page.getByRole('menuitem', { name: /leave group/i }).first().click({ timeout: 10000 });
    await page.getByRole('dialog').getByRole('button', { name: /^leave group$/i }).last().click({ timeout: 10000 });
    await page.getByRole('dialog').filter({ hasText: /leave group/i }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  }

  async function worker() {
    const page = await ctx.newPage();
    try {
      while (queue.length && !stopRequested) {
        const { g, n } = queue.shift();
        let url;
        try { url = cleanGroupUrl(g); } catch (e) { log(`❌ ${e.message}`); fail++; continue; }
        try { await leaveOne(page, url, n); log(`  👋 left ${url}`); ok++; }
        catch (e) { log(`  ❌ ${url} failed: ${e.message.split('\n')[0]}`); fail++; }
      }
    } finally { await page.close().catch(() => {}); }
  }

  log(`Leaving ${groups.length} group(s) using ${Math.min(LEAVE_TABS, groups.length)} tabs at once…`);
  await Promise.all(Array.from({ length: Math.min(LEAVE_TABS, groups.length) }, worker));
  if (stopRequested) log('⏹ Stopped.');
  log(`Done. Left ${ok} group(s), ${fail} failed.`);
}

// ---------- Bump: comment "." on my latest post in each group, then delete it ----------
export async function bumpPosts(groups, log) {
  stopRequested = false;
  const uid = await myUserId(log);
  if (!uid) return;
  const page = await getPage();
  let ok = 0, fail = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    if (stopRequested) { log('⏹ Stopped.'); break; }
    let url;
    try { url = cleanGroupUrl(groups[gi]); } catch (e) { log(`❌ ${e.message}`); fail++; continue; }
    log(`[${gi + 1}/${groups.length}] ${url} — bumping my latest post`);

    try {
      await page.goto(`${url}/user/${uid}/`, { waitUntil: 'domcontentloaded' });
      const post = page.getByRole('article').first();
      await post.waitFor({ timeout: 20000 });
      await post.scrollIntoViewIfNeeded();

      let box = post.getByRole('textbox', { name: L.commentBox }).first();
      if (!(await box.isVisible().catch(() => false))) {
        await post.getByRole('button', { name: L.commentBtn }).first().click({ timeout: 10000 });
        box = page.getByRole('textbox', { name: L.commentBox }).first();
      }
      await box.click({ timeout: 10000 });
      await page.keyboard.type('.');
      await page.keyboard.press('Enter');
      log('  💬 commented "."');
      await sleep(2000);

      const comment = page.getByRole('article')
        .filter({ has: page.locator('div[dir="auto"]', { hasText: /^\.$/ }) })
        .last();
      await comment.hover({ timeout: 10000 });
      await comment.getByRole('button', { name: L.commentMenu }).first().click({ timeout: 10000 });
      await page.getByRole('menuitem', { name: L.deleteItem }).first().click({ timeout: 10000 });
      await page.getByRole('dialog').getByRole('button', { name: L.deleteItem }).last().click({ timeout: 10000 });
      log('  🗑 deleted the comment — ✅ bumped');
      ok++;
    } catch (e) {
      log(`  ❌ failed: ${e.message.split('\n')[0]}`);
      fail++;
    }
    if (gi < groups.length - 1) await pause(DELAY.bump, log);
  }
  log(`Done. ${ok} bumped, ${fail} failed.`);
}
