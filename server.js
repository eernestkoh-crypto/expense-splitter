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
const SCHEMA_VERSION = 3;

// Guards the clear-all endpoint against an accidental wipe. The client knows
// this value, so it is a speed bump, not access control.
const CLEAR_PIN = process.env.CLEAR_PIN || '123456';

app.use(express.json({ limit: '100kb' }));

// Keep the site out of search results. The header covers every response
// including /api/data, which a <meta> tag in index.html cannot reach, and it
// applies before express.static so it is set on static files too.
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  next();
});

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
  return { version: SCHEMA_VERSION, people: [], expenses: [], payments: [] };
}

// v1 referenced people from expenses by array index, which broke as soon as
// anyone was added or removed; v2 moved to stable ids; v3 added payments.
function migrate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyData();

  if (data.version === SCHEMA_VERSION) {
    // Tolerate a v3 file written before it had any payments recorded.
    if (!Array.isArray(data.payments)) return { ...data, payments: [] };
    return data;
  }

  if (data.version === 2) {
    return {
      version: SCHEMA_VERSION,
      people: Array.isArray(data.people) ? data.people : [],
      expenses: Array.isArray(data.expenses) ? data.expenses : [],
      payments: []
    };
  }

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

  return { version: SCHEMA_VERSION, people, expenses, payments: [] };
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

// Expenses and payments are both kept in date order so an edited or restored
// row lands where it belongs rather than at the end of the list.
function byDate(a, b) {
  return Date.parse(a.date) - Date.parse(b.date);
}

function parseDate(value, fallback) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback || new Date().toISOString();
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

  // "shares" is optional. When absent the expense splits evenly among
  // splitAmong; when present it is an exact per-person amount that must add up
  // to the total, so the books can never silently disagree with the receipt.
  let shares = null;
  if (body.shares !== undefined && body.shares !== null) {
    if (typeof body.shares !== 'object' || Array.isArray(body.shares)) {
      return { error: 'Split amounts must be an object keyed by person.' };
    }
    const keys = Object.keys(body.shares);
    if (keys.length !== splitAmong.length || keys.some(k => !splitAmong.includes(k))) {
      return { error: 'Split amounts must cover exactly the people in the split.' };
    }
    shares = {};
    let sum = 0;
    for (const id of splitAmong) {
      const value = Number(body.shares[id]);
      if (!Number.isFinite(value) || value < 0) {
        return { error: 'Every split amount must be 0 or more.' };
      }
      shares[id] = round2(value);
      sum = round2(sum + shares[id]);
    }
    if (Math.abs(sum - round2(amount)) > 0.01) {
      return { error: `Split amounts add up to ${sum}, but the expense is ${round2(amount)}.` };
    }
  }

  const expense = {
    id: newId('e'),
    desc,
    amount: round2(amount),
    payerId: body.payerId,
    splitAmong,
    date: parseDate(body.date)
  };
  if (shares) expense.shares = shares;

  return { expense };
}

function validatePayment(body, people) {
  if (!body || typeof body !== 'object') return { error: 'Invalid request body.' };
  const ids = new Set(people.map(p => p.id));

  if (!ids.has(body.fromId)) return { error: 'The person paying is not in the squad.' };
  if (!ids.has(body.toId)) return { error: 'The person being paid is not in the squad.' };
  if (body.fromId === body.toId) return { error: 'A payment needs two different people.' };

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Payment must be greater than 0.' };
  if (amount > MAX_AMOUNT) return { error: 'That amount is unreasonably large.' };

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > MAX_DESC_LEN) return { error: `Note must be ${MAX_DESC_LEN} characters or fewer.` };

  return {
    payment: {
      id: newId('pay'),
      fromId: body.fromId,
      toId: body.toId,
      amount: round2(amount),
      note,
      date: parseDate(body.date)
    }
  };
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

  // Removing someone who appears in an expense or a payment would orphan that
  // record, so refuse rather than silently corrupting the history.
  const keptIds = new Set(people.map(p => p.id));
  const removed = data.people.filter(p => !keptIds.has(p.id));
  const blocking = removed.filter(p =>
    data.expenses.some(e => e.payerId === p.id || e.splitAmong.includes(p.id)) ||
    data.payments.some(y => y.fromId === p.id || y.toId === p.id)
  );
  if (blocking.length > 0) {
    return res.status(409).json({
      error: `Can't remove ${blocking.map(p => p.name).join(', ')} — they still appear in recorded expenses or payments. Delete those first.`
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
  data.expenses.sort(byDate);
  writeData(data);
  res.status(201).json(data);
});

// Editing keeps the original id so history, and anything referencing it, stays
// stable. Everything else including the date can change.
app.put('/api/expenses/:id', (req, res) => {
  const data = readData();
  const index = data.expenses.findIndex(e => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'That expense no longer exists.' });

  const { expense, error } = validateExpense(req.body, data.people);
  if (error) return res.status(400).json({ error });

  data.expenses[index] = { ...expense, id: req.params.id };
  data.expenses.sort(byDate);
  writeData(data);
  res.json(data);
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

// Backs the undo action after a delete. Re-adds an expense with its original
// id and timestamp instead of minting new ones, so undo restores the row that
// was there rather than a lookalike.
app.post('/api/expenses/restore', (req, res) => {
  const data = readData();
  const raw = req.body && req.body.expense;
  if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'Nothing to restore.' });

  const { expense, error } = validateExpense(raw, data.people);
  if (error) return res.status(400).json({ error });

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Restored expense is missing its id.' });
  if (data.expenses.some(e => e.id === id)) {
    return res.status(409).json({ error: 'That expense is already back.' });
  }

  data.expenses.push({ ...expense, id });
  data.expenses.sort(byDate);
  writeData(data);
  res.status(201).json(data);
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

// Payments settle debt between two people. They are kept separate from
// expenses so that handing someone cash never inflates group spending.
app.post('/api/payments', (req, res) => {
  const data = readData();
  if (data.people.length < MIN_PEOPLE) {
    return res.status(409).json({ error: 'Set up the squad before recording payments.' });
  }
  const { payment, error } = validatePayment(req.body, data.people);
  if (error) return res.status(400).json({ error });

  data.payments.push(payment);
  data.payments.sort(byDate);
  writeData(data);
  res.status(201).json(data);
});

app.delete('/api/payments/:id', (req, res) => {
  const data = readData();
  const before = data.payments.length;
  data.payments = data.payments.filter(y => y.id !== req.params.id);
  if (data.payments.length === before) {
    return res.status(404).json({ error: 'That payment no longer exists.' });
  }
  writeData(data);
  res.json(data);
});

app.post('/api/payments/restore', (req, res) => {
  const data = readData();
  const raw = req.body && req.body.payment;
  if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'Nothing to restore.' });

  const { payment, error } = validatePayment(raw, data.people);
  if (error) return res.status(400).json({ error });

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Restored payment is missing its id.' });
  if (data.payments.some(y => y.id === id)) {
    return res.status(409).json({ error: 'That payment is already back.' });
  }

  data.payments.push({ ...payment, id });
  data.payments.sort(byDate);
  writeData(data);
  res.status(201).json(data);
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
