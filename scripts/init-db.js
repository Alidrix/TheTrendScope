import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_USER, ADMIN_PASSWORD } = process.env;

const log = (msg) => console.log(`→ ${msg}`);

const run = async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Les variables SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requises dans .env.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  log('Rappel : exécute le fichier supabase.sql dans le SQL Editor de Supabase si les tables ne sont pas encore créées.');
  if (fs.existsSync('supabase.sql')) {
    log('Chemin du script SQL local : supabase.sql');
  }

  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    console.error('ADMIN_USER et ADMIN_PASSWORD doivent être définis pour insérer le compte admin par défaut.');
    process.exit(1);
  }

  log(`Tentative d\'upsert de l\'admin par défaut (${ADMIN_USER})…`);
  const { error } = await supabase
    .from('admins')
    .upsert({ username: ADMIN_USER, password: ADMIN_PASSWORD })
    .select('username')
    .single();

  if (error) {
    console.error('Échec de l\'upsert. Assure-toi que les tables sont créées via supabase.sql puis relance :', error.message);
    process.exit(1);
  }

  log('Compte admin prêt dans Supabase.');
};

run();
