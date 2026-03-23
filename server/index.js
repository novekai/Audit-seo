import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDb } from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { encrypt } from './utils/encrypt.js';
import {
    createAirtableAudit,
    deleteAirtableAudit,
    GENERATED_ACTION_PLAN_FIELD_NAME,
    getAirtableRecord,
    readGeneratedActionPlanUrl,
    readGeneratedSlidesUrl,
    updateAirtableStatut
} from './airtable.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { auditQueue } from './jobs/queue.js';
import { initWorker } from './jobs/worker.js';
import { initAirtablePoller } from './jobs/airtablePoller.js';
import { reconcileAuditCompletion } from './utils/auditStatus.js';
import { generateActionPlanSheet } from './modules/action_plan_sheet.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '..', 'dist');

import cookieParser from 'cookie-parser';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: 'http://localhost:5173',
        credentials: true
    }
});

const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.JWT_SECRET || 'votre_cle_secrete_super_secure';
const DEFAULT_GOOGLE_SLIDES_WEBHOOK_URL =
    process.env.GOOGLE_SLIDES_WEBHOOK_URL ||
    'https://primary-production-2eb79.up.railway.app/webhook/4f510189-32ea-4c74-af0f-2786b57308cf';
const DEFAULT_GOOGLE_ACTION_PLAN_WEBHOOK_URL =
    process.env.GOOGLE_ACTION_PLAN_WEBHOOK_URL ||
    '';
const SLIDES_GENERATION_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const SLIDES_AIRTABLE_POLL_INTERVAL_MS = 1000;
const SLIDES_AIRTABLE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const GOOGLE_SLIDES_URL_REGEX = /https?:\/\/docs\.google\.com\/presentation\/d\/[^\s"'<>]+/i;
const GOOGLE_SHEETS_URL_REGEX = /https?:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s"'<>]+/i;
const GOOGLE_SLIDES_ID_KEYS = new Set([
    'presentationid',
    'googleslidesid',
    'slidesid',
    'presentationdocid'
]);
const GOOGLE_SHEETS_ID_KEYS = new Set([
    'spreadsheetid',
    'googlesheetid',
    'googlespreadsheetid',
    'sheetid'
]);

app.use(cors({
    origin: 'http://localhost:5173', // Vite default
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Simple memory-based lockout (Redis for production)
const loginAttempts = new Map();

// Log requests
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Serve static files from the React app dist folder
app.use(express.static(distPath));

// Auth Middleware
const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.sendStatus(401);

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

function normalizeSlidesKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z]/g, '');
}

function summarizeSlidesMessage(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function buildGoogleSlidesUrlFromId(presentationId) {
    return `https://docs.google.com/presentation/d/${presentationId}/edit`;
}

function buildGoogleSheetUrlFromId(spreadsheetId) {
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function buildSlidesWebhookCandidates(recordId) {
    const primaryUrl = new URL(DEFAULT_GOOGLE_SLIDES_WEBHOOK_URL);
    primaryUrl.searchParams.set('RECORD_ID', recordId);

    const candidates = [primaryUrl];

    if (primaryUrl.pathname.includes('/webhook-test/')) {
        const fallbackUrl = new URL(primaryUrl.toString());
        fallbackUrl.pathname = fallbackUrl.pathname.replace('/webhook-test/', '/webhook/');

        if (fallbackUrl.toString() !== primaryUrl.toString()) {
            candidates.push(fallbackUrl);
        }
    }

    return candidates;
}

function buildActionPlanWebhookCandidates(recordId) {
    if (!DEFAULT_GOOGLE_ACTION_PLAN_WEBHOOK_URL) {
        return [];
    }

    const primaryUrl = new URL(DEFAULT_GOOGLE_ACTION_PLAN_WEBHOOK_URL);
    primaryUrl.searchParams.set('RECORD_ID', recordId);

    const candidates = [primaryUrl];

    if (primaryUrl.pathname.includes('/webhook-test/')) {
        const fallbackUrl = new URL(primaryUrl.toString());
        fallbackUrl.pathname = fallbackUrl.pathname.replace('/webhook-test/', '/webhook/');

        if (fallbackUrl.toString() !== primaryUrl.toString()) {
            candidates.push(fallbackUrl);
        }
    }

    return candidates;
}

function extractGoogleSlidesUrl(value, visited = new Set()) {
    if (!value) return null;

    if (typeof value === 'string') {
        const match = value.match(GOOGLE_SLIDES_URL_REGEX);
        return match ? match[0].replace(/[),.;]+$/, '') : null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const match = extractGoogleSlidesUrl(item, visited);
            if (match) return match;
        }
        return null;
    }

    if (typeof value === 'object') {
        if (visited.has(value)) return null;
        visited.add(value);

        for (const [key, nestedValue] of Object.entries(value)) {
            if (
                typeof nestedValue === 'string' &&
                GOOGLE_SLIDES_ID_KEYS.has(normalizeSlidesKey(key)) &&
                nestedValue.trim()
            ) {
                return buildGoogleSlidesUrlFromId(nestedValue.trim());
            }

            const match = extractGoogleSlidesUrl(nestedValue, visited);
            if (match) return match;
        }
    }

    return null;
}

function extractGoogleSheetUrl(value, visited = new Set()) {
    if (!value) return null;

    if (typeof value === 'string') {
        const match = value.match(GOOGLE_SHEETS_URL_REGEX);
        return match ? match[0].replace(/[),.;]+$/, '') : null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const match = extractGoogleSheetUrl(item, visited);
            if (match) return match;
        }
        return null;
    }

    if (typeof value === 'object') {
        if (visited.has(value)) return null;
        visited.add(value);

        for (const [key, nestedValue] of Object.entries(value)) {
            if (
                typeof nestedValue === 'string' &&
                GOOGLE_SHEETS_ID_KEYS.has(normalizeSlidesKey(key)) &&
                nestedValue.trim()
            ) {
                return buildGoogleSheetUrlFromId(nestedValue.trim());
            }

            const match = extractGoogleSheetUrl(nestedValue, visited);
            if (match) return match;
        }
    }

    return null;
}

