import { pool,query } from '../src/server/db';
import { indexPost,meili } from '../src/server/worker';
if(!meili)throw new Error('Set MEILI_URL and MEILI_MASTER_KEY first');
const rows=await query('SELECT id FROM posts');for(const row of rows)await indexPost(row.id);console.log(`Indexed ${rows.length} posts`);await pool.end();
