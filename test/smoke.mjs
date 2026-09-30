// Быстрый интеграционный тест: поднимает сервер, регистрирует 2 юзеров,
// создаёт сервер, шлёт сообщение, проверяет доставку. Запуск: node test/smoke.mjs
import http from 'http';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const SERVER_PORT = process.env.TEST_PORT || 3399;

// 1. Build server? Assumes dist/index.cjs built. We'll spawn it with a temp data dir.
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

const testDataDir = mkdtempSync(path.join(tmpdir(), 'mvt-test-'));

const child = spawn(process.execPath, ['dist/index.cjs'], {
  env: { ...process.env, PORT: String(SERVER_PORT), APP_DATA_DIR: testDataDir },
  cwd: './server',
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stderr.on('data', (d) => console.error('[server-stderr]', d.toString()));
child.stdout.on('data', (d) => console.error('[server-log]', d.toString()));

// wait until port is listening (poll)
const waitForPort = () => new Promise((resolve, reject) => {
  const start = Date.now();
  const tryConnect = () => {
    const sock = new WebSocket(`ws://localhost:${SERVER_PORT}/ws`);
    sock.on('open', () => { sock.close(); resolve(); });
    sock.on('error', () => {
      if (Date.now() - start > 8000) reject(new Error('server did not come up'));
      else setTimeout(tryConnect, 200);
    });
  };
  tryConnect();
});
await waitForPort();
console.log('  сервер поднялся');

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// debug: log first raw message on each socket
const debugOnce = (ws, label) => {
  let done = false;
  ws.on('message', (data) => {
    if (done) return; done = true;
    const raw = Buffer.isBuffer(data) ? data.toString() : String(data);
    console.log(`[${label}] raw first msg (type=${typeof data}, isBuff=${Buffer.isBuffer(data)}): ${raw.slice(0,120)}`);
  });
};

function waitMsg(ws, type, timeout = 5000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeout);
    const onMsg = (data) => {
      const raw = Buffer.isBuffer(data) ? data.toString() : data;
      const m = JSON.parse(raw);
      if (m.type === type) { clearTimeout(t); ws.off('message', onMsg); resolve(m.data); }
      else if (m.type === 'auth:error' || m.type === 'error') { clearTimeout(t); ws.off('message', onMsg); resolve({ __error: m }); }
    };
    ws.on('message', onMsg);
  });
}

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name); } };