function extractSlidesErrorMessage(value, visited = new Set()) {
    if (!value) return null;

    if (typeof value === 'string') {
        return summarizeSlidesMessage(value);
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const message = extractSlidesErrorMessage(item, visited);
            if (message) return message;
        }
        return null;
    }

    if (typeof value === 'object') {
        if (visited.has(value)) return null;
        visited.add(value);

        const priorityKeys = ['error', 'message', 'detail', 'details'];
        for (const key of priorityKeys) {
            if (key in value) {
                const message = extractSlidesErrorMessage(value[key], visited);
                if (message) return message;
            }
        }

        for (const nestedValue of Object.values(value)) {
            const message = extractSlidesErrorMessage(nestedValue, visited);
            if (message) return message;
        }
    }

    return null;
}

function extractActionPlanErrorMessage(value, visited = new Set()) {
    return extractSlidesErrorMessage(value, visited);
}

function buildSlidesAcceptedMessage(rawMessage) {
    const message = summarizeSlidesMessage(rawMessage);

    if (!message || /workflow was started/i.test(message)) {
        return 'La génération du Google Slides a été lancée. Le lien sera disponible une fois le workflow terminé.';
    }

    return message;
}

function buildActionPlanAcceptedMessage(rawMessage) {
    const message = summarizeSlidesMessage(rawMessage);

    if (!message || /workflow was started/i.test(message)) {
        return 'La génération du Google Sheet plan d’actions a été lancée. Le lien sera disponible une fois le workflow terminé.';
    }

    return message;
}

function isSlidesGenerationLockStale(audit) {
    if (!audit || audit.slides_generation_status !== 'EN_COURS' || !audit.updated_at) {
        return false;
    }

    const updatedAtMs = new Date(audit.updated_at).getTime();
    if (!Number.isFinite(updatedAtMs)) {
        return false;
    }

    return Date.now() - updatedAtMs > SLIDES_GENERATION_LOCK_TIMEOUT_MS;
}

