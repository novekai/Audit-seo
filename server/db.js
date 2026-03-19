import { Pool, types } from 'pg';

// PostgreSQL returns COUNT(*) as int8 by default.
types.setTypeParser(types.builtins.INT8, (value) => parseInt(value, 10));

function toPgPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function createDbAdapter(pool) {
  return {
    async exec(sql) {
      await pool.query(sql);
    },

    async run(sql, params = []) {
      return pool.query(toPgPlaceholders(sql), params);
    },

    async get(sql, params = []) {
      const result = await pool.query(toPgPlaceholders(sql), params);
      return result.rows[0];
    },

    async all(sql, params = []) {
      const result = await pool.query(toPgPlaceholders(sql), params);
      return result.rows;
    },

    async close() {
      await pool.end();
    }
  };
}

function createPool() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required. PostgreSQL is now the only supported database.');
  }

  const isLocal =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1');

  return new Pool({
    connectionString,
    ssl: isLocal || process.env.PGSSLMODE === 'disable'
      ? false
      : { rejectUnauthorized: false }
  });
}

export async function initDb() {
  const pool = createPool();
  const db = createDbAdapter(pool);

  await pool.query('SELECT 1');
  console.log('[DB] PostgreSQL connection established');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      nom_site TEXT,
      url_site TEXT,
      sheet_audit_url TEXT,
      sheet_plan_url TEXT,
      mrm_report_url TEXT,
      airtable_record_id TEXT,
      google_slides_url TEXT,
      slides_generation_status TEXT DEFAULT 'NON_GENERE',
      slides_generation_error TEXT,
      slides_generated_at TIMESTAMPTZ,
      slides_review_confirmed_at TIMESTAMPTZ,
      google_action_plan_url TEXT,
      action_plan_generation_status TEXT DEFAULT 'NON_GENERE',
      action_plan_generation_error TEXT,
      action_plan_generated_at TIMESTAMPTZ,
      statut_global TEXT DEFAULT 'EN_ATTENTE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS audit_steps (
      id TEXT PRIMARY KEY,
      audit_id TEXT REFERENCES audits(id) ON DELETE CASCADE,
      step_key TEXT,
      statut TEXT DEFAULT 'EN_ATTENTE',
      attempts INTEGER DEFAULT 0,
      error_message TEXT,
      resultat TEXT,
      output_cloudinary_url TEXT,
      output_value TEXT,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      service TEXT,
      encrypted_cookies TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON users(email)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audits_user_created_at
    ON audits(user_id, created_at DESC)
  `);

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_steps_audit_step_key
    ON audit_steps(audit_id, step_key)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_service_created_at
    ON user_sessions(user_id, service, created_at DESC)
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS google_slides_url TEXT
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS slides_generation_status TEXT DEFAULT 'NON_GENERE'
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS slides_generation_error TEXT
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS slides_generated_at TIMESTAMPTZ
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS slides_review_confirmed_at TIMESTAMPTZ
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS google_action_plan_url TEXT
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS action_plan_generation_status TEXT DEFAULT 'NON_GENERE'
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS action_plan_generation_error TEXT
  `);

  await db.exec(`
    ALTER TABLE audits
    ADD COLUMN IF NOT EXISTS action_plan_generated_at TIMESTAMPTZ
  `);

  await db.run(`
    UPDATE audits
    SET slides_generation_status = 'NON_GENERE'
    WHERE slides_generation_status IS NULL
  `);

  await db.run(`
    UPDATE audits
    SET action_plan_generation_status = 'NON_GENERE'
    WHERE action_plan_generation_status IS NULL
  `);

  await db.exec(`
    ALTER TABLE audit_steps
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  `);

  await db.exec(`
    ALTER TABLE audit_steps
    ADD COLUMN IF NOT EXISTS resultat TEXT
  `);

  const userCount = await db.get('SELECT COUNT(*) AS count FROM users');
  if (Number(userCount?.count || 0) === 0) {
    console.log('[DB] Seeding default admin user for Airtable integration...');
    const { v4: uuidv4 } = await import('uuid');
    await db.run(
      'INSERT INTO users (id, email, password) VALUES (?, ?, ?)',
      [uuidv4(), 'admin@novek.ai', '']
    );
  }

  return db;
}