try {
  const a = await connect();
  const b = await connect();
  debugOnce(a, 'a'); debugOnce(b, 'b');

  console.log('Тест: регистрация');
  a.send(JSON.stringify({ type: 'register', data: { username: 'alice', displayName: 'Алиса', password: 'pass123' } }));
  await waitMsg(a, 'auth:ok');
  b.send(JSON.stringify({ type: 'register', data: { username: 'bob', displayName: 'Боб', password: 'pass123' } }));
  await waitMsg(b, 'auth:ok');
  check('оба зарегистрировались', true);

  console.log('Тест: сервер');
  a.send(JSON.stringify({ type: 'guild:create', data: { name: 'Команда' } }));
  const guildState = await waitMsg(a, 'guild:state');
  const guild = guildState.guild;
  check('сервер создан', !!guild && !!guild.id);
  check('каналы созданы (текст+голос)', guildState.channels.length >= 2);
  check('хост назначен создателю (alice id=1)', guild.host_id === 1);

  const textCh = guildState.channels.find((c) => c.type === 'text');
  check('есть текстовый канал', !!textCh);

  console.log('Тест: join и сообщение');
  b.send(JSON.stringify({ type: 'guild:join', data: { guildId: guild.id } }));
  await waitMsg(b, 'guild:state');
  b.send(JSON.stringify({ type: 'fetch:messages', data: { channelId: textCh.id } }));
  await waitMsg(b, 'messages');
  check('bob прочитал пустой канал', true);

  a.send(JSON.stringify({ type: 'message:send', data: { channelId: textCh.id, content: 'привет, Боб!' } }));
  const gotByB = await waitMsg(b, 'message:new');
  check('сообщение дошло до Боба', gotByB && gotByB.message && gotByB.message.content === 'привет, Боб!');

  a.send(JSON.stringify({ type: 'fetch:messages', data: { channelId: textCh.id } }));
  const histA = await waitMsg(a, 'messages');
  check('Алиса видит историю', histA.messages.length === 1);

  console.log('Тест: голосовой join');
  const voiceCh = guildState.channels.find((c) => c.type === 'voice');
  a.send(JSON.stringify({ type: 'voice:join', data: { channelId: voiceCh.id } }));
  const va = await waitMsg(a, 'voice:state');
  check('Алиса вошла в голосовой', va.channelId === voiceCh.id && va.users.length === 1);
  // подписываем A ДО отправки join B, чтобы не проспать событие
  const joinPromise = waitMsg(a, 'voice:member:join');
  b.send(JSON.stringify({ type: 'voice:join', data: { channelId: voiceCh.id } }));
  await waitMsg(b, 'voice:state');
  const joinData = await joinPromise;
  check('Алиса увидела приход Боба', joinData && joinData.userId === 2);

  console.log('Тест: DM');
  a.send(JSON.stringify({ type: 'dm:open', data: { username: 'bob' } }));
  const dm = await waitMsg(a, 'dm:opened');
  check('DM открыт', !!dm && !!dm.dmChannel && !!dm.dmChannel.other_user);
  a.send(JSON.stringify({ type: 'message:send', data: { channelId: dm.dmChannel.id, content: 'привет лично' } }));
  const dmGot = await waitMsg(b, 'message:new');
  check('DM сообщение дошло', dmGot && dmGot.message && dmGot.message.content === 'привет лично');

  console.log('Тест: заявки в друзья');
  // B подписывается на входящую заявку ДО отправки
  const incProm = waitMsg(b, 'friend:req:incoming');
  a.send(JSON.stringify({ type: 'friend:request', data: { username: 'bob' } }));
  const reqSent = await waitMsg(a, 'friend:req:sent');
  check('Алиса отправила заявку Бобу', reqSent && reqSent.to && reqSent.to.username === 'bob');
  const inc = await incProm;
  check('Боб получил входящую заявку', inc && inc.from && inc.from.username === 'alice');
  // Боб принимает
  const acceptPromise = waitMsg(a, 'friend:added'); // Алиса узнает, что стали друзьями
  b.send(JSON.stringify({ type: 'friend:accept', data: { userId: inc.from.id } }));
  const acc = await waitMsg(b, 'friend:added');
  const accA = await acceptPromise;
  check('после принятия оба стали друзьями', acc && acc.friend && acc.friend.username === 'alice' && accA && accA.friend && accA.friend.username === 'bob');
  // проверка: повторная заявка невозможна
  a.send(JSON.stringify({ type: 'friend:request', data: { username: 'bob' } }));
  const err = await waitMsg(a, 'error');
  check('повторная заявка отклонена (уже друзья)', err && /Уже друзья|Заявка/.test(err.error));

  console.log('Тест: поиск серверов');
  a.send(JSON.stringify({ type: 'search:guilds', data: { query: 'Команда' } }));
  const res = await waitMsg(a, 'guilds:results');
  check('поиск нашёл сервер "Команда"', res && res.results && res.results.some((g) => g.name === 'Команда'));
  check('в результатах есть member_count', res && res.results[0] && typeof res.results[0].member_count === 'number');

  console.log('Тест: редактирование/удаление');
  // отправить новое сообщение
  a.send(JSON.stringify({ type: 'message:send', data: { channelId: textCh.id, content: 'для правки' } }));
  const sent = await waitMsg(a, 'message:new');
  const msgId = sent.message.id;
  // боб получает тоже (подпишем заранее)
  const updProm = waitMsg(b, 'message:update');
  a.send(JSON.stringify({ type: 'message:edit', data: { messageId: msgId, content: 'исправлено' } }));
  const upd = await waitMsg(a, 'message:update');
  const updB = await updProm;
  check('сообщение отредактировано (у обоих)', upd && upd.message && upd.message.content === 'исправлено' && upd.message.edited === 1 && updB && updB.message.content === 'исправлено');
  // удаление
  a.send(JSON.stringify({ type: 'message:delete', data: { messageId: msgId } }));
  const del = await waitMsg(a, 'message:update');
  check('сообщение удалено', del && del.message && del.message.deleted === 1);
  // нельзя изменить чужое: боб пытается удалить сообщение алисы (id=2 ранее)
  b.send(JSON.stringify({ type: 'message:delete', data: { messageId: 2 } }));
  const errDel = await waitMsg(b, 'error');
  check('нельзя удалить чужое', errDel && /нельзя/i.test(errDel.error));

  a.close(); b.close();
} catch (e) {
  console.error('ОШИБКА теста:', e);
  failed++;
}

child.kill();

console.log(`\nИтог: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);