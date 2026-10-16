// Supabase'i ühenduse andmed. Leiad need Supabase'is: Project Settings → API.
// Avalik võti (anon / publishable key) on mõeldud brauserile ja selle võib avaldada:
// andmeid kaitsevad sisselogimine ja andmebaasi õigused (Row Level Security).
// ÄRA pane siia kunagi "service_role" ehk salajast võtit.
window.SALDO_CONFIG = {
  url: 'https://SINU-PROJEKT.supabase.co',
  anonKey: 'SINU-AVALIK-VÕTI',
};