function isActionPlanGenerationLockStale(audit) {
    if (!audit || audit.action_plan_generation_status !== 'EN_COURS' || !audit.updated_at) {
        return false;
    }

    const updatedAtMs = new Date(audit.updated_at).getTime();
    if (!Number.isFinite(updatedAtMs)) {
        return false;
    }

    return Date.now() - updatedAtMs > SLIDES_GENERATION_LOCK_TIMEOUT_MS;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeSlidesAirtablePollers = new Map();
const activeActionPlanAirtablePollers = new Map();

async function syncSlidesLinkFromAirtable(auditId, airtableRecordId) {
    const airtableRecord = await getAirtableRecord(airtableRecordId);
    const googleSlidesUrl = readGeneratedSlidesUrl(airtableRecord);

    if (!googleSlidesUrl) {
        return null;
    }

    await db.run(
        `UPDATE audits
         SET google_slides_url = ?,
             slides_generation_status = ?,
             slides_generation_error = NULL,
             slides_generated_at = CURRENT_TIMESTAMP,
             slides_review_confirmed_at = NULL,
             google_action_plan_url = NULL,
             action_plan_generation_status = 'NON_GENERE',
             action_plan_generation_error = NULL,
             action_plan_generated_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [googleSlidesUrl, 'PRET', auditId]
    );

    const updatedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
    io.emit('audit:update', updatedAudit);
    console.log(`[SLIDES] Google Slides link synced from Airtable for audit ${auditId}`);

    return updatedAudit;
}

function watchSlidesLinkInAirtable(auditId, airtableRecordId) {
    if (activeSlidesAirtablePollers.has(auditId)) {
        return activeSlidesAirtablePollers.get(auditId);
    }

    const watcherPromise = (async () => {
        const deadline = Date.now() + SLIDES_AIRTABLE_POLL_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const currentAudit = await db.get(
                'SELECT google_slides_url, slides_generation_status FROM audits WHERE id = ?',
                [auditId]
            );

            if (!currentAudit) {
                return null;
            }

            if (currentAudit.google_slides_url || currentAudit.slides_generation_status === 'PRET') {
                return currentAudit;
            }

            if (currentAudit.slides_generation_status === 'ERREUR') {
                return null;
            }

            try {
                const updatedAudit = await syncSlidesLinkFromAirtable(auditId, airtableRecordId);
                if (updatedAudit?.google_slides_url) {
                    return updatedAudit;
                }
            } catch (err) {
                console.error(`[SLIDES] Airtable polling error for audit ${auditId}:`, err.message);
            }

            await delay(SLIDES_AIRTABLE_POLL_INTERVAL_MS);
        }

        await db.run(
            `UPDATE audits
             SET slides_generation_status = ?,
                 slides_generation_error = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND slides_generation_status = ?`,
            [
                'ERREUR',
                'Le workflow Slides a été lancé, mais le champ Airtable "Document Slide Généré" n’a pas été renseigné dans le délai attendu.',
                auditId,
                'EN_COURS'
            ]
        );

        const timeoutAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
        if (timeoutAudit) {
            io.emit('audit:update', timeoutAudit);
        }

        console.warn(`[SLIDES] Airtable polling timed out for audit ${auditId}`);
        return null;
    })().finally(() => {
        activeSlidesAirtablePollers.delete(auditId);
    });

    activeSlidesAirtablePollers.set(auditId, watcherPromise);
    return watcherPromise;
}

async function syncActionPlanLinkFromAirtable(auditId, airtableRecordId) {
    const airtableRecord = await getAirtableRecord(airtableRecordId);
    const googleActionPlanUrl = readGeneratedActionPlanUrl(airtableRecord);

    if (!googleActionPlanUrl) {
        return null;
    }

    await db.run(
        `UPDATE audits
         SET google_action_plan_url = ?,
             action_plan_generation_status = ?,
             action_plan_generation_error = NULL,
             action_plan_generated_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [googleActionPlanUrl, 'PRET', auditId]
    );

    const updatedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
    io.emit('audit:update', updatedAudit);
    console.log(`[ACTION PLAN] Google Sheet link synced from Airtable for audit ${auditId}`);

    return updatedAudit;
}

function watchActionPlanLinkInAirtable(auditId, airtableRecordId) {
    if (activeActionPlanAirtablePollers.has(auditId)) {
        return activeActionPlanAirtablePollers.get(auditId);
    }

    const watcherPromise = (async () => {
        const deadline = Date.now() + SLIDES_AIRTABLE_POLL_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const currentAudit = await db.get(
                'SELECT google_action_plan_url, action_plan_generation_status FROM audits WHERE id = ?',
                [auditId]
            );

            if (!currentAudit) {
                return null;
            }

            if (currentAudit.google_action_plan_url || currentAudit.action_plan_generation_status === 'PRET') {
                return currentAudit;
            }

            if (currentAudit.action_plan_generation_status === 'ERREUR') {
                return null;
            }

            try {
                const updatedAudit = await syncActionPlanLinkFromAirtable(auditId, airtableRecordId);
                if (updatedAudit?.google_action_plan_url) {
                    return updatedAudit;
                }
            } catch (err) {
                console.error(`[ACTION PLAN] Airtable polling error for audit ${auditId}:`, err.message);
            }

            await delay(SLIDES_AIRTABLE_POLL_INTERVAL_MS);
        }

        await db.run(
            `UPDATE audits
             SET action_plan_generation_status = ?,
                 action_plan_generation_error = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND action_plan_generation_status = ?`,
            [
                'ERREUR',
                `Le workflow plan d’actions a été lancé, mais le champ Airtable "${GENERATED_ACTION_PLAN_FIELD_NAME}" n’a pas été renseigné dans le délai attendu.`,
                auditId,
                'EN_COURS'
            ]
        );

        const timeoutAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
        if (timeoutAudit) {
            io.emit('audit:update', timeoutAudit);
        }

        console.warn(`[ACTION PLAN] Airtable polling timed out for audit ${auditId}`);
        return null;
    })().finally(() => {
        activeActionPlanAirtablePollers.delete(auditId);
    });

    activeActionPlanAirtablePollers.set(auditId, watcherPromise);
    return watcherPromise;
}

async function triggerGoogleSlidesWebhook(recordId) {
    const webhookCandidates = buildSlidesWebhookCandidates(recordId);
    let lastError = null;

    for (const webhookUrl of webhookCandidates) {
        console.log(`[SLIDES] Calling webhook: ${webhookUrl.toString()}`);
        const response = await fetch(webhookUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(120000)
        });
        console.log(`[SLIDES] Webhook response status: ${response.status}`);

        const rawText = await response.text();
        let payload = rawText;

        if (rawText) {
            try {
                payload = JSON.parse(rawText);
            } catch { }
        }

        const googleSlidesUrl =
            extractGoogleSlidesUrl(payload) ||
            extractGoogleSlidesUrl(rawText) ||
            extractGoogleSlidesUrl(response.url);

        if (!response.ok) {
            lastError = new Error(
                extractSlidesErrorMessage(payload) ||
                summarizeSlidesMessage(rawText) ||
                `Le webhook Slides a répondu avec le statut ${response.status}.`
            );

            const canFallbackToProduction =
                response.status === 404 &&
                webhookUrl.pathname.includes('/webhook-test/');

            if (canFallbackToProduction) {
                continue;
            }

            throw lastError;
        }

        if (googleSlidesUrl) {
            return {
                googleSlidesUrl,
                webhookUrl: webhookUrl.toString(),
                asynchronous: false,
                message: 'Google Slides généré avec succès'
            };
        }

        return {
            googleSlidesUrl: null,
            webhookUrl: webhookUrl.toString(),
            asynchronous: true,
            message: buildSlidesAcceptedMessage(
                extractSlidesErrorMessage(payload) || rawText
            )
        };
    }

    throw lastError || new Error('Impossible de contacter le webhook Google Slides.');
}

