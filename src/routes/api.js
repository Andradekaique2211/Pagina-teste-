const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'scaling_sales_secret_key_2026';

// ─── Middlewares ─────────────────────────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Acesso negado' });
  try {
    const verified = jwt.verify(token.split(' ')[1], JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ error: 'Token inválido' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sem privilégios de Admin' });
  next();
};

// ─── ROTAS PÚBLICAS ───────────────────────────────────────────────────────────

// 1. Cadastro de Afiliado
router.post('/cadastro', async (req, res) => {
  const { name, whatsapp, password, pix } = req.body;
  if (!name || !whatsapp || !password) return res.status(400).json({ error: 'Dados incompletos' });

  const id = 'AF' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 100);

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    db.run(`INSERT INTO users (id, name, whatsapp, password, pix) VALUES (?, ?, ?, ?, ?)`,
      [id, name, whatsapp, hashedPassword, pix || ''],
      function (err) {
        if (err) {
          if (err.message === 'WHATSAPP_DUPLICATE') {
            return res.status(400).json({ error: 'Este WhatsApp já está cadastrado. Faça login ou use outro número.' });
          }
          return res.status(500).json({ error: 'Erro ao cadastrar: ' + err.message });
        }
        res.json({ message: 'Cadastro realizado! Aguarde aprovação do administrador para liberar seu link.', id });
      }
    );
  } catch (err) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// 2. Login
router.post('/login', (req, res) => {
  const { id, password } = req.body;

  db.get(`SELECT * FROM users WHERE id = ?`, [id], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Erro no servidor' });
    if (!user) return res.status(400).json({ error: 'ID ou Senha inválidos' });

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: 'ID ou Senha inválidos' });

    const token = jwt.sign({ id: user.id, role: user.role, status: user.status }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, role: user.role, name: user.name, status: user.status });
  });
});

// 3. Captura de Visita
router.post('/visit', (req, res) => {
  const { affiliate_id } = req.body;
  if (!affiliate_id) return res.status(400).json({ error: 'ID de afiliado ausente' });

  // Só registra se afiliado ativo
  db.get(`SELECT * FROM users WHERE id = ?`, [affiliate_id], (err, user) => {
    if (!user || user.status !== 'active') return res.json({ skipped: true });
    db.run(`INSERT INTO visits (affiliate_id) VALUES (?)`, [affiliate_id], () => {
      res.json({ success: true });
    });
  });
});

// 4. Captura de Lead (clique no WhatsApp)
router.post('/lead', (req, res) => {
  const { affiliate_id, client_contact } = req.body;
  if (!affiliate_id) return res.status(400).json({ error: 'ID de afiliado ausente' });

  // Só registra se afiliado ativo
  db.get(`SELECT * FROM users WHERE id = ?`, [affiliate_id], (err, user) => {
    if (!user || user.status !== 'active') return res.json({ skipped: true });
    db.run(`INSERT INTO leads (affiliate_id, client_contact, value, status) VALUES (?, ?, ?, ?)`,
      [affiliate_id, client_contact || 'Via WhatsApp', 1000, 'pending'],
      function (err) {
        if (err) return res.status(500).json({ error: 'Erro ao registrar Lead' });
        res.json({ message: 'Lead registrado', leadId: this.lastID });
      }
    );
  });
});

// ─── ROTAS AFILIADO ───────────────────────────────────────────────────────────

// 5. Dashboard
router.get('/dashboard', authMiddleware, (req, res) => {
  const affiliate_id = req.user.id;

  db.all(`SELECT * FROM leads WHERE affiliate_id = ? ORDER BY created_at DESC`, [affiliate_id], (errL, leads) => {
    db.all(`SELECT * FROM visits WHERE affiliate_id = ?`, [affiliate_id], (errV, visits) => {
      let totalSales = 0, totalCommission = 0, availableCommission = 0;

      leads.forEach(lead => {
        if (lead.status === 'closed' || lead.status === 'paid') {
          totalSales += lead.value;
          totalCommission += (lead.value * 0.25);
          if (lead.status === 'closed') availableCommission += (lead.value * 0.25);
        }
      });

      res.json({
        metrics: {
          totalVisits: visits ? visits.length : 0,
          totalLeads: leads ? leads.length : 0,
          totalSales, totalCommission, availableCommission
        },
        leads,
        affiliateStatus: req.user.status // 'active' ou 'pending'
      });
    });
  });
});

// ─── ROTAS ADMIN ──────────────────────────────────────────────────────────────

// 6. Dados gerais admin
router.get('/admin/data', authMiddleware, adminMiddleware, (req, res) => {
  db.all(`SELECT * FROM leads ORDER BY created_at DESC`, [], (err, leads) => {
    db.all(`SELECT id, name, whatsapp, pix, status, created_at FROM users WHERE role = 'affiliate'`, [], (errU, users) => {
      db.all(`SELECT * FROM notifications WHERE read = 0`, [], (errN, notifs) => {
        res.json({ leads, affiliates: users, unreadNotifications: notifs ? notifs.length : 0 });
      });
    });
  });
});

// 7. Fechar lead
router.post('/admin/close-lead', authMiddleware, adminMiddleware, (req, res) => {
  const { lead_id, value } = req.body;
  db.run(`UPDATE leads SET status = 'closed', value = ? WHERE id = ?`, [value, lead_id], (err) => {
    if (err) return res.status(500).json({ error: 'Erro' });
    res.json({ success: true });
  });
});

// 8. Aprovar afiliado
router.post('/admin/approve-affiliate', authMiddleware, adminMiddleware, (req, res) => {
  const { affiliate_id } = req.body;
  db.run(`UPDATE users SET status = 'active' WHERE id = ?`, [affiliate_id], (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao aprovar' });
    res.json({ success: true, message: 'Afiliado aprovado com sucesso!' });
  });
});

// 9. Reset de senha do afiliado
router.post('/admin/reset-password', authMiddleware, adminMiddleware, async (req, res) => {
  const { affiliate_id } = req.body;
  const newPassword = 'Scaling@' + Math.floor(1000 + Math.random() * 9000); // ex: Scaling@4872
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    db.run(`UPDATE users SET password = ? WHERE id = ?`, [hash, affiliate_id], (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao resetar' });
      res.json({ success: true, newPassword, message: `Senha resetada para: ${newPassword}` });
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// 10. Marcar notificações como lidas
router.post('/admin/read-notifications', authMiddleware, adminMiddleware, (req, res) => {
  db.run(`UPDATE notifications SET read = 1`, [], (err) => {
    res.json({ success: true });
  });
});

// 11. Pagar comissões
router.post('/pagar', authMiddleware, adminMiddleware, (req, res) => {
  const { affiliate_id, amount } = req.body;
  db.run(`UPDATE leads SET status = 'paid' WHERE affiliate_id = ? AND status = 'closed'`, [affiliate_id], (err) => {
    if (err) return res.status(500).json({ error: 'Erro' });
    res.json({ success: true, message: `Comissão de R$${amount} marcada como paga para ${affiliate_id}!` });
  });
});

module.exports = router;
