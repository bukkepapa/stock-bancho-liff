// api/data.js — GET /api/data?userId=xxx
// stock_bancho_users テーブルからユーザーデータを取得

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { data: row, error } = await supabase
      .from('stock_bancho_users')
      .select('data')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // 行なし → 空データを返す
        return res.status(200).json({ settings: null, inventory: null, purchaseLogs: [] });
      }
      throw error;
    }

    return res.status(200).json(row.data || {});
  } catch (e) {
    console.error('data error:', e);
    return res.status(500).json({ error: e.message });
  }
};
