const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
// On a host with an ephemeral filesystem (Railway, Render, Fly) this MUST point
// at a mounted volume, or every deploy and every container restart wipes the
// data. Locally it falls back to the project directory.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const TMP_FILE = DATA_FILE + '.tmp';

const MIN_PEOPLE = 2;
const MAX_PEOPLE = 20;
const MAX_NAME_LEN = 20;
const MAX_DESC_LEN = 100;
const MAX_AMOUNT = 100000000;
const SCHEMA_VERSION = 2;

// Guards the clear-all endpoint against an accidental wipe. The client knows
// this value, so it is a speed bump, not access control.
const CLEAR_PIN = process.env.CLEAR_PIN || '123456';

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// A freshly mounted volume may be empty but present; a mistyped DATA_DIR won't
// exist at all. Create it either way so the first write cannot fail.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- helpers ---

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function emptyData() {
  return { version: SCHEMA_VERSION, people: [], expenses: [] };
}

// v1 stored people as plain name strings and referenced them from expenses by
// array index, which breaks as soon as anyone is added or removed. Rewrite the
// references onto stable ids.
function migrate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyData();
  if (data.version === SCHEMA_VERSION) return data;

  const names = Array.isArray(data.people) ? data.people : [];
  const balances = Array.isArray(data.startingBalances) ? data.startingBalances : [];

  const people = names
    .filter(n => typeof n === 'string' && n.trim() !== '')
    .map((name, i) => ({
      id: newId('p'),
      name: name.trim().slice(0, MAX_NAME_LEN),
      startingBalance: Number.isFinite(Number(balances[i])) ? round2(Number(balances[i])) : 0
    }));

  const expenses = (Array.isArray(data.expenses) ? data.expenses : [])
    .filter(e => e && people[e.payer] && Array.isArray(e.splitAmong))
    .map(e => ({
      id: newId('e'),
      desc: String(e.desc || '').trim().slice(0, MAX_DESC_LEN) || 'Expense',
      amount: round2(Number(e.amount)),
      payerId: people[e.payer].id,
      splitAmong: [...new Set(e.splitAmong.map(i => people[i] && people[i].id).filter(Boolean))],
      date: typeof e.date === 'string' ? e.date : new Date().toISOString()
    }))
    .filter(e => Number.isFinite(e.amount) && e.amount > 0 && e.splitAmong.length > 0);

  return { version: SCHEMA_VERSION, people, expenses };
}

function readData() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('data.json unreadable, starting empty:', err.message);
    }
    return emptyData();
  }
  const migrated = migrate(parsed);
  if (migrated !== parsed) writeData(migrated);
  return migrated;
}

// Write to a temp file and rename, so a crash mid-write cannot leave a
// truncated data.json behind. rename() is atomic on the same filesystem, which
// is why TMP_FILE lives in DATA_DIR rather than the OS temp dir.
function writeData(data) {
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2));
  fs.renameSync(TMP_FILE, DATA_FILE);
}

// --- validation ---

function validatePeople(input, existing) {
  if (!Array.isArray(input)) return { error: '"people" must be an array.' };
  if (input.length < MIN_PEOPLE) return { error: `You need at least ${MIN_PEOPLE} people.` };
  if (input.length > MAX_PEOPLE) return { error: `You can have at most ${MAX_PEOPLE} people.` };

  const known = new Map(existing.map(p => [p.id, p]));
  const seen = new Set();
  const people = [];

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'Each person must be an object.' };

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return { error: 'Every person needs a name.' };
    if (name.length > MAX_NAME_LEN) return { error: `Names must be ${MAX_NAME_LEN} characters or fewer.` };

    const bal = raw.startingBalance === undefined || raw.startingBalance === null
      ? 0
      : Number(raw.startingBalance);
    if (!Number.isFinite(bal) || Math.abs(bal) > MAX_AMOUNT) {
      return { error: `Invalid starting balance for ${name}.` };
    }

    // Only accept an id we already issued; anything else is a new person.
    const id = typeof raw.id === 'string' && known.has(raw.id) ? raw.id : newId('p');
    if (seen.has(id)) return { error: 'The same person was submitted twice.' };
    seen.add(id);

    people.push({ id, name, startingBalance: round2(bal) });
  }

  return { people };
}

function validateExpense(body, people) {
  if (!body || typeof body !== 'object') return { error: 'Invalid request body.' };
  const ids = new Set(people.map(p => p.id));

  const desc = typeof body.desc === 'string' ? body.desc.trim() : '';
  if (!desc) return { error: 'Description is required.' };
  if (desc.length > MAX_DESC_LEN) return { error: `Description must be ${MAX_DESC_LEN} characters or fewer.` };

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Amount must be greater than 0.' };
  if (amount > MAX_AMOUNT) return { error: 'That amount is unreasonably large.' };

  if (!ids.has(body.payerId)) return { error: 'The payer is not in the squad.' };

  if (!Array.isArray(body.splitAmong) || body.splitAmong.length === 0) {
    return { error: 'Select at least one person to split with.' };
  }
  const splitAmong = [...new Set(body.splitAmong)];
  if (splitAmong.some(id => !ids.has(id))) return { error: 'Someone in the split is not in the squad.' };

  return {
    expense: {
      id: newId('e'),
      desc,
      amount: round2(amount),
      payerId: body.payerId,
      splitAmong,
      date: new Date().toISOString()
    }
  };
}

