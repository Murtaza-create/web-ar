/**
 * MODEL: supabaseModel.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Single source of truth for the Supabase client.
 * ✏️  PLACE YOUR CREDENTIALS ONLY IN THIS FILE.
 * ──────────────────────────────────────────────────────────────────────────────
 */

// ── Supabase Configuration ────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://jfibnjndtmdgugilbswn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpmaWJuam5kdG1kZ3VnaWxic3duIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk4NTU5NTUsImV4cCI6MjA4NTQzMTk1NX0.qMkdqgzldJmR7h37xDLpsOFcyjHxNn00DN7aD7K3Z6s';

// ── Client initialisation (Supabase CDN must be loaded before this module) ────
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Export via global namespace so plain-HTML pages can import this as a <script>
window.SupabaseModel = { supabaseClient, SUPABASE_URL };
