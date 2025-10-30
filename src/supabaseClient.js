import { createClient } from '@supabase/supabase-js'

// ⬇️ Replace these two with your values from Supabase (Project Settings → API)
const SUPABASE_URL = 'https://dyyevqpnalfxnceulclc.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5eWV2cXBuYWxmeG5jZXVsY2xjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE3NTg5MTYsImV4cCI6MjA3NzMzNDkxNn0.e0gJURKtTsH4dulerHMDRmKXolvyPqfAOgUxXBDAwlo'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
