const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const webpush = require('web-push');   // <-- ADD THIS

// --- ADD THIS BLOCK ---
webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);
const app = express();
// In-memory store for push subscriptions
// For production, replace this with a database table
let pushSubscriptions = {}; // key: username, value: array of subscription objects
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_here_change_in_production';
// --- Middleware ---
app.use(cors({
  // Allow all origins (adjust for production if needed)
  origin: '*',
  credentials: true
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- Request logging ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- PostgreSQL Database Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

// =============================================
// 1. DATABASE INITIALIZATION
// =============================================
async function initDatabase() {
  try {
    // Users table – ADD approved column
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        assigned_sites TEXT,
        full_name TEXT,
        email TEXT UNIQUE,
        approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // ★★★ MIGRATION: Ensure new columns exist (for existing databases) ★★★
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE`);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT FALSE`);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);

    // Reports table (unchanged)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        template_key TEXT,
        template_name TEXT,
        format_no TEXT,
        meta TEXT,
        sections TEXT,
        score INTEGER,
        defects_count INTEGER,
        title_loc TEXT,
        prepared_by TEXT,
        status TEXT,
        comment TEXT,
        attachments TEXT,
        created_by TEXT,
        created_by_display TEXT,
        decision_by TEXT,
        decision_by_display TEXT,
        saved_at TEXT,
        audit TEXT,
        raised_from_rfi TEXT,
        site_name TEXT
      )
    `);

    // Notifications table (unchanged)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        recipient_username TEXT,
        message TEXT,
        type TEXT,
        rfi_id TEXT,
        rfi_no TEXT,
        sender_name TEXT,
        read INTEGER DEFAULT 0,
        created_at TEXT
      )
    `);

    // ★★★ CREATE SITES TABLE ★★★
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sites (
        name TEXT PRIMARY KEY
      )
    `);

    // Seed default sites if table is empty
    const siteResult = await pool.query("SELECT COUNT(*) as count FROM sites");
    if (parseInt(siteResult.rows[0].count) === 0) {
      await pool.query("INSERT INTO sites (name) VALUES ('Site-A'), ('Site-B'), ('Default')");
      console.log('✅ Default sites created.');
    }

    // Seed default users (only if empty)
    const userResult = await pool.query("SELECT COUNT(*) as count FROM users");
    if (parseInt(userResult.rows[0].count) === 0) {
      console.log('🌱 Seeding default users...');
      const defaultUsers = [
        { username: 'admin', password: 'Admin123', role: 'admin', full_name: 'System Admin', sites: '["*"]', approved: true },
        { username: 'exec_siteA', password: 'ExecA123', role: 'exec_engineer', full_name: 'Execution Engineer Site A', sites: '["Site-A"]', approved: true },
        { username: 'qa_siteA', password: 'QaA123', role: 'qa_head', full_name: 'QA Head Site A', sites: '["Site-A"]', approved: true },
        { username: 'contractor1_siteA', password: 'ContA123', role: 'engineer', full_name: 'Contractor 1 - Site A', sites: '["Site-A"]', approved: true },
        { username: 'contractor2_siteA', password: 'ContA456', role: 'engineer', full_name: 'Contractor 2 - Site A', sites: '["Site-A"]', approved: true },
        { username: 'exec_siteB', password: 'ExecB123', role: 'exec_engineer', full_name: 'Execution Engineer Site B', sites: '["Site-B"]', approved: true },
        { username: 'qa_siteB', password: 'QaB123', role: 'qa_head', full_name: 'QA Head Site B', sites: '["Site-B"]', approved: true },
        { username: 'contractor1_siteB', password: 'ContB123', role: 'engineer', full_name: 'Contractor 1 - Site B', sites: '["Site-B"]', approved: true },
        { username: 'manager', password: 'Mgr123', role: 'manager', full_name: 'Project Manager', sites: '["*"]', approved: true },
        { username: 'consultant', password: 'View123', role: 'consultant', full_name: 'Consultant', sites: '["*"]', approved: true }
      ];
      for (const u of defaultUsers) {
        const hashed = bcrypt.hashSync(u.password, 10);
        await pool.query(
          `INSERT INTO users (username, password, role, assigned_sites, full_name, approved) VALUES ($1, $2, $3, $4, $5, $6)`,
          [u.username, hashed, u.role, u.sites, u.full_name, u.approved]
        );
      }
      console.log('✅ Default users created.');
    }
    console.log('✅ PostgreSQL database initialized successfully.');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
    process.exit(1);
  }
}

// =============================================
// 2. HELPER FUNCTIONS
// =============================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function verifyAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

async function getUserByUsername(username) {
  const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  return result.rows[0] || null;
}

function userHasSiteAccess(user, siteName) {
  const sites = user.assigned_sites || '[]';
  let assigned = [];
  try { assigned = JSON.parse(sites); } catch (e) { assigned = []; }
  if (assigned.includes('*')) return true;
  // Global reports (site_name = '*') are accessible to everyone
  if (siteName === '*') return true;
  return assigned.includes(siteName);
}
// ★★★ NEW HELPER: Check if user can access a specific report ★★★
function userCanAccessReport(user, reportRow) {
  // First check site access
  if (userHasSiteAccess(user, reportRow.site_name)) return true;
  // Then check if user is listed in the agency field
  let meta = {};
  try { meta = JSON.parse(reportRow.meta || '{}'); } catch(e) { meta = {}; }
  const agency = meta.agency;
  if (!agency) return false;
  // agency can be array (audit) or string (NCR)
  if (Array.isArray(agency)) {
    return agency.includes(user.username);
  }
  if (typeof agency === 'string') {
    return agency === user.username;
  }
  return false;
}

function buildSiteFilter(user) {
  const sites = user.assigned_sites || '[]';
  let assigned = [];
  try { assigned = JSON.parse(sites); } catch (e) { assigned = []; }
  if (assigned.includes('*')) {
    // Admin/manager sees everything – no filter
    return { sql: '', params: [] };
  }
  // For users with specific sites, also include global reports (site_name = '*')
  const placeholders = assigned.map((_, i) => `$${i + 1}`).join(',');
  // Note: we keep the assigned list as parameters for the IN clause
  // We add an OR for site_name = '*'
  return {
    sql: `WHERE (site_name IN (${placeholders}) OR site_name = '*')`,
    params: assigned
  };
}
function parseReportRow(row) {
  return {
    ...row,
    meta: JSON.parse(row.meta || '{}'),
    sections: JSON.parse(row.sections || '[]'),
    attachments: JSON.parse(row.attachments || '[]'),
    audit: JSON.parse(row.audit || '[]')
  };
}

async function getReportsForUser(user) {
  const username = user.username;
  const sites = user.assigned_sites || '[]';
  let assigned = [];
  try { assigned = JSON.parse(sites); } catch (e) { assigned = []; }

  // If user has '*' site access, return all reports
  if (assigned.includes('*')) {
    const result = await pool.query('SELECT * FROM reports ORDER BY saved_at DESC');
    return result.rows.map(parseReportRow);
  }

  // Build site condition
  const placeholders = assigned.map((_, i) => `$${i + 1}`).join(',');
  const siteCondition = `(site_name IN (${placeholders}) OR site_name = '*')`;
  const params = [...assigned];

  // ★★★ ADD AGENCY CONDITION FOR BOTH AUDIT AND NCR ★★★
  const query = `
    SELECT * FROM reports
    WHERE (
      ${siteCondition}
      OR (
        meta IS NOT NULL AND (
          meta::jsonb->'agency' ? $${params.length + 1}
          OR meta::jsonb->>'agency' = $${params.length + 1}
        )
      )
    )
    ORDER BY saved_at DESC
  `;
  params.push(username);

  const result = await pool.query(query, params);
  return result.rows.map(parseReportRow);
}

// =============================================
// 3. AUTH APIs
// =============================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const user = await getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    
    // Check if user is approved (new)
    if (!user.approved) {
      return res.status(403).json({ error: 'Account pending approval. Please wait for admin approval.' });
    }
    
    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        assigned_sites: user.assigned_sites,
        full_name: user.full_name || user.username
      },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    const { password: pwd, ...userInfo } = user;
    res.json({
      token,
      user: {
        ...userInfo,
        assigned_sites: JSON.parse(userInfo.assigned_sites || '[]')
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
 // =============================================
// REGISTRATION
// =============================================
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, full_name, role, assigned_sites } = req.body;

    // 1. Validate required fields
    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ error: 'Email, password, full name, and role are required' });
    }

    // 2. Validate role against allowed list
    const allowedRoles = ['engineer', 'exec_engineer', 'qa_head', 'manager', 'consultant', 'admin'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // 3. Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // 4. Check if user already exists (by email)
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // 5. Hash password
    const hashedPassword = bcrypt.hashSync(password, 10);

    // 6. Build assigned_sites array
    let sites = [];
    if (assigned_sites) {
      if (Array.isArray(assigned_sites)) {
        sites = assigned_sites;
      } else if (typeof assigned_sites === 'string') {
        sites = assigned_sites.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    if (sites.length === 0) {
      if (role === 'manager' || role === 'consultant' || role === 'admin') {
        sites = ['*'];
      } else {
        sites = ['Default'];
      }
    }
    const sitesJson = JSON.stringify(sites);

    // ★★★ UPDATED INSERT – includes 'approved' column with FALSE ★★★
    const result = await pool.query(
      `INSERT INTO users (username, email, password, role, assigned_sites, full_name, created_at, approved)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), FALSE)
       RETURNING id`,
      [email, email, hashedPassword, role, sitesJson, full_name]
    );

    // New users start with approved = FALSE (explicitly set)
    res.status(201).json({
      message: 'User registered successfully. Please wait for admin approval.',
      userId: result.rows[0].id
    });

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
 
// =============================================
// SITES API
// =============================================

// GET all sites (public - for registration)
app.get('/api/sites', async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM sites ORDER BY name');
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST - Add a new site (Admin only)
app.post('/api/sites', authenticateToken, verifyAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Site name required' });
  try {
    await pool.query('INSERT INTO sites (name) VALUES ($1)', [name]);
    res.status(201).json({ message: 'Site added' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Site already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE - Remove a site (Admin only)
app.delete('/api/sites/:name', authenticateToken, verifyAdmin, async (req, res) => {
  const { name } = req.params;
  try {
    await pool.query('DELETE FROM sites WHERE name = $1', [name]);
    res.json({ message: 'Site deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// USER MANAGEMENT API (Admin only)
// =============================================

app.get('/api/users', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username, role, assigned_sites, full_name FROM users");
    const users = result.rows.map(u => ({
      ...u,
      assigned_sites: JSON.parse(u.assigned_sites || '[]')
    }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const { username, password, role, assigned_sites, full_name } = req.body;
    if (!username || !password || !role || !assigned_sites) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const hashed = bcrypt.hashSync(password, 10);
    const sitesJson = JSON.stringify(assigned_sites);
    const result = await pool.query(
      `INSERT INTO users (username, password, role, assigned_sites, full_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [username, hashed, role, sitesJson, full_name || '']
    );
    res.status(201).json({ id: result.rows[0].id, message: 'User created' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});
 app.get('/api/users/all', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, role, assigned_sites, full_name, approved, created_at FROM users ORDER BY created_at DESC"
    );
    const users = result.rows.map(u => ({
      ...u,
      assigned_sites: JSON.parse(u.assigned_sites || '[]')
    }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/users/:id/approve', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE users SET approved = TRUE WHERE id = $1", [id]);
    res.json({ message: 'User approved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/users/:id', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM users WHERE id = $1 AND username != 'admin'", [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ← PASTE HERE ↓↓↓
// =============================================
// GET AGENCY USERS (for Audit/NCR selection)
// =============================================
app.get('/api/users/agency', authenticateToken, async (req, res) => {
  try {
    const currentUser = req.user;
    let siteFilter = '';
    let params = [];

    // Determine site access
    const assignedSites = JSON.parse(currentUser.assigned_sites || '[]');
    if (!assignedSites.includes('*')) {
      // For users with specific sites, only return users from those sites
      const placeholders = assignedSites.map((_, i) => `$${i + 1}`).join(',');
      siteFilter = `AND (assigned_sites::jsonb ?| ARRAY[${placeholders}])`;
      params = assignedSites;
    }

    // Query: only engineers and exec_engineers who are approved
    const query = `
      SELECT username, full_name, role, assigned_sites
      FROM users
      WHERE (role = 'engineer' OR role = 'exec_engineer')
        AND approved = true
        ${siteFilter}
      ORDER BY full_name
    `;

    const result = await pool.query(query, params);
    const users = result.rows.map(u => ({
      u: u.username,
      name: u.full_name || u.username,
      role: u.role,
      assigned_sites: JSON.parse(u.assigned_sites || '[]')
    }));
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// GET USERS BY ROLE (for notifications)
// =============================================
app.get('/api/users/role/:role', authenticateToken, async (req, res) => {
  try {
    const { role } = req.params;
    const result = await pool.query(
      "SELECT username, full_name, role FROM users WHERE role = $1 AND approved = true",
      [role]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ← PASTE HERE ↑↑↑

// =============================================
// 4. REPORTS API
// =============================================

app.get('/api/reports', authenticateToken, async (req, res) => {
  try {
    const reports = await getReportsForUser(req.user);
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM reports WHERE id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
      const row = result.rows[0];
    if (!userCanAccessReport(req.user, row)) {
      return res.status(403).json({ error: 'Access denied to this report' });
    }
    res.json(parseReportRow(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/by-rfi/:rfiNo', authenticateToken, async (req, res) => {
  try {
    const { rfiNo } = req.params;
    const allReports = await getReportsForUser(req.user);
    const checklists = allReports.filter(r =>
      r.templateKey !== 'rfi' &&
      (r.meta?.linkedRfi === rfiNo || r.raisedFromRfi === rfiNo)
    );
    const ncrList = allReports.filter(r =>
      r.templateKey === 'ncr' &&
      (r.raisedFromRfi === rfiNo || r.meta?.raisedFromRfi === rfiNo)
    );
    res.json({ checklists, ncrList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/:id/children', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const parentResult = await pool.query("SELECT * FROM reports WHERE id = $1", [id]);
    if (parentResult.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
       const parentRow = parentResult.rows[0];
    if (!userCanAccessReport(req.user, parentRow)) {
      return res.status(403).json({ error: 'Access denied to this report' });
    }

    const allReports = await getReportsForUser(req.user);
    const parent = parseReportRow(parentRow);
    const linkedKey = parent.meta?.rfiNo || parent.id;

    const checklists = allReports.filter(r =>
      r.templateKey !== 'rfi' &&
      (r.meta?.linkedRfi === linkedKey || r.raisedFromRfi === linkedKey)
    );
    const ncrList = allReports.filter(r =>
      r.templateKey === 'ncr' &&
      (r.raisedFromRfi === linkedKey || r.meta?.raisedFromRfi === linkedKey)
    );

    res.json({ report: parent, checklists, ncrList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reports', authenticateToken, async (req, res) => {
  try {
    const {
      id, template_key, template_name, format_no, meta, sections,
      score, defects_count, title_loc, prepared_by, status, comment,
      attachments, decision_by, decision_by_display, raised_from_rfi, site_name
    } = req.body;

    if (!id || !template_key || !site_name) {
      return res.status(400).json({ error: 'Missing required fields: id, template_key, site_name' });
    }
    const siteName = site_name || 'Default';
    if (!userHasSiteAccess(req.user, siteName)) {
      return res.status(403).json({ error: 'You do not have access to this site' });
    }

    const now = new Date().toISOString();
    const created_by = req.user.username;
    const created_by_display = req.user.full_name || req.user.username;

    await pool.query(
      `INSERT INTO reports (
        id, template_key, template_name, format_no, meta, sections,
        score, defects_count, title_loc, prepared_by, status, comment,
        attachments, created_by, created_by_display, decision_by,
        decision_by_display, saved_at, audit, raised_from_rfi, site_name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        id, template_key, template_name, format_no, JSON.stringify(meta || {}), JSON.stringify(sections || []),
        score || 0, defects_count || 0, title_loc || '', prepared_by || '', status || 'Draft', comment || '',
        JSON.stringify(attachments || []), created_by, created_by_display, decision_by || '',
        decision_by_display || '', now, JSON.stringify([]), raised_from_rfi || '', siteName
      ]
    );
    res.status(201).json({ message: 'Report saved', id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Report ID already exists' });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/reports/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      meta, sections, score, defects_count, title_loc, prepared_by,
      status, comment, attachments, decision_by, decision_by_display,
      saved_at, audit, raised_from_rfi
    } = req.body;

    const existing = await pool.query("SELECT * FROM reports WHERE id = $1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        const row = existing.rows[0];
    if (!userCanAccessReport(req.user, row)) {
      return res.status(403).json({ error: 'Access denied to this report' });
    }
    const fields = {
      meta: meta !== undefined ? JSON.stringify(meta) : row.meta,
      sections: sections !== undefined ? JSON.stringify(sections) : row.sections,
      score: score !== undefined ? score : row.score,
      defects_count: defects_count !== undefined ? defects_count : row.defects_count,
      title_loc: title_loc !== undefined ? title_loc : row.title_loc,
      prepared_by: prepared_by !== undefined ? prepared_by : row.prepared_by,
      status: status !== undefined ? status : row.status,
      comment: comment !== undefined ? comment : row.comment,
      attachments: attachments !== undefined ? JSON.stringify(attachments) : row.attachments,
      decision_by: decision_by !== undefined ? decision_by : row.decision_by,
      decision_by_display: decision_by_display !== undefined ? decision_by_display : row.decision_by_display,
      saved_at: saved_at !== undefined ? saved_at : row.saved_at,
      audit: audit !== undefined ? JSON.stringify(audit) : row.audit,
      raised_from_rfi: raised_from_rfi !== undefined ? raised_from_rfi : row.raised_from_rfi
    };

    const setClause = Object.keys(fields).map((key, i) => `${key} = $${i + 1}`).join(', ');
    const values = Object.values(fields);
    values.push(id);
    const query = `UPDATE reports SET ${setClause} WHERE id = $${values.length}`;
    await pool.query(query, values);
    res.json({ message: 'Report updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reports/:id', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM reports WHERE id = $1", [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Report not found' });
    res.json({ message: 'Report deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// 5. NOTIFICATIONS API
// =============================================

app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM notifications WHERE recipient_username = $1 ORDER BY created_at DESC",
      [req.user.username]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const { recipient_username, message, type, rfi_id, rfi_no, sender_name } = req.body;
    if (!recipient_username || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const id = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const created_at = new Date().toISOString();
    const sender = sender_name || req.user.full_name || req.user.username;

    await pool.query(
      `INSERT INTO notifications (id, recipient_username, message, type, rfi_id, rfi_no, sender_name, read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
      [id, recipient_username, message, type || 'info', rfi_id || '', rfi_no || '', sender, created_at]
    );
       // --- PUSH NOTIFICATIONS ---
    const recipientSubs = pushSubscriptions[recipient_username] || [];
    for (const sub of recipientSubs) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({
          title: 'QA/QC Suite',
          body: message,
          icon: '/icon.png',
          data: { rfi_id, rfi_no }
        }));
      } catch (err) {
        if (err.statusCode === 410) {
          pushSubscriptions[recipient_username] = pushSubscriptions[recipient_username].filter(s => s.endpoint !== sub.endpoint);
        } else {
          console.warn('Push send failed:', err.message);
        }
      }
    }
    
    res.status(201).json({ message: 'Notification sent', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "UPDATE notifications SET read = 1 WHERE id = $1 AND recipient_username = $2",
      [id, req.user.username]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// 6. COMBINED DATA ENDPOINT (for frontend)
// =============================================

app.get('/api/data', authenticateToken, async (req, res) => {
  try {
    const reports = await getReportsForUser(req.user);
    const notifResult = await pool.query(
      'SELECT * FROM notifications WHERE recipient_username = $1 ORDER BY created_at DESC',
      [req.user.username]
    );
    res.json({ reports, notifications: notifResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// 7. HEALTH CHECK
// =============================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'QA/QC Enterprise Server is running!' });
});

// =============================================
// 8. PUSH SUBSCRIPTION (moved before catch-all)
// =============================================
// Save push subscription for the logged-in user
app.post('/api/push/subscribe', authenticateToken, (req, res) => {
  try {
    const { subscription } = req.body;
    // Assume your auth middleware sets `req.user` with a `username` property
    const username = req.user.username;

    if (!pushSubscriptions[username]) pushSubscriptions[username] = [];
    // Remove older subscription with same endpoint to avoid duplicates
    pushSubscriptions[username] = pushSubscriptions[username].filter(s => s.endpoint !== subscription.endpoint);
    pushSubscriptions[username].push(subscription);

    res.json({ success: true });
  } catch (error) {
    console.error('Push subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// 9. SERVE FRONTEND (SPA catch‑all)
// =============================================

// Important: this must come AFTER all API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================
// 10. START SERVER
// =============================================

app.listen(PORT, async () => {
  await initDatabase();
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Serving static files from /public folder`);
});
