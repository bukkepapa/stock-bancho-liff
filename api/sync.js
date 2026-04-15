// api/sync.js — POST /api/sync
// 受信: { userId, settings, inventory, purchaseLogs }
// stock_bancho_users テーブルへ UPSERT

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { userId, settings, inventory, purchaseLogs } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const data = { settings, inventory, purchaseLogs };

    const { error } = await supabase
      .from('stock_bancho_users')
      .upsert(
        { user_id: userId, data, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

    if (error) throw error;

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('sync error:', e);
    return res.status(500).json({ error: e.message });
  }
};
