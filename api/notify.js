// api/notify.js — POST /api/notify (Vercel Cron: 毎日 11:00 UTC = 20:00 JST)
// stock_bancho_users テーブルの全ユーザーに在庫不足を LINE 通知

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const LINE_API = 'https://api.line.me/v2/bot/message/push';
const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function getNextShoppingInfo(shoppingDays) {
  const today = new Date().getDay();
  const candidates = shoppingDays
    .map(day => ({ day, diff: (day - today + 7) % 7 }))
    .filter(x => x.diff > 0)
    .sort((a, b) => a.diff - b.diff);

  if (candidates.length > 0) {
    const { day, diff } = candidates[0];
    return { daysUntil: diff, dayName: DAY_NAMES[day] };
  }
  const firstDay = [...shoppingDays].sort((a, b) => a - b)[0];
  return { daysUntil: 7, dayName: DAY_NAMES[firstDay] };
}

function getStockDays(item, count) {
  if (!item.dailyAmount || item.dailyAmount <= 0) return 999;
  return count / item.dailyAmount;
}

function getStockStatus(stockDays, daysUntilShopping) {
  if (stockDays < daysUntilShopping)        return 'ALERT';
  if (stockDays < daysUntilShopping * 1.5) return 'WARNING';
  return 'OK';
}

module.exports = async (req, res) => {
  try {
    // Vercel Cron または手動呼び出しのみ許可
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: rows, error } = await supabase
      .from('stock_bancho_users')
      .select('user_id, data');

    if (error) throw error;
    if (!rows || rows.length === 0) {
      return res.status(200).json({ sent: 0 });
    }

    let sentCount = 0;

    for (const row of rows) {
      try {
        const { user_id, data } = row;
        if (!data || !data.settings || !data.inventory) continue;

        const { settings, inventory } = data;
        const items       = settings.items || [];
        const shoppingDays = settings.shoppingDays || [1, 4];

        const { daysUntil, dayName } = getNextShoppingInfo(shoppingDays);

        const alertItems = items.filter(item => {
          const inv  = inventory[item.id] || { count: 0 };
          const days = getStockDays(item, inv.count);
          return getStockStatus(days, daysUntil) === 'ALERT';
        });

        if (alertItems.length === 0) continue;

        const lines = [
          '【ストック番長】在庫が少なくなっています！',
          `${dayName}曜の買い物（${daysUntil}日後）までに補充を検討してください。`,
          ''
        ];
        alertItems.forEach(item => {
          const inv  = inventory[item.id] || { count: 0 };
          const days = getStockDays(item, inv.count);
          lines.push(`${item.emoji} ${item.name}：あと ${days.toFixed(1)} 日分`);
        });

        await fetch(LINE_API, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
          },
          body: JSON.stringify({
            to: user_id,
            messages: [{ type: 'text', text: lines.join('\n') }]
          })
        });

        sentCount++;
      } catch (userErr) {
        console.error('notify error for user:', row.user_id, userErr);
      }
    }

    return res.status(200).json({ sent: sentCount });
  } catch (e) {
    console.error('notify error:', e);
    return res.status(500).json({ error: e.message });
  }
};
