import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { openLogin, shareToGroups, bumpPosts, requestStop, loadShared, clearShared, openSharedGroups, listJoinedGroups, leaveGroups } from './fb.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3778; // Auto Post uses 3777, so both can run at once
const GROUPS_FILE = path.join(ROOT, 'groups.txt');
const SHARES_FILE = path.join(ROOT, 'shares.json');

const readGroups = () =>
  fs.readFileSync(GROUPS_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const readShares = () => JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8'));

// Live log streamed to the page.
const clients = new Set();
const history = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  console.log(line);
  history.push(line);
  if (history.length > 500) history.shift();
  for (const res of clients) res.write(`data: ${JSON.stringify(line)}\n\n`);
}

let busy = false;
async function runJob(name, fn) {
  if (busy) { log('⚠️ Already running — wait for it to finish or press Stop.'); return; }
  busy = true;
  try { await fn(); } catch (e) { log(`❌ ${name} error: ${e.message}`); } finally { busy = false; }
}

const body = (req) => new Promise((resolve) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d ? JSON.parse(d) : {}));
});
const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const isFbLink = (s) => { try { return /(^|\.)facebook\.com$|(^|\.)fb\.watch$/.test(new URL(s).hostname); } catch { return false; } };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
    }
    if (req.method === 'POST' && url.pathname === '/api/shares') {
      const { shares } = await body(req);
      const clean = shares.map((s, i) => ({
        id: String(s.id || `item${Date.now()}${i}`),
        title: String(s.title || 'Untitled'),
        link: String(s.link || '').trim(),
        text: String(s.text || ''),
      }));
      fs.writeFileSync(SHARES_FILE, JSON.stringify(clean, null, 2) + '\n');
      log(`Saved ${clean.length} post link(s).`);
      return json(res, { ok: true, shares: clean });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, { groups: readGroups(), shares: readShares(), shared: loadShared(), busy });
    }
    if (req.method === 'GET' && url.pathname === '/api/log') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      history.forEach((l) => res.write(`data: ${JSON.stringify(l)}\n\n`));
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/groups') {
      const { groups } = await body(req);
      fs.writeFileSync(GROUPS_FILE, groups.join('\n') + '\n');
      log(`Saved ${groups.length} group(s).`);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      runJob('login', () => openLogin(log));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/share') {
      const { shareIds } = await body(req);
      const items = readShares().filter((s) => shareIds.includes(s.id));
      const bad = items.find((s) => !isFbLink(s.link));
      if (bad) { log(`⚠️ "${bad.title}" needs a Facebook post link (https://www.facebook.com/...).`); return json(res, { ok: false }); }
      const groups = readGroups();
      if (!groups.length || !items.length) { log('⚠️ Add groups and pick at least one post first.'); return json(res, { ok: false }); }
      runJob('share', () => shareToGroups(groups, items, log));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/bump') {
      const groups = readGroups();
      if (!groups.length) { log('⚠️ Add groups first.'); return json(res, { ok: false }); }
      runJob('bump', () => bumpPosts(groups, log));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/shared/open') {
      openSharedGroups(log).catch((e) => log(`❌ ${e.message}`));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/shared/clear') {
      if (busy) { log('⚠️ Wait for the current run to finish before clearing history.'); return json(res, { ok: false }); }
      clearShared(); log('Shared history cleared — every group will get the share again.');
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/joined') {
      if (busy) { log('⚠️ Already running — wait for it to finish or press Stop.'); return json(res, { ok: false, groups: [] }); }
      busy = true;
      try { return json(res, { ok: true, groups: await listJoinedGroups(log) }); }
      catch (e) { log(`❌ ${e.message}`); return json(res, { ok: false, groups: [] }); }
      finally { busy = false; }
    }
    if (req.method === 'POST' && url.pathname === '/api/leave') {
      const { groups, confirm } = await body(req);
      if (confirm !== 'LEAVE' || !Array.isArray(groups) || !groups.length) { log('⚠️ Nothing to leave.'); return json(res, { ok: false }); }
      runJob('leave', () => leaveGroups(groups, log));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      requestStop(); log('Stopping after the current step…');
      return json(res, { ok: true });
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end(e.message);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Auto Share running → http://localhost:${PORT}`);
  if (!process.env.NO_OPEN) exec(`open http://localhost:${PORT}`);
});
