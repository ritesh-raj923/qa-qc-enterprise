const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_here_change_in_production';

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- PostgreSQL Database Connection ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Neon.tech
});

// =============================================
// 1. DATABASE INITIALIZATION (Tables + Seed)
// =============================================
async function initDatabase() {
    try {
        // Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT,
                role TEXT,
                assigned_sites TEXT,
                full_name TEXT
            )
        `);

        // Reports table
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

        // Notifications table
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

        // Seed default users (if none exist)
        const result = await pool.query("SELECT COUNT(*) as count FROM users");
        if (parseInt(result.rows[0].count) === 0) {
            console.log('🌱 Seeding default users...');
            const defaultUsers = [
                { username: 'admin', password: 'Admin123', role: 'admin', full_name: 'System Admin', sites: '["*"]' },
                { username: 'exec_siteA', password: 'ExecA123', role: 'exec_engineer', full_name: 'Execution Engineer Site A', sites: '["Site-A"]' },
                { username: 'qa_siteA', password: 'QaA123', role: 'qa_head', full_name: 'QA Head Site A', sites: '["Site-A"]' },
                { username: 'contractor1_siteA', password: 'ContA123', role: 'engineer', full_name: 'Contractor 1 - Site A', sites: '["Site-A"]' },
                { username: 'contractor2_siteA', password: 'ContA456', role: 'engineer', full_name: 'Contractor 2 - Site A', sites: '["Site-A"]' },
                { username: 'exec_siteB', password: 'ExecB123', role: 'exec_engineer', full_name: 'Execution Engineer Site B', sites: '["Site-B"]' },
                { username: 'qa_siteB', password: 'QaB123', role: 'qa_head', full_name: 'QA Head Site B', sites: '["Site-B"]' },
                { username: 'contractor1_siteB', password: 'ContB123', role: 'engineer', full_name: 'Contractor 1 - Site B', sites: '["Site-B"]' },
                { username: 'manager', password: 'Mgr123', role: 'manager', full_name: 'Project Manager', sites: '["*"]' },
                { username: 'consultant', password: 'View123', role: 'consultant', full_name: 'Consultant', sites: '["*"]' }
            ];
            for (const u of defaultUsers) {
                const hashed = bcrypt.hashSync(u.password, 10);
                await pool.query(
                    `INSERT INTO users (username, password, role, assigned_sites, full_name) VALUES ($1, $2, $3, $4, $5)`,
                    [u.username, hashed, u.role, u.sites, u.full_name]
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

// Middleware: Verify JWT Token
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

// Middleware: Verify Admin role
function verifyAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// Helper: Get user by username
async function getUserByUsername(username) {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    return result.rows[0] || null;
}

// Helper: Check site access
function userHasSiteAccess(user, siteName) {
    const sites = user.assigned_sites || '[]';
    let assigned = [];
    try { assigned = JSON.parse(sites); } catch(e) { assigned = []; }
    if (assigned.includes('*')) return true;
    return assigned.includes(siteName);
}

// Helper: Build SQL filter for site
function buildSiteFilter(user) {
    const sites = user.assigned_sites || '[]';
    let assigned = [];
    try { assigned = JSON.parse(sites); } catch(e) { assigned = []; }
    if (assigned.includes('*')) {
        return { sql: '', params: [] };
    }
    const placeholders = assigned.map((_, i) => `$${i + 1}`).join(',');
    return { sql: `WHERE site_name IN (${placeholders})`, params: assigned };
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
                assigned_sites: JSON.parse(userInfo.assigned_sites)
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/users (Admin only)
app.get('/api/users', authenticateToken, verifyAdmin, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, username, role, assigned_sites, full_name FROM users");
        const users = result.rows.map(u => ({
            ...u,
            assigned_sites: JSON.parse(u.assigned_sites)
        }));
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/users (Admin only)
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

// DELETE /api/users/:username (Admin only)
app.delete('/api/users/:username', authenticateToken, verifyAdmin, async (req, res) => {
    try {
        const { username } = req.params;
        if (username === 'admin') {
            return res.status(403).json({ error: 'Cannot delete admin' });
        }
        const result = await pool.query("DELETE FROM users WHERE username = $1", [username]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================
// 4. REPORTS API
// =============================================

// GET /api/reports
app.get('/api/reports', authenticateToken, async (req, res) => {
    try {
        const filter = buildSiteFilter(req.user);
        let query = `SELECT * FROM reports ${filter.sql} ORDER BY saved_at DESC`;
        const result = await pool.query(query, filter.params);
        const reports = result.rows.map(r => ({
            ...r,
            meta: JSON.parse(r.meta || '{}'),
            sections: JSON.parse(r.sections || '[]'),
            audit: JSON.parse(r.audit || '[]')
        }));
        res.json(reports);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/reports/:id
app.get('/api/reports/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query("SELECT * FROM reports WHERE id = $1", [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        const row = result.rows[0];
        if (!userHasSiteAccess(req.user, row.site_name)) {
            return res.status(403).json({ error: 'Access denied to this site' });
        }
        res.json({
            ...row,
            meta: JSON.parse(row.meta || '{}'),
            sections: JSON.parse(row.sections || '[]'),
            audit: JSON.parse(row.audit || '[]')
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/reports
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
        if (!userHasSiteAccess(req.user, site_name)) {
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
                decision_by_display || '', now, JSON.stringify([]), raised_from_rfi || '', site_name
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

// PUT /api/reports/:id
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
        if (!userHasSiteAccess(req.user, row.site_name)) {
            return res.status(403).json({ error: 'Access denied to this site' });
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

// DELETE /api/reports/:id (Admin only)
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
        const filter = buildSiteFilter(req.user);
        const query = `SELECT * FROM reports ${filter.sql} ORDER BY saved_at DESC`;
        const result = await pool.query(query, filter.params);
        const reports = result.rows.map(r => ({
            ...r,
            meta: JSON.parse(r.meta || '{}'),
            sections: JSON.parse(r.sections || '[]'),
            audit: JSON.parse(r.audit || '[]')
        }));
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
// 8. START SERVER
// =============================================

app.listen(PORT, async () => {
    await initDatabase();
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Serving static files from /public folder`);
});
