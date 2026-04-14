const fs = require('fs');
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.json');
const backupDir = path.resolve(__dirname, 'backups');

// ─── Helpers ────────────────────────────────────────────────────────────────
function readData() {
  const data = fs.readFileSync(dbPath, 'utf-8');
  return JSON.parse(data);
}

function writeData(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// ─── Inicializa o banco ──────────────────────────────────────────────────────
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify({ users: [], leads: [], visits: [], notifications: [] }, null, 2));
}

// Migração: garante que todos os campos novos existam
const _checkDb = readData();
let _changed = false;
if (!_checkDb.visits)        { _checkDb.visits = [];        _changed = true; }
if (!_checkDb.notifications) { _checkDb.notifications = []; _changed = true; }
_checkDb.users.forEach(u => {
  if (u.status === undefined) { u.status = 'active'; _changed = true; }
  if (u.pix    === undefined) { u.pix    = '';       _changed = true; }
});
if (_changed) writeData(_checkDb);

// ─── Backup automático (1× por dia) ─────────────────────────────────────────
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const backupFile = path.join(backupDir, `backup-${today}.json`);
if (!fs.existsSync(backupFile)) {
  fs.copyFileSync(dbPath, backupFile);
  console.log(`📦 Backup do banco criado: backup-${today}.json`);
}

// ─── Seed admin ──────────────────────────────────────────────────────────────
const _init = readData();
if (!_init.users.find(u => u.role === 'admin')) {
  const bcrypt = require('bcryptjs');
  const adminPass = process.env.ADMIN_PASSWORD || 'ScalingSales@Admin2026!';
  const hash = bcrypt.hashSync(adminPass, 10);
  _init.users.push({
    id: process.env.ADMIN_ID || 'ADMIN',
    name: process.env.ADMIN_NAME || 'Administrador',
    whatsapp: 'master',
    password: hash,
    pix: '',
    role: 'admin',
    status: 'active',
    created_at: new Date().toISOString()
  });
  writeData(_init);
  console.log('👑 Admin criado com as credenciais do .env');
}

// ─── DB API ──────────────────────────────────────────────────────────────────
const db = {
  run(query, params, callback) {
    const data = readData();

    // INSERT USER
    if (query.includes('INSERT INTO users')) {
      // Bloquear WhatsApp duplicado
      const waExists = data.users.find(u => u.whatsapp === params[2] && u.role !== 'admin');
      if (waExists) {
        if (callback) callback.call({}, new Error('WHATSAPP_DUPLICATE'));
        return;
      }
      data.users.push({
        id: params[0], name: params[1], whatsapp: params[2],
        password: params[3], pix: params[4] || '',
        role: 'affiliate', status: 'pending', // começa pendente, admin aprova
        created_at: new Date().toISOString()
      });
      writeData(data);
      // Notificação de novo afiliado
      data.notifications = data.notifications || [];
      const nData = readData();
      nData.notifications.push({ id: Date.now(), type: 'new_affiliate', message: `Novo afiliado aguardando aprovação: ${params[1]}`, read: false, created_at: new Date().toISOString() });
      writeData(nData);
      if (callback) callback.call({ lastID: params[0] }, null);
    }

    // INSERT LEAD
    else if (query.includes('INSERT INTO leads')) {
      const newLead = {
        id: Date.now(), affiliate_id: params[0], client_contact: params[1],
        value: params[2], status: params[3], created_at: new Date().toISOString()
      };
      data.leads.push(newLead);
      // Notificação de novo lead
      data.notifications = data.notifications || [];
      data.notifications.push({ id: Date.now() + 1, type: 'new_lead', message: `Novo lead do afiliado ${params[0]}: ${params[1]}`, read: false, created_at: new Date().toISOString() });
      writeData(data);
      if (callback) callback.call({ lastID: newLead.id }, null);
    }

    // INSERT VISIT
    else if (query.includes('INSERT INTO visits')) {
      data.visits = data.visits || [];
      data.visits.push({ id: Date.now(), affiliate_id: params[0], created_at: new Date().toISOString() });
      writeData(data);
      if (callback) callback(null);
    }

    // UPDATE lead -> closed
    else if (query.includes("UPDATE leads SET status = 'closed'")) {
      const lead = data.leads.find(l => l.id == params[1]);
      if (lead) { lead.status = 'closed'; lead.value = params[0]; }
      writeData(data);
      if (callback) callback(null);
    }

    // UPDATE lead -> paid
    else if (query.includes("UPDATE leads SET status = 'paid'")) {
      data.leads.forEach(l => {
        if (l.affiliate_id === params[0] && l.status === 'closed') l.status = 'paid';
      });
      writeData(data);
      if (callback) callback(null);
    }

    // APPROVE affiliate
    else if (query.includes("UPDATE users SET status = 'active'")) {
      const user = data.users.find(u => u.id === params[0]);
      if (user) user.status = 'active';
      writeData(data);
      if (callback) callback(null);
    }

    // RESET PASSWORD
    else if (query.includes('UPDATE users SET password =')) {
      const user = data.users.find(u => u.id === params[1]);
      if (user) user.password = params[0];
      writeData(data);
      if (callback) callback(null);
    }

    // MARK notifications read
    else if (query.includes('UPDATE notifications SET read = 1')) {
      data.notifications = data.notifications || [];
      data.notifications.forEach(n => n.read = true);
      writeData(data);
      if (callback) callback(null);
    }

    else { if (callback) callback(null); }
  },

  get(query, params, callback) {
    const data = readData();
    if (query.includes('SELECT * FROM users WHERE id = ?')) {
      const user = data.users.find(u => u.id === params[0]);
      callback(null, user);
    }
  },

  all(query, params, callback) {
    const data = readData();

    if (query.includes('SELECT * FROM leads WHERE affiliate_id = ?')) {
      const leads = data.leads.filter(l => l.affiliate_id === params[0]).sort((a, b) => b.id - a.id);
      callback(null, leads);
    }
    else if (query.includes('SELECT * FROM visits WHERE affiliate_id = ?')) {
      const visits = (data.visits || []).filter(v => v.affiliate_id === params[0]);
      callback(null, visits);
    }
    else if (query.includes('SELECT * FROM leads ORDER BY')) {
      callback(null, data.leads.sort((a, b) => b.id - a.id));
    }
    else if (query.includes('SELECT id, name, whatsapp, pix, status, created_at FROM users')) {
      const aff = data.users.filter(u => u.role === 'affiliate');
      callback(null, aff);
    }
    else if (query.includes('SELECT * FROM notifications')) {
      const notifs = (data.notifications || []).sort((a, b) => b.id - a.id);
      callback(null, notifs);
    }
  }
};

module.exports = db;
