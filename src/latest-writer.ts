export interface LatestWriterStats {
  writes_started: number;
  writes_completed: number;
  coalesced_updates: number;
  last_duration_ms: number | null;
  max_duration_ms: number;
  consecutive_failures: number;
  last_error: string | null;
  last_write_at: string | null;
}

export interface LatestValueWriter<T> {
  enqueue(value: T): Promise<void>;
  close(finalValue?: T): Promise<void>;
  stats(): LatestWriterStats;
}

export async function withOperationTimeout<T>(operation:Promise<T>,timeoutMs:number,label:string):Promise<T>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([operation,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} exceeded ${timeoutMs}ms`)),timeoutMs)})])}
  finally{if(timer)clearTimeout(timer)}
}

export function createLatestValueWriter<T>(write: (value: T) => Promise<void>): LatestValueWriter<T> {
  let pending: T | undefined, running: Promise<void> | null = null, closed = false, failed:Error|null=null;
  const stats: LatestWriterStats = { writes_started: 0, writes_completed: 0, coalesced_updates: 0, last_duration_ms: null, max_duration_ms: 0, consecutive_failures: 0, last_error: null, last_write_at: null };
  const start = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (pending !== undefined) {
        const value = pending; pending = undefined;
        const began = Date.now(); stats.writes_started += 1;
        try {
          await write(value);
          const duration = Math.max(0, Date.now() - began); stats.last_duration_ms = duration; stats.max_duration_ms = Math.max(stats.max_duration_ms, duration);
          stats.writes_completed += 1; stats.consecutive_failures = 0; stats.last_error = null; stats.last_write_at = new Date().toISOString();
        } catch (error) {
          const duration = Math.max(0, Date.now() - began); stats.last_duration_ms = duration; stats.max_duration_ms = Math.max(stats.max_duration_ms, duration);
          stats.consecutive_failures += 1; stats.last_error = (error as Error).message.slice(0, 1000);pending=undefined;failed=error as Error;throw error;
        }
      }
    })().finally(() => { running = null; });
    return running;
  };
  return {
    enqueue(value: T) {
      if (closed) return Promise.reject(new Error('latest-value writer is closed'));
      if(failed)return Promise.reject(failed);
      if (pending !== undefined) stats.coalesced_updates += 1;
      pending = value; return start();
    },
    close(finalValue?: T) {
      if(failed){closed=true;return Promise.reject(failed)}
      if (finalValue !== undefined) { if (pending !== undefined) stats.coalesced_updates += 1; pending = finalValue; }
      closed = true; return start();
    },
    stats: () => ({ ...stats }),
  };
}