// Validates a whole document from an exported backup. Unlike validatePeople
// this accepts the ids in the file, since the point is to restore the original
// references exactly. Everything is still checked — a backup is not trusted
// just because it came from us.
function validateImport(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid backup file.' };
  if (!Array.isArray(body.people) || !Array.isArray(body.expenses)) {
    return { error: 'Backup must contain "people" and "expenses" arrays.' };
  }
  if (body.people.length < MIN_PEOPLE) return { error: `Backup needs at least ${MIN_PEOPLE} people.` };
  if (body.people.length > MAX_PEOPLE) return { error: `Backup has more than ${MAX_PEOPLE} people.` };

  const people = [];
  const ids = new Set();
  for (const raw of body.people) {
    if (!raw || typeof raw !== 'object') return { error: 'Malformed person in backup.' };
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!id || !name) return { error: 'Every person in the backup needs an id and a name.' };
    if (name.length > MAX_NAME_LEN) return { error: `Name "${name}" is too long.` };
    if (ids.has(id)) return { error: 'Backup contains two people with the same id.' };
    const bal = raw.startingBalance === undefined ? 0 : Number(raw.startingBalance);
    if (!Number.isFinite(bal) || Math.abs(bal) > MAX_AMOUNT) {
      return { error: `Invalid starting balance for ${name}.` };
    }
    ids.add(id);
    people.push({ id, name, startingBalance: round2(bal) });
  }

  const expenses = [];
  const expenseIds = new Set();
  for (const raw of body.expenses) {
    if (!raw || typeof raw !== 'object') return { error: 'Malformed expense in backup.' };
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const desc = typeof raw.desc === 'string' ? raw.desc.trim() : '';
    if (!id || !desc) return { error: 'Every expense in the backup needs an id and a description.' };
    if (desc.length > MAX_DESC_LEN) return { error: `Description "${desc}" is too long.` };
    if (expenseIds.has(id)) return { error: 'Backup contains two expenses with the same id.' };
    const amount = Number(raw.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      return { error: `Invalid amount on "${desc}".` };
    }
    if (!ids.has(raw.payerId)) return { error: `"${desc}" was paid by someone not in the backup.` };
    if (!Array.isArray(raw.splitAmong) || raw.splitAmong.length === 0) {
      return { error: `"${desc}" has an empty split.` };
    }
    const splitAmong = [...new Set(raw.splitAmong)];
    if (splitAmong.some(pid => !ids.has(pid))) {
      return { error: `"${desc}" is split with someone not in the backup.` };
    }
    const date = typeof raw.date === 'string' && !Number.isNaN(Date.parse(raw.date))
      ? raw.date
      : new Date().toISOString();
    expenseIds.add(id);
    expenses.push({ id, desc, amount: round2(amount), payerId: raw.payerId, splitAmong, date });
  }

  return { data: { version: SCHEMA_VERSION, people, expenses } };
}

// --- API ---
// Every write is a read-modify-write of the whole file using synchronous fs
// calls inside a single handler, so requests cannot interleave and concurrent
// clients no longer clobber each other's changes.

app.get('/api/data', (req, res) => {
  res.json(readData());
});

app.put('/api/people', (req, res) => {
  const data = readData();
  const { people, error } = validatePeople(req.body && req.body.people, data.people);
  if (error) return res.status(400).json({ error });

  // Removing someone who appears in an expense would orphan that expense, so
  // refuse rather than silently corrupting the history.
  const keptIds = new Set(people.map(p => p.id));
  const removed = data.people.filter(p => !keptIds.has(p.id));
  const blocking = removed.filter(p =>
    data.expenses.some(e => e.payerId === p.id || e.splitAmong.includes(p.id))
  );
  if (blocking.length > 0) {
    return res.status(409).json({
      error: `Can't remove ${blocking.map(p => p.name).join(', ')} — they still appear in recorded expenses. Delete those expenses first.`
    });
  }

  data.people = people;
  writeData(data);
  res.json(data);
});

app.post('/api/expenses', (req, res) => {
  const data = readData();
  if (data.people.length < MIN_PEOPLE) {
    return res.status(409).json({ error: 'Set up the squad before adding expenses.' });
  }
  const { expense, error } = validateExpense(req.body, data.people);
  if (error) return res.status(400).json({ error });

  data.expenses.push(expense);
  writeData(data);
  res.status(201).json(data);
});

app.delete('/api/expenses/:id', (req, res) => {
  const data = readData();
  const before = data.expenses.length;
  data.expenses = data.expenses.filter(e => e.id !== req.params.id);
  if (data.expenses.length === before) {
    return res.status(404).json({ error: 'That expense no longer exists.' });
  }
  writeData(data);
  res.json(data);
});

app.delete('/api/expenses', (req, res) => {
  const pin = req.body && req.body.pin;
  if (typeof pin !== 'string' || pin.trim() !== CLEAR_PIN) {
    return res.status(403).json({ error: 'Incorrect PIN.' });
  }
  const data = readData();
  data.expenses = [];
  writeData(data);
  res.json(data);
});

// Restore from an exported backup. PIN-gated because it replaces everything.
app.put('/api/data', (req, res) => {
  const pin = req.body && req.body.pin;
  if (typeof pin !== 'string' || pin.trim() !== CLEAR_PIN) {
    return res.status(403).json({ error: 'Incorrect PIN.' });
  }
  const { data, error } = validateImport(req.body && req.body.data);
  if (error) return res.status(400).json({ error });

  writeData(data);
  res.json(data);
});

// Unknown API routes must 404 as JSON rather than falling through to index.html.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Malformed JSON bodies reach here as a SyntaxError from express.json().
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Expense Splitter running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  if (!process.env.DATA_DIR) {
    console.warn('WARNING: DATA_DIR is not set. On a host with an ephemeral ' +
      'filesystem, all data will be lost on the next deploy or restart.');
  }
});
