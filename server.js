const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize data file if it doesn't exist
function initDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      people: [],
      expenses: [],
      startingBalances: [0, 0, 0, 0]
    }));
  }
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { people: [], expenses: [], startingBalances: [0, 0, 0, 0] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

initDataFile();

// API endpoints
app.get('/api/data', (req, res) => {
  res.json(readData());
});

app.post('/api/data', (req, res) => {
  const { people, expenses, startingBalances } = req.body;
  writeData({ people, expenses, startingBalances });
  res.json({ success: true });
});

app.delete('/api/expenses/:id', (req, res) => {
  const data = readData();
  data.expenses = data.expenses.filter(e => e.id !== parseInt(req.params.id));
  writeData(data);
  res.json({ success: true });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Expense Splitter running on port ${PORT}`);
});