async function triggerGoogleActionPlanWebhook(recordId) {
    const webhookCandidates = buildActionPlanWebhookCandidates(recordId);
    let lastError = null;

    if (webhookCandidates.length === 0) {
        throw new Error('Le webhook Google Sheet plan d’actions n’est pas configuré.');
    }

    for (const webhookUrl of webhookCandidates) {
        console.log(`[ACTION PLAN] Calling webhook: ${webhookUrl.toString()}`);
        const response = await fetch(webhookUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(120000)
        });
        console.log(`[ACTION PLAN] Webhook response status: ${response.status}`);

        const rawText = await response.text();
        let payload = rawText;

        if (rawText) {
            try {
                payload = JSON.parse(rawText);
            } catch { }
        }

        const googleActionPlanUrl =
            extractGoogleSheetUrl(payload) ||
            extractGoogleSheetUrl(rawText) ||
            extractGoogleSheetUrl(response.url);

        if (!response.ok) {
            lastError = new Error(
                extractActionPlanErrorMessage(payload) ||
                summarizeSlidesMessage(rawText) ||
                `Le webhook Google Sheet plan d’actions a répondu avec le statut ${response.status}.`
            );

            const canFallbackToProduction =
                response.status === 404 &&
                webhookUrl.pathname.includes('/webhook-test/');

            if (canFallbackToProduction) {
                continue;
            }

            throw lastError;
        }

        if (googleActionPlanUrl) {
            return {
                googleActionPlanUrl,
                webhookUrl: webhookUrl.toString(),
                asynchronous: false,
                message: 'Google Sheet plan d’actions généré avec succès'
            };
        }

        return {
            googleActionPlanUrl: null,
            webhookUrl: webhookUrl.toString(),
            asynchronous: true,
            message: buildActionPlanAcceptedMessage(
                extractActionPlanErrorMessage(payload) || rawText
            )
        };
    }

    throw lastError || new Error('Impossible de contacter le webhook Google Sheet plan d’actions.');
}

let db;

async function startServer() {
    try {
        db = await initDb();
        console.log('[DB] Database initialized successfully');

        // Initialize Background Services
        initWorker(io, db);
        initAirtablePoller(io, db);

        httpServer.listen(PORT, () => {
            console.log(`[SERVER] Running on port ${PORT}`);
            console.log(`[SERVER] Serving static files from: ${distPath}`);
            console.log(`[SERVER] API available at http://localhost:${PORT}/api`);
        });
    } catch (err) {
        console.error('[CRITICAL] Failed to initialize database:', err);
        process.exit(1);
    }
}

startServer();

// Socket.io Room Logic
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('join-audit', (auditId) => {
        socket.join(`audit:${auditId}`);
        console.log(`Client ${socket.id} joined audit room: ${auditId}`);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        const dbStatus = db ? 'OK' : 'LOCKED';
        const redisStatus = auditQueue ? 'OK' : 'FAIL';
        res.json({ status: 'UP', db: dbStatus, redis: redisStatus });
    } catch (err) {
        res.status(500).json({ status: 'DOWN', error: err.message });
    }
});

// API Routes
// Register
app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    if (!db) return res.status(503).json({ error: 'Base de données en cours de chargement' });
    const id = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 12); // Cost 12 as per instructions

    try {
        await db.run('INSERT INTO users (id, email, password) VALUES (?, ?, ?)', [id, email, hashedPassword]);
        res.status(201).json({ message: 'Compte créé avec succès' });
    } catch (error) {
        const isDuplicateEmail = error?.code === '23505' || (error.message && error.message.includes('UNIQUE'));
        const msg = isDuplicateEmail ? 'Email déjà utilisé' : 'Erreur serveur';
        res.status(400).json({ error: msg });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!db) return res.status(503).json({ error: 'Base de données en cours de chargement' });

    // Check lockout
    const attempts = loginAttempts.get(email) || { count: 0, last: 0 };
    if (attempts.count >= 5 && Date.now() - attempts.last < 15 * 60 * 1000) {
        return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    }

    try {
        console.log(`[AUTH] Login attempt for: ${email}`);
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (user && await bcrypt.compare(password, user.password)) {
            // Success: Reset attempts
            loginAttempts.delete(email);

            const token = jwt.sign({ userId: user.id }, SECRET_KEY, { expiresIn: '24h' });

            res.cookie('token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 24 * 60 * 60 * 1000
            });

            res.json({ user: { email: user.email, id: user.id } });
        } else {
            // Fail: Increment attempts
            attempts.count += 1;
            attempts.last = Date.now();
            loginAttempts.set(email, attempts);
            res.status(401).json({ error: 'Email ou mot de passe incorrect' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Déconnecté' });
});

// Check Auth Status (for frontend refresh)
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    const user = await db.get('SELECT id, email FROM users WHERE id = ?', [req.user.userId]);
    res.json(user);
});

