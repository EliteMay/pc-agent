import { RelayError, TTL } from './protocol.mjs';

export function createStore(db) {
  const stmt=(sql,...values)=>db.prepare(sql).bind(...values);
  async function batch(statements) {
    try { const result=await db.batch(statements); if(result.some(r=>r.success!==true)) throw 0; return result; }
    catch { throw new RelayError('unavailable'); }
  }
  return {
    async rate(scope,now) {
      const duration=scope==='prepare'?600000:60000, limit=scope==='prepare'?5:20;
      const start=Math.floor(now/duration)*duration;
      const row=await stmt(`INSERT INTO relay_limits(scope,window_start,hits,expires_at) VALUES(?1,?2,1,?3)
        ON CONFLICT(scope) DO UPDATE SET window_start=excluded.window_start,
          hits=CASE WHEN relay_limits.window_start=excluded.window_start THEN relay_limits.hits+1 ELSE 1 END,
          expires_at=excluded.expires_at
        WHERE relay_limits.window_start!=excluded.window_start OR relay_limits.hits<?4 RETURNING hits`,scope,start,start+duration,limit).first();
      if(!row) throw new RelayError('rate_limited');
    },
    async prepare(stateHash,binding,nonceHash,now) {
      const result=await batch([
        stmt('INSERT OR IGNORE INTO relay_nonces(nonce_hash,expires_at) VALUES(?1,?2)',nonceHash,now+90000),
        stmt(`INSERT INTO relay_pending(state_hash,binding,expires_at,phase)
          SELECT ?1,?2,?3,'prepared' WHERE changes()=1
          AND (SELECT COUNT(*) FROM relay_pending WHERE expires_at>?4 AND phase!='consumed')<5
          ON CONFLICT(state_hash) DO NOTHING`,stateHash,binding,now+TTL,now),
      ]);
      if(result[0].meta.changes!==1) throw new RelayError('replay_rejected');
      if(result[1].meta.changes!==1) throw new RelayError('state_unavailable');
    },
    row:(stateHash)=>stmt('SELECT state_hash,binding,expires_at,phase FROM relay_pending WHERE state_hash=?1',stateHash).first(),
    async receive(row,envelope,now) {
      const result=await stmt(`UPDATE relay_pending SET phase='ready',envelope=?1
        WHERE state_hash=?2 AND binding=?3 AND expires_at=?4 AND expires_at>?5 AND phase='prepared'`,envelope,row.state_hash,row.binding,row.expires_at,now).run();
      if(result.success!==true||result.meta.changes!==1) throw new RelayError('state_unavailable');
    },
    async claim(stateHash,binding,nonceHash,now) {
      // Each statement and its RETURNING result belong to the same transaction.
      // No SELECT-then-DELETE race, and ciphertext is cleared before handoff.
      const result=await batch([
        stmt('INSERT OR IGNORE INTO relay_nonces(nonce_hash,expires_at) VALUES(?1,?2)',nonceHash,now+90000),
        stmt(`UPDATE relay_pending SET phase='consumed',claim_id=?1
          WHERE state_hash=?2 AND binding=?3 AND expires_at>?4 AND phase='ready' AND changes()=1
          RETURNING state_hash,binding,expires_at,envelope`,nonceHash,stateHash,binding,now),
        stmt("UPDATE relay_pending SET envelope=NULL WHERE state_hash=?1 AND claim_id=?2 AND phase='consumed'",stateHash,nonceHash),
      ]);
      if(result[0].meta.changes!==1) throw new RelayError('replay_rejected');
      const row=result[1].results?.[0]; if(!row) throw new RelayError('state_unavailable'); return row;
    },
    async cleanup(now) { await batch([
      stmt('DELETE FROM relay_pending WHERE expires_at<=?1',now),
      stmt('DELETE FROM relay_nonces WHERE expires_at<=?1',now),
      stmt('DELETE FROM relay_limits WHERE expires_at<=?1',now),
    ]); },
  };
}
