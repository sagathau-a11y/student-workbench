/* 学员管理工作台 — Web Push 后端
 * 托管前端静态文件，并作为系统推送（关屏/被杀也能到）的调度器。
 * 数据本地优先：后端只接收「事件时间 + 标题」，到点的那一刻通过 Web Push 发给系统。
 */
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:push@example.com';
const DB_FILE = path.join(__dirname, 'db.json');
const VAPID_FILE = path.join(__dirname, 'vapid.json');

// ---------- VAPID 密钥（首次启动生成并持久化） ----------
function loadVapid() {
  if (fs.existsSync(VAPID_FILE)) return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.log('[vapid] 已生成并保存到', VAPID_FILE);
  return keys;
}
const VAPID = loadVapid();
webpush.setVapidDetails(VAPID_SUBJECT, VAPID.publicKey, VAPID.privateKey);

// ---------- 持久化存储 ----------
let db = { devices: {} };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const pushed = new Set(); // 已推送的事件 id（重启后从 db 恢复）

function persist() {
  // 只持久化设备订阅与事件，不持久化 pushed（运行期去重即可，过期自动清理）
  fs.writeFile(DB_FILE, JSON.stringify(db), () => {});
}
function restorePushed() {
  Object.values(db.devices).forEach(d => (d.events || []).forEach(e => {
    if (e.pushed) pushed.add(e.id);
  }));
}
restorePushed();

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// 仅托管前端静态文件，避免泄露 server.js / db.json / node_modules
const PUBLIC = ['index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
PUBLIC.slice(1).forEach(f => app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f))));
app.get('/api/vapid', (req, res) => res.json({ publicKey: VAPID.publicKey }));
app.get('/api/health', (req, res) => res.json({ ok: true, devices: Object.keys(db.devices).length }));

app.post('/api/subscribe', (req, res) => {
  const { deviceId, subscription } = req.body || {};
  if (!deviceId || !subscription || !subscription.endpoint) return res.status(400).json({ error: 'bad' });
  db.devices[deviceId] = db.devices[deviceId] || { subscriptions: [], events: [] };
  const subs = db.devices[deviceId].subscriptions;
  if (!subs.find(s => s.endpoint === subscription.endpoint)) subs.push(subscription);
  persist();
  res.json({ ok: true });
});

app.post('/api/schedule', (req, res) => {
  const { deviceId, events } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'bad' });
  db.devices[deviceId] = db.devices[deviceId] || { subscriptions: [], events: [] };
  // 用客户端发来的事件表整体替换；保留已推送标记
  const prev = new Map((db.devices[deviceId].events || []).map(e => [e.id, e]));
  db.devices[deviceId].events = (events || []).map(e => ({
    id: e.id, fireAt: e.fireAt, dueAt: e.dueAt, title: e.title, body: e.body,
    pushed: prev.get(e.id)?.pushed || pushed.has(e.id) || false,
  }));
  persist();
  res.json({ ok: true, count: db.devices[deviceId].events.length });
});

app.post('/api/unsubscribe', (req, res) => {
  const { deviceId, endpoint } = req.body || {};
  const dev = db.devices[deviceId];
  if (dev) {
    if (endpoint) dev.subscriptions = dev.subscriptions.filter(s => s.endpoint !== endpoint);
    else dev.subscriptions = [];
    if (!dev.subscriptions.length && !dev.events.length) delete db.devices[deviceId];
  }
  persist();
  res.json({ ok: true });
});

// ---------- 调度器：到点强推 ----------
const GRACE = 60 * 1000; // 事件结束后 1 分钟内仍可补推一次
async function dispatch() {
  const now = Date.now();
  for (const [deviceId, dev] of Object.entries(db.devices)) {
    const due = (dev.events || []).filter(e => !e.pushed && now >= e.fireAt && now <= e.dueAt + GRACE);
    if (!due.length) continue;
    for (const ev of due) {
      const payload = JSON.stringify({ title: ev.title, body: ev.body || '', tag: ev.id });
      let delivered = false;
      for (const sub of dev.subscriptions) {
        try {
          await webpush.sendNotification(sub, payload, { TTL: 120 });
          delivered = true;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            dev.subscriptions = dev.subscriptions.filter(s => s.endpoint !== sub.endpoint);
            console.log('[push] 移除失效订阅', sub.endpoint.slice(0, 40));
          } else {
            console.warn('[push] 发送失败', err.statusCode || err.message);
          }
        }
      }
      if (delivered) { ev.pushed = true; pushed.add(ev.id); }
    }
    persist();
  }
  // 清理过期事件与 pushed 标记
  for (const dev of Object.values(db.devices)) {
    dev.events = (dev.events || []).filter(e => now <= e.dueAt + GRACE);
  }
  if (pushed.size > 5000) { /* 粗略裁剪 */ }
}
setInterval(dispatch, 15000);
dispatch();

app.listen(PORT, "0.0.0.0", () => console.log(`[server] 监听 0.0.0.0:${PORT}  (Web Push 已就绪)`));