// ── Cookie Import (JSON from Cookie-Editor extension) ──────────────────
app.post('/api/sessions/import/:service', authenticateToken, async (req, res) => {
    const { service } = req.params;
    const userId = req.user.userId;
    if (!db) return res.status(503).json({ error: 'Base de données en cours de chargement' });

    const validServices = ['google', 'mrm', 'ubersuggest'];
    if (!validServices.includes(service)) {
        return res.status(400).json({ error: `Service non supporté. Utilisez: ${validServices.join(', ')}` });
    }

    try {
        const { cookies } = req.body;
        if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
            return res.status(400).json({ error: 'Format invalide. Exportez vos cookies depuis Cookie-Editor au format JSON.' });
        }

        // Normalize cookie format (Cookie-Editor uses different casing)
        const normalized = cookies.map(c => ({
            name: c.name || c.Name,
            value: c.value || c.Value,
            domain: c.domain || c.Domain || '',
            path: c.path || c.Path || '/',
            secure: c.secure ?? c.Secure ?? false,
            httpOnly: c.httpOnly ?? c.HttpOnly ?? false,
            sameSite: (c.sameSite || c.SameSite || 'Lax'),
            expires: c.expirationDate || c.expires || -1
        })).filter(c => c.name && c.value);

        if (normalized.length === 0) {
            return res.status(400).json({ error: 'Aucun cookie valide trouvé dans le JSON.' });
        }

        console.log(`[SESSION] Importing ${normalized.length} cookies for ${service} (user: ${userId})`);

        const encryptedCookies = encrypt(JSON.stringify(normalized));
        const sessionId = uuidv4();

        await db.run('DELETE FROM user_sessions WHERE user_id = ? AND service = ?', [userId, service]);
        await db.run(
            'INSERT INTO user_sessions (id, user_id, service, encrypted_cookies) VALUES (?, ?, ?, ?)',
            [sessionId, userId, service, encryptedCookies]
        );

        console.log(`[SESSION] SUCCESS: ${normalized.length} cookies stored for ${service}`);
        res.json({ message: `${normalized.length} cookies importés pour ${service}`, count: normalized.length });

    } catch (err) {
        console.error('[SESSION] Import error:', err);
        res.status(500).json({ error: err.message || 'Erreur lors de l\'import des cookies' });
    }
});

