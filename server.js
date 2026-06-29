const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = 'your_super_secret_key_here_change_in_production'; // ⚠️ CHANGE THIS!

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

// =============================================
// 1. DATABASE INITIALIZATION (Tables + Seed)
// =============================================
function initDatabase() {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        assigned_sites TEXT,
        full_name TEXT
    )`);

    // Reports table (RFI, NCR, Checklists)
    db.run(`CREATE TABLE IF NOT EXISTS reports (
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
    )`);

    // Notifications table
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        recipient_username TEXT,
        message TEXT,
        type TEXT,
        rfi_id TEXT,
        rfi_no TEXT,
        sender_name TEXT,
        read INTEGER DEFAULT 0,
        created_at TEXT
    )`);

    // Seed default users (if none exist)
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (err) return console.error(err);
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
        }
    });
}

// =============================================
// 2. HELPER FUNCTIONS
// =============================================

// Middleware: Verify JWT Token and attach user to request
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
function getUserByUsername(username, callback) {
    db.get("SELECT * FROM users WHERE username = ?", [username], callback);
}

// Helper: Check if a user has access to a specific site
function userHasSiteAccess(user, siteName) {
    const sites = user.assigned_sites || '[]';
    let assigned = [];
    try { assigned = JSON.parse(sites); } catch(e) { assigned = []; }
    if (assigned.includes('*')) return true;
    return assigned.includes(siteName);
}

// Helper: Build SQL placeholder string for site filtering
function buildSiteFilter(user) {
    const sites = user.assigned_sites || '[]';
    let assigned = [];
    try { assigned = JSON.parse(sites); } catch(e) { assigned = []; }
    if (assigned.includes('*')) {
        return { sql: '', params: [] }; // No filter, get all
    }
    const placeholders = assigned.map(() => '?').join(',');
    return { sql: `WHERE site_name IN (${placeholders})`, params: assigned };
}

// =============================================
// 3. AUTH APIs (Login + User Management)
// =============================================

// POST /api/login
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

// GET /api/users (Admin only)
app.get('/api/users', authenticateToken, verifyAdmin, (req, res) => {
    db.all("SELECT id, username, role, assigned_sites, full_name FROM users", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const users = rows.map(u => ({
            ...u,
            assigned_sites: JSON.parse(u.assigned_sites)
        }));
        res.json(users);
    });
});

// POST /api/users (Admin only)
app.post('/api/users', authenticateToken, verifyAdmin, (req, res) => {
    const { username, password, role, assigned_sites, full_name } = req.body;
    if (!username || !password || !role || !assigned_sites) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const hashed = bcrypt.hashSync(password, 10);
    const sitesJson = JSON.stringify(assigned_sites);
    db.run(
        `INSERT INTO users (username, password, role, assigned_sites, full_name) VALUES (?, ?, ?, ?, ?)`,
        [username, hashed, role, sitesJson, full_name || ''],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint')) {
                    return res.status(409).json({ error: 'Username already exists' });
                }
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ id: this.lastID, message: 'User created' });
        }
    );
});

// DELETE /api/users/:username (Admin only)
app.delete('/api/users/:username', authenticateToken, verifyAdmin, (req, res) => {
    const { username } = req.params;
    if (username === 'admin') {
        return res.status(403).json({ error: 'Cannot delete admin' });
    }
    db.run("DELETE FROM users WHERE username = ?", [username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User deleted' });
    });
});

// =============================================
// 4. REPORTS API (RFI, NCR, Checklists)
// =============================================

// GET /api/reports - Fetch all reports (filtered by site)
app.get('/api/reports', authenticateToken, (req, res) => {
    const filter = buildSiteFilter(req.user);
    let query = `SELECT * FROM reports ${filter.sql} ORDER BY saved_at DESC`;
    db.all(query, filter.params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Parse JSON fields for each row
        const reports = rows.map(r => ({
            ...r,
            meta: JSON.parse(r.meta || '{}'),
            sections: JSON.parse(r.sections || '[]'),
            audit: JSON.parse(r.audit || '[]')
        }));
        res.json(reports);
    });
});

// GET /api/reports/:id - Fetch a single report
app.get('/api/reports/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    db.get("SELECT * FROM reports WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Report not found' });
        // Check site access
        if (!userHasSiteAccess(req.user, row.site_name)) {
            return res.status(403).json({ error: 'Access denied to this site' });
        }
        res.json({
            ...row,
            meta: JSON.parse(row.meta || '{}'),
            sections: JSON.parse(row.sections || '[]'),
            audit: JSON.parse(row.audit || '[]')
        });
    });
});

// POST /api/reports - Create a new report
app.post('/api/reports', authenticateToken, (req, res) => {
    const { 
        id, template_key, template_name, format_no, meta, sections, 
        score, defects_count, title_loc, prepared_by, status, comment, 
        attachments, decision_by, decision_by_display, raised_from_rfi, site_name 
    } = req.body;

    // Validate required fields
    if (!id || !template_key || !site_name) {
        return res.status(400).json({ error: 'Missing required fields: id, template_key, site_name' });
    }

    // Check if user has access to this site
    if (!userHasSiteAccess(req.user, site_name)) {
        return res.status(403).json({ error: 'You do not have access to this site' });
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

// PUT /api/reports/:id - Update a report
app.put('/api/reports/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { 
        meta, sections, score, defects_count, title_loc, prepared_by, 
        status, comment, attachments, decision_by, decision_by_display, 
        saved_at, audit, raised_from_rfi 
    } = req.body;

    // First, fetch the existing report to check site access
    db.get("SELECT * FROM reports WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Report not found' });
        
        if (!userHasSiteAccess(req.user, row.site_name)) {
            return res.status(403).json({ error: 'Access denied to this site' });
        }

        // Build update query dynamically
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

// DELETE /api/reports/:id - Delete a report (Admin only)
app.delete('/api/reports/:id', authenticateToken, verifyAdmin, (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM reports WHERE id = ?", [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Report not found' });
        res.json({ message: 'Report deleted' });
    });
});

// =============================================
// 5. NOTIFICATIONS API
// =============================================

// GET /api/notifications - Fetch notifications for the logged-in user
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

// POST /api/notifications - Send a notification
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

// PUT /api/notifications/:id/read - Mark a notification as read
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

// =============================================
// 6. HEALTH CHECK
// =============================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'QA/QC Enterprise Server is running!' });
});

// =============================================
// 7. START SERVER
// =============================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Serving static files from /public folder`);
});