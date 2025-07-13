// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://hpgcqrsxttflutdsasar.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwZ2NxcnN4dHRmbHV0ZHNhc2FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTI0MjEzMTYsImV4cCI6MjA2Nzk5NzMxNn0.7gecaEShO4oUStTcL9Xi-sJni9Pkb4d3mV5OVWxxiyM'; // remplace avec ta vraie clé
export const supabase = createClient(supabaseUrl, supabaseKey);