// ── Cookie Delete ──────────────────────────────────────────────────────
app.delete('/api/sessions/delete/:service', authenticateToken, async (req, res) => {
    const { service } = req.params;
    const userId = req.user.userId;
    if (!db) return res.status(503).json({ error: 'Base de données en cours de chargement' });

    try {
        await db.run('DELETE FROM user_sessions WHERE user_id = ? AND service = ?', [userId, service]);
        console.log(`[SESSION] Deleted cookies for ${service} (user: ${userId})`);
        res.json({ message: `Cookies ${service} supprimés` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Create Audit
app.post('/api/audits', authenticateToken, async (req, res) => {
    const { siteName, siteUrl, auditSheetUrl, actionPlanSheetUrl, mrmReportUrl } = req.body;
    const userId = req.user.userId;
    if (!db) return res.status(503).json({ error: 'Base de données en cours de chargement' });

    try {
        // 1. Create Airtable Record
        const airtableId = await createAirtableAudit(req.body);

        // 2. Create Audit in DB
        const auditId = uuidv4();
        await db.run(
            'INSERT INTO audits (id, user_id, nom_site, url_site, sheet_audit_url, sheet_plan_url, mrm_report_url, airtable_record_id, statut_global) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [auditId, userId, siteName, siteUrl, auditSheetUrl, actionPlanSheetUrl, mrmReportUrl, airtableId, 'EN_ATTENTE']
        );

        // 3. Initialize Steps — matches exactly the step_keys used by worker.js
        const steps = [
            // Phase 1: Public captures (no auth)
            'robots_txt', 'sitemap', 'logo',
            'ami_responsive', 'responsive_menu_mobile_1', 'responsive_menu_mobile_2', 'ssl_labs',
            'psi_mobile', 'psi_desktop',
            // Phase 2: Google Sheets — Audit
            'sheet_images', 'sheet_meme_title', 'sheet_meta_desc_double',
            'sheet_doublons_h1', 'sheet_h1_absente', 'sheet_h1_vides',
            'sheet_h1_au_moins', 'sheet_hn_pas_h1', 'sheet_sauts_hn',
            'sheet_hn_longue', 'sheet_mots_body', 'sheet_meta_desc',
            'sheet_balise_title',
            // Phase 3: Google Sheets — Plan d'action
            'plan_synthese', 'plan_requetes', 'plan_donnees_img', 'plan_longueur',
            // Phase 4: Google Search Console
            'gsc_sitemaps', 'gsc_https',
            // Phase 5: Authenticated sessions
            'mrm_profondeur', 'ubersuggest_da',
            // Phase 6: Anti-bot crawls
            'semrush_authority', 'ahrefs_authority',
            // Phase 7: Additional checks
            'check_404',
            'gsc_performance', 'gsc_meilleure_requete', 'gsc_query_page_clicks_impressions',
            'gsc_coverage', 'gsc_indexation_image', 'gsc_problemes_indexation', 'gsc_top_pages',
            'majestic_backlinks'
        ];

        for (const stepKey of steps) {
            await db.run(
                'INSERT INTO audit_steps (id, audit_id, step_key, statut) VALUES (?, ?, ?, ?)',
                [uuidv4(), auditId, stepKey, 'EN_ATTENTE']
            );
        }

        // 5. Add to BullMQ queue with timeout protection
        try {
            const queuePromise = auditQueue.add(`audit-${auditId}`, { auditId, userId });
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Redis Timeout')), 5000)
            );
            await Promise.race([queuePromise, timeoutPromise]);
            console.log(`[QUEUE] Audit ${auditId} successfully added to queue`);
        } catch (queueErr) {
            console.error('[QUEUE ERROR]:', queueErr.message);

            await db.run(
                'UPDATE audits SET statut_global = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                ['ERREUR', auditId]
            );

            if (airtableId) {
                await updateAirtableStatut(airtableId, 'Erreur');
            }

            const failedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            io.emit('audit:created', failedAudit);

            return res.status(503).json({
                error: 'L’audit a été créé mais n’a pas pu démarrer. La file de traitement Redis est indisponible.',
                auditId,
                audit: failedAudit
            });
        }

        // 6. Notify clients via Socket.io
        const createdAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
        io.emit('audit:created', createdAudit);

        res.status(201).json({ auditId, message: 'Audit mis en file avec succès', audit: createdAudit });
    } catch (err) {
        console.error('SERVER ERROR (audit):', err);
        res.status(500).json({ error: 'Erreur lors de la création de l\'audit: ' + err.message });
    }
});

// // Retry failed steps of a completed/errored audit
// app.post('/api/audits/:id/retry-failed-steps', authenticateToken, async (req, res) => {
//     const userId = req.user.userId;
//     const auditId = req.params.id;

//     if (!db) {
//         return res.status(503).json({ error: 'Base de donn\u00e9es en cours de chargement' });
//     }

//     try {
//         const audit = await db.get('SELECT * FROM audits WHERE id = ? AND user_id = ?', [auditId, userId]);
//         if (!audit) {
//             return res.status(404).json({ error: 'Audit non trouv\u00e9' });
//         }

//         if (audit.statut_global === 'EN_COURS') {
//             return res.status(409).json({ error: "L'audit est d\u00e9j\u00e0 en cours d'ex\u00e9cution." });
//         }

//         const failedSteps = await db.all(
//             "SELECT step_key FROM audit_steps WHERE audit_id = ? AND statut IN ('FAILED', 'ERROR', 'ERREUR', 'EN_COURS')",
//             [auditId]
//         );

//         if (!failedSteps || failedSteps.length === 0) {
//             return res.status(200).json({
//                 message: 'Aucune \u00e9tape en \u00e9chec \u00e0 relancer.',
//                 failedCount: 0
//             });
//         }

//         await db.run(
//             "UPDATE audit_steps SET statut = 'EN_ATTENTE', resultat = NULL, output_cloudinary_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE audit_id = ? AND statut IN ('FAILED', 'ERROR', 'ERREUR', 'EN_COURS')",
//             [auditId]
//         );

//         await db.run(
//             "UPDATE audits SET statut_global = 'EN_ATTENTE', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
//             [auditId]
//         );

//         await auditQueue.add('audit', {
//             auditId: audit.id,
//             userId: audit.user_id
//         });

//         const updatedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
//         io.emit('audit:update', updatedAudit);

//         console.log(`[RETRY] Re-queued audit ${auditId} with ${failedSteps.length} failed step(s)`);

//         return res.json({
//             message: `${failedSteps.length} \u00e9tape(s) en \u00e9chec relanc\u00e9e(s).`,
//             failedCount: failedSteps.length,
//             failedSteps: failedSteps.map(s => s.step_key),
//             audit: updatedAudit
//         });
//     } catch (err) {
//         console.error('[RETRY] Error:', err);
//         return res.status(500).json({ error: 'Erreur serveur lors de la relance des \u00e9tapes \u00e9chou\u00e9es' });
//     }
// });

app.post('/api/audits/:id/generate-slides', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const auditId = req.params.id;

    if (!db) {
        return res.status(503).json({ error: 'Base de données en cours de chargement' });
    }

    try {
        const audit = await db.get('SELECT * FROM audits WHERE id = ? AND user_id = ?', [auditId, userId]);

        if (!audit) {
            return res.status(404).json({ error: 'Audit non trouvé' });
        }

        const effectiveAudit = await reconcileAuditCompletion(db, audit);

        if (effectiveAudit.statut_global !== 'TERMINE') {
            return res.status(409).json({
                error: 'Le Google Slides peut être généré uniquement quand l’audit est terminé.'
            });
        }

        if (!effectiveAudit.airtable_record_id) {
            return res.status(400).json({
                error: 'Aucun RECORD_ID Airtable disponible pour cet audit.'
            });
        }

        if (effectiveAudit.slides_generation_status === 'EN_COURS' && !isSlidesGenerationLockStale(effectiveAudit)) {
            return res.status(409).json({
                error: 'Une génération Google Slides est déjà en cours pour cet audit.'
            });
        }

        if (isSlidesGenerationLockStale(effectiveAudit)) {
            console.warn(`[SLIDES] Clearing stale generation lock for audit ${auditId}`);
        }

        await db.run(
            `UPDATE audits
             SET slides_generation_status = ?,
                 slides_generation_error = NULL,
                 slides_review_confirmed_at = NULL,
                 google_action_plan_url = NULL,
                 action_plan_generation_status = 'NON_GENERE',
                 action_plan_generation_error = NULL,
                 action_plan_generated_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            ['EN_COURS', auditId]
        );

        const pendingAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
        io.emit('audit:update', pendingAudit);

        try {
            const { googleSlidesUrl, webhookUrl, asynchronous, message } = await triggerGoogleSlidesWebhook(effectiveAudit.airtable_record_id);

            if (asynchronous || !googleSlidesUrl) {
                watchSlidesLinkInAirtable(auditId, effectiveAudit.airtable_record_id).catch((err) => {
                    console.error(`[SLIDES] Background Airtable polling failed for audit ${auditId}:`, err.message);
                });

                return res.status(202).json({
                    message,
                    webhookUrl,
                    audit: pendingAudit
                });
            }

            await db.run(
                `UPDATE audits
                 SET google_slides_url = ?,
                     slides_generation_status = ?,
                     slides_generation_error = NULL,
                     slides_generated_at = CURRENT_TIMESTAMP,
                     slides_review_confirmed_at = NULL,
                     google_action_plan_url = NULL,
                     action_plan_generation_status = 'NON_GENERE',
                     action_plan_generation_error = NULL,
                     action_plan_generated_at = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [googleSlidesUrl, 'PRET', auditId]
            );

            const updatedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            io.emit('audit:update', updatedAudit);

            return res.json({
                message,
                googleSlidesUrl,
                webhookUrl,
                audit: updatedAudit
            });
        } catch (err) {
            const errorMessage = summarizeSlidesMessage(err.message) || 'Erreur lors de la génération Google Slides';

            await db.run(
                `UPDATE audits
                 SET slides_generation_status = ?, slides_generation_error = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                ['ERREUR', errorMessage, auditId]
            );

            const failedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            io.emit('audit:update', failedAudit);

            return res.status(502).json({
                error: errorMessage,
                audit: failedAudit
            });
        }
    } catch (err) {
        console.error('[SLIDES] Generation error:', err);
        return res.status(500).json({ error: 'Erreur serveur lors de la génération du Google Slides' });
    }
});

app.post('/api/audits/:id/confirm-slides-review', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const auditId = req.params.id;

    try {
        const audit = await db.get('SELECT * FROM audits WHERE id = ? AND user_id = ?', [auditId, userId]);

        if (!audit) {
            return res.status(404).json({ error: 'Audit non trouvé' });
        }

        if (!audit.google_slides_url) {
            return res.status(409).json({
                error: 'Le Google Slides doit être généré avant de confirmer sa relecture.'
            });
        }

        await db.run(
            `UPDATE audits
             SET slides_review_confirmed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [auditId]
        );

        const updatedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
        io.emit('audit:update', updatedAudit);

        return res.json({
            message: 'Relecture du Google Slides confirmée.',
            audit: updatedAudit
        });
    } catch (err) {
        return res.status(500).json({
            error: 'Erreur serveur lors de la confirmation de relecture du Google Slides'
        });
    }
});

app.delete('/api/audits/:id/confirm-slides-review', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const auditId = req.params.id;

    try {
        const audit = await db.get('SELECT * FROM audits WHERE id = ? AND user_id = ?', [auditId, userId]);

        if (!audit) {
            return res.status(404).json({ error: 'Audit non trouvé' });
        }

        await db.run(
            `UPDATE audits
             SET slides_review_confirmed_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [auditId]
        );

        const updatedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
        io.emit('audit:update', updatedAudit);

        return res.json({
            message: 'Confirmation de relecture retirée.',
            audit: updatedAudit
        });
    } catch (err) {
        return res.status(500).json({
            error: 'Erreur serveur lors du retrait de la confirmation de relecture'
        });
    }
});

app.post('/api/audits/:id/generate-action-plan', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const auditId = req.params.id;

    if (!db) {
        return res.status(503).json({ error: 'Base de données en cours de chargement' });
    }

    try {
        const audit = await db.get('SELECT * FROM audits WHERE id = ? AND user_id = ?', [auditId, userId]);

        if (!audit) {
            return res.status(404).json({ error: 'Audit non trouvé' });
        }

        if (!audit.google_slides_url) {
            return res.status(409).json({
                error: 'Le Google Slides doit être généré avant de lancer le Google Sheet plan d’actions.'
            });
        }

        if (!audit.slides_review_confirmed_at) {
            return res.status(409).json({
                error: 'Le client doit confirmer la relecture du Google Slides avant de générer le Google Sheet plan d’actions.'
            });
        }

        const { email } = req.body || {};
        if (!email || typeof email !== 'string' || !email.trim()) {
            return res.status(400).json({
                error: "Une adresse e-mail est requise pour partager le Google Sheet plan d’actions."
            });
        }

        if (audit.action_plan_generation_status === 'EN_COURS' && !isActionPlanGenerationLockStale(audit)) {
            return res.status(409).json({
                error: "Une génération du Google Sheet plan d’actions est déjà en cours pour cet audit."
            });
        }

        if (isActionPlanGenerationLockStale(audit)) {
            console.warn(`[ACTION PLAN] Clearing stale generation lock for audit ${auditId}`);
        }

        await db.run(
            `UPDATE audits
             SET action_plan_generation_status = ?,
                 action_plan_generation_error = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            ['EN_COURS', auditId]
        );

        const pendingAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
        io.emit('audit:update', pendingAudit);

        try {
            // Retry up to 2 times with exponential backoff for transient Google API errors
            const ACTION_PLAN_MAX_RETRIES = 2;
            const ACTION_PLAN_RETRY_BASE_DELAY_MS = 5000;
            let actionPlanResult;
            let lastActionPlanErr;

            for (let attempt = 0; attempt <= ACTION_PLAN_MAX_RETRIES; attempt++) {
                try {
                    actionPlanResult = await generateActionPlanSheet(audit, email.trim());
                    break;
                } catch (retryErr) {
                    lastActionPlanErr = retryErr;
                    if (attempt < ACTION_PLAN_MAX_RETRIES) {
                        const delayMs = ACTION_PLAN_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                        console.warn(`[ACTION PLAN] Attempt ${attempt + 1}/${ACTION_PLAN_MAX_RETRIES + 1} failed: ${retryErr.message}. Retrying in ${delayMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, delayMs));
                    }
                }
            }

            if (!actionPlanResult) throw lastActionPlanErr;
            const { spreadsheetUrl, sourceTabsCopied, actionCount } = actionPlanResult;

            await db.run(
                `UPDATE audits
                 SET google_action_plan_url = ?,
                     action_plan_generation_status = ?,
                     action_plan_generation_error = NULL,
                     action_plan_generated_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [spreadsheetUrl, 'PRET', auditId]
            );

            const updatedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            io.emit('audit:update', updatedAudit);

            return res.json({
                message: sourceTabsCopied > 0
                    ? `Google Sheet plan d’actions généré avec succès. ${actionCount} action(s) proposée(s). ${sourceTabsCopied} onglet(s) source ont été ajoutés.`
                    : `Google Sheet plan d’actions généré avec succès. ${actionCount} action(s) proposée(s).`,
                googleActionPlanUrl: spreadsheetUrl,
                actionCount,
                audit: updatedAudit
            });
        } catch (err) {
            const errorMessage =
                summarizeSlidesMessage(err.message) ||
                'Erreur lors de la génération du Google Sheet plan d’actions';

            await db.run(
                `UPDATE audits
                 SET action_plan_generation_status = ?,
                     action_plan_generation_error = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                ['ERREUR', errorMessage, auditId]
            );

            const failedAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            io.emit('audit:update', failedAudit);

            return res.status(502).json({
                error: errorMessage,
                audit: failedAudit
            });
        }
    } catch (err) {
        console.error('[ACTION PLAN] Generation error:', err);
        return res.status(500).json({
            error: 'Erreur serveur lors de la génération du Google Sheet plan d’actions'
        });
    }
});

app.delete('/api/audits/:id', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const auditId = req.params.id;

    if (!db) {
        return res.status(503).json({ error: 'Base de données en cours de chargement' });
    }

    try {
        const audit = await db.get('SELECT * FROM audits WHERE id = ? AND user_id = ?', [auditId, userId]);

        if (!audit) {
            return res.status(404).json({ error: 'Audit non trouvé' });
        }

        const isAuditRunning = ['EN_ATTENTE', 'EN_COURS'].includes(String(audit.statut_global || '').toUpperCase());
        const isSlidesRunning = String(audit.slides_generation_status || '').toUpperCase() === 'EN_COURS';
        const isActionPlanRunning = String(audit.action_plan_generation_status || '').toUpperCase() === 'EN_COURS';

        if (isAuditRunning || isSlidesRunning || isActionPlanRunning) {
            return res.status(409).json({
                error: 'Suppression impossible pendant le traitement de l’audit ou la génération des livrables.'
            });
        }

        if (audit.airtable_record_id) {
            await deleteAirtableAudit(audit.airtable_record_id);
        }

        await db.run('DELETE FROM audits WHERE id = ? AND user_id = ?', [auditId, userId]);

        io.emit('audit:deleted', { id: auditId });

        return res.json({
            message: 'Audit supprimé avec succès.',
            id: auditId
        });
    } catch (err) {
        console.error('[AUDIT] Delete error:', err);
        return res.status(500).json({
            error: 'Erreur serveur lors de la suppression de l’audit'
        });
    }
});

// Get Audit List
app.get('/api/audits', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const audits = await db.all('SELECT * FROM audits WHERE user_id = ? ORDER BY created_at DESC', [userId]);
        const reconciledAudits = [];

        for (const audit of audits) {
            reconciledAudits.push(await reconcileAuditCompletion(db, audit));
        }

        res.json(reconciledAudits);
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Get Audit Details (with steps)
app.get('/api/audits/:id', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const auditId = req.params.id;
    try {
        const audit = await db.get('SELECT * FROM audits WHERE id = ? AND user_id = ?', [auditId, userId]);
        if (!audit) return res.status(404).json({ error: 'Audit non trouvé' });

        const reconciledAudit = await reconcileAuditCompletion(db, audit);
        const steps = await db.all('SELECT * FROM audit_steps WHERE audit_id = ?', [auditId]);
        res.json({ ...reconciledAudit, steps });
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Session Status
app.get('/api/sessions/status', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    if (!db) return res.status(503).json({ error: 'Base de données en cours de chargement' });
    try {
        console.log(`[AUTH] Fetching session status for user ${userId}`);
        const sessions = await db.all('SELECT service, created_at FROM user_sessions WHERE user_id = ?', [userId]);
        console.log(`[AUTH] Found ${sessions.length} sessions`);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// The "catchall" handler: for any request that doesn't
// match one above, send back React's index.html file.
app.use((req, res) => {
    const indexPath = path.join(distPath, 'index.html');
    res.sendFile(indexPath, (err) => {
        if (err) {
            console.error('Error sending index.html:', err);
            // If it's an API route that failed, maybe return JSON
            if (req.url.startsWith('/api')) {
                res.status(404).json({ error: 'Route non trouvée' });
            } else {
                res.status(500).send(err.message);
            }
        }
    });
});

// Server start moved to startServer() wrapper above
