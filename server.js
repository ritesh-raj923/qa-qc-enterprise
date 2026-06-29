const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_change_in_production';

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- Database ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error opening database', err.message);
        process.exit(1);
    } else {
        console.log('✅ Connected to SQLite database.');
        initDatabase();
    }
});

// --- Database Initialisation (DROPS and recreates tables) ---
function initDatabase() {
    // 1. Drop all existing tables to start fresh (safe for first deployment)
    db.exec(`
        DROP TABLE IF EXISTS users;
        DROP TABLE IF EXISTS reports;
        DROP TABLE IF EXISTS notifications;

        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT,
            assigned_sites TEXT,
            full_name TEXT
        );

        CREATE TABLE reports (
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
        );

        CREATE TABLE notifications (
            id TEXT PRIMARY KEY,
            recipient_username TEXT,
            message TEXT,
            type TEXT,
            rfi_id TEXT,
            rfi_no TEXT,
            sender_name TEXT,
            read INTEGER DEFAULT 0,
            created_at TEXT
        );
    `, (err) => {
        if (err) {
            console.error('Error creating tables:', err);
            return;
        }
        console.log('✅ Tables created/verified.');

        // 2. Seed default users (only if users table is empty)
        db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
            if (err) {
                console.error('Error checking users:', err);
                return;
            }
            if (row.count === 0) {
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
                const stmt = db.prepare(`INSERT INTO users (username, password, role, assigned_sites, full_name) VALUES (?, ?, ?, ?, ?)`);
                defaultUsers.forEach(u => {
                    const hashed = bcrypt.hashSync(u.password, 10);
                    stmt.run(u.username, hashed, u.role, u.sites, u.full_name);
                });
                stmt.finalize();
                console.log('✅ Default users created.');
            } else {
                console.log('ℹ️ Users already exist, skipping seed.');
            }
        });
    });
}

// --- Helper Functions ---
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

function getUserByUsername(username, callback) {
    db.get("SELECT * FROM users WHERE username = ?", [username], callback);
}

function userHasSiteAccess(user, siteName) {
    const sites = user.assigned_sites || '[]';
    let assigned = [];
    try { assigned = JSON.parse(sites); } catch(e) { assigned = []; }
    if (assigned.includes('*')) return true;
    return assigned.includes(siteName);
}

function buildSiteFilter(user) {
    const sites = user.assigned_sites || '[]';
    let assigned = [];
    try { assigned = JSON.parse(sites); } catch(e) { assigned = []; }
    if (assigned.includes('*')) {
        return { sql: '', params: [] };
    }
    const placeholders = assigned.map(() => '?').join(',');
    return { sql: `WHERE site_name IN (${placeholders})`, params: assigned };
}

// --- AUTH APIs ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    getUserByUsername(username, (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const valid = bcrypt.compareSync(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, assigned_sites: user.assigned_sites },
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
    });
});

// --- REPORTS API ---
app.get('/api/reports', authenticateToken, (req, res) => {
    const filter = buildSiteFilter(req.user);
    let query = `SELECT * FROM reports ${filter.sql} ORDER BY saved_at DESC`;
    db.all(query, filter.params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const reports = rows.map(r => ({
            ...r,
            meta: JSON.parse(r.meta || '{}'),
            sections: JSON.parse(r.sections || '[]'),
            audit: JSON.parse(r.audit || '[]')
        }));
        res.json(reports);
    });
});

app.post('/api/reports', authenticateToken, (req, res) => {
    const { 
        id, template_key, template_name, format_no, meta, sections, 
        score, defects_count, title_loc, prepared_by, status, comment, 
        attachments, decision_by, decision_by_display, raised_from_rfi, site_name 
    } = req.body;

    if (!id || !template_key || !site_name) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!userHasSiteAccess(req.user, site_name)) {
        return res.status(403).json({ error: 'Access denied to this site' });
    }

    const now = new Date().toISOString();
    const created_by = req.user.username;
    const created_by_display = req.user.full_name || req.user.username;

    db.run(
        `INSERT INTO reports (
            id, template_key, template_name, format_no, meta, sections, 
            score, defects_count, title_loc, prepared_by, status, comment, 
            attachments, created_by, created_by_display, decision_by, 
            decision_by_display, saved_at, audit, raised_from_rfi, site_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id, template_key, template_name, format_no, JSON.stringify(meta || {}), JSON.stringify(sections || []),
            score || 0, defects_count || 0, title_loc || '', prepared_by || '', status || 'Draft', comment || '',
            JSON.stringify(attachments || []), created_by, created_by_display, decision_by || '',
            decision_by_display || '', now, JSON.stringify([]), raised_from_rfi || '', site_name
        ],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint')) {
                    return res.status(409).json({ error: 'Report ID already exists' });
                }
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ message: 'Report saved', id });
        }
    );
});

app.put('/api/reports/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { 
        meta, sections, score, defects_count, title_loc, prepared_by, 
        status, comment, attachments, decision_by, decision_by_display, 
        saved_at, audit, raised_from_rfi 
    } = req.body;

    db.get("SELECT * FROM reports WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Report not found' });
        if (!userHasSiteAccess(req.user, row.site_name)) {
            return res.status(403).json({ error: 'Access denied to this site' });
        }

        const updates = [];
        const params = [];
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
        Object.keys(fields).forEach(key => {
            updates.push(`${key} = ?`);
            params.push(fields[key]);
        });
        params.push(id);

        const query = `UPDATE reports SET ${updates.join(', ')} WHERE id = ?`;
        db.run(query, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Report not found' });
            res.json({ message: 'Report updated' });
        });
    });
});

app.delete('/api/reports/:id', authenticateToken, verifyAdmin, (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM reports WHERE id = ?", [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Report not found' });
        res.json({ message: 'Report deleted' });
    });
});

// --- NOTIFICATIONS API ---
app.get('/api/notifications', authenticateToken, (req, res) => {
    db.all(
        "SELECT * FROM notifications WHERE recipient_username = ? ORDER BY created_at DESC",
        [req.user.username],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/notifications', authenticateToken, (req, res) => {
    const { recipient_username, message, type, rfi_id, rfi_no, sender_name } = req.body;
    if (!recipient_username || !message) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const id = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const created_at = new Date().toISOString();
    const sender = sender_name || req.user.full_name || req.user.username;

    db.run(
        `INSERT INTO notifications (id, recipient_username, message, type, rfi_id, rfi_no, sender_name, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [id, recipient_username, message, type || 'info', rfi_id || '', rfi_no || '', sender, created_at],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ message: 'Notification sent', id });
        }
    );
});

app.put('/api/notifications/:id/read', authenticateToken, (req, res) => {
    const { id } = req.params;
    db.run(
        "UPDATE notifications SET read = 1 WHERE id = ? AND recipient_username = ?",
        [id, req.user.username],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Notification not found' });
            res.json({ message: 'Notification marked as read' });
        }
    );
});

// --- HEALTH CHECK ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'QA/QC Backend is running!' });
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Serving static files from /public folder`);
});
